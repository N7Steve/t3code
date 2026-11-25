import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  AGENT_PLUGIN_ZIP_MAX_BYTES,
  AuthOrchestrationOperateScope,
  PROVIDER_DISPLAY_NAMES,
  isAgentMcpConnector,
  type AgentConfigSnapshot,
  type AgentConfigTarget,
  type AgentMcpProblem,
  type AgentMcpServer,
  type AgentPlugin,
  type AgentSkill,
  type EnvironmentId,
} from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";
import {
  AlertTriangleIcon,
  FolderOpenIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  UploadIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { useId, useState } from "react";

import { useOpenInPreferredEditor } from "../../editorPreferences";
import { agentConfigEnvironment } from "../../state/agentConfig";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Label } from "../ui/label";
import { Radio, RadioGroup } from "../ui/radio-group";
import { RefreshIcon } from "../ui/refresh-icon";
import { Skeleton } from "../ui/skeleton";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  AGENT_CONFIG_TAB_TARGETS,
  agentConfigTabForTarget,
  agentConfigTargetLabel,
  isValidMcpServerName,
  matchesSkillQuery,
  mcpServerDraft,
  mcpTransportFromDraft,
  mcpTransportSummary,
  type AgentConfigTab,
  type McpServerDraft,
} from "./AgentConfigSettings.logic";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SettingsPageContainer,
  SettingsSection,
  useSettingsSearchTargetId,
} from "./settingsLayout";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";

// Identifiers, not copy: an env variable and an HTTP header name.
const ENV_PLACEHOLDER = "API_KEY";
const HEADER_PLACEHOLDER = "Authorization";

export function AgentConfigSettingsPanel() {
  return (
    <SettingsPageContainer>
      <AgentConfigContent />
    </SettingsPageContainer>
  );
}

