import type { AgentMcpTransport, AgentMcpTransportKind } from "@t3tools/contracts";
import {
  applyEdits,
  modify,
  parse as parseJsonc,
  type FormattingOptions,
  type ParseError,
} from "jsonc-parser";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import * as Schema from "effect/Schema";
import { parse as parseYaml } from "yaml";

/** The config dialects T3 Code edits. Each driver maps to one. */
export type AgentMcpDialect = "claude" | "cursor" | "opencode" | "codex";

type RawEntry = Record<string, unknown>;

export interface McpFileEntry {
  /** Null when the entry uses a shape T3 Code does not model; it is listed nowhere and left alone. */
  readonly transport: AgentMcpTransport | null;
  readonly enabled: boolean;
  readonly raw: RawEntry;
}

export const MCP_DIALECT_TRANSPORTS: Readonly<
  Record<AgentMcpDialect, ReadonlyArray<AgentMcpTransportKind>>
> = {
  claude: ["stdio", "http", "sse"],
  cursor: ["stdio", "http", "sse"],
  // OpenCode's remote entries try streamable HTTP, then fall back to SSE.
  opencode: ["stdio", "http", "sse"],
  // Codex speaks stdio and streamable HTTP only.
  codex: ["stdio", "http"],
};

const MANAGED_KEYS: Readonly<Record<AgentMcpDialect, ReadonlyArray<string>>> = {
  claude: ["type", "command", "args", "env", "url", "headers"],
  cursor: ["type", "command", "args", "env", "cwd", "url", "headers"],
  opencode: ["type", "command", "environment", "url", "headers", "enabled"],
  codex: ["command", "args", "env", "cwd", "url", "http_headers", "enabled"],
};

const isRecord = (value: unknown): value is RawEntry =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringMap = (value: unknown): Record<string, string> =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).flatMap(([key, item]) =>
          typeof item === "string" ? [[key, item]] : [],
        ),
      )
    : {};

const stringArray = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const nonEmpty = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

function decodeEntry(dialect: AgentMcpDialect, raw: RawEntry): AgentMcpTransport | null {
  const url = nonEmpty(raw.url);
  if (dialect === "opencode") {
    if (raw.type === "remote" && url !== null)
      return { _tag: "http", url, headers: stringMap(raw.headers) };
    const [command, ...args] = stringArray(raw.command);
    const commandName = nonEmpty(command);
    if (raw.type === "local" && commandName !== null)
      return {
        _tag: "stdio",
        command: commandName,
        args,
        env: stringMap(raw.environment),
        cwd: null,
      };
    return null;
  }
  const command = nonEmpty(raw.command);
  if (command !== null) {
    return {
      _tag: "stdio",
      command,
      args: stringArray(raw.args),
      env: stringMap(raw.env),
      cwd: dialect === "claude" ? null : nonEmpty(raw.cwd),
    };
  }
  if (url === null) return null;
  const headers = stringMap(dialect === "codex" ? raw.http_headers : raw.headers);
  return raw.type === "sse" ? { _tag: "sse", url, headers } : { _tag: "http", url, headers };
}

const withoutEmpty = (entry: RawEntry): RawEntry =>
  Object.fromEntries(
    Object.entries(entry).filter(
      ([, value]) =>
        value !== undefined &&
        value !== null &&
        !(Array.isArray(value) && value.length === 0) &&
        !(isRecord(value) && Object.keys(value).length === 0),
    ),
  );

/** The entry to store, keeping keys of a previous entry that T3 Code does not manage. */
export function encodeMcpEntry(
  dialect: AgentMcpDialect,
  transport: AgentMcpTransport,
  previous?: RawEntry,
): RawEntry {
  const managed = new Set(MANAGED_KEYS[dialect]);
  const extras = Object.fromEntries(
    Object.entries(previous ?? {}).filter(([key]) => !managed.has(key)),
  );
  switch (dialect) {
    case "claude":
      return transport._tag === "stdio"
        ? {
            ...extras,
            type: "stdio",
            command: transport.command,
            args: transport.args,
            env: transport.env,
          }
        : {
            ...extras,
            ...withoutEmpty({
              type: transport._tag,
              url: transport.url,
              headers: transport.headers,
            }),
          };
    case "cursor":
      return transport._tag === "stdio"
        ? {
            ...extras,
            ...withoutEmpty({
              command: transport.command,
              args: transport.args,
              env: transport.env,
              cwd: transport.cwd,
            }),
          }
        : {
            ...extras,
            ...withoutEmpty({
              type: transport._tag === "sse" ? "sse" : undefined,
              url: transport.url,
              headers: transport.headers,
            }),
          };
    case "opencode":
      return transport._tag === "stdio"
        ? {
            ...extras,
            ...withoutEmpty({
              type: "local",
              command: [transport.command, ...transport.args],
              environment: transport.env,
            }),
            enabled: true,
          }
        : {
            ...extras,
            ...withoutEmpty({ type: "remote", url: transport.url, headers: transport.headers }),
            enabled: true,
          };
    case "codex":
      return transport._tag === "stdio"
        ? {
            ...extras,
            ...withoutEmpty({
              command: transport.command,
              args: transport.args,
              env: transport.env,
              cwd: transport.cwd,
            }),
          }
        : {
            ...extras,
            ...withoutEmpty({ url: transport.url, http_headers: transport.headers }),
          };
  }
}

