// @effect-diagnostics-next-line nodeBuiltinImport:off -- Hashes a local library path, with no I/O.
import * as NodeCrypto from "node:crypto";
import {
  AgentConfigError,
  AgentMcpTransport,
  ProviderDriverKind,
  defaultInstanceIdForDriver,
  type AgentConfigImportPluginInput,
  type AgentConfigRemovePluginInput,
  type AgentConfigRemoveInput,
  type AgentConfigRepairMcpServerInput,
  type AgentConfigSetEnabledInput,
  type AgentConfigSetPluginEnabledInput,
  type AgentConfigSnapshot,
  type AgentConfigSyncMcpServerInput,
  type AgentConfigTarget,
  type AgentConfigUpsertMcpServerInput,
  type AgentMcpProblem,
  type AgentMcpServer,
  type AgentPlugin,
  type AgentSkill,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { parse as parseToml } from "smol-toml";

import * as ServerConfig from "../config.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  MCP_DIALECT_TRANSPORTS,
  isUnsafeTomlEditError,
  encodeMcpEntry,
  parseMcpFile,
  parseSkillDescription,
  sameMcpDefinition,
  stableStringify,
  withMcpEntryEnabled,
  writeMcpEntry,
  type AgentMcpDialect,
  type McpFileEntry,
} from "./agentConfigFormats.ts";
import { diagnoseMcpEntry, mcpPathRewriter, sameRewrites } from "./agentMcpDiagnostics.ts";
import { readAgentPluginManifest, unpackAgentPlugin } from "./agentPluginArchive.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CODEX = ProviderDriverKind.make("codex");
const CURSOR = ProviderDriverKind.make("cursor");
const OPENCODE = ProviderDriverKind.make("opencode");

// Their CLIs either keep MCP servers and skills somewhere T3 Code has not mapped yet, or take
// them only from T3 Code per session.
const UNSUPPORTED_DRIVERS = ["grok", "antigravity", "kiro", "pi", "muse", "fx", "acpRegistry"].map(
  (driver) => ProviderDriverKind.make(driver),
);

const BACKUPS_KEPT = 5;
const BACKUP_INFIX = ".t3-backup-";

interface ResolvedTarget {
  readonly id: string;
  readonly driver: ProviderDriverKind;
  readonly dialect: AgentMcpDialect;
  readonly instanceLabel: string | null;
  readonly mcpConfigPath: string;
  readonly skillsDirectory: string;
  readonly codex?: {
    readonly binaryPath: string;
    readonly managed: boolean;
    readonly environment: ProviderInstanceConfig["environment"];
  };
}

interface McpTargetRead {
  readonly target: ResolvedTarget;
  readonly entries: ReadonlyMap<string, McpFileEntry> | null;
}

const LibraryFile = Schema.fromJsonString(
  Schema.Struct({ servers: Schema.Record(Schema.String, AgentMcpTransport) }),
);
const decodeLibraryFile = Schema.decodeUnknownEffect(LibraryFile);
const encodeLibraryFile = Schema.encodeEffect(LibraryFile);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const isAgentConfigError = Schema.is(AgentConfigError);

const configString = (instance: ProviderInstanceConfig, key: string): string => {
  const config = instance.config;
  if (typeof config !== "object" || config === null) return "";
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
};

const instanceVariable = (instance: ProviderInstanceConfig, name: string): string => {
  const value = instance.environment?.find((variable) => variable.name === name)?.value;
  return typeof value === "string" ? value.trim() : "";
};

const isNotFound = (error: PlatformError.PlatformError) => error.reason._tag === "NotFound";

export class AgentConfig extends Context.Service<
  AgentConfig,
  {
    readonly list: Effect.Effect<AgentConfigSnapshot, AgentConfigError>;
    readonly upsertMcpServer: (
      input: AgentConfigUpsertMcpServerInput,
    ) => Effect.Effect<void, AgentConfigError>;
    readonly setMcpServerEnabled: (
      input: AgentConfigSetEnabledInput,
    ) => Effect.Effect<void, AgentConfigError>;
    readonly removeMcpServer: (
      input: AgentConfigRemoveInput,
    ) => Effect.Effect<void, AgentConfigError>;
    /** Applies path rewrites a fresh diagnosis still proposes, to that one entry only. */
    readonly repairMcpServer: (
      input: AgentConfigRepairMcpServerInput,
    ) => Effect.Effect<void, AgentConfigError>;
    readonly syncMcpServer: (
      input: AgentConfigSyncMcpServerInput,
    ) => Effect.Effect<void, AgentConfigError>;
    readonly setSkillEnabled: (
      input: AgentConfigSetEnabledInput,
    ) => Effect.Effect<void, AgentConfigError>;
    readonly removeSkill: (input: AgentConfigRemoveInput) => Effect.Effect<void, AgentConfigError>;
    readonly importPlugin: (
      input: AgentConfigImportPluginInput,
    ) => Effect.Effect<void, AgentConfigError>;
    readonly setPluginEnabled: (
      input: AgentConfigSetPluginEnabledInput,
    ) => Effect.Effect<void, AgentConfigError>;
    readonly removePlugin: (
      input: AgentConfigRemovePluginInput,
    ) => Effect.Effect<void, AgentConfigError>;
  }
