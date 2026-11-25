import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId, type AgentMcpTransport } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import * as AgentConfig from "./AgentConfig.ts";

const server: AgentMcpTransport = {
  _tag: "stdio",
  command: "npx",
  args: ["-y", "@acme/mcp"],
  env: { ACME_TOKEN: "secret" },
  cwd: null,
};

/** Runs `use` against a temp home, never the developer's real CLI config. */
const withHome = <A, E>(
  use: (paths: {
    readonly home: string;
    readonly join: (...parts: ReadonlyArray<string>) => string;
  }) => Effect.Effect<A, E, AgentConfig.AgentConfig | FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agent-config-" });
    const join = (...parts: ReadonlyArray<string>) => path.join(home, ...parts);
    const layer = AgentConfig.layer.pipe(
      Layer.provide(ServerConfig.layerTest(home, join("t3"))),
      Layer.provide(
        Layer.mock(CodexInstallation.CodexInstallation)({ managedDirectory: join("managed") }),
      ),
      Layer.provide(
        ServerSettings.layerTest({
          providerInstances: {
            [ProviderInstanceId.make("claude_work")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              displayName: "Work",
              config: { homePath: join("claude-work") },
            },
          },
        }),
      ),
    );
    return yield* use({ home, join }).pipe(
      Effect.provide(layer),
      Effect.provideService(HostProcess.HomeDirectory, home),
      Effect.provideService(HostProcess.Environment, {}),
    );
  });