/**
 * Codex and OpenCode keep an entry and flip `enabled`, which keeps their own extra keys.
 * Claude Code and Cursor have no such key in their user config, so an entry turned off is removed.
 */
export function withMcpEntryEnabled(
  dialect: AgentMcpDialect,
  raw: RawEntry,
  enabled: boolean,
): RawEntry | undefined {
  switch (dialect) {
    case "claude":
    case "cursor":
      return enabled ? raw : undefined;
    case "opencode":
      return { ...raw, enabled };
    case "codex": {
      const { enabled: _enabled, ...rest } = raw;
      return enabled ? rest : { ...rest, enabled: false };
    }
  }
}

const containerKey = (dialect: AgentMcpDialect) =>
  dialect === "opencode" ? "mcp" : dialect === "codex" ? "mcp_servers" : "mcpServers";

type McpFileParse =
  | { readonly _tag: "parsed"; readonly entries: ReadonlyMap<string, McpFileEntry> }
  | { readonly _tag: "unreadable"; readonly cause: unknown };

function parseDocument(dialect: AgentMcpDialect, text: string): unknown {
  if (text.trim().length === 0) return {};
  if (dialect === "codex") return parseToml(text);
  const errors: ParseError[] = [];
  const value: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) throw new Error(`JSON parse error at offset ${errors[0]!.offset}`);
  return value;
}

export function parseMcpFile(dialect: AgentMcpDialect, text: string): McpFileParse {
  let document: unknown;
  try {
    document = parseDocument(dialect, text);
  } catch (cause) {
    return { _tag: "unreadable", cause };
  }
  if (!isRecord(document)) return { _tag: "unreadable", cause: new Error("Not an object") };
  const container = document[containerKey(dialect)];
  const entries = new Map<string, McpFileEntry>();
  if (isRecord(container)) {
    for (const [name, raw] of Object.entries(container)) {
      if (!isRecord(raw)) continue;
      entries.set(name, {
        transport: decodeEntry(dialect, raw),
        enabled: raw.enabled !== false,
        raw,
      });
    }
  }
  return { _tag: "parsed", entries };
}

class UnsafeTomlEditError extends Schema.TaggedError<UnsafeTomlEditError>()("UnsafeTomlEditError", {
  serverName: Schema.String,
}) {}

export const isUnsafeTomlEditError = Schema.is(UnsafeTomlEditError);

function jsonFormatting(text: string): FormattingOptions {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = /^([ \t]+)\S/m.exec(text)?.[1] ?? "  ";
  return indent.startsWith("\t")
    ? { insertSpaces: false, tabSize: 1, eol }
    : { insertSpaces: true, tabSize: indent.length, eol };
}

/** Sets or, with `undefined`, removes one server, leaving the rest of the file's text as it was. */
export function writeMcpEntry(
  dialect: AgentMcpDialect,
  text: string,
  name: string,
  raw: RawEntry | undefined,
): string {
  if (dialect === "codex") return writeTomlServer(text, name, raw);
  const source = text.trim().length === 0 ? "{}\n" : text;
  const edits = modify(source, [containerKey(dialect), name], raw, {
    formattingOptions: jsonFormatting(source),
  });
  return applyEdits(source, edits);
}

