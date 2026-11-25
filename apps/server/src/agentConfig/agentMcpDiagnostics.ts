import type { AgentMcpPathIssue, AgentMcpPathRewrite, AgentMcpProblem } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type { AgentMcpDialect } from "./agentConfigFormats.ts";

type RawEntry = Record<string, unknown>;
type PathRole = "command" | "cwd" | "value";

// Sibling folders listed when looking for a moved version directory.
const MAX_SIBLINGS = 512;

const isRecord = (value: unknown): value is RawEntry =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Maps every string in the fields a stdio entry runs with: command, args, env values and cwd.
 * URLs, headers and keys T3 Code does not model are never visited.
 */
function mapPathFields(
  dialect: AgentMcpDialect,
  raw: RawEntry,
  map: (field: string, value: string, role: PathRole) => string,
): RawEntry {
  const text = (field: string, value: unknown, role: PathRole) =>
    typeof value === "string" ? map(field, value, role) : value;
  const env = (value: unknown) =>
    isRecord(value)
      ? Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, text(`env.${key}`, item, "value")]),
        )
      : value;
  const next: RawEntry = { ...raw };
  if (dialect === "opencode") {
    if (Array.isArray(raw.command)) {
      next.command = raw.command.map((item: unknown, index) =>
        index === 0 ? text("command", item, "command") : text(`args[${index - 1}]`, item, "value"),
      );
    }
    if ("environment" in raw) next.environment = env(raw.environment);
    return next;
  }
  if ("command" in raw) next.command = text("command", raw.command, "command");
  if (Array.isArray(raw.args)) {
    next.args = raw.args.map((item: unknown, index) => text(`args[${index}]`, item, "value"));
  }
  if ("env" in raw) next.env = env(raw.env);
  if (dialect !== "claude" && "cwd" in raw) next.cwd = text("cwd", raw.cwd, "cwd");
  return next;
}

const stringEnv = (dialect: AgentMcpDialect, raw: RawEntry): Record<string, string> => {
  const value = dialect === "opencode" ? raw.environment : raw.env;
  return isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).flatMap(([key, item]) =>
          typeof item === "string" ? [[key, item]] : [],
        ),
      )
    : {};
};

/** Hashes and version numbers collapse, so `22cfb1d3…` matches `34ab3e13…` and `v20.1` matches `v22.3`. */
const versionShape = (name: string) =>
  name
    .toLowerCase()
    .replace(/[0-9a-f]{6,}/g, "#")
    .replace(/\d+/g, "0");

interface StalePath {
  readonly field: string;
  readonly kind: AgentMcpPathIssue["kind"];
  readonly path: string;
  readonly role: PathRole;
}

/** Helpers bound to the host's path rules: Windows compares case-insensitively. */
const pathRules = Effect.gen(function* () {
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const key = (value: string) => (platform === "win32" ? value.toLowerCase() : value);
  const delimiter = platform === "win32" ? ";" : ":";
  const isAbsolute = (value: string) =>
    value.length > 1 &&
    path.isAbsolute(value) &&
    // Named pipes and device paths are not files to look for.
    !value.startsWith("\\\\.\\") &&
    !value.startsWith("\\\\?\\");
  const segments = (value: string, role: PathRole) =>
    role === "value" ? value.split(delimiter) : [value];
  const rewrite = (segment: string, rewrites: ReadonlyArray<AgentMcpPathRewrite>) => {
    const trimmed = segment.trim();
    if (!isAbsolute(trimmed)) return segment;
    const normalized = path.normalize(trimmed);
    for (const { from, to } of rewrites) {
      if (key(normalized) === key(from) || key(normalized).startsWith(key(from) + path.sep)) {
        return to + normalized.slice(from.length);
      }
    }
    return segment;
  };
  return { path, platform, key, delimiter, isAbsolute, segments, rewrite };
});

/** Applies confirmed rewrites to an entry's paths, leaving everything else untouched. */
export const mcpPathRewriter = Effect.map(
  pathRules,
  (rules) =>
    (
      dialect: AgentMcpDialect,
      raw: RawEntry,
      rewrites: ReadonlyArray<AgentMcpPathRewrite>,
    ): RawEntry =>
      mapPathFields(dialect, raw, (_field, value, role) =>
        rules
          .segments(value, role)
          .map((segment) => rules.rewrite(segment, rewrites))
          .join(rules.delimiter),
      ),
);

/**
 * Finds paths an enabled stdio entry runs with that are gone, and, when a missing directory has
 * a sibling of the same version shape holding every missing file, proposes swapping it in. That
 * covers runtimes installed under versioned or hashed folders that an update replaced.
 */