>()("t3/agentConfig/AgentConfig") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const codexInstallation = yield* CodexInstallation.CodexInstallation;
  const writeLock = yield* Semaphore.make(1);
  const libraryDirectory = path.join(serverConfig.stateDir, "agent-config");
  const libraryFilePath = path.join(libraryDirectory, "mcp-servers.json");
  const librarySkillsDirectory = path.join(libraryDirectory, "skills");
  const pluginsDirectory = path.join(libraryDirectory, "plugins");
  const marketplacePrefix = `t3code-${NodeCrypto.createHash("sha256").update(pluginsDirectory).digest("hex").slice(0, 12)}`;
  const marketplaceName = (name: string) => `${marketplacePrefix}-${name}`;

  const ioFailed = (filePath: string) => (cause: unknown) =>
    new AgentConfigError({ reason: "io-failed", path: filePath, cause });

  const writeAtomically = (filePath: string, contents: string) =>
    writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(ioFailed(filePath)),
    );

  const withHostFiles = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const resolveTargets = Effect.fn("AgentConfig.resolveTargets")(function* () {
    const home = yield* HostProcess.HomeDirectory;
    const hostEnvironment = yield* HostProcess.Environment;
    const platform = yield* HostProcess.Platform;
    const settings = yield* serverSettings.getSettings.pipe(Effect.option);
    const configured: ReadonlyArray<readonly [string, ProviderInstanceConfig]> =
      settings._tag === "Some" ? Object.entries(settings.value.providerInstances) : [];
    // The default instance's home is where the CLI looks on its own, configured or not.
    const instancesOf = (driver: ProviderDriverKind) => {
      const instances = configured.filter(([, instance]) => instance.driver === driver);
      const defaultId: string = defaultInstanceIdForDriver(driver);
      return instances.some(([id]) => id === defaultId)
        ? instances
        : [[defaultId, { driver }] as const, ...instances];
    };
    const resolveHome = (value: string) => path.resolve(expandHomePath(value, home));

    const candidates: Array<Omit<ResolvedTarget, "instanceLabel"> & { label: string | null }> = [];
    for (const [id, instance] of instancesOf(CLAUDE)) {
      const homeSetting =
        configString(instance, "homePath") ||
        instanceVariable(instance, "CLAUDE_CONFIG_DIR") ||
        hostEnvironment.CLAUDE_CONFIG_DIR?.trim() ||
        "";
      // Claude Code keeps `.claude.json` beside its config dir only when one is set explicitly.
      const configDir = homeSetting ? resolveHome(homeSetting) : null;
      candidates.push({
        id,
        driver: CLAUDE,
        dialect: "claude",
        label:
          instance.displayName ?? (id === defaultInstanceIdForDriver(instance.driver) ? null : id),
        mcpConfigPath: path.join(configDir ?? home, ".claude.json"),
        skillsDirectory: path.join(configDir ?? path.join(home, ".claude"), "skills"),
      });
    }
    for (const [id, instance] of instancesOf(CODEX)) {
      const homeSetting =
        configString(instance, "homePath") ||
        instanceVariable(instance, "CODEX_HOME") ||
        hostEnvironment.CODEX_HOME?.trim() ||
        "";
      // A shadow home links config.toml and skills back to this shared home.
      const managed = configString(instance, "setupMode") === "managed";
      const configuredHome = managed ? configString(instance, "homePath") : homeSetting;
      const codexHome = configuredHome ? resolveHome(configuredHome) : path.join(home, ".codex");
      candidates.push({
        id,
        driver: CODEX,
        dialect: "codex",
        label:
          instance.displayName ?? (id === defaultInstanceIdForDriver(instance.driver) ? null : id),
        mcpConfigPath: path.join(codexHome, "config.toml"),
        skillsDirectory: path.join(codexHome, "skills"),
        codex: {
          binaryPath: expandHomePath(configString(instance, "binaryPath") || "codex", home),
          managed,
          environment: instance.environment,
        },
      });
    }
    candidates.push({
      id: CURSOR,
      driver: CURSOR,
      dialect: "cursor",
      label: null,
      mcpConfigPath: path.join(home, ".cursor", "mcp.json"),
      skillsDirectory: path.join(home, ".cursor", "skills"),
    });
    const xdgConfig = hostEnvironment.XDG_CONFIG_HOME?.trim();
    const openCodeDirectory = path.join(
      xdgConfig ? path.resolve(xdgConfig) : path.join(home, ".config"),
      "opencode",
    );
    let openCodeConfig = path.join(openCodeDirectory, "opencode.json");
    for (const name of ["opencode.jsonc", "opencode.json", "config.json"]) {
      const candidate = path.join(openCodeDirectory, name);
      if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        openCodeConfig = candidate;
        break;
      }
    }
    candidates.push({
      id: OPENCODE,
      driver: OPENCODE,
      dialect: "opencode",
      label: null,
      mcpConfigPath: openCodeConfig,
      skillsDirectory: path.join(openCodeDirectory, "skills"),
    });

    const pathKey = (value: string) => (platform === "win32" ? value.toLowerCase() : value);
    const seen = new Set<string>();
    const unique = candidates.filter((candidate) => {
      const key = pathKey(candidate.mcpConfigPath);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return unique.map(({ label, ...target }): ResolvedTarget => ({
      ...target,
      instanceLabel:
        unique.filter((other) => other.driver === target.driver).length > 1 ? label : null,
    }));
  });

  const readOptionalText = (filePath: string) =>
    fileSystem.readFileString(filePath).pipe(
      Effect.catchIf(isNotFound, () => Effect.succeed("")),
      Effect.mapError(ioFailed(filePath)),
    );

  const readMcpTarget = Effect.fn("AgentConfig.readMcpTarget")(function* (target: ResolvedTarget) {
    const text = yield* readOptionalText(target.mcpConfigPath).pipe(Effect.option);
    if (text._tag === "None") return { target, entries: null } satisfies McpTargetRead;
    const parsed = parseMcpFile(target.dialect, text.value);
    if (parsed._tag === "unreadable") {
      yield* Effect.logWarning("agent MCP config is unreadable; leaving it unchanged", {
        path: target.mcpConfigPath,
      });
      return { target, entries: null } satisfies McpTargetRead;
    }
    return { target, entries: parsed.entries } satisfies McpTargetRead;
  });

  const readLibrary = Effect.fn("AgentConfig.readLibrary")(function* () {
    const text = yield* readOptionalText(libraryFilePath).pipe(Effect.orElseSucceed(() => ""));
    if (text.trim().length === 0) return new Map<string, AgentMcpTransport>();
    const decoded = yield* decodeLibraryFile(text).pipe(Effect.option);
    return new Map(decoded._tag === "Some" ? Object.entries(decoded.value.servers) : []);
  });

  const writeLibrary = Effect.fn("AgentConfig.writeLibrary")(function* (
    servers: ReadonlyMap<string, AgentMcpTransport>,
  ) {
    const contents = yield* encodeLibraryFile({ servers: Object.fromEntries(servers) }).pipe(
      Effect.mapError(ioFailed(libraryFilePath)),
    );
    yield* writeAtomically(libraryFilePath, `${contents}\n`);
  });

  const backup = Effect.fn("AgentConfig.backup")(function* (filePath: string) {
    const stamp = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-");
    const directory = path.dirname(filePath);
    const prefix = `${path.basename(filePath)}${BACKUP_INFIX}`;
    yield* fileSystem
      .copyFile(filePath, path.join(directory, `${prefix}${stamp}`))
      .pipe(Effect.mapError(ioFailed(filePath)));
    const backups = (yield* fileSystem
      .readDirectory(directory)
      .pipe(Effect.orElseSucceed(() => [])))
      .filter((name) => name.startsWith(prefix))
      .toSorted();
    for (const stale of backups.slice(0, Math.max(0, backups.length - BACKUPS_KEPT))) {
      yield* fileSystem.remove(path.join(directory, stale)).pipe(Effect.ignore({ log: true }));
    }
  });

  const prepareMcpEdit = Effect.fn("AgentConfig.prepareMcpEdit")(function* (
    target: ResolvedTarget,
    name: string,
    update: (
      current: McpFileEntry | undefined,
    ) => Record<string, unknown> | AgentConfigError | undefined,
  ) {
    const filePath = target.mcpConfigPath;
    const text = yield* readOptionalText(filePath);
    const parsed = parseMcpFile(target.dialect, text);
    if (parsed._tag === "unreadable") {
      return yield* new AgentConfigError({
        reason: "unreadable-config",
        targetId: target.id,
        path: filePath,
        cause: parsed.cause,
      });
    }
    const current = parsed.entries.get(name);
    const next = update(current);
    if (isAgentConfigError(next)) return yield* next;
    if (next === current?.raw) return { filePath, text, contents: text };
    const contents = yield* Effect.try({
      try: () => writeMcpEntry(target.dialect, text, name, next),
      catch: (cause) =>
        new AgentConfigError({
          reason: isUnsafeTomlEditError(cause) ? "unsafe-edit" : "io-failed",
          targetId: target.id,
          entryName: name,
          path: filePath,
          cause,
        }),
    });
    return { filePath, text, contents };
  });

  /** Re-reads the file before editing, so the edit lands on what the CLI last wrote. */
  const editMcpEntry = Effect.fn("AgentConfig.editMcpEntry")(function* (
    ...args: Parameters<typeof prepareMcpEdit>
  ) {
    const { filePath, text, contents } = yield* prepareMcpEdit(...args);
    if (contents !== text) {
      if (text.length > 0) yield* backup(filePath);
      yield* writeAtomically(filePath, contents);
    }
  });

  const listSkillDirectory = Effect.fn("AgentConfig.listSkillDirectory")(function* (
    directory: string,
  ) {
    const names = yield* fileSystem
      .readDirectory(directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const skills: Array<{ readonly name: string; readonly path: string }> = [];
    // Dot folders hold the CLIs' own bundled skills, such as Codex's `.system`.
    for (const name of names.filter((entry) => !entry.startsWith(".")).toSorted()) {
      const skillPath = path.join(directory, name);
      const hasSkillFile = yield* fileSystem
        .exists(path.join(skillPath, "SKILL.md"))
        .pipe(Effect.orElseSucceed(() => false));
      if (hasSkillFile) skills.push({ name, path: skillPath });
    }
    return skills;
  });

  const listSkills = Effect.fn("AgentConfig.listSkills")(function* (
    targets: ReadonlyArray<ResolvedTarget>,
  ) {
    const byName = new Map<
      string,
      { locations: Array<{ targetId: string; path: string }>; libraryPath: string | null }
    >();
    const entryFor = (name: string) => {
      const existing = byName.get(name);
      if (existing) return existing;
      const created = { locations: [], libraryPath: null };
      byName.set(name, created);
      return created;
    };
    for (const target of targets) {
      for (const skill of yield* listSkillDirectory(target.skillsDirectory)) {
        entryFor(skill.name).locations.push({ targetId: target.id, path: skill.path });
      }
    }
    for (const skill of yield* listSkillDirectory(librarySkillsDirectory)) {
      entryFor(skill.name).libraryPath = skill.path;
    }
    const skills: Array<AgentSkill> = [];
    for (const [name, entry] of [...byName].toSorted(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const skillPath = entry.locations[0]?.path ?? entry.libraryPath;
      const contents =
        skillPath === null
          ? ""
          : yield* fileSystem
              .readFileString(path.join(skillPath, "SKILL.md"))
              .pipe(Effect.orElseSucceed(() => ""));
      skills.push({
        name,
        description: parseSkillDescription(contents),
        locations: entry.locations,
        libraryPath: entry.libraryPath,
      });
    }
    return skills;
  });

  const listMcpServers = (
    reads: ReadonlyArray<McpTargetRead>,
    library: ReadonlyMap<string, AgentMcpTransport>,
  ): ReadonlyArray<AgentMcpServer> => {
    const names = new Set(library.keys());
    for (const read of reads) {
      for (const [name, entry] of read.entries ?? []) {
        if (entry.transport !== null) names.add(name);
      }
    }
    const servers: Array<AgentMcpServer> = [];
    for (const name of [...names].toSorted((left, right) => left.localeCompare(right))) {
      const found = reads.flatMap((read) => {
        const entry = read.entries?.get(name);
        return entry?.transport
          ? [{ targetId: read.target.id, entry, transport: entry.transport }]
          : [];
      });
      const enabled = found.filter((item) => item.entry.enabled);
      const transport = enabled[0]?.transport ?? found[0]?.transport ?? library.get(name);
      if (transport === undefined) continue;
      const divergent = enabled.some((item) => !sameMcpDefinition(item.transport, transport));
      servers.push({
        name,
        transport,
        enabledIn: enabled.map((item) => item.targetId),
        divergent,
        ...(divergent
          ? { definitions: enabled.map(({ targetId, transport }) => ({ targetId, transport })) }
          : {}),
      });
    }
    return servers;
  };

  const snapshot = Effect.fn("AgentConfig.snapshot")(function* () {
    const targets = yield* resolveTargets();
    const reads = yield* Effect.forEach(targets, readMcpTarget);
    const library = yield* readLibrary();
    return {
      targets,
      reads,
      library,
      mcpServers: listMcpServers(reads, library),
      skills: yield* listSkills(targets),
    };
  });

  // Only enabled stdio entries run, so only they can fail to start.
  const listMcpProblems = Effect.fn("AgentConfig.listMcpProblems")(function* (
    reads: ReadonlyArray<McpTargetRead>,
  ) {
    const checks = reads.flatMap((read) =>
      [...(read.entries ?? [])].flatMap(([name, entry]) =>
        entry.enabled && entry.transport?._tag === "stdio" ? [{ read, name, entry }] : [],
      ),
    );
    const problems = yield* Effect.forEach(
      checks,
      ({ read, name, entry }) =>
        withHostFiles(diagnoseMcpEntry(read.target.dialect, entry.raw)).pipe(
          Effect.map((diagnosis): AgentMcpProblem => ({
            name,
            targetId: read.target.id,
            ...diagnosis,
          })),
        ),
      { concurrency: 8 },
    );
    return problems.filter((problem) => problem.issues.length > 0);
  });

  const list: AgentConfig["Service"]["list"] = Effect.gen(function* () {
    const current = yield* snapshot();
    return {
      ...current,
      mcpProblems: yield* listMcpProblems(current.reads),
      plugins: yield* listPlugins(current.targets),
    };
  }).pipe(
    Effect.map(
      ({ targets, reads, mcpServers, mcpProblems, skills, plugins }): AgentConfigSnapshot => ({
        targets: targets.map((target, index): AgentConfigTarget => ({
          id: target.id,
          driver: target.driver,
          instanceLabel: target.instanceLabel,
          mcpConfigPath: target.mcpConfigPath,
          mcpTransports: MCP_DIALECT_TRANSPORTS[target.dialect],
          skillsDirectory: target.skillsDirectory,
          mcpConfigUnreadable: reads[index]?.entries === null,
        })),
        unsupportedDrivers: UNSUPPORTED_DRIVERS,
        mcpServers,
        mcpProblems,
        skills,
        plugins,
      }),
    ),
  );

  const findTarget = (targets: ReadonlyArray<ResolvedTarget>, targetId: string) => {
    const target = targets.find((candidate) => candidate.id === targetId);
    return target === undefined
      ? Effect.fail(new AgentConfigError({ reason: "unknown-target", targetId }))
      : Effect.succeed(target);
  };

  const requireTransport = (target: ResolvedTarget, transport: AgentMcpTransport) =>
    MCP_DIALECT_TRANSPORTS[target.dialect].includes(transport._tag)
      ? Effect.void
      : Effect.fail(new AgentConfigError({ reason: "unsupported-transport", targetId: target.id }));

  const syncMcpServer: AgentConfig["Service"]["syncMcpServer"] = Effect.fn(
    "AgentConfig.syncMcpServer",
  )(function* (input) {
    const targets = yield* resolveTargets();
    const reads = yield* Effect.forEach(targets, readMcpTarget);
    const definitions = listMcpServers(reads, new Map()).find(
      (server) => server.name === input.name,
    )?.definitions;
    const source = definitions?.find((entry) => entry.targetId === input.sourceTargetId);
    const changed = new AgentConfigError({ reason: "repair-changed", entryName: input.name });
    if (
      source === undefined ||
      definitions === undefined ||
      stableStringify(definitions) !== stableStringify(input.definitions)
    )
      return yield* changed;

    const edits = yield* Effect.forEach(
      definitions,
      Effect.fnUntraced(function* (definition) {
        const target = yield* findTarget(targets, definition.targetId);
        yield* requireTransport(target, source.transport);
        return yield* prepareMcpEdit(target, input.name, (current) => {
          if (
            !current?.enabled ||
            stableStringify(current.transport) !== stableStringify(definition.transport)
          )
            return changed;
          return sameMcpDefinition(definition.transport, source.transport)
            ? current.raw
            : encodeMcpEntry(target.dialect, source.transport, current.raw);
        });
      }),
    );
    const writes = edits.filter(({ text, contents }) => text !== contents);
    for (const edit of edits) {
      if ((yield* readOptionalText(edit.filePath)) !== edit.text) return yield* changed;
    }
    for (const edit of writes) yield* backup(edit.filePath);
    for (const edit of writes) {
      if ((yield* readOptionalText(edit.filePath)) !== edit.text) return yield* changed;
      yield* writeAtomically(edit.filePath, edit.contents);
    }
  }, writeLock.withPermits(1));

  const disableIn = (target: ResolvedTarget, name: string) =>
    editMcpEntry(target, name, (current) =>
      current === undefined ? undefined : withMcpEntryEnabled(target.dialect, current.raw, false),
    );

  const removeFrom = (target: ResolvedTarget, name: string) =>
    editMcpEntry(target, name, () => undefined);

  const upsertMcpServer: AgentConfig["Service"]["upsertMcpServer"] = Effect.fn(
    "AgentConfig.upsertMcpServer",
  )(function* (input) {
    const { targets, library } = yield* snapshot();
    const enabledTargets = yield* Effect.forEach(input.targetIds, (id) => findTarget(targets, id));
    yield* Effect.forEach(enabledTargets, (target) => requireTransport(target, input.transport), {
      discard: true,
    });
    const renamed =
      input.previousName !== undefined && input.previousName !== input.name
        ? input.previousName
        : undefined;
    for (const target of targets) {
      if (renamed !== undefined) yield* removeFrom(target, renamed);
      if (enabledTargets.includes(target)) {
        yield* editMcpEntry(target, input.name, (current) =>
          encodeMcpEntry(target.dialect, input.transport, current?.raw),
        );
      } else {
        yield* disableIn(target, input.name);
      }
    }
    const next = new Map(library);
    if (renamed !== undefined) next.delete(renamed);
    next.set(input.name, input.transport);
    yield* writeLibrary(next);
  }, writeLock.withPermits(1));

  const setMcpServerEnabled: AgentConfig["Service"]["setMcpServerEnabled"] = Effect.fn(
    "AgentConfig.setMcpServerEnabled",
  )(function* (input) {
    const { targets, mcpServers, library } = yield* snapshot();
    const target = yield* findTarget(targets, input.targetId);
    const server = mcpServers.find((candidate) => candidate.name === input.name);
    if (server === undefined) {
      return yield* new AgentConfigError({ reason: "not-found", entryName: input.name });
    }
    if (!input.enabled) {
      // Kept in T3 Code's library so a server turned off everywhere can be turned back on.
      yield* writeLibrary(new Map(library).set(input.name, server.transport));
      return yield* disableIn(target, input.name);
    }
    yield* requireTransport(target, server.transport);
    yield* editMcpEntry(target, input.name, (current) =>
      current?.transport
        ? withMcpEntryEnabled(target.dialect, current.raw, true)
        : encodeMcpEntry(target.dialect, server.transport, current?.raw),
    );
  }, writeLock.withPermits(1));

  const removeMcpServer: AgentConfig["Service"]["removeMcpServer"] = Effect.fn(
    "AgentConfig.removeMcpServer",
  )(function* (input) {
    const { targets, library } = yield* snapshot();
    for (const target of targets) yield* removeFrom(target, input.name);
    if (library.has(input.name)) {
      const next = new Map(library);
      next.delete(input.name);
      yield* writeLibrary(next);
    }
  }, writeLock.withPermits(1));

  const repairMcpServer: AgentConfig["Service"]["repairMcpServer"] = Effect.fn(
    "AgentConfig.repairMcpServer",
  )(function* (input) {
    const target = yield* findTarget(yield* resolveTargets(), input.targetId);
    const read = yield* readMcpTarget(target);
    const entry = read.entries?.get(input.name);
    if (entry === undefined || !entry.enabled || entry.transport?._tag !== "stdio") {
      return yield* new AgentConfigError({ reason: "not-found", entryName: input.name });
    }
    // Re-diagnosed here, so what is written is exactly what the user confirmed.
    const diagnosis = yield* withHostFiles(diagnoseMcpEntry(target.dialect, entry.raw));
    if (input.rewrites.length === 0 || !sameRewrites(diagnosis.rewrites, input.rewrites)) {
      return yield* new AgentConfigError({
        reason: "repair-changed",
        targetId: target.id,
        entryName: input.name,
      });
    }
    const rewrite = yield* withHostFiles(mcpPathRewriter);
    yield* editMcpEntry(target, input.name, (current) =>
      current === undefined ? undefined : rewrite(target.dialect, current.raw, input.rewrites),
    );
  }, writeLock.withPermits(1));

  const copySkill = Effect.fn("AgentConfig.copySkill")(
    function* (source: string, destination: string) {
      // A linked skill is copied as its contents, not as another link.
      const real = yield* fileSystem.realPath(source);
      yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
      yield* fileSystem.copy(real, destination);
    },
    (effect, _source, destination) => effect.pipe(Effect.mapError(ioFailed(destination))),
  );

  const removeSkillPath = (skillPath: string) =>
    fileSystem.remove(skillPath, { recursive: true }).pipe(Effect.mapError(ioFailed(skillPath)));

  const setSkillEnabled: AgentConfig["Service"]["setSkillEnabled"] = Effect.fn(
    "AgentConfig.setSkillEnabled",
  )(function* (input) {
    const { targets, skills } = yield* snapshot();
    const target = yield* findTarget(targets, input.targetId);
    const skill = skills.find((candidate) => candidate.name === input.name);
    if (skill === undefined) {
      return yield* new AgentConfigError({ reason: "not-found", entryName: input.name });
    }
    const here = skill.locations.find((location) => location.targetId === target.id);
    if (input.enabled) {
      if (here !== undefined) return;
      const source = skill.locations[0]?.path ?? skill.libraryPath;
      if (source === null) {
        return yield* new AgentConfigError({ reason: "not-found", entryName: input.name });
      }
      yield* copySkill(source, path.join(target.skillsDirectory, skill.name));
      if (skill.libraryPath !== null) yield* removeSkillPath(skill.libraryPath);
      return;
    }
    if (here === undefined) return;
    if (skill.locations.length === 1 && skill.libraryPath === null) {
      yield* copySkill(here.path, path.join(librarySkillsDirectory, skill.name));
    }
    yield* removeSkillPath(here.path);
  }, writeLock.withPermits(1));

  const removeSkill: AgentConfig["Service"]["removeSkill"] = Effect.fn("AgentConfig.removeSkill")(
    function* (input) {
      const { skills } = yield* snapshot();
      const skill = skills.find((candidate) => candidate.name === input.name);
      if (skill === undefined) {
        return yield* new AgentConfigError({ reason: "not-found", entryName: input.name });
      }
      for (const location of skill.locations) yield* removeSkillPath(location.path);
      if (skill.libraryPath !== null) yield* removeSkillPath(skill.libraryPath);
    },
    writeLock.withPermits(1),
  );

  const readPluginConfig = Effect.fn("AgentConfig.readPluginConfig")(function* (
    target: ResolvedTarget,
  ) {
    const text = yield* readOptionalText(target.mcpConfigPath);
    const config = yield* Effect.try({
      try: () => parseToml(text),
      catch: () =>
        new AgentConfigError({
          reason: "unreadable-config",
          targetId: target.id,
          path: target.mcpConfigPath,
        }),
    });
    const asTable = (value: unknown): Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    return {
      target,
      text,
      installed: asTable(config.plugins),
      marketplaces: asTable(config.marketplaces),
    };
  });

  const listPlugins = Effect.fn("AgentConfig.listPlugins")(function* (
    targets: ReadonlyArray<ResolvedTarget>,
  ) {
    const names = yield* fileSystem
      .readDirectory(pluginsDirectory)
      .pipe(Effect.orElseSucceed(() => []));
    const roots = names.filter((name) => !name.startsWith(".")).toSorted();
    if (roots.length === 0) return [];
    const configs = yield* Effect.forEach(
      targets.filter((target) => target.codex !== undefined),
      (target) => readPluginConfig(target).pipe(Effect.option),
    );
    const plugins: AgentPlugin[] = [];
    for (const name of roots) {
      const manifest = yield* withHostFiles(
        readAgentPluginManifest(path.join(pluginsDirectory, name, "plugin")),
      ).pipe(Effect.option);
      if (manifest._tag === "None" || manifest.value.name !== name) continue;
      const selector = `${name}@${marketplaceName(name)}`;
      plugins.push({
        ...manifest.value,
        enabledIn: configs.flatMap((config) => {
          if (config._tag === "None") return [];
          const entry = config.value.installed[selector];
          return typeof entry === "object" &&
            entry !== null &&
            "enabled" in entry &&
            entry.enabled === true
            ? [config.value.target.id]
            : [];
        }),
      });
    }
    return plugins;
  });

  const importPlugin: AgentConfig["Service"]["importPlugin"] = Effect.fn(
    "AgentConfig.importPlugin",
  )(
    function* ({ archive }) {
      const ioError = Effect.mapError(ioFailed(pluginsDirectory));
      yield* fileSystem.makeDirectory(pluginsDirectory, { recursive: true }).pipe(ioError);
      const staging = yield* fileSystem
        .makeTempDirectoryScoped({
          directory: pluginsDirectory,
          prefix: ".import-",
        })
        .pipe(ioError);
      const unpacked = yield* withHostFiles(unpackAgentPlugin(archive, staging));
      const manifest = yield* withHostFiles(readAgentPluginManifest(unpacked));
      const destination = path.join(pluginsDirectory, manifest.name);
      if (yield* fileSystem.exists(destination).pipe(ioError)) {
        return yield* new AgentConfigError({
          reason: "plugin-already-imported",
          entryName: manifest.name,
        });
      }
      const marketplaceRoot = path.join(staging, "marketplace");
      const manifestDir = path.join(marketplaceRoot, ".agents", "plugins");
      yield* fileSystem.makeDirectory(manifestDir, { recursive: true }).pipe(ioError);
      yield* fileSystem.rename(unpacked, path.join(marketplaceRoot, "plugin")).pipe(ioError);
      yield* writeAtomically(
        path.join(manifestDir, "marketplace.json"),
        yield* encodeJson({
          name: marketplaceName(manifest.name),
          plugins: [
            {
              name: manifest.name,
              source: { source: "local", path: "./plugin" },
              policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
              category: "Other",
            },
          ],
        }).pipe(ioError),
      );
      yield* fileSystem.rename(marketplaceRoot, destination).pipe(ioError);
    },
    Effect.scoped,
    writeLock.withPermits(1),
  );

  const requirePlugin = Effect.fn("AgentConfig.requirePlugin")(function* (name: string) {
    const root = path.join(pluginsDirectory, name);
    if (!(yield* fileSystem.exists(root).pipe(Effect.mapError(ioFailed(root))))) {
      return yield* new AgentConfigError({ reason: "not-found", entryName: name });
    }
    return root;
  });

  const updatePlugin = Effect.fn("AgentConfig.updatePlugin")(function* (
    config: Effect.Success<ReturnType<typeof readPluginConfig>>,
    name: string,
    root: string,
    enabled: boolean,
  ) {
    const { target } = config;
    const codex = target.codex;
    if (codex === undefined)
      return yield* new AgentConfigError({ reason: "unknown-target", targetId: target.id });
    const marketplace = marketplaceName(name);
    const selector = `${name}@${marketplace}`;
    const hasMarketplace = Object.hasOwn(config.marketplaces, marketplace);
    const installed = Object.hasOwn(config.installed, selector);
    if (!enabled && !installed && !hasMarketplace) return;
    const failure = () =>
      new AgentConfigError({
        reason: "plugin-command-failed",
        entryName: name,
        targetId: target.id,
      });
    const binaryPath = codex.managed
      ? (yield* codexInstallation.acquire().pipe(Effect.mapError(failure))).executablePath
      : codex.binaryPath;
    const inherited = yield* mergeProviderInstanceEnvironment(
      codex.environment,
      yield* HostProcess.Environment,
    );
    const env = { ...inherited };
    const platform = yield* HostProcess.Platform;
    for (const key of Object.keys(env)) {
      if (platform === "win32" && key.toUpperCase() === "CODEX_HOME") delete env[key];
    }
    env.CODEX_HOME = path.dirname(target.mcpConfigPath);
    if (enabled) {
      yield* fileSystem
        .makeDirectory(env.CODEX_HOME, { recursive: true })
        .pipe(Effect.mapError(failure));
    }
    const run = Effect.fn("AgentConfig.runCodexPluginCommand")(function* (
      args: ReadonlyArray<string>,
    ) {
      const command = yield* resolveSpawnCommand(binaryPath, ["plugin", ...args], {
        env,
        bypassNpmShim: true,
      });
      const code = yield* spawner
        .exitCode(
          ChildProcess.make(command.command, command.args, {
            cwd: libraryDirectory,
            env,
            shell: command.shell,
          }),
        )
        .pipe(Effect.timeout("30 seconds"), Effect.mapError(failure));
      if (code !== 0) return yield* failure();
    });
    if (config.text.length > 0) yield* backup(target.mcpConfigPath);
    if (enabled) {
      if (!hasMarketplace) yield* run(["marketplace", "add", root]);
      yield* run(["add", selector]);
    } else {
      if (installed) yield* run(["remove", selector]);
      if (hasMarketplace) yield* run(["marketplace", "remove", marketplace]);
    }
  }, Effect.scoped);

  const setPluginEnabled: AgentConfig["Service"]["setPluginEnabled"] = Effect.fn(
    "AgentConfig.setPluginEnabled",
  )(function* (input) {
    const root = yield* requirePlugin(input.name);
    const target = yield* findTarget(yield* resolveTargets(), input.targetId);
    if (target.codex === undefined) {
      return yield* new AgentConfigError({ reason: "unknown-target", targetId: input.targetId });
    }
    yield* updatePlugin(yield* readPluginConfig(target), input.name, root, input.enabled);
  }, writeLock.withPermits(1));

  const removePlugin: AgentConfig["Service"]["removePlugin"] = Effect.fn(
    "AgentConfig.removePlugin",
  )(function* ({ name }) {
    const root = yield* requirePlugin(name);
    const targets = (yield* resolveTargets()).filter((target) => target.codex !== undefined);
    const configs = yield* Effect.forEach(targets, readPluginConfig);
    for (const config of configs) yield* updatePlugin(config, name, root, false);
    yield* fileSystem.remove(root, { recursive: true }).pipe(Effect.mapError(ioFailed(root)));
  }, writeLock.withPermits(1));

  return AgentConfig.of({
    list,
    upsertMcpServer,
    setMcpServerEnabled,
    removeMcpServer,
    repairMcpServer,
    syncMcpServer,
    setSkillEnabled,
    removeSkill,
    importPlugin,
    setPluginEnabled,
    removePlugin,
  });
});

export const layer = Layer.effect(AgentConfig, make);
