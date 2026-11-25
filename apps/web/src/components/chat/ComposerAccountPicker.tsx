import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ChevronDownIcon } from "lucide-react";
import { Fragment } from "react";

import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { providerClients } from "../settings/providerDriverMeta";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, type ComposerControlSize } from "./ComposerControl";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { groupProviderAccounts } from "./ProviderModelPicker.logic";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";

interface ComposerAccountChoices {
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly activeInstanceId: ProviderInstanceId;
  readonly lockedProvider: ProviderDriverKind | null;
  readonly lockedContinuationGroupKey: string | null;
  readonly getDisabledReason: (instanceId: ProviderInstanceId) => string | null;
  readonly onSelect: (instanceId: ProviderInstanceId) => void;
}

function AccountProviderIcon({ entry }: { readonly entry: ProviderInstanceEntry }) {
  return (
    <ProviderInstanceIcon
      driverKind={entry.driverKind}
      displayName={entry.displayName}
      acpRegistryAgentId={entry.acpRegistryAgentId}
      acpRegistryIconUrl={entry.acpRegistryIconUrl}
      size="compact"
      className="size-4"
    />
  );
}

function providerLabel(entry: ProviderInstanceEntry): string {
  return entry.driverKind === "acpRegistry"
    ? entry.displayName
    : (providerClients.get(entry.driverKind)?.label ?? entry.driverKind);
}

function accountLabel(entry: ProviderInstanceEntry): string {
  const provider = providerLabel(entry);
  return provider.toLowerCase() === entry.displayName.toLowerCase()
    ? entry.displayName
    : `${provider} · ${entry.displayName}`;
}

function useAccountDisabledReason(choices: ComposerAccountChoices) {
  const gt = useGT();
  return (entry: ProviderInstanceEntry): string | null => {
    if (entry.instanceId === choices.activeInstanceId) return null;
    if (
      choices.lockedProvider !== null &&
      (entry.driverKind !== choices.lockedProvider ||
        (choices.lockedContinuationGroupKey !== null &&
          entry.continuationGroupKey !== choices.lockedContinuationGroupKey))
    ) {
      return gt("Start a new thread to use this account.");
    }
    if (!entry.enabled) return gt("Disabled in settings.");
    if (entry.snapshot.auth.status === "unauthenticated") return gt("Signed out.");
    if (!isProviderInstancePickerReady(entry)) return gt("Unavailable right now.");
    return choices.getDisabledReason(entry.instanceId);
  };
}

/** The accounts as menu radio items; the footer select and the overflow menu both list them. */
export function ComposerAccountRadioItems(props: { choices: ComposerAccountChoices }) {
  const gt = useGT();
  const { choices } = props;
  const disabledReason = useAccountDisabledReason(choices);
  const groups = groupProviderAccounts(choices.entries);
  return (
    <MenuRadioGroup
      aria-label={gt("Account", { $context: "provider account heading" })}
      value={choices.activeInstanceId}
      onValueChange={(instanceId: ProviderInstanceId) => {
        if (instanceId !== choices.activeInstanceId) choices.onSelect(instanceId);
      }}
    >
      {Array.from(groups, ([key, entries], index) => (
        <Fragment key={key}>
          {index > 0 ? <MenuSeparator /> : null}
          <MenuGroup>
            <MenuGroupLabel>
              <span className="flex items-center gap-2">
                <AccountProviderIcon entry={entries[0]} />
                {providerLabel(entries[0])}
              </span>
            </MenuGroupLabel>
            {entries.map((entry) => {
              const reason = disabledReason(entry);
              const detail = reason ?? entry.snapshot.auth.email ?? entry.snapshot.auth.label;
              return (
                <MenuRadioItem
                  key={entry.instanceId}
                  value={entry.instanceId}
                  disabled={reason !== null}
                  closeOnClick
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{entry.displayName}</span>
                      {detail ? (
                        <span className="truncate text-muted-foreground text-xs">{detail}</span>
                      ) : null}
                    </span>
                    <MenuRadioItemIndicator />
                  </span>
                </MenuRadioItem>
              );
            })}
          </MenuGroup>
        </Fragment>
      ))}
    </MenuRadioGroup>
  );
}

export function ComposerAccountPicker(props: {
  choices: ComposerAccountChoices;
  size: ComposerControlSize;
  hidden: boolean;
  disabled: boolean;
}) {
  const gt = useGT();
  const composerMenuProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden || props.disabled);
  const active = props.choices.entries.find(
    (entry) => entry.instanceId === props.choices.activeInstanceId,
  );
  if (!active) return null;
  const label = gt("Account: {account}", { account: accountLabel(active) });
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ComposerControl
                  size={props.size}
                  disabled={props.disabled}
                  aria-label={label}
                  className="data-popup-open:bg-accent data-popup-open:text-foreground"
                />
              }
            />
          }
        >
          <AccountProviderIcon entry={active} />
          <span data-composer-control-label className="max-w-32 truncate">
            {active.displayName}
          </span>
          <ChevronDownIcon aria-hidden="true" data-composer-control-chevron className="size-3" />
        </TooltipTrigger>
        <TooltipPopup side="top">
          {active.snapshot.auth.email ? `${label} · ${active.snapshot.auth.email}` : label}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" side="top" className="min-w-56" {...composerMenuProps}>
        <ComposerAccountRadioItems choices={props.choices} />
      </MenuPopup>
    </Menu>
  );
}