export const diagnoseMcpEntry = Effect.fn("AgentConfig.diagnoseMcpEntry")(function* (
  dialect: AgentMcpDialect,
  raw: RawEntry,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const hostEnvironment = yield* HostProcess.Environment;
  const rules = yield* pathRules;
  const { path } = rules;
  // An unreadable path is not reported: only a definite miss is a problem.
  const exists = (value: string) => fileSystem.exists(value).pipe(Effect.orElseSucceed(() => true));
  // Windows may omit the extension a PATHEXT lookup adds.
  const commandExists = (value: string) =>
    exists(value).pipe(
      Effect.flatMap((found) =>
        found ? Effect.succeed(true) : Effect.map(resolveCommandPath(value), (hit) => hit !== null),
      ),
    );

  const fields: Array<{ field: string; value: string; role: PathRole }> = [];
  mapPathFields(dialect, raw, (field, value, role) => {
    fields.push({ field, value, role });
    return value;
  });

  const stale: Array<StalePath> = [];
  for (const { field, value, role } of fields) {
    if (role === "command") {
      const command = value.trim();
      if (rules.isAbsolute(command)) {
        if (!(yield* commandExists(command))) {
          stale.push({ field, kind: "missing", path: command, role });
        }
      } else if (command.length > 0 && !/[\\/]/.test(command)) {
        const env = { ...hostEnvironment, ...stringEnv(dialect, raw) };
        // Without a PATH there is nothing to judge a bare command against.
        const searchPath = env.PATH ?? env.Path ?? env.path ?? "";
        if (searchPath.length > 0 && (yield* resolveCommandPath(command, { env })) === null) {
          stale.push({ field, kind: "not-on-path", path: command, role });
        }
      }
      continue;
    }
    for (const segment of rules.segments(value, role)) {
      const candidate = segment.trim();
      if (!rules.isAbsolute(candidate) || (yield* exists(candidate))) continue;
      // An argument or variable may name a file the server creates; its folder must exist.
      if (role === "value" && (yield* exists(path.dirname(candidate)))) continue;
      stale.push({ field, kind: "missing", path: candidate, role });
    }
  }

  // Each missing path belongs to the shallowest missing folder under an existing parent.
  const groups = new Map<
    string,
    { parent: string; name: string; members: Array<{ rest: string; role: PathRole }> }
  >();
  for (const item of stale) {
    if (item.kind !== "missing") continue;
    let child = path.normalize(item.path);
    let parent = path.dirname(child);
    while (parent !== child && !(yield* exists(parent))) {
      child = parent;
      parent = path.dirname(parent);
    }
    const rest = path.relative(child, path.normalize(item.path));
    // A folder with nothing named below it gives no layout to match a sibling against.
    if (parent === child || rest.length === 0) continue;
    const groupKey = rules.key(child);
    const group = groups.get(groupKey) ?? { parent, name: path.basename(child), members: [] };
    group.members.push({ rest, role: item.role });
    groups.set(groupKey, group);
  }

  const rewrites: Array<AgentMcpPathRewrite> = [];
  for (const { parent, name, members } of groups.values()) {
    const shape = versionShape(name);
    const siblings = (yield* fileSystem
      .readDirectory(parent)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])))
      .filter((entry) => rules.key(entry) !== rules.key(name) && versionShape(entry) === shape)
      .toSorted()
      .slice(0, MAX_SIBLINGS);
    let best: { name: string; modified: number } | null = null;
    for (const sibling of siblings) {
      const root = path.join(parent, sibling);
      let complete = true;
      for (const member of members) {
        const target = path.join(root, member.rest);
        if (!(yield* member.role === "command" ? commandExists(target) : exists(target))) {
          complete = false;
          break;
        }
      }
      if (!complete) continue;
      const info = yield* fileSystem.stat(root).pipe(Effect.option);
      const modified =
        Option.isSome(info) && Option.isSome(info.value.mtime)
          ? info.value.mtime.value.getTime()
          : 0;
      // The newest install is the one an updater left behind most recently.
      if (best === null || modified > best.modified) best = { name: sibling, modified };
    }
    if (best !== null) {
      rewrites.push({ from: path.join(parent, name), to: path.join(parent, best.name) });
    }
  }

  const issues = stale.map((item): AgentMcpPathIssue => {
    const repaired = item.kind === "missing" ? rules.rewrite(item.path, rewrites) : item.path;
    return {
      field: item.field,
      kind: item.kind,
      path: item.path,
      repairedPath: repaired === item.path ? null : repaired,
    };
  });
  return { issues, rewrites } satisfies Omit<AgentMcpProblem, "name" | "targetId">;
});

export const sameRewrites = (
  left: ReadonlyArray<AgentMcpPathRewrite>,
  right: ReadonlyArray<AgentMcpPathRewrite>,
) => {
  const canonical = (rewrites: ReadonlyArray<AgentMcpPathRewrite>) =>
    JSON.stringify(rewrites.map(({ from, to }) => [from, to]).toSorted());
  return canonical(left) === canonical(right);
};