function AgentConfigContent() {
  const gt = useGT();
  const { environment, environments } = useSettingsScope();
  const environmentId =
    environment?.connection.phase === "connected" ? environment.environmentId : null;
  const environmentLabel = environment
    ? settingsScopeEnvironmentLabel(environment, environments)
    : null;
  const query = useEnvironmentQuery(
    environmentId === null ? null : agentConfigEnvironment.snapshot({ environmentId, input: {} }),
    useMessages(),
  );
  const canManage = useAtomValue(
    agentConfigEnvironment.upsertMcpServer.permissionAtom(environmentId),
  );

  // A search result for another tab's anchor switches to it, even while the page is open.
  const targetTab = agentConfigTabForTarget(useSettingsSearchTargetId());
  const [tab, setTab] = useState<AgentConfigTab>(targetTab ?? "servers");
  const [lastTargetTab, setLastTargetTab] = useState(targetTab);
  if (targetTab !== lastTargetTab) {
    setLastTargetTab(targetTab);
    if (targetTab !== null) setTab(targetTab);
  }
  const [editing, setEditing] = useState<{ readonly server: AgentMcpServer | null } | null>(null);
  const [importEnvironmentId, setImportEnvironmentId] = useState<EnvironmentId | null>(null);

  const title = gt("MCP & skills");
  if (environmentId === null || environmentLabel === null) {
    return (
      <SettingsSection id={AGENT_CONFIG_TAB_TARGETS[tab]} title={title}>
        <p className="px-4 py-3 text-sm text-muted-foreground">
          <T>Connect an environment to manage its agents' MCP servers and skills.</T>
        </p>
      </SettingsSection>
    );
  }
  const snapshot = query.data;
  const tabs = (
    <ToggleGroup
      aria-label={gt("MCP & skills view")}
      variant="segmented"
      value={[tab]}
      onValueChange={(next) => {
        const value = next[0];
        if (
          value === "servers" ||
          value === "connectors" ||
          value === "skills" ||
          value === "plugins"
        )
          setTab(value);
      }}
    >
      <Toggle value="servers">
        <T>MCP servers</T>
      </Toggle>
      <Toggle value="connectors">
        <T>Connectors</T>
      </Toggle>
      <Toggle value="skills">
        <T>Skills</T>
      </Toggle>
      {snapshot?.plugins === undefined ? null : (
        <Toggle value="plugins">
          <T>Plugins</T>
        </Toggle>
      )}
    </ToggleGroup>
  );

  return (
    <>
      <SettingsSection
        id={AGENT_CONFIG_TAB_TARGETS[tab]}
        title={title}
        headerAction={
          <div className="flex items-center gap-1">
            {tab === "plugins" ? (
              <Button
                size="xs"
                variant="outline"
                disabled={!canManage || snapshot?.plugins === undefined}
                onClick={() => setImportEnvironmentId(environmentId)}
              >
                <UploadIcon />
                <T>Import ZIP</T>
              </Button>
            ) : tab === "skills" ? null : (
              <Button
                size="xs"
                variant="outline"
                disabled={!canManage || snapshot === null}
                onClick={() => setEditing({ server: null })}
              >
                <PlusIcon />
                {tab === "connectors" ? <T>Add connector</T> : <T>Add server</T>}
              </Button>
            )}
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={gt("Reload from config files")}
              disabled={query.isPending}
              onClick={query.refresh}
            >
              <RefreshIcon refreshing={query.isPending} />
            </Button>
          </div>
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-3 sm:px-4">
          {tabs}
          <p className="text-xs text-muted-foreground">
            <T>
              Edits each CLI's own config files on <Var>{environmentLabel}</Var>, keeping a backup
              beside each file it changes.
            </T>
          </p>
        </div>
        {snapshot === null ? (
          query.error === null ? (
            <div className="grid gap-2 px-4 py-3">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <p className="text-sm text-destructive">{query.error}</p>
              <Button size="xs" variant="outline" onClick={query.refresh}>
                <T>Retry</T>
              </Button>
            </div>
          )
        ) : tab === "plugins" ? (
          <PluginList
            key={environmentId}
            environmentId={environmentId}
            snapshot={snapshot}
            canManage={canManage}
          />
        ) : tab === "skills" ? (
          <SkillList
            environmentId={environmentId}
            environmentLabel={environmentLabel}
            snapshot={snapshot}
            canManage={canManage}
          />
        ) : (
          <McpServerList
            key={environmentId}
            environmentId={environmentId}
            environmentLabel={environmentLabel}
            snapshot={snapshot}
            connectors={tab === "connectors"}
            canManage={canManage}
            onEdit={(server) => setEditing({ server })}
          />
        )}
      </SettingsSection>
      {snapshot === null ? null : (
        <ConfigFilesSection environmentId={environmentId} snapshot={snapshot} />
      )}
      {editing === null || snapshot === null ? null : (
        <McpServerDialog
          key={editing.server?.name ?? "new"}
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          snapshot={snapshot}
          server={editing.server}
          defaultKind={tab === "connectors" ? "http" : "stdio"}
          onClose={() => setEditing(null)}
        />
      )}
      {importEnvironmentId === environmentId ? (
        <PluginImportDialog
          key={environmentId}
          environmentId={environmentId}
          onClose={() => setImportEnvironmentId(null)}
        />
      ) : null}
    </>
  );
}

type CommandResult = AtomCommandResult<unknown, unknown>;

/** Runs one edit at a time for a row and keeps its failure beside the row. */
function useRowCommand() {
  const gt = useGT();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const run = async (action: () => Promise<CommandResult>) => {
    setBusy(true);
    setFailure(null);
    const result = await action();
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setFailure(error instanceof Error ? error.message : gt("The request failed."));
    }
    return result;
  };
  return { busy, failure, run };
}

function TargetPill({
  target,
  pressed,
  disabled,
  reason,
  onPressedChange,
}: {
  readonly target: AgentConfigTarget;
  readonly pressed: boolean;
  readonly disabled: boolean;
  readonly reason: string | null;
  readonly onPressedChange: (pressed: boolean) => void;
}) {
  const label = agentConfigTargetLabel(target);
  return (
    <Toggle
      variant="outline"
      size="xs"
      pressed={pressed}
      disabled={disabled}
      onPressedChange={onPressedChange}
      title={reason ?? undefined}
      aria-label={label}
    >
      <ProviderInstanceIcon driverKind={target.driver} displayName={label} size="compact" />
      <span>{label}</span>
    </Toggle>
  );
}

function McpServerList({
  environmentId,
  environmentLabel,
  snapshot,
  connectors,
  canManage,
  onEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly snapshot: AgentConfigSnapshot;
  readonly connectors: boolean;
  readonly canManage: boolean;
  readonly onEdit: (server: AgentMcpServer) => void;
}) {
  const servers = snapshot.mcpServers.filter(
    (server) => isAgentMcpConnector(server.transport) === connectors,
  );
  if (servers.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-sm text-muted-foreground">
        {connectors ? (
          <T>No connectors yet. Connectors are remote MCP servers reached by URL.</T>
        ) : (
          <T>No MCP servers in these CLIs' config files yet.</T>
        )}
      </p>
    );
  }
  return servers.map((server) => (
    <McpServerRow
      key={server.name}
      environmentId={environmentId}
      environmentLabel={environmentLabel}
      snapshot={snapshot}
      server={server}
      canManage={canManage}
      onEdit={() => onEdit(server)}
    />
  ));
}

