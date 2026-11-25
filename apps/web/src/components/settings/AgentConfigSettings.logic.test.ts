import { describe, expect, it } from "vite-plus/test";

import { mcpServerDraft, mcpTransportFromDraft } from "./AgentConfigSettings.logic";

describe("mcpTransportFromDraft", () => {
  it("reads one argument per line and drops blank variables", () => {
    const draft = {
      ...mcpServerDraft(null, []),
      command: " npx ",
      args: "-y\n\n@acme/mcp --root ./my dir\n",
      pairs: [
        { key: "ACME_TOKEN", value: "secret" },
        { key: "  ", value: "orphan" },
      ],
    };
    expect(mcpTransportFromDraft(draft)).toEqual({
      _tag: "stdio",
      command: "npx",
      args: ["-y", "@acme/mcp --root ./my dir"],
      env: { ACME_TOKEN: "secret" },
      cwd: null,
    });
  });

  it("needs a command or an http(s) URL", () => {
    expect(mcpTransportFromDraft(mcpServerDraft(null, []))).toBeNull();
    const remote = { ...mcpServerDraft(null, [], "sse"), url: "ftp://example.test" };
    expect(mcpTransportFromDraft(remote)).toBeNull();
    expect(mcpTransportFromDraft({ ...remote, url: "https://example.test/sse" })).toEqual({
      _tag: "sse",
      url: "https://example.test/sse",
      headers: {},
    });
  });

  it("round-trips an existing server through its draft", () => {
    const server = {
      name: "docs",
      transport: {
        _tag: "http" as const,
        url: "https://docs.example/mcp",
        headers: { Authorization: "Bearer x" },
      },
      enabledIn: ["claudeAgent"],
      divergent: false,
    };
    const draft = mcpServerDraft(server, ["codex"]);
    expect(draft.targetIds).toEqual(["claudeAgent"]);
    expect(mcpTransportFromDraft(draft)).toEqual(server.transport);
  });
});
