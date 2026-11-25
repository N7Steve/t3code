import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import {
  isProviderInstancePickerReady,
  isProviderInstancePickerVisible,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import type { ModelEsque } from "./providerIconUtils";

/** Keeps a hidden model visible while its provider is locked or turned off. */
export function retainedModelWhileProviderLocked(
  entry: {
    readonly driverKind: ProviderDriverKind;
    readonly enabled: boolean;
    readonly isAvailable: boolean;
    readonly models: ReadonlyArray<Pick<ModelEsque, "slug" | "name" | "shortName" | "subProvider">>;
  } | null,
  model: string,
): ModelEsque | undefined {
  if (!entry || (entry.enabled && entry.isAvailable) || !model) return undefined;
  if (entry.driverKind === "opencode" || entry.driverKind === "antigravity") return undefined;
  return entry.models.find((candidate) => candidate.slug === model) ?? { slug: model, name: model };
}

type GroupableEntry = Pick<
  ProviderInstanceEntry,
  "instanceId" | "driverKind" | "acpRegistryAgentId" | "enabled" | "isAvailable"
>;

/**
 * Instances that run the same agent are accounts of one provider. Every ACP registry agent is its
 * own provider, so registry instances group by the agent they run.
 */
function providerGroupKey(entry: GroupableEntry): string {
  return entry.driverKind === "acpRegistry"
    ? `acpRegistry:${entry.acpRegistryAgentId ?? entry.instanceId}`
    : entry.driverKind;
}

export function groupProviderAccounts<Entry extends ProviderInstanceEntry>(
  entries: ReadonlyArray<Entry>,
): ReadonlyMap<string, readonly [Entry, ...Entry[]]> {
  const groups = new Map<string, [Entry, ...Entry[]]>();
  for (const entry of entries) {
    const key = providerGroupKey(entry);
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  return groups;
}

/**
 * One instance per provider for the model picker's provider rail: the active instance where it
 * belongs to the group, otherwise the first ready one in picker order (default instance first).
 */
export function providerGroupRepresentatives<Entry extends ProviderInstanceEntry>(
  entries: ReadonlyArray<Entry>,
  activeInstanceId: ProviderInstanceId,
): ReadonlyArray<Entry> {
  return [...groupProviderAccounts(entries).values()].map(
    (group) =>
      group.find((entry) => entry.instanceId === activeInstanceId) ??
      group.find(isProviderInstancePickerReady) ??
      group[0],
  );
}

export function providerAccountEntries<Entry extends ProviderInstanceEntry>(
  entries: ReadonlyArray<Entry>,
  activeInstanceId: ProviderInstanceId,
): ReadonlyArray<Entry> {
  return entries.filter(
    (entry) => entry.instanceId === activeInstanceId || isProviderInstancePickerVisible(entry),
  );
}

/**
 * The model an account switch lands on: the current model when the other account offers it,
 * else that account's default, else its first available model.
 */
export function resolveAccountSwitchModel(input: {
  readonly currentModel: string;
  readonly options: ReadonlyArray<Pick<ModelEsque, "slug" | "isDefault" | "isUnavailable">>;
}): string | null {
  const available = input.options.filter((option) => !option.isUnavailable);
  return (
    available.find((option) => option.slug === input.currentModel)?.slug ??
    available.find((option) => option.isDefault)?.slug ??
    available[0]?.slug ??
    null
  );
}
