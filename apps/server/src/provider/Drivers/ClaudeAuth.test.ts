import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { makeClaudeAuth } from "./ClaudeAuth.ts";

it.effect("signs in through a terminal using the selected Claude instance's config", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const cwd = path.join(home, "t3-data");
    const instanceId = ProviderInstanceId.make("claude-mery");
    let input: PtyAdapter.PtySpawnInput | undefined;
    let onExit: ((event: PtyAdapter.PtyExitEvent) => void) | undefined;
    let refreshed = false;
    const auth = yield* makeClaudeAuth({
      instanceId,
      credentialKey: "claude:home:mery",
      settings: { binaryPath: "custom-claude", homePath: "~/.claude-mery" },
      cwd,
      environment: { CLAUDE_CONFIG_DIR: path.join(home, ".claude-personal"), KEEP: "1" },
      adapter: {
        spawn: (spawn) =>
          Effect.sync(() => {
            input = spawn;
            return {
              pid: 1,
              write: () => {},
              resize: () => {},
              kill: () => {},
              onData: () => () => {},
              onExit: (listener) => {
                onExit = listener;
                return () => {};
              },
            };
          }),
      },
      refresh: Effect.sync(() => {
        refreshed = true;
      }),
    });

    yield* auth.start("owner");
    const waiting = yield* auth.subscribe("owner").pipe(
      Stream.filter((state) => state.interaction?.type === "terminal"),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
    assert.equal(waiting.instanceId, instanceId);
    assert.equal(input?.shell, "custom-claude");
    assert.deepEqual(input?.args, ["auth", "login"]);
    assert.equal(input?.cwd, cwd);
    assert.deepEqual(input?.env, { CLAUDE_CONFIG_DIR: path.join(home, ".claude-mery"), KEEP: "1" });
    assert.isFalse(refreshed);

    assert.isFunction(onExit);
    onExit?.({ exitCode: 0, signal: null });
    yield* auth.subscribe("owner").pipe(
      Stream.filter((state) => state.phase === "succeeded"),
      Stream.runHead,
    );
    assert.isTrue(refreshed);
  }).pipe(
    Effect.scoped,
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);