// TOML: a header line names a table; key segments may be bare, "basic" or 'literal' strings.
const HEADER_PATTERN = /^\s*\[\[?\s*(.+?)\s*\]\]?\s*(?:#.*)?$/;

function parseTomlKeyPath(source: string): ReadonlyArray<string> | null {
  const keys: string[] = [];
  let index = 0;
  const skipSpace = () => {
    while (source[index] === " " || source[index] === "\t") index += 1;
  };
  while (index < source.length) {
    skipSpace();
    const char = source[index];
    if (char === '"') {
      let value = "";
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === "\\") {
          const escaped = source[index + 1];
          const simple: Record<string, string> = { n: "\n", t: "\t", '"': '"', "\\": "\\" };
          if (escaped === "u" || escaped === "U") {
            const length = escaped === "u" ? 4 : 8;
            value += String.fromCodePoint(
              Number.parseInt(source.slice(index + 2, index + 2 + length), 16),
            );
            index += 2 + length;
            continue;
          }
          value += simple[escaped ?? ""] ?? escaped ?? "";
          index += 2;
          continue;
        }
        value += source[index];
        index += 1;
      }
      if (source[index] !== '"') return null;
      index += 1;
      keys.push(value);
    } else if (char === "'") {
      const end = source.indexOf("'", index + 1);
      if (end < 0) return null;
      keys.push(source.slice(index + 1, end));
      index = end + 1;
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(source.slice(index));
      if (!match) return null;
      keys.push(match[0]);
      index += match[0].length;
    }
    skipSpace();
    if (index >= source.length) break;
    if (source[index] !== ".") return null;
    index += 1;
  }
  return keys;
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return typeof value === "bigint" ? `${value}n` : JSON.stringify(value);
}

// An emptied `mcp_servers` may or may not leave its header behind; both mean no servers.
function withoutEmptyServers(document: RawEntry): RawEntry {
  if (!isRecord(document.mcp_servers) || Object.keys(document.mcp_servers).length > 0) {
    return document;
  }
  const { mcp_servers: _empty, ...rest } = document;
  return rest;
}

function expectedToml(document: RawEntry, name: string, raw: RawEntry | undefined): RawEntry {
  const servers = isRecord(document.mcp_servers) ? { ...document.mcp_servers } : {};
  delete servers[name];
  if (raw !== undefined) servers[name] = raw;
  return withoutEmptyServers({ ...document, mcp_servers: servers });
}

/**
 * Edits `[mcp_servers.<name>]` and its sub-tables as text so comments and other tables stay as
 * written, then re-parses to prove only that server changed. An entry written inline or with
 * dotted keys fails that proof and is refused rather than rewritten.
 */
function writeTomlServer(text: string, name: string, raw: RawEntry | undefined): string {
  const before = text.trim().length === 0 ? {} : (parseToml(text) as RawEntry);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.length === 0 ? [] : text.split(/\r?\n/);
  const kept: string[] = [];
  let skipped: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = HEADER_PATTERN.exec(line);
    if (header) {
      const keys = parseTomlKeyPath(header[1]!);
      const owned =
        keys !== null && keys.length >= 2 && keys[0] === "mcp_servers" && keys[1] === name;
      if (skipping && !owned) {
        // Comments just above the next table describe that table, not the removed one.
        let start = skipped.length;
        while (start > 0 && /^s*(?:#.*)?$/.test(skipped[start - 1]!)) start -= 1;
        kept.push(...skipped.slice(start));
      }
      skipping = owned;
      skipped = [];
    }
    if (skipping) skipped.push(line);
    else kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
  let next = kept.join(eol);
  if (raw !== undefined) {
    const section = stringifyToml({ mcp_servers: { [name]: raw } })
      .trim()
      .replace(/\n/g, eol);
    next = next.length === 0 ? section : `${next}${eol}${eol}${section}`;
  }
  next = next.length === 0 ? "" : `${next}${eol}`;
  let after: unknown;
  try {
    after = next.trim().length === 0 ? {} : parseToml(next);
  } catch {
    throw new UnsafeTomlEditError({ serverName: name });
  }
  if (
    stableStringify(withoutEmptyServers(after as RawEntry)) !==
    stableStringify(expectedToml(before, name, raw))
  ) {
    throw new UnsafeTomlEditError({ serverName: name });
  }
  return next;
}

/** Remote transports compare alike: OpenCode records SSE and HTTP servers the same way. */
export function sameMcpDefinition(left: AgentMcpTransport, right: AgentMcpTransport): boolean {
  const canonical = (transport: AgentMcpTransport) =>
    transport._tag === "stdio"
      ? stableStringify({ ...transport, cwd: null })
      : stableStringify({ _tag: "remote", url: transport.url, headers: transport.headers });
  return canonical(left) === canonical(right);
}

const FRONTMATTER_PATTERN = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** The `description` in a SKILL.md's YAML frontmatter, when it has one. */
export function parseSkillDescription(contents: string): string | null {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) return null;
  try {
    const parsed: unknown = parseYaml(match[1] ?? "");
    return isRecord(parsed) ? nonEmpty(parsed.description) : null;
  } catch {
    const line = /^description:[ \t]*(.+)$/m.exec(match[1] ?? "")?.[1];
    return nonEmpty(line?.replace(/^["']|["']$/g, ""));
  }
}
