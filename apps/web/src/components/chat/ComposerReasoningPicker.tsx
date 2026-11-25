import { useGT } from "gt-react";
import { ChevronDownIcon, SlidersHorizontalIcon } from "lucide-react";
import { type ReactNode, useRef } from "react";

import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { ComposerEffortColumn, ComposerPickerFooter } from "./ComposerModelEffort";
import type { TraitsSelectionInput } from "./TraitsPicker";
import { useComposerMenuState } from "./useComposerMenuState";

/** The selected level, else the column's first option row. */
function focusSelectedLevel(popup: HTMLElement | null) {
  const row =
    popup?.querySelector<HTMLElement>('[data-effort-level][aria-checked="true"]:not(:disabled)') ??
    popup?.querySelector<HTMLElement>("[data-effort-row]:not(:disabled)");
  row?.focus({ preventScroll: true });
  row?.scrollIntoView({ block: "nearest" });
}

/** Reasoning effort and the model's other options (speed, modes), apart from the model itself. */
export function ComposerReasoningPicker(props: {
  traits: TraitsSelectionInput;
  /** The trigger content: the level as a word or bars, plus speed and context markers. */
  summary: ReactNode;
  /** Names the summary for the tooltip and screen readers. */
  detail: string | null;
  modelLabel: string;
  size: ComposerControlSize;
  hidden: boolean;
  disabled: boolean;
}) {
  const gt = useGT();
  const composerMenuProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden || props.disabled);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const label = props.detail
    ? gt("Reasoning: {level}", { level: props.detail })
    : gt("Reasoning", { $context: "model reasoning options" });
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) => {
        if (isOpen) focusSelectedLevel(popupRef.current);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <ComposerControl
                  size={props.size}
                  disabled={props.disabled}
                  aria-label={label}
                  data-composer-shortcut="composer.effort"
                  className="data-popup-open:bg-accent data-popup-open:text-foreground"
                />
              }
            />
          }
        >
          {props.summary ?? <ComposerControlIcon icon={SlidersHorizontalIcon} size={props.size} />}
          <ChevronDownIcon aria-hidden="true" data-composer-control-chevron className="size-3" />
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
      <PopoverPopup
        {...composerMenuProps}
        ref={popupRef}
        side="top"
        align="start"
        padding="none"
        className="before:hidden"
      >
        <div
          data-model-picker-effort
          className="flex max-h-[min(24rem,var(--available-height))] w-56 flex-col"
        >
          <ComposerEffortColumn traits={props.traits} modelLabel={props.modelLabel} />
          <ComposerPickerFooter traits={props.traits} />
        </div>
      </PopoverPopup>
    </Popover>
  );
}
