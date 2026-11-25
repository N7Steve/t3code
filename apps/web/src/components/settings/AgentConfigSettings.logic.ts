import {
  PROVIDER_DISPLAY_NAMES,
  type AgentConfigTarget,
  type AgentMcpServer,
  type AgentMcpTransport,
  type AgentMcpTransportKind,
} from "@t3tools/contracts";

export type AgentConfigTab = "servers" | "connectors" | "skills" | "plugins";

/** Settings search anchors, one per tab, so a search result opens its tab. */
export const AGENT_CONFIG_TAB_TARGETS = {
  servers: "mcp-servers",
  connectors: "mcp-connectors",
  skills: "agent-skills",
  plugins: "agent-plugins",
} as const satisfies Record<AgentConfigTab, string>;

export function agentConfigTabForTarget(targetId: string | null): AgentConfigTab | null {
  const entry = Object.entries(AGENT_CONFIG_TAB_TARGETS).find(([, id]) => id === targetId);
  return entry ? (entry[0] as AgentConfigTab) : null;
}

export function agentConfigTargetLabel(target: AgentConfigTarget): string {
  const driver = PROVIDER_DISPLAY_NAMES[target.driver] ?? target.driver;
  return target.instanceLabel ? `${driver} · ${target.instanceLabel}` : driver;
}

export function mcpTransportSummary(transport: AgentMcpTransport): string {
  return transport._tag === "stdio"
    ? [transport.command, ...transport.args].join(" ")
    : transport.url;
}

interface KeyValueDraft {
  readonly key: string;
  readonly value: string;
}

export interface McpServerDraft {
  readonly name: string;
  readonly kind: AgentMcpTransportKind;
  readonly command: string;
  /** One argument per line, so arguments with spaces need no quoting. */
  readonly args: string;
  readonly cwd: string;
  readonly url: string;
  /** Environment variables for a command, headers for a remote server. */
  readonly pairs: ReadonlyArray<KeyValueDraft>;
  readonly targetIds: ReadonlyArray<string>;
}

export function mcpServerDraft(
  server: AgentMcpServer | null,
  defaultTargetIds: ReadonlyArray<string>,
  kind: AgentMcpTransportKind = "stdio",
): McpServerDraft {
  const transport = server?.transport;
  const pairs = transport ? (transport._tag === "stdio" ? transport.env : transport.headers) : {};
  return {
    name: server?.name ?? "",
    kind: transport?._tag ?? kind,
    command: transport?._tag === "stdio" ? transport.command : "",
    args: transport?._tag === "stdio" ? transport.args.join("\n") : "",
    cwd: transport?._tag === "stdio" ? (transport.cwd ?? "") : "",
    url: transport && transport._tag !== "stdio" ? transport.url : "",
    pairs: Object.entries(pairs).map(([key, value]) => ({ key, value })),
    targetIds: server ? server.enabledIn : defaultTargetIds,
  };
}

// The same characters the server's name schema refuses: they break one of the CLIs' config keys.
const INVALID_NAME = /[\s"'\\/[\]{}]/;

export function isValidMcpServerName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= 128 && !INVALID_NAME.test(trimmed);
}

/** The transport a draft describes, or null while a required field is empty. Blank keys drop out. */
export function mcpTransportFromDraft(draft: McpServerDraft): AgentMcpTransport | null {
  const pairs = Object.fromEntries(
    draft.pairs.flatMap((pair) => (pair.key.trim() ? [[pair.key.trim(), pair.value]] : [])),
  );
  if (draft.kind === "stdio") {
    const command = draft.command.trim();
    if (!command) return null;
    return {
      _tag: "stdio",
      command,
      args: draft.args
        .split(/\r?\n/)
        .map((arg) => arg.trim())
        .filter((arg) => arg.length > 0),
      env: pairs,
      cwd: draft.cwd.trim() || null,
    };
  }
  const url = draft.url.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return null;
  return { _tag: draft.kind, url, headers: pairs };
}

export function matchesSkillQuery(
  skill: { readonly name: string; readonly description: string | null },
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    skill.name.toLowerCase().includes(needle) ||
    (skill.description?.toLowerCase().includes(needle) ?? false)
  );
}
