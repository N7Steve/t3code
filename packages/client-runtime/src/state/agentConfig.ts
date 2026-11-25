import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom, AtomRegistry } from "effect/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as Persistence from "../platform/persistence.ts";

/**
 * MCP servers and skills in the provider CLIs' config files on one environment's machine. One
 * query carries all of it; every edit refreshes it, since the CLIs also write those files.
 */
export function createAgentConfigEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  const snapshot = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:agent-config:list",
    tag: WS_METHODS.agentConfigList,
  });
  const edit = {
    scheduler: commandScheduler,
    // Edits read and rewrite the same files, so one environment's edits run one at a time.
    concurrency: {
      mode: "serial" as const,
      key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
    },
    onSettled: (
      target: { readonly environmentId: EnvironmentId },
      registry: AtomRegistry.AtomRegistry,
    ) =>
      Effect.sync(() =>
        registry.refresh(snapshot({ environmentId: target.environmentId, input: {} })),
      ),
  };
  return {
    snapshot,
    upsertMcpServer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agent-config:upsert-mcp-server",
      tag: WS_METHODS.agentConfigUpsertMcpServer,
      ...edit,
    }),
    setMcpServerEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agent-config:set-mcp-server-enabled",
      tag: WS_METHODS.agentConfigSetMcpServerEnabled,
      ...edit,
    }),
    removeMcpServer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agent-config:remove-mcp-server",
      tag: WS_METHODS.agentConfigRemoveMcpServer,
      ...edit,
    }),
    repairMcpServer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agent-config:repair-mcp-server",
      tag: WS_METHODS.agentConfigRepairMcpServer,
      ...edit,
    }),
    setSkillEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agent-config:set-skill-enabled",
      tag: WS_METHODS.agentConfigSetSkillEnabled,
      ...edit,
    }),
    syncMcpServer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agent-config:sync-mcp-server",
      tag: WS_METHODS.agentConfigSyncMcpServer,
      ...edit,
    }),
    importPlugin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agent-config:import-plugin",
      tag: WS_METHODS.agentConfigImportPlugin,
      ...edit,
    }),
    setPluginEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agent-config:set-plugin-enabled",
      tag: WS_METHODS.agentConfigSetPluginEnabled,
      ...edit,
    }),
    removePlugin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agent-config:remove-plugin",
      tag: WS_METHODS.agentConfigRemovePlugin,
      ...edit,
    }),
    removeSkill: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agent-config:remove-skill",
      tag: WS_METHODS.agentConfigRemoveSkill,
      ...edit,
    }),
  };
}
