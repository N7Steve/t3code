import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

/**
 * MCP servers and skills in the provider CLIs' own config files on one environment's machine.
 * Each target is one config location: a driver's default home, or an instance's own home.
 */
export const AgentConfigTargetId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export type AgentConfigTargetId = typeof AgentConfigTargetId.Type;

export const AgentMcpServerName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[^\s"'\\/[\]{}]+$/),
);
export type AgentMcpServerName = typeof AgentMcpServerName.Type;

const StringMap = Schema.Record(Schema.String, Schema.String);

export const AgentMcpTransportKind = Schema.Literals(["stdio", "http", "sse"]);
export type AgentMcpTransportKind = typeof AgentMcpTransportKind.Type;

export const AgentMcpTransport = Schema.Union([
  Schema.TaggedStruct("stdio", {
    command: TrimmedNonEmptyString,
    args: Schema.Array(Schema.String),
    env: StringMap,
    cwd: Schema.NullOr(TrimmedNonEmptyString),
  }),
  Schema.TaggedStruct("http", { url: TrimmedNonEmptyString, headers: StringMap }),
  Schema.TaggedStruct("sse", { url: TrimmedNonEmptyString, headers: StringMap }),
]);
export type AgentMcpTransport = typeof AgentMcpTransport.Type;

/** Connectors are remote MCP servers: the same entries, filtered by transport. */
export const isAgentMcpConnector = (transport: AgentMcpTransport) => transport._tag !== "stdio";

export const AgentConfigTarget = Schema.Struct({
  id: AgentConfigTargetId,
  driver: ProviderDriverKind,
  /** Instance display name when several targets share a driver; otherwise null. */
  instanceLabel: Schema.NullOr(TrimmedNonEmptyString),
  /** Null when T3 Code does not manage this driver's MCP servers. */
  mcpConfigPath: Schema.NullOr(Schema.String),
  mcpTransports: Schema.Array(AgentMcpTransportKind),
  /** Null when T3 Code does not manage this driver's skills. */
  skillsDirectory: Schema.NullOr(Schema.String),
  /** The MCP config exists but could not be parsed, so nothing is written to it. */
  mcpConfigUnreadable: Schema.Boolean,
});
export type AgentConfigTarget = typeof AgentConfigTarget.Type;

const AgentMcpDefinition = Schema.Struct({
  targetId: AgentConfigTargetId,
  transport: AgentMcpTransport,
});

export const AgentMcpServer = Schema.Struct({
  name: Schema.String,
  transport: AgentMcpTransport,
  /** Targets whose config defines and enables this server. */
  enabledIn: Schema.Array(AgentConfigTargetId),
  /** Targets disagree on its definition; `transport` is the first one found. */
  divergent: Schema.Boolean,
  /** Enabled definitions when the CLIs disagree. */
  definitions: Schema.optional(Schema.Array(AgentMcpDefinition)),
});
export type AgentMcpServer = typeof AgentMcpServer.Type;

/**
 * One stale path in an enabled stdio entry: `missing` is an absolute path that no longer exists,
 * `not-on-path` a bare command the environment's PATH does not resolve.
 */
export const AgentMcpPathIssue = Schema.Struct({
  /** `command`, `cwd`, `args[1]` or `env.NAME`. */
  field: Schema.String,
  kind: Schema.Literals(["missing", "not-on-path"]),
  path: Schema.String,
  /** The existing path a repair writes instead, or null when none was found. */
  repairedPath: Schema.NullOr(Schema.String),
});
export type AgentMcpPathIssue = typeof AgentMcpPathIssue.Type;

/** Swaps a missing version directory for an existing sibling with the same layout. */
export const AgentMcpPathRewrite = Schema.Struct({ from: Schema.String, to: Schema.String });
export type AgentMcpPathRewrite = typeof AgentMcpPathRewrite.Type;

export const AgentMcpProblem = Schema.Struct({
  name: Schema.String,
  targetId: AgentConfigTargetId,
  issues: Schema.Array(AgentMcpPathIssue),
  /** Empty when nothing can be repaired automatically. */
  rewrites: Schema.Array(AgentMcpPathRewrite),
});
export type AgentMcpProblem = typeof AgentMcpProblem.Type;

export const AgentSkillLocation = Schema.Struct({
  targetId: AgentConfigTargetId,
  path: Schema.String,
});
export type AgentSkillLocation = typeof AgentSkillLocation.Type;

export const AgentSkill = Schema.Struct({
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  locations: Schema.Array(AgentSkillLocation),
  /** T3 Code's copy, kept when the skill was turned off everywhere so it can return. */
  libraryPath: Schema.NullOr(Schema.String),
});
export type AgentSkill = typeof AgentSkill.Type;

const AgentPluginName = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/));
const AgentPlugin = Schema.Struct({
  name: AgentPluginName,
  displayName: Schema.String,
  description: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  enabledIn: Schema.Array(AgentConfigTargetId),
});
export type AgentPlugin = typeof AgentPlugin.Type;

