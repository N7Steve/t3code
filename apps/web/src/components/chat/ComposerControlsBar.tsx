import type { ChatComposerProps } from "./ChatComposer";
import type { PromptUltrathink } from "./TraitsPicker";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { type AppModelOption } from "../../modelSelection";
import { useGT, useMessages } from "gt-react";
import { CircleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerControl } from "./ComposerControl";
import { ComposerModelPicker } from "./ComposerFooterControls";
import {
  type EnvironmentId,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { EffortDisplay } from "@t3tools/contracts/settings";
import { cn } from "~/lib/utils";
import { resolveComposerTraitsInput } from "./composerProviderState";
import { useApplyThreadModelPick } from "./useApplyThreadModelPick";
import { useStableCallback } from "../../hooks/useStableCallback";
import { describeComposerEffort } from "./ComposerModelEffort";
import type { useComposerProviderModel } from "./useComposerProviderModel";
import { ComposerAccountPicker, ComposerAccountRadioItems } from "./ComposerAccountPicker";
import { ComposerReasoningPicker } from "./ComposerReasoningPicker";
import { providerAccountEntries, resolveAccountSwitchModel } from "./ProviderModelPicker.logic";
import { TraitsMenuContent } from "./TraitsPicker";

const SELECT_TRIGGER_STATES = "data-popup-open:bg-accent data-popup-open:text-foreground";

type BlockId = "reasoning" | "account";
/** Collapse order: the last block turns icon-only first, then hides first. */
const BLOCK_PRIORITY: ReadonlyArray<BlockId> = ["account", "reasoning"];

export function ComposerControlsBar(props: {
  environmentId: EnvironmentId;
  workspaceCwd: string | null;
  routeKind: ChatComposerProps["routeKind"];
  routeThreadRef: ChatComposerProps["routeThreadRef"];
  draftId: ChatComposerProps["draftId"];
  selectedProvider: ProviderDriverKind;
  selectedInstanceId: ProviderInstanceId;
  selectedModel: string;
  selectedProviderModels: ServerProvider["models"];
  composerModelOptions: ReturnType<typeof useComposerProviderModel>["composerModelOptions"];
  reportedModelSelection: ChatComposerProps["reportedModelSelection"];
  promptUltrathink: PromptUltrathink;
  onPromptEdit: (edit: (prompt: string) => string) => void;
  effortDisplay: EffortDisplay;
  composerControlsCollapsed: boolean;
  composerControlsHidden: boolean;
  restingHiddenBlockCount: number;
  iconOnlyBlockCount: number;
  showProviderUnavailable: boolean;
  providerSetupInstanceId: ProviderInstanceId | undefined;
  onOpenProviderSetup: ChatComposerProps["onOpenProviderSetup"];
  providerCatalogPending: boolean;
  isSendBusy: boolean;
  multipleModelsEnabled: boolean;
  multipleModelSelections: ChatComposerProps["multipleModelSelections"];
  onMultipleModelSelectionsChange: ChatComposerProps["onMultipleModelSelectionsChange"];
  selectedModelSelection: ModelSelection;
  onProviderModelSelect: ChatComposerProps["onProviderModelSelect"];
  activeThreadModelSelection: ChatComposerProps["activeThreadModelSelection"];
  selectedModelForPickerWithCustomFallback: string;
  lockedProvider: ChatComposerProps["lockedProvider"];
  lockedContinuationGroupKey: string | null;
  providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings: ChatComposerProps["keybindings"];
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>;
  terminalOpen: boolean;
  modelPickerOpen: boolean;
  onModelPickerOpenChange: (open: boolean) => void;
  modelPickerIconClassName: string | undefined;
  getModelDisabledReason: ChatComposerProps["getModelDisabledReason"];
}) {
  const {
    environmentId,
    routeKind,
    routeThreadRef,
    draftId,
    selectedProvider,
    selectedInstanceId,
    selectedModel,
    selectedProviderModels,
    composerModelOptions,
    reportedModelSelection,
    promptUltrathink,
    onPromptEdit,
    composerControlsCollapsed,
    composerControlsHidden,
    restingHiddenBlockCount,
    iconOnlyBlockCount,
    showProviderUnavailable,
    providerSetupInstanceId,
    onOpenProviderSetup,
    providerCatalogPending,
    isSendBusy,
    multipleModelsEnabled,
    multipleModelSelections,
    onMultipleModelSelectionsChange,
    selectedModelSelection,
    onProviderModelSelect,
    activeThreadModelSelection,
    selectedModelForPickerWithCustomFallback,
    lockedProvider,
    lockedContinuationGroupKey,
    providerInstanceEntries,
    keybindings,
    modelOptionsByInstance,
    terminalOpen,
    modelPickerOpen,
    onModelPickerOpenChange,
    modelPickerIconClassName,
    getModelDisabledReason,
  } = props;
  const controlSize = composerControlsCollapsed ? "xs" : "sm";
  const controlsDisabled = providerCatalogPending || isSendBusy;
  const gt = useGT();
  const m = useMessages();
  const applyThreadModelPick = useApplyThreadModelPick();
  const applyRouteThreadModelPick = useStableCallback(() => applyThreadModelPick(routeThreadRef));
  const traitsInput = resolveComposerTraitsInput({
    provider: selectedProvider,
    instanceId: selectedInstanceId,
    ...(routeKind === "server"
      ? { threadRef: routeThreadRef, onDraftModelOptionsChange: applyRouteThreadModelPick }
      : {}),
    ...(routeKind === "draft" && draftId ? { draftId } : {}),
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedInstanceId],
    reportedModelSelection,
    promptUltrathink,
    onPromptEdit,
  });
  const effort = describeComposerEffort(traitsInput, props.effortDisplay, controlSize, m);
  const selectedModelEntry = selectedProviderModels.find((model) => model.slug === selectedModel);
  const modelLabel = selectedModelEntry?.shortName ?? selectedModelEntry?.name ?? selectedModel;

  const accountEntries =
    multipleModelSelections === null
      ? providerAccountEntries(providerInstanceEntries, selectedInstanceId)
      : [];
  const resolveModelForAccount = (instanceId: ProviderInstanceId) =>
    resolveAccountSwitchModel({
      currentModel: selectedModel,
      options: (modelOptionsByInstance.get(instanceId) ?? []).filter(
        (option) => getModelDisabledReason(instanceId, option.slug) === null,
      ),
    });
  const accountChoices = {
    entries: accountEntries,
    activeInstanceId: selectedInstanceId,
    lockedProvider,
    lockedContinuationGroupKey,
    getDisabledReason: (instanceId: ProviderInstanceId) => {
      if (resolveModelForAccount(instanceId) !== null) return null;
      const model = modelOptionsByInstance.get(instanceId)?.find((option) => !option.isUnavailable);
      return (model && getModelDisabledReason(instanceId, model.slug)) ?? gt("No models available");
    },
    onSelect: (instanceId: ProviderInstanceId) => {
      const model = resolveModelForAccount(instanceId);
      if (model !== null) onProviderModelSelect(instanceId, model);
    },
  };
  const blockIds = BLOCK_PRIORITY.filter((id) => {
    switch (id) {
      case "reasoning":
        return traitsInput !== null && (effort.suffix !== null || effort.detail !== null);
      case "account":
        return accountEntries.length > 0;
    }
  });
  const isHidden = (id: BlockId) =>
    blockIds.indexOf(id) >= blockIds.length - restingHiddenBlockCount;
  const isIconOnly = (id: BlockId) => blockIds.indexOf(id) >= blockIds.length - iconOnlyBlockCount;
  const hiddenIds = blockIds.filter(isHidden);

  const block = (id: BlockId, content: ReactNode) => {
    if (!blockIds.includes(id)) return null;
    const hidden = isHidden(id);
    const iconOnly = isIconOnly(id);
    return (
      <div
        key={id}
        data-resting-block={id}
        data-resting-block-priority={blockIds.indexOf(id)}
        data-composer-block-icon-only={iconOnly ? "true" : "false"}
        aria-hidden={hidden || undefined}
        inert={hidden || undefined}
        className={cn(
          "flex w-max min-w-max shrink-0 items-center gap-1",
          hidden && "pointer-events-none invisible absolute",
          iconOnly &&
            "[&_[data-composer-control-label]]:pointer-events-none [&_[data-composer-control-label]]:invisible [&_[data-composer-control-label]]:absolute [&_[data-composer-control-label]]:w-max [&_[data-composer-control-label]]:max-w-none [&_[data-composer-control-compact-icon]]:[visibility:inherit] [&_[data-composer-control-compact-icon]]:relative",
        )}
      >
        {content}
      </div>
    );
  };

  if (showProviderUnavailable) {
    return (
      <ComposerControl
        type="button"
        disabled={!providerSetupInstanceId}
        onClick={() => {
          if (providerSetupInstanceId) {
            onOpenProviderSetup(providerSetupInstanceId);
          }
        }}
        data-chat-provider-unavailable="true"
        className="shrink-0"
      >
        <CircleAlertIcon className="size-4" />
        {providerSetupInstanceId ? gt("Open provider settings") : gt("No provider available")}
      </ComposerControl>
    );
  }

  return (
    <>
      {block(
        "account",
        <ComposerAccountPicker
          choices={accountChoices}
          size={controlSize}
          hidden={composerControlsHidden || isHidden("account")}
          disabled={controlsDisabled}
        />,
      )}
      <ComposerModelPicker
        environmentId={environmentId}
        workspaceCwd={props.workspaceCwd}
        compact={false}
        isComposerOwned
        {...(multipleModelSelections !== null ? { groupAccounts: true } : { accountOnly: true })}
        // The trigger grows away from this edge when its model label changes.
        popupAlign={composerControlsCollapsed ? "start" : "end"}
        disabled={controlsDisabled}
        multipleModelsEnabled={multipleModelsEnabled}
        multipleModelSelections={multipleModelSelections}
        onMultipleModelSelectionsChange={onMultipleModelSelectionsChange}
        selectedModelSelection={selectedModelSelection}
        onProviderModelSelect={onProviderModelSelect}
        activeInstanceId={
          providerCatalogPending
            ? (activeThreadModelSelection?.instanceId ?? selectedInstanceId)
            : selectedInstanceId
        }
        model={
          providerCatalogPending
            ? (activeThreadModelSelection?.model ?? selectedModelForPickerWithCustomFallback)
            : selectedModelForPickerWithCustomFallback
        }
        lockedProvider={lockedProvider}
        lockedContinuationGroupKey={lockedContinuationGroupKey}
        instanceEntries={providerInstanceEntries}
        keybindings={keybindings}
        modelOptionsByInstance={modelOptionsByInstance}
        size={controlSize}
        triggerClassName={cn(
          SELECT_TRIGGER_STATES,
          composerControlsCollapsed ? "min-w-13 shrink text-xs!" : "min-w-13",
        )}
        terminalOpen={terminalOpen}
        open={modelPickerOpen}
        instanceIndicatorBackground={
          composerControlsCollapsed
            ? "color-mix(in srgb, var(--chat-composer-glass-surface) var(--glass-opacity), transparent)"
            : "var(--contrast-input)"
        }
        {...(modelPickerIconClassName
          ? { activeProviderIconClassName: modelPickerIconClassName }
          : {})}
        onOpenChange={onModelPickerOpenChange}
        getModelDisabledReason={getModelDisabledReason}
        onOpenProviderSetup={onOpenProviderSetup}
      />
      {traitsInput
        ? block(
            "reasoning",
            <ComposerReasoningPicker
              traits={traitsInput}
              summary={effort.suffix}
              detail={effort.detail}
              modelLabel={modelLabel}
              size={controlSize}
              hidden={composerControlsHidden || isHidden("reasoning")}
              disabled={controlsDisabled}
            />,
          )
        : null}
      <div
        data-resting-controls-overflow
        aria-hidden={hiddenIds.length === 0 || undefined}
        inert={hiddenIds.length === 0 || undefined}
        className={cn(
          "min-w-0 shrink-0",
          hiddenIds.length === 0 && "pointer-events-none invisible absolute",
        )}
      >
        <CompactComposerControlsMenu
          size={controlSize}
          hidden={composerControlsHidden || hiddenIds.length === 0}
          {...(hiddenIds.includes("account")
            ? { account: <ComposerAccountRadioItems choices={accountChoices} /> }
            : {})}
          {...(hiddenIds.includes("reasoning") && traitsInput
            ? {
                reasoning: {
                  label: effort.detail
                    ? gt("Reasoning: {level}", { level: effort.detail })
                    : gt("Reasoning", { $context: "model reasoning options" }),
                  content: <TraitsMenuContent {...traitsInput} />,
                },
              }
            : {})}
        />
      </div>
    </>
  );
}