it.layer(NodeServices.layer)("AgentConfig", (it) => {
  describe("MCP servers", () => {
    it.effect("writes one definition to each chosen CLI, backing up files it changes", () =>
      withHome(({ join }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const agentConfig = yield* AgentConfig.AgentConfig;
          yield* fs.writeFileString(
            join(".claude.json"),
            '{\n  "numStartups": 3,\n  "mcpServers": {}\n}\n',
          );
          yield* fs.makeDirectory(join(".codex"), { recursive: true });
          yield* fs.writeFileString(join(".codex", "config.toml"), '# mine\nmodel = "gpt-5"\n');

          const initial = yield* agentConfig.list;
          expect(initial.targets.map((target) => [target.id, target.instanceLabel])).toEqual([
            ["claudeAgent", null],
            ["claude_work", "Work"],
            ["codex", null],
            ["cursor", null],
            ["opencode", null],
          ]);
          expect(initial.targets[1]?.mcpConfigPath).toBe(join("claude-work", ".claude.json"));

          yield* agentConfig.upsertMcpServer({
            name: "acme",
            transport: server,
            targetIds: ["claudeAgent", "codex"],
          });

          const claude = JSON.parse(yield* fs.readFileString(join(".claude.json")));
          expect(claude.numStartups).toBe(3);
          expect(claude.mcpServers.acme).toEqual({
            type: "stdio",
            command: "npx",
            args: ["-y", "@acme/mcp"],
            env: { ACME_TOKEN: "secret" },
          });
          const codex = yield* fs.readFileString(join(".codex", "config.toml"));
          expect(codex.startsWith('# mine\nmodel = "gpt-5"\n\n[mcp_servers.acme]\n')).toBe(true);
          const backups = (yield* fs.readDirectory(join(".codex"))).filter((name) =>
            name.startsWith("config.toml.t3-backup-"),
          );
          expect(backups).toHaveLength(1);
          expect(yield* fs.readFileString(join(".codex", backups[0]!))).toBe(
            '# mine\nmodel = "gpt-5"\n',
          );
          // Cursor had no file, so nothing was created or backed up there.
          expect(yield* fs.exists(join(".cursor"))).toBe(false);

          const after = yield* agentConfig.list;
          expect(after.mcpServers).toEqual([
            {
              name: "acme",
              transport: server,
              enabledIn: ["claudeAgent", "codex"],
              divergent: false,
            },
          ]);
        }),
      ),
    );

    it.effect("keeps a server turned off everywhere so it can be turned back on", () =>
      withHome(({ join }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const agentConfig = yield* AgentConfig.AgentConfig;
          yield* agentConfig.upsertMcpServer({
            name: "acme",
            transport: server,
            targetIds: ["cursor"],
          });
          yield* agentConfig.setMcpServerEnabled({
            name: "acme",
            targetId: "cursor",
            enabled: false,
          });
          const cursor = JSON.parse(yield* fs.readFileString(join(".cursor", "mcp.json")));
          expect(cursor.mcpServers).toEqual({});
          expect((yield* agentConfig.list).mcpServers).toEqual([
            { name: "acme", transport: server, enabledIn: [], divergent: false },
          ]);

          yield* agentConfig.setMcpServerEnabled({
            name: "acme",
            targetId: "opencode",
            enabled: true,
          });
          const openCode = JSON.parse(
            yield* fs.readFileString(join(".config", "opencode", "opencode.json")),
          );
          expect(openCode.mcp.acme).toEqual({
            type: "local",
            command: ["npx", "-y", "@acme/mcp"],
            environment: { ACME_TOKEN: "secret" },
            enabled: true,
          });

          yield* agentConfig.removeMcpServer({ name: "acme" });
          expect((yield* agentConfig.list).mcpServers).toEqual([]);
        }),
      ),
    );

    it.effect("syncs enabled definitions from the selected CLI and rejects stale previews", () =>
      withHome(({ join }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const agentConfig = yield* AgentConfig.AgentConfig;
          const codex = join(".codex", "config.toml");
          const claude = join(".claude.json");
          yield* agentConfig.upsertMcpServer({
            name: "acme",
            transport: server,
            targetIds: ["claudeAgent", "codex", "opencode"],
          });
          const claudeBefore = (yield* fs.readFileString(claude)).replace(
            '"command": "npx"',
            '"command": "npx", "customField": 42',
          );
          yield* fs.writeFileString(claude, claudeBefore);
          const original = yield* fs.readFileString(codex);
          const chosen = original.replace(
            'command = "npx"',
            'command = "node"\nstartup_timeout_sec = 42',
          );
          yield* fs.writeFileString(codex, chosen);
          const [entry] = (yield* agentConfig.list).mcpServers;
          expect(entry?.divergent).toBe(true);
          const sync = {
            name: "acme",
            sourceTargetId: "codex",
            definitions: entry?.definitions ?? [],
          };
          yield* fs.writeFileString(
            codex,
            original.replace('command = "npx"', 'command = "python"'),
          );
          expect((yield* agentConfig.syncMcpServer(sync).pipe(Effect.flip)).reason).toBe(
            "repair-changed",
          );
          expect(yield* fs.readFileString(claude)).toBe(claudeBefore);
          yield* fs.writeFileString(codex, chosen);
          yield* agentConfig.syncMcpServer(sync);
          expect((yield* agentConfig.list).mcpServers).toEqual([
            {
              name: "acme",
              transport: { ...server, command: "node" },
              enabledIn: ["claudeAgent", "codex", "opencode"],
              divergent: false,
            },
          ]);
          expect(yield* fs.readFileString(codex)).toBe(chosen);
          expect(yield* fs.readFileString(claude)).toContain('"customField": 42');
          expect(yield* fs.exists(join(".cursor", "mcp.json"))).toBe(false);
        }),
      ),
    );

    it.effect("refuses a transport the target CLI cannot run", () =>
      withHome(() =>
        Effect.gen(function* () {
          const agentConfig = yield* AgentConfig.AgentConfig;
          const error = yield* agentConfig
            .upsertMcpServer({
              name: "events",
              transport: { _tag: "sse", url: "https://example.test/sse", headers: {} },
              targetIds: ["codex"],
            })
            .pipe(Effect.flip);
          expect(error.reason).toBe("unsupported-transport");
        }),
      ),
    );
  });

  describe("local plugins", () => {
    // ZIP containing .codex-plugin/plugin.json and .app.json.
    const sample = Buffer.from(
      "UEsDBBQAAAAIACyVdV0a5BiqUwAAAF8AAAAZAAAALmNvZGV4LXBsdWdpbi9wbHVnaW4uanNvbqtWykvMTVWyUipOzC3ISVXSUSpLLSrOzM8DChnqGQD5iQUFxUCOnr4ekKWXVQyU0lHKzCtJLUpLTAbqrFZKySwuyEms9IMYFAw2SMGxoECpthYAUEsDBBQAAAAIACyVdV2EBe8UJgAAACoAAAAJAAAALmFwcC5qc29uq1ZKLCgoVrKqBtEgKjNFyUopsTglOx4oEJ9akZhbkJOqVFtbCwBQSwECFAAUAAAACAAslXVdGuQYqlMAAABfAAAAGQAAAAAAAAAAAAAAgAEAAAAALmNvZGV4LXBsdWdpbi9wbHVnaW4uanNvblBLAQIUABQAAAAIACyVdV2EBe8UJgAAACoAAAAJAAAAAAAAAAAAAACAAYoAAAAuYXBwLmpzb25QSwUGAAAAAAIAAgB+AAAA1wAAAAAA",
      "base64",
    );
    const traversal = Buffer.from(
      "UEsDBBQAAAAIAFOWdV2SClMNEwAAABEAAAAZAAAALmNvZGV4LXBsdWdpbi9wbHVnaW4uanNvbqtWykvMTVWyUirNK05MS1WqBQBQSwMEFAAAAAgAU5Z1XR8oqmcEAAAAAgAAAA4AAAAuLi9lc2NhcGVkLnR4dMvLBwBQSwECFAAUAAAACABTlnVdkgpTDRMAAAARAAAAGQAAAAAAAAAAAAAAgAEAAAAALmNvZGV4LXBsdWdpbi9wbHVnaW4uanNvblBLAQIUABQAAAAIAFOWdV0fKKpnBAAAAAIAAAAOAAAAAAAAAAAAAACAAUoAAAAuLi9lc2NhcGVkLnR4dFBLBQYAAAAAAgACAIMAAAB6AAAAAAA=",
      "base64",
    );

    it.effect(
      "imports app-only Codex plugins without enabling them and rejects duplicates and unsafe archives",
      () =>
        withHome(({ join }) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const agentConfig = yield* AgentConfig.AgentConfig;
            expect(
              (yield* agentConfig.importPlugin({ archive: traversal }).pipe(Effect.flip)).reason,
            ).toBe("invalid-plugin-archive");
            yield* agentConfig.importPlugin({ archive: sample });
            expect(
              (yield* agentConfig.importPlugin({ archive: sample }).pipe(Effect.flip)).reason,
            ).toBe("plugin-already-imported");
            expect((yield* agentConfig.list).plugins).toEqual([
              {
                name: "sample",
                version: "1.0",
                displayName: "Sample App",
                description: null,
                enabledIn: [],
              },
            ]);
            expect(yield* fs.exists(join(".codex", "config.toml"))).toBe(false);
            yield* agentConfig.removePlugin({ name: "sample" });
            expect((yield* agentConfig.list).plugins).toEqual([]);
          }),
        ),
    );
  });

  describe("stale MCP paths", () => {
    it.effect(
      "proposes the newest sibling install with the same layout and repairs on confirm",
      () =>
        withHome(({ join }) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const agentConfig = yield* AgentConfig.AgentConfig;
            const install = (name: string, modified: number) =>
              Effect.gen(function* () {
                yield* fs.makeDirectory(join("runtimes", name, "bin"), { recursive: true });
                yield* fs.writeFileString(join("runtimes", name, "bin", "repl.exe"), "");
                yield* fs.writeFileString(join("runtimes", name, "bin", "node.exe"), "");
                yield* fs.utimes(join("runtimes", name), modified, modified);
              });
            yield* install("34ab3e1324cc55b5", 1_000);
            yield* install("8dbccda2214d0643", 2_000);
            // Newer, but without the layout the entry needs, or not shaped like a version.
            yield* fs.makeDirectory(join("runtimes", "5b9024f90663758b"), { recursive: true });
            yield* fs.utimes(join("runtimes", "5b9024f90663758b"), 3_000, 3_000);
            yield* fs.makeDirectory(join("runtimes", "current", "bin"), { recursive: true });
            yield* fs.writeFileString(join("runtimes", "current", "bin", "repl.exe"), "");
            yield* fs.writeFileString(join("runtimes", "current", "bin", "node.exe"), "");

            const stale = join("runtimes", "22cfb1d302613eae");
            const fresh = join("runtimes", "8dbccda2214d0643");
            const inFresh = (...parts: ReadonlyArray<string>) =>
              join("runtimes", "8dbccda2214d0643", ...parts);
            const listSeparator = (yield* HostProcess.Platform) === "win32" ? ";" : ":";
            yield* fs.makeDirectory(join(".codex"), { recursive: true });
            yield* fs.writeFileString(
              join(".codex", "config.toml"),
              [
                "[mcp_servers.repl]",
                `command = '${join("runtimes", "22cfb1d302613eae", "bin", "repl.exe")}'`,
                'env_vars = ["PIPE_ID"]',
                "startup_timeout_sec = 120",
                "",
                "[mcp_servers.repl.env]",
                `REPL_NODE = '${join("runtimes", "22cfb1d302613eae", "bin", "node.exe")}'`,
                `TRUSTED = '${join("trusted")}${listSeparator}${join("runtimes", "22cfb1d302613eae", "bin")}'`,
                `LOG_FILE = '${join("repl.log")}'`,
                'TOKEN = "secret"',
                "",
                "[mcp_servers.gone]",
                `command = '${join("tools", "v1.2.0", "gone.exe")}'`,
                "",
              ].join("\n"),
            );
            yield* fs.makeDirectory(join("trusted"));

            const before = yield* agentConfig.list;
            expect(before.mcpProblems).toEqual([
              {
                name: "repl",
                targetId: "codex",
                issues: [
                  {
                    field: "command",
                    kind: "missing",
                    path: join("runtimes", "22cfb1d302613eae", "bin", "repl.exe"),
                    repairedPath: inFresh("bin", "repl.exe"),
                  },
                  {
                    field: "env.REPL_NODE",
                    kind: "missing",
                    path: join("runtimes", "22cfb1d302613eae", "bin", "node.exe"),
                    repairedPath: inFresh("bin", "node.exe"),
                  },
                  {
                    field: "env.TRUSTED",
                    kind: "missing",
                    path: join("runtimes", "22cfb1d302613eae", "bin"),
                    repairedPath: inFresh("bin"),
                  },
                ],
                rewrites: [{ from: stale, to: fresh }],
              },
              {
                name: "gone",
                targetId: "codex",
                issues: [
                  {
                    field: "command",
                    kind: "missing",
                    path: join("tools", "v1.2.0", "gone.exe"),
                    repairedPath: null,
                  },
                ],
                rewrites: [],
              },
            ]);

            const refused = yield* agentConfig
              .repairMcpServer({
                name: "repl",
                targetId: "codex",
                rewrites: [{ from: stale, to: join("runtimes", "34ab3e1324cc55b5") }],
              })
              .pipe(Effect.flip);
            expect(refused.reason).toBe("repair-changed");

            yield* agentConfig.repairMcpServer({
              name: "repl",
              targetId: "codex",
              rewrites: [{ from: stale, to: fresh }],
            });
            const codex = yield* fs.readFileString(join(".codex", "config.toml"));
            expect(codex).not.toContain("22cfb1d302613eae");
            expect(codex).toContain('env_vars = [ "PIPE_ID" ]');
            expect(codex).toContain("startup_timeout_sec = 120");
            expect(codex).toContain('TOKEN = "secret"');
            expect(codex).toContain(`[mcp_servers.gone]`);
            const after = yield* agentConfig.list;
            expect(after.mcpProblems.map((problem) => problem.name)).toEqual(["gone"]);
            const repl = after.mcpServers.find((entry) => entry.name === "repl");
            expect(repl?.transport).toEqual({
              _tag: "stdio",
              command: inFresh("bin", "repl.exe"),
              args: [],
              env: {
                REPL_NODE: inFresh("bin", "node.exe"),
                TRUSTED: `${join("trusted")}${listSeparator}${inFresh("bin")}`,
                LOG_FILE: join("repl.log"),
                TOKEN: "secret",
              },
              cwd: null,
            });
          }),
        ),
    );
  });

  it.effect("copies skills between CLIs and keeps the last copy when turned off", () =>
    withHome(({ join }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const agentConfig = yield* AgentConfig.AgentConfig;
        const claudeSkill = join(".claude", "skills", "review");
        yield* fs.makeDirectory(claudeSkill, { recursive: true });
        yield* fs.writeFileString(
          join(".claude", "skills", "review", "SKILL.md"),
          "---\nname: review\ndescription: Review a diff.\n---\n",
        );
        // Codex's bundled skills live in a dot folder and are not the user's to manage.
        yield* fs.makeDirectory(join(".codex", "skills", ".system", "x"), { recursive: true });
        yield* fs.writeFileString(join(".codex", "skills", ".system", "x", "SKILL.md"), "# x");

        yield* agentConfig.setSkillEnabled({ name: "review", targetId: "codex", enabled: true });
        expect(yield* fs.readFileString(join(".codex", "skills", "review", "SKILL.md"))).toContain(
          "Review a diff.",
        );

        yield* agentConfig.setSkillEnabled({
          name: "review",
          targetId: "claudeAgent",
          enabled: false,
        });
        yield* agentConfig.setSkillEnabled({ name: "review", targetId: "codex", enabled: false });
        const off = (yield* agentConfig.list).skills;
        expect(off).toEqual([
          {
            name: "review",
            description: "Review a diff.",
            locations: [],
            libraryPath: join("t3", "userdata", "agent-config", "skills", "review"),
          },
        ]);

        yield* agentConfig.setSkillEnabled({ name: "review", targetId: "cursor", enabled: true });
        const on = (yield* agentConfig.list).skills;
        expect(
          on.map((skill) => [skill.locations.map((l) => l.targetId), skill.libraryPath]),
        ).toEqual([[["cursor"], null]]);
      }),
    ),
  );
});