export const AgentConfigSnapshot = Schema.Struct({
  targets: Schema.Array(AgentConfigTarget),
  /** Drivers whose MCP servers and skills this manager does not edit. */
  unsupportedDrivers: Schema.Array(ProviderDriverKind),
  mcpServers: Schema.Array(AgentMcpServer),
  /** Enabled entries whose command or paths are missing on this machine. */
  mcpProblems: Schema.Array(AgentMcpProblem),
  skills: Schema.Array(AgentSkill),
  plugins: Schema.optional(Schema.Array(AgentPlugin)),
});
export type AgentConfigSnapshot = typeof AgentConfigSnapshot.Type;

export const AgentConfigUpsertMcpServerInput = Schema.Struct({
  name: AgentMcpServerName,
  /** Set when renaming; the old name is removed from every target. */
  previousName: Schema.optional(Schema.String),
  transport: AgentMcpTransport,
  /** Exactly the targets that should have it enabled afterwards. */
  targetIds: Schema.Array(AgentConfigTargetId),
});
export type AgentConfigUpsertMcpServerInput = typeof AgentConfigUpsertMcpServerInput.Type;

export const AgentConfigSetEnabledInput = Schema.Struct({
  name: Schema.String,
  targetId: AgentConfigTargetId,
  enabled: Schema.Boolean,
});
export type AgentConfigSetEnabledInput = typeof AgentConfigSetEnabledInput.Type;

export const AgentConfigRemoveInput = Schema.Struct({ name: Schema.String });
export type AgentConfigRemoveInput = typeof AgentConfigRemoveInput.Type;

export const AgentConfigRepairMcpServerInput = Schema.Struct({
  name: Schema.String,
  targetId: AgentConfigTargetId,
  /** The rewrites the user confirmed; refused if a fresh check proposes others. */
  rewrites: Schema.Array(AgentMcpPathRewrite),
});
export type AgentConfigRepairMcpServerInput = typeof AgentConfigRepairMcpServerInput.Type;

export const AgentConfigSyncMcpServerInput = Schema.Struct({
  name: Schema.String,
  sourceTargetId: AgentConfigTargetId,
  definitions: Schema.Array(AgentMcpDefinition),
});
export type AgentConfigSyncMcpServerInput = typeof AgentConfigSyncMcpServerInput.Type;

export const AGENT_PLUGIN_ZIP_MAX_BYTES = 8 * 1024 * 1024;
export const AgentConfigImportPluginInput = Schema.Struct({
  archive: Schema.Uint8ArrayFromBase64.check(Schema.isMaxLength(AGENT_PLUGIN_ZIP_MAX_BYTES)),
});
export type AgentConfigImportPluginInput = typeof AgentConfigImportPluginInput.Type;

export const AgentConfigSetPluginEnabledInput = Schema.Struct({
  name: AgentPluginName,
  targetId: AgentConfigTargetId,
  enabled: Schema.Boolean,
});
export type AgentConfigSetPluginEnabledInput = typeof AgentConfigSetPluginEnabledInput.Type;

export const AgentConfigRemovePluginInput = Schema.Struct({ name: AgentPluginName });
export type AgentConfigRemovePluginInput = typeof AgentConfigRemovePluginInput.Type;

export const AgentConfigErrorReason = Schema.Literals([
  "unknown-target",
  "unsupported-transport",
  "not-found",
  "unreadable-config",
  "unsafe-edit",
  "io-failed",
  "repair-changed",
  "invalid-plugin-archive",
  "plugin-already-imported",
  "plugin-command-failed",
]);
export type AgentConfigErrorReason = typeof AgentConfigErrorReason.Type;

export class AgentConfigError extends Schema.TaggedError<AgentConfigError>()("AgentConfigError", {
  reason: AgentConfigErrorReason,
  targetId: Schema.optional(Schema.String),
  entryName: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "unknown-target":
        return `No agent config target named ${this.targetId ?? "(none)"} on this environment.`;
      case "unsupported-transport":
        return `${this.targetId ?? "This target"} does not support this MCP transport.`;
      case "not-found":
        return `${this.entryName ?? "The entry"} was not found.`;
      case "unreadable-config":
        return `${this.path ?? "The config file"} could not be parsed, so it was left unchanged.`;
      case "unsafe-edit":
        return `${this.entryName ?? "This entry"} is written in a form T3 Code cannot edit safely in ${this.path ?? "its config file"}. Edit that file by hand.`;
      case "io-failed":
        return `Could not update ${this.path ?? "the config file"}.`;
      case "repair-changed":
        return `${this.entryName ?? "This entry"} changed since it was checked. Review the repair again.`;
      case "invalid-plugin-archive":
        return "Choose a valid Codex plugin ZIP (up to 8 MB) with a .codex-plugin/plugin.json manifest.";
      case "plugin-already-imported":
        return `${this.entryName} is already in this environment's plugin library.`;
      case "plugin-command-failed":
        return `Codex could not update ${this.entryName ?? "the plugin"} in ${this.targetId}. Check that the Codex CLI is installed and supports local plugins.`;
    }
  }
}
