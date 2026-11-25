import {
  ProviderSetupError,
  type ClaudeSettings,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makeClaudeEnvironment } from "./ClaudeHome.ts";

export const makeClaudeAuth = Effect.fn("ClaudeAuth.make")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly credentialKey: string;
  readonly settings: Pick<ClaudeSettings, "binaryPath" | "homePath">;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly adapter: PtyAdapter.PtyAdapter["Service"];
  readonly refresh: Effect.Effect<void>;
}) {
  const env = yield* makeClaudeEnvironment(options.settings, options.environment);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const logout = Effect.fn("ClaudeAuth.logout")(function* () {
    const failure = () =>
      new ProviderSetupError({
        instanceId: options.instanceId,
        operation: "logout",
        detail: "Claude Code could not sign out.",
      });
    const command = yield* resolveSpawnCommand(options.settings.binaryPath, ["auth", "logout"], {
      env,
    });
    const code = yield* spawner
      .exitCode(
        ChildProcess.make(command.command, command.args, {
          cwd: options.cwd,
          env,
          shell: command.shell,
        }),
      )
      .pipe(Effect.mapError(failure));
    if (code !== 0) return yield* failure();
    yield* options.refresh;
  });
  return yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: { owner: "provider", key: options.credentialKey },
    methods: Effect.succeed([
      { id: "claude", name: "Claude", description: null, type: "terminal" },
    ]),
    authenticate: Effect.fn("ClaudeAuth.authenticate")(function* (_, context) {
      const command = yield* resolveSpawnCommand(options.settings.binaryPath, ["auth", "login"], {
        env,
        bypassNpmShim: true,
      });
      // Pass the escaped batch command verbatim so ConPTY does not apply executable-argument quoting.
      const shell = command.shell ? (env.ComSpec ?? env.COMSPEC ?? "cmd.exe") : command.command;
      const args = command.shell ? `/d /s /c "${command.command}"` : [...command.args];
      yield* ProviderAuthFlow.runTerminal({
        instanceId: options.instanceId,
        adapter: options.adapter,
        spawn: { shell, args, cwd: options.cwd, cols: 80, rows: 24, env },
        context,
        exitDetail: () => "Claude Code did not finish signing in.",
      }).pipe(Effect.scoped);
      yield* context.verifying;
      yield* options.refresh;
    }),
    logout: logout(),
  });
});
