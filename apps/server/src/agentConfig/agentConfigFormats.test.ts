import { describe, expect, it } from "@effect/vitest";
import { parse as parseToml } from "smol-toml";

import {
  encodeMcpEntry,
  parseMcpFile,
  parseSkillDescription,
  withMcpEntryEnabled,
  writeMcpEntry,
} from "./agentConfigFormats.ts";

const stdio = {
  _tag: "stdio" as const,
  command: "npx",
  args: ["-y", "@acme/mcp"],
  env: { ACME_TOKEN: "secret" },
  cwd: null,
};

describe("JSON MCP configs", () => {
  it("adds and removes one server while keeping other keys, comments and indentation", () => {
    const original = [
      "{",
      '\t"numStartups": 12, // Claude Code bookkeeping',
      '\t"projects": { "/repo": { "allowedTools": [] } },',
      '\t"mcpServers": {',
      '\t\t"docs": { "type": "http", "url": "https://docs.example/mcp" }',
      "\t}",
      "}",
      "",
    ].join("\n");

    const added = writeMcpEntry("claude", original, "acme", encodeMcpEntry("claude", stdio));
    expect(added).toContain('"numStartups": 12, // Claude Code bookkeeping');
    expect(added).toContain('\t"projects": { "/repo": { "allowedTools": [] } },');
    const parsed = parseMcpFile("claude", added);
    expect(parsed._tag === "parsed" && [...parsed.entries.keys()]).toEqual(["docs", "acme"]);
    expect(parsed._tag === "parsed" && parsed.entries.get("acme")?.transport).toEqual(stdio);

    const removed = writeMcpEntry("claude", added, "acme", undefined);
    const afterRemove = parseMcpFile("claude", removed);
    expect(afterRemove._tag === "parsed" && [...afterRemove.entries.keys()]).toEqual(["docs"]);
    expect(removed).toContain("// Claude Code bookkeeping");
  });

  it("refuses to read a file that is not JSON instead of treating it as empty", () => {
    expect(parseMcpFile("cursor", "{ mcpServers: ")._tag).toBe("unreadable");
  });

  it("maps OpenCode's local command array and disabled flag", () => {
    const text = JSON.stringify({
      mcp: {
        acme: {
          type: "local",
          command: ["npx", "-y", "@acme/mcp"],
          environment: { ACME_TOKEN: "secret" },
          enabled: false,
          timeout: 5000,
        },
      },
    });
    const parsed = parseMcpFile("opencode", text);
    const entry = parsed._tag === "parsed" ? parsed.entries.get("acme") : undefined;
    expect(entry?.transport).toEqual(stdio);
    expect(entry?.enabled).toBe(false);
    expect(withMcpEntryEnabled("opencode", entry!.raw, true)).toMatchObject({
      enabled: true,
      timeout: 5000,
    });
  });
});

describe("Codex config.toml", () => {
  const original = [
    'model = "gpt-5"',
    "",
    "# Shared profile",
    "[profiles.fast]",
    'model = "gpt-5-mini"',
    "",
    "[mcp_servers.acme]",
    'command = "old"',
    'enabled_tools = ["search"]',
    "",
    "[mcp_servers.acme.env]",
    'OLD = "1"',
    "",
    "# GitHub tools",
    '[mcp_servers."github"]',
    'url = "https://api.githubcopilot.com/mcp/"',
    "",
  ].join("\n");

  it("replaces one server's tables and leaves every other line as written", () => {
    const parsed = parseMcpFile("codex", original);
    const previous = parsed._tag === "parsed" ? parsed.entries.get("acme")?.raw : undefined;
    const next = writeMcpEntry("codex", original, "acme", encodeMcpEntry("codex", stdio, previous));

    expect(next.startsWith(original.split("[mcp_servers.acme]")[0]!)).toBe(true);
    expect(next).toContain('# GitHub tools\n[mcp_servers."github"]');
    expect(next).not.toContain('command = "old"');
    expect(parseToml(next)).toEqual({
      model: "gpt-5",
      profiles: { fast: { model: "gpt-5-mini" } },
      mcp_servers: {
        github: { url: "https://api.githubcopilot.com/mcp/" },
        acme: {
          command: "npx",
          args: ["-y", "@acme/mcp"],
          env: { ACME_TOKEN: "secret" },
          enabled_tools: ["search"],
        },
      },
    });
  });

  it("turns a server off in place and removes the last one cleanly", () => {
    const parsed = parseMcpFile("codex", original);
    const raw = parsed._tag === "parsed" ? parsed.entries.get("github")!.raw : {};
    const disabled = writeMcpEntry(
      "codex",
      original,
      "github",
      withMcpEntryEnabled("codex", raw, false),
    );
    const reread = parseMcpFile("codex", disabled);
    expect(reread._tag === "parsed" && reread.entries.get("github")?.enabled).toBe(false);

    const onlyServer = '[mcp_servers.acme]\ncommand = "x"\n';
    expect(writeMcpEntry("codex", onlyServer, "acme", undefined)).toBe("");
  });

  it("refuses servers written as inline tables rather than rewriting the file", () => {
    const inline = 'mcp_servers = { acme = { command = "x" } }\n';
    expect(() => writeMcpEntry("codex", inline, "acme", encodeMcpEntry("codex", stdio))).toThrow();
  });
});

describe("parseSkillDescription", () => {
  it("reads the frontmatter description and tolerates unquoted colons", () => {
    expect(
      parseSkillDescription("---\nname: review\ndescription: Review a diff.\n---\n# Body"),
    ).toBe("Review a diff.");
    expect(parseSkillDescription("---\ndescription: Use when: a PR is open\n---\n")).toBe(
      "Use when: a PR is open",
    );
    expect(parseSkillDescription("# No frontmatter")).toBeNull();
  });
});