function McpServerRow({
  environmentId,
  environmentLabel,
  snapshot,
  server,
  canManage,
  onEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly snapshot: AgentConfigSnapshot;
  readonly server: AgentMcpServer;
  readonly canManage: boolean;
  readonly onEdit: () => void;
}) {
  const gt = useGT();
  const { busy, failure, run } = useRowCommand();
  const setEnabled = useAtomCommand(agentConfigEnvironment.setMcpServerEnabled, {
    reportFailure: false,
  });
  const remove = useAtomCommand(agentConfigEnvironment.removeMcpServer, { reportFailure: false });
  const [confirming, setConfirming] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [syncing, setSyncing] = useState<AgentMcpServer["definitions"]>();
  const problems = snapshot.mcpProblems.filter((problem) => problem.name === server.name);
  const transportLabel =
    server.transport._tag === "stdio" ? gt("Command") : server.transport._tag.toUpperCase();

  return (
    <div className="flex items-start justify-between gap-3 px-3 py-3 sm:px-4">
      <div className="min-w-0 flex-1 space-y-2">
        <div className="space-y-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate font-ident text-sm font-medium text-foreground">
              {server.name}
            </span>
            <Badge variant="outline" size="sm">
              {transportLabel}
            </Badge>
            {server.divergent ? (
              <Badge variant="warning" size="sm">
                <T>Differs between CLIs</T>
              </Badge>
            ) : null}
            {server.definitions === undefined ? null : (
              <Button
                size="xs"
                variant="outline"
                disabled={!canManage || busy}
                onClick={() => setSyncing(server.definitions)}
              >
                <T>Sync CLIs</T>
              </Button>
            )}
            {problems.length > 0 ? (
              <Badge variant="warning" size="sm">
                <AlertTriangleIcon />
                <T>Missing files</T>
              </Badge>
            ) : null}
          </div>
          <p className="truncate font-ident text-xs text-muted-foreground">
            {mcpTransportSummary(server.transport)}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {snapshot.targets
            .filter((target) => target.mcpConfigPath !== null)
            .map((target) => {
              const supported = target.mcpTransports.includes(server.transport._tag);
              const reason = target.mcpConfigUnreadable
                ? gt("This CLI's config file could not be parsed.")
                : supported
                  ? null
                  : gt("This CLI cannot run this kind of server.");
              const enabled = server.enabledIn.includes(target.id);
              return (
                <TargetPill
                  key={target.id}
                  target={target}
                  pressed={enabled}
                  disabled={!canManage || busy || (!enabled && reason !== null)}
                  reason={reason}
                  onPressedChange={(pressed) =>
                    void run(() =>
                      setEnabled({
                        environmentId,
                        input: { name: server.name, targetId: target.id, enabled: pressed },
                      }),
                    )
                  }
                />
              );
            })}
        </div>
        {failure ? <p className="text-xs text-destructive">{failure}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {problems.length > 0 ? (
          <Button
            size="xs"
            variant="outline"
            disabled={!canManage || busy}
            onClick={() => setRepairing(true)}
          >
            <WrenchIcon />
            <T>Repair MCP</T>
          </Button>
        ) : null}
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={gt("Edit {name}", { name: server.name })}
          disabled={!canManage || busy}
          onClick={onEdit}
        >
          <PencilIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost-destructive"
          aria-label={gt("Remove {name}", { name: server.name })}
          disabled={!canManage || busy}
          onClick={() => setConfirming(true)}
        >
          <Trash2Icon />
        </Button>
      </div>
      {repairing ? (
        <McpRepairDialog
          environmentId={environmentId}
          snapshot={snapshot}
          name={server.name}
          problems={problems}
          onClose={() => setRepairing(false)}
        />
      ) : null}
      {syncing === undefined ? null : (
        <McpSyncDialog
          environmentId={environmentId}
          snapshot={snapshot}
          name={server.name}
          definitions={syncing}
          onClose={() => setSyncing(undefined)}
        />
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>
                Remove <Var>{server.name}</Var>?
              </T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                It is removed from every CLI's config file on <Var>{environmentLabel}</Var> and from
                this list. A backup of each changed file stays beside it.
              </T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirming(false);
                void run(() => remove({ environmentId, input: { name: server.name } }));
              }}
            >
              <T>Remove</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function McpSyncDialog({
  environmentId,
  snapshot,
  name,
  definitions,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: AgentConfigSnapshot;
  readonly name: string;
  readonly definitions: NonNullable<AgentMcpServer["definitions"]>;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const { busy, failure, run } = useRowCommand();
  const sync = useAtomCommand(agentConfigEnvironment.syncMcpServer, { reportFailure: false });
  const eligible = (definition: (typeof definitions)[number]) =>
    definitions.every(({ targetId }) =>
      snapshot.targets
        .find((target) => target.id === targetId)
        ?.mcpTransports.includes(definition.transport._tag),
    );
  const isMissingFiles = (targetId: string) =>
    snapshot.mcpProblems.some((problem) => problem.name === name && problem.targetId === targetId);
  const [source, setSource] = useState(
    () =>
      definitions.find((definition) => eligible(definition) && !isMissingFiles(definition.targetId))
        ?.targetId ?? definitions.find(eligible)?.targetId,
  );
  const confirm = async () => {
    if (source === undefined) return;
    const result = await run(() =>
      sync({
        environmentId,
        input: { name, sourceTargetId: source, definitions },
      }),
    );
    if (result._tag === "Success") onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            <T>
              Sync <Var>{name}</Var>
            </T>
          </DialogTitle>
          <DialogDescription>
            <T>Choose the configuration to copy to the other CLIs where this server is enabled.</T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <RadioGroup value={source} onValueChange={setSource} aria-label={gt("Source CLI")}>
            {definitions.map((definition) => {
              const target = snapshot.targets.find((entry) => entry.id === definition.targetId);
              return (
                <label key={definition.targetId} className="flex min-w-0 items-start gap-2 text-sm">
                  <Radio value={definition.targetId} disabled={busy || !eligible(definition)} />
                  <span className="grid min-w-0 gap-1">
                    <span>{target ? agentConfigTargetLabel(target) : definition.targetId}</span>
                    <span className="break-all font-ident text-xs text-muted-foreground">
                      {mcpTransportSummary(definition.transport)}
                    </span>
                    {!eligible(definition) ? (
                      <span className="text-xs text-muted-foreground">
                        <T>Some enabled CLIs cannot run this kind of server.</T>
                      </span>
                    ) : isMissingFiles(definition.targetId) ? (
                      <span className="text-xs text-muted-foreground">
                        <T>Missing files</T>
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </RadioGroup>
          {failure ? (
            <p role="alert" className="mt-3 text-xs text-destructive">
              {failure}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            <T>Cancel</T>
          </Button>
          <Button disabled={busy || source === undefined} onClick={() => void confirm()}>
            <T>Sync CLIs</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Shows what is missing per CLI and, on confirm, applies only the rewrites shown. */
function McpRepairDialog({
  environmentId,
  snapshot,
  name,
  problems,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: AgentConfigSnapshot;
  readonly name: string;
  readonly problems: ReadonlyArray<AgentMcpProblem>;
  readonly onClose: () => void;
}) {
  const { busy, failure, run } = useRowCommand();
  const repair = useAtomCommand(agentConfigEnvironment.repairMcpServer, { reportFailure: false });
  const repairable = problems.filter((problem) => problem.rewrites.length > 0);

  const confirm = async () => {
    for (const problem of repairable) {
      const result = await run(() =>
        repair({
          environmentId,
          input: { name, targetId: problem.targetId, rewrites: problem.rewrites },
        }),
      );
      if (result._tag === "Failure") return;
    }
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            <T>
              Repair <Var>{name}</Var>
            </T>
          </DialogTitle>
          <DialogDescription>
            <T>
              These paths no longer exist, so the server cannot start. A repair points each one at
              the newest install beside it that has the same files, and changes nothing else. A
              backup of each changed file stays beside it.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            {problems.map((problem) => {
              const target = snapshot.targets.find((entry) => entry.id === problem.targetId);
              const label = target ? agentConfigTargetLabel(target) : problem.targetId;
              return (
                <section key={problem.targetId} className="grid gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{label}</p>
                    <p className="truncate font-ident text-xs text-muted-foreground">
                      {target?.mcpConfigPath}
                    </p>
                  </div>
                  <ul className="grid gap-2">
                    {problem.issues.map((issue) => (
                      <li
                        key={`${issue.field}:${issue.path}`}
                        className="grid gap-0.5 font-ident text-xs break-all"
                      >
                        <span className="text-muted-foreground">{issue.field}</span>
                        <span className="text-destructive line-through">{issue.path}</span>
                        {issue.repairedPath !== null ? (
                          <span className="text-foreground">{issue.repairedPath}</span>
                        ) : (
                          <span className="font-sans text-muted-foreground">
                            {issue.kind === "not-on-path" ? (
                              <T>
                                Not found on this environment's PATH. Install it or edit the server.
                              </T>
                            ) : (
                              <T>
                                No replacement found. Reinstall what it runs or edit the server.
                              </T>
                            )}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
            <p className="text-xs text-muted-foreground">
              <T>
                If another app writes this entry, such as a CLI that registers its own servers, it
                may replace the repair the next time it runs.
              </T>
            </p>
            {failure ? <p className="text-sm text-destructive">{failure}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            <T>Cancel</T>
          </Button>
          <Button disabled={busy || repairable.length === 0} onClick={() => void confirm()}>
            <WrenchIcon />
            <T>Repair MCP</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function McpServerDialog({
  environmentId,
  environmentLabel,
  snapshot,
  server,
  defaultKind,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly snapshot: AgentConfigSnapshot;
  readonly server: AgentMcpServer | null;
  readonly defaultKind: "stdio" | "http";
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const formId = useId();
  const { busy, failure, run } = useRowCommand();
  const upsert = useAtomCommand(agentConfigEnvironment.upsertMcpServer, { reportFailure: false });
  // A new server starts on the CLIs that already have MCP servers turned on.
  const [draft, setDraft] = useState<McpServerDraft>(() =>
    mcpServerDraft(
      server,
      snapshot.targets
        .filter((target) =>
          snapshot.mcpServers.some((entry) => entry.enabledIn.includes(target.id)),
        )
        .map((target) => target.id),
      defaultKind,
    ),
  );
  const transport = mcpTransportFromDraft(draft);
  const nameValid = isValidMcpServerName(draft.name);
  const update = (patch: Partial<McpServerDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const targets = snapshot.targets.filter((target) => target.mcpConfigPath !== null);
  const supportedTargetIds = draft.targetIds.filter((id) =>
    targets.some((target) => target.id === id && target.mcpTransports.includes(draft.kind)),
  );
  const pairLabel = draft.kind === "stdio" ? gt("Environment variables") : gt("Headers");

  const save = async () => {
    if (transport === null || !nameValid) return;
    const result = await run(() =>
      upsert({
        environmentId,
        input: {
          name: draft.name.trim(),
          ...(server ? { previousName: server.name } : {}),
          transport,
          targetIds: supportedTargetIds,
        },
      }),
    );
    if (result._tag === "Success") onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {server ? (
              <T>
                Edit <Var>{server.name}</Var>
              </T>
            ) : (
              <T>Add an MCP server</T>
            )}
          </DialogTitle>
          <DialogDescription>
            <T>
              Saved to the config files of the CLIs you turn on, on <Var>{environmentLabel}</Var>.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor={`${formId}-name`}>
                <T>Name</T>
              </Label>
              <Input
                id={`${formId}-name`}
                value={draft.name}
                placeholder="github"
                autoFocus
                aria-invalid={draft.name.length > 0 && !nameValid}
                onChange={(event) => update({ name: event.target.value })}
              />
            </div>
            <ToggleGroup
              aria-label={gt("Transport")}
              variant="segmented"
              value={[draft.kind]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "stdio" || value === "http" || value === "sse")
                  update({ kind: value });
              }}
            >
              <Toggle value="stdio">
                <T>Command</T>
              </Toggle>
              <Toggle value="http">HTTP</Toggle>
              <Toggle value="sse">SSE</Toggle>
            </ToggleGroup>
            {draft.kind === "stdio" ? (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor={`${formId}-command`}>
                    <T>Command</T>
                  </Label>
                  <Input
                    id={`${formId}-command`}
                    value={draft.command}
                    placeholder="npx"
                    onChange={(event) => update({ command: event.target.value })}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={`${formId}-args`}>
                    <T>Arguments, one per line</T>
                  </Label>
                  <Textarea
                    id={`${formId}-args`}
                    value={draft.args}
                    placeholder={"-y\n@modelcontextprotocol/server-github"}
                    onChange={(event) => update({ args: event.target.value })}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={`${formId}-cwd`}>
                    <T>Working directory (optional, Codex and Cursor only)</T>
                  </Label>
                  <Input
                    id={`${formId}-cwd`}
                    value={draft.cwd}
                    onChange={(event) => update({ cwd: event.target.value })}
                  />
                </div>
              </>
            ) : (
              <div className="grid gap-1.5">
                <Label htmlFor={`${formId}-url`}>URL</Label>
                <Input
                  id={`${formId}-url`}
                  value={draft.url}
                  placeholder="https://example.com/mcp"
                  onChange={(event) => update({ url: event.target.value })}
                />
              </div>
            )}
            <fieldset className="grid gap-1.5">
              <legend className="mb-1.5 text-sm font-medium">{pairLabel}</legend>
              {draft.pairs.map((pair, index) => (
                // oxlint-disable-next-line react/no-array-index-key -- rows have no identity but their position while editing
                <div key={index} className="flex items-center gap-1.5">
                  <Input
                    aria-label={gt("Name")}
                    value={pair.key}
                    placeholder={draft.kind === "stdio" ? ENV_PLACEHOLDER : HEADER_PLACEHOLDER}
                    onChange={(event) =>
                      update({
                        pairs: draft.pairs.map((item, at) =>
                          at === index ? { ...item, key: event.target.value } : item,
                        ),
                      })
                    }
                  />
                  <Input
                    aria-label={gt("Value")}
                    value={pair.value}
                    onChange={(event) =>
                      update({
                        pairs: draft.pairs.map((item, at) =>
                          at === index ? { ...item, value: event.target.value } : item,
                        ),
                      })
                    }
                  />
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={gt("Remove row")}
                    onClick={() => update({ pairs: draft.pairs.filter((_, at) => at !== index) })}
                  >
                    <XIcon />
                  </Button>
                </div>
              ))}
              <div>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => update({ pairs: [...draft.pairs, { key: "", value: "" }] })}
                >
                  <PlusIcon />
                  {draft.kind === "stdio" ? <T>Add variable</T> : <T>Add header</T>}
                </Button>
              </div>
            </fieldset>
            <fieldset className="grid gap-1.5">
              <legend className="mb-1.5 text-sm font-medium">
                <T>Turn on for</T>
              </legend>
              <div className="flex flex-wrap gap-1.5">
                {targets.map((target) => {
                  const supported = target.mcpTransports.includes(draft.kind);
                  return (
                    <TargetPill
                      key={target.id}
                      target={target}
                      pressed={supported && draft.targetIds.includes(target.id)}
                      disabled={!supported || target.mcpConfigUnreadable}
                      reason={supported ? null : gt("This CLI cannot run this kind of server.")}
                      onPressedChange={(pressed) =>
                        update({
                          targetIds: pressed
                            ? [...draft.targetIds, target.id]
                            : draft.targetIds.filter((id) => id !== target.id),
                        })
                      }
                    />
                  );
                })}
              </div>
            </fieldset>
            {failure ? <p className="text-sm text-destructive">{failure}</p> : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            <T>Cancel</T>
          </Button>
          <Button type="submit" form={formId} disabled={busy || transport === null || !nameValid}>
            {server ? <T>Save</T> : <T>Add</T>}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function SkillList({
  environmentId,
  environmentLabel,
  snapshot,
  canManage,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly snapshot: AgentConfigSnapshot;
  readonly canManage: boolean;
}) {
  const gt = useGT();
  const [query, setQuery] = useState("");
  const skills = snapshot.skills.filter((skill) => matchesSkillQuery(skill, query));
  return (
    <>
      <div className="px-3 py-2 sm:px-4">
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            aria-label={gt("Search skills")}
            placeholder={gt("Search skills")}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            size="sm"
            type="search"
          />
        </InputGroup>
      </div>
      {skills.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">
          {snapshot.skills.length === 0 ? (
            <T>No skills in these CLIs' skill folders yet.</T>
          ) : (
            <T>No skills match.</T>
          )}
        </p>
      ) : (
        skills.map((skill) => (
          <SkillRow
            key={skill.name}
            environmentId={environmentId}
            environmentLabel={environmentLabel}
            snapshot={snapshot}
            skill={skill}
            canManage={canManage}
          />
        ))
      )}
    </>
  );
}

function PluginImportDialog({
  environmentId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const id = useId();
  const [file, setFile] = useState<File | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const { busy, failure, run } = useRowCommand();
  const importPlugin = useAtomCommand(agentConfigEnvironment.importPlugin, {
    reportFailure: false,
  });
  const tooLarge = file !== null && file.size > AGENT_PLUGIN_ZIP_MAX_BYTES;
  const pending = reading || busy;
  const error = tooLarge ? gt("Choose a ZIP file up to 8 MB.") : (readError ?? failure);

  const submit = async () => {
    if (file === null || tooLarge) return;
    setReading(true);
    setReadError(null);
    const buffer = await file.arrayBuffer().catch(() => null);
    setReading(false);
    if (buffer === null) {
      setReadError(gt("Could not read the ZIP file."));
      return;
    }
    const result = await run(() =>
      importPlugin({ environmentId, input: { archive: new Uint8Array(buffer) } }),
    );
    if (result._tag === "Success") onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            <T>Import Codex plugin</T>
          </DialogTitle>
          <DialogDescription>
            <T>Upload a plugin ZIP, then choose the Codex profiles where you want it enabled.</T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-2">
            <Label htmlFor={id}>
              <T>ZIP file</T>
            </Label>
            <Input
              id={id}
              type="file"
              accept=".zip,application/zip"
              disabled={pending}
              onChange={(event) => {
                setReadError(null);
                setFile(event.currentTarget.files?.item(0) ?? null);
              }}
            />
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            <T>Cancel</T>
          </Button>
          <Button disabled={pending || !file || tooLarge} onClick={() => void submit()}>
            <T>Import ZIP</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function PluginList({
  environmentId,
  snapshot,
  canManage,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: AgentConfigSnapshot;
  readonly canManage: boolean;
}) {
  if (snapshot.plugins === undefined || snapshot.plugins.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-sm text-muted-foreground">
        {snapshot.plugins === undefined ? (
          <T>Update the environment to manage plugins.</T>
        ) : (
          <T>No custom plugins imported.</T>
        )}
      </p>
    );
  }
  const targets = snapshot.targets.filter((target) => target.driver === "codex");
  return snapshot.plugins.map((plugin) => (
    <PluginRow
      key={plugin.name}
      environmentId={environmentId}
      targets={targets}
      plugin={plugin}
      canManage={canManage}
    />
  ));
}

function PluginRow({
  environmentId,
  targets,
  plugin,
  canManage,
}: {
  readonly environmentId: EnvironmentId;
  readonly targets: ReadonlyArray<AgentConfigTarget>;
  readonly plugin: AgentPlugin;
  readonly canManage: boolean;
}) {
  const gt = useGT();
  const { busy, failure, run } = useRowCommand();
  const [confirming, setConfirming] = useState(false);
  const setEnabled = useAtomCommand(agentConfigEnvironment.setPluginEnabled, {
    reportFailure: false,
  });
  const remove = useAtomCommand(agentConfigEnvironment.removePlugin, { reportFailure: false });
  return (
    <div className="flex items-start justify-between gap-3 px-3 py-3 sm:px-4">
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="break-all text-sm font-medium text-foreground">
            {plugin.displayName}
          </span>
          {plugin.version ? (
            <span className="text-xs text-muted-foreground">{plugin.version}</span>
          ) : null}
        </div>
        {plugin.description ? (
          <p className="text-xs text-muted-foreground">{plugin.description}</p>
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          {targets.map((target) => (
            <TargetPill
              key={target.id}
              target={target}
              pressed={plugin.enabledIn.includes(target.id)}
              disabled={!canManage || busy || target.mcpConfigUnreadable}
              reason={
                target.mcpConfigUnreadable
                  ? gt("This CLI's config file could not be parsed.")
                  : null
              }
              onPressedChange={(enabled) =>
                void run(() =>
                  setEnabled({
                    environmentId,
                    input: { name: plugin.name, targetId: target.id, enabled },
                  }),
                )
              }
            />
          ))}
        </div>
        {failure ? (
          <p role="alert" className="text-xs text-destructive">
            {failure}
          </p>
        ) : null}
      </div>
      <Button
        size="icon-xs"
        variant="ghost-destructive"
        aria-label={gt("Delete {name}", { name: plugin.displayName })}
        disabled={!canManage || busy}
        onClick={() => setConfirming(true)}
      >
        <Trash2Icon />
      </Button>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>
                Delete <Var>{plugin.displayName}</Var>?
              </T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                This uninstalls the plugin from Codex and removes it from this environment's
                library.
              </T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirming(false);
                void run(() => remove({ environmentId, input: { name: plugin.name } }));
              }}
            >
              <T>Delete</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function SkillRow({
  environmentId,
  environmentLabel,
  snapshot,
  skill,
  canManage,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly snapshot: AgentConfigSnapshot;
  readonly skill: AgentSkill;
  readonly canManage: boolean;
}) {
  const gt = useGT();
  const { busy, failure, run } = useRowCommand();
  const { environment } = useSettingsScope();
  const canOpen = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const openInEditor = useOpenInPreferredEditor(
    environmentId,
    environment?.serverConfig?.availableEditors ?? [],
  );
  const setEnabled = useAtomCommand(agentConfigEnvironment.setSkillEnabled, {
    reportFailure: false,
  });
  const remove = useAtomCommand(agentConfigEnvironment.removeSkill, { reportFailure: false });
  const [confirming, setConfirming] = useState(false);
  const folder = skill.locations[0]?.path ?? skill.libraryPath;

  return (
    <div className="flex items-start justify-between gap-3 px-3 py-3 sm:px-4">
      <div className="min-w-0 flex-1 space-y-2">
        <div className="space-y-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate font-ident text-sm font-medium text-foreground">
              {skill.name}
            </span>
            {skill.locations.length === 0 ? (
              <Badge variant="secondary" size="sm">
                <T>Off everywhere</T>
              </Badge>
            ) : null}
          </div>
          {skill.description ? (
            <p className="line-clamp-2 text-xs text-muted-foreground">{skill.description}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {snapshot.targets
            .filter((target) => target.skillsDirectory !== null)
            .map((target) => (
              <TargetPill
                key={target.id}
                target={target}
                pressed={skill.locations.some((location) => location.targetId === target.id)}
                disabled={!canManage || busy}
                reason={null}
                onPressedChange={(pressed) =>
                  void run(() =>
                    setEnabled({
                      environmentId,
                      input: { name: skill.name, targetId: target.id, enabled: pressed },
                    }),
                  )
                }
              />
            ))}
        </div>
        {failure ? <p className="text-xs text-destructive">{failure}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {folder !== null && canOpen ? (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={gt("Open {name} folder", { name: skill.name })}
            onClick={() => void run(() => openInEditor(folder))}
          >
            <FolderOpenIcon />
          </Button>
        ) : null}
        <Button
          size="icon-xs"
          variant="ghost-destructive"
          aria-label={gt("Delete {name}", { name: skill.name })}
          disabled={!canManage || busy}
          onClick={() => setConfirming(true)}
        >
          <Trash2Icon />
        </Button>
      </div>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>
                Delete <Var>{skill.name}</Var>?
              </T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                Its folder is deleted from every CLI on <Var>{environmentLabel}</Var>. To keep it
                but stop agents using it, turn it off instead.
              </T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirming(false);
                void run(() => remove({ environmentId, input: { name: skill.name } }));
              }}
            >
              <T>Delete</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function ConfigFilesSection({
  environmentId,
  snapshot,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: AgentConfigSnapshot;
}) {
  const gt = useGT();
  const { environment } = useSettingsScope();
  const canOpen = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const openInEditor = useOpenInPreferredEditor(
    environmentId,
    environment?.serverConfig?.availableEditors ?? [],
  );
  const unsupported = snapshot.unsupportedDrivers
    .map((driver) => PROVIDER_DISPLAY_NAMES[driver] ?? driver)
    .join(", ");
  return (
    <SettingsSection title={gt("Config files")}>
      {snapshot.targets.map((target) => (
        <div
          key={target.id}
          className="flex items-center justify-between gap-3 px-3 py-2.5 sm:px-4"
        >
          <div className="flex min-w-0 items-center gap-2">
            <ProviderInstanceIcon
              driverKind={target.driver}
              displayName={agentConfigTargetLabel(target)}
              size="compact"
            />
            <div className="min-w-0">
              <p className="text-sm text-foreground">{agentConfigTargetLabel(target)}</p>
              <p className="truncate font-ident text-xs text-muted-foreground">
                {target.mcpConfigPath ?? target.skillsDirectory}
              </p>
            </div>
            {target.mcpConfigUnreadable ? (
              <Badge variant="warning" size="sm">
                <AlertTriangleIcon />
                <T>Could not parse</T>
              </Badge>
            ) : null}
          </div>
          {canOpen && target.mcpConfigPath !== null ? (
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={gt("Open {file}", { file: target.mcpConfigPath })}
              onClick={() => void openInEditor(target.mcpConfigPath ?? "")}
            >
              <FolderOpenIcon />
            </Button>
          ) : null}
        </div>
      ))}
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        <T>
          Not managed here yet: <Var>{unsupported}</Var>.
        </T>
      </p>
    </SettingsSection>
  );
}
