import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { useGT, useLocale, useMessages } from "gt-react";
import { ChartPieIcon } from "lucide-react";

import { formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { ComposerControl } from "./ComposerControl";
import { composerFloatingLayerProps } from "./composerEventScope";
import { formatContextWindowCompactionMessage } from "./compaction.logic";

export function ComposerContextMeter({ usage }: { readonly usage: ContextWindowSnapshot | null }) {
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
  const label = gt("Context window");
  const percent = usage?.usedPercentage == null ? null : Math.round(usage.usedPercentage);
  const capacity = usage?.maxTokens ?? null;
  const compactAt = usage?.autoCompactThreshold ?? null;
  const parts = usage
    ? [
        {
          label: gt("Input", { $context: "input tokens" }),
          value: usage.lastInputTokens ?? usage.inputTokens,
        },
        {
          label: gt("Cached input"),
          value: usage.lastCachedInputTokens ?? usage.cachedInputTokens,
          subset: true,
        },
        {
          label: gt("Output", { $context: "output tokens" }),
          value: usage.lastOutputTokens ?? usage.outputTokens,
        },
        {
          label: gt("Reasoning", { $context: "model reasoning options" }),
          value: usage.lastReasoningOutputTokens ?? usage.reasoningOutputTokens,
          subset: true,
        },
      ].filter(({ value }) => value !== null)
    : [];
  const tone =
    percent !== null && percent >= 90
      ? "text-error-foreground"
      : percent !== null && percent >= 80
        ? "text-warning-foreground"
        : "text-foreground";
  const summary =
    percent !== null
      ? gt("Context: {used}% used", { used: percent })
      : usage
        ? gt("Context: {usedTokens} tokens used", {
            usedTokens: usage.usedTokens.toLocaleString(locale),
          })
        : label;
  return (
    <Popover>
      <PopoverTrigger render={<ComposerControl size="xs" aria-label={summary} />}>
        <ChartPieIcon aria-hidden="true" />
        <span aria-hidden="true" className={cn("font-medium tabular-nums", usage && tone)}>
          {percent !== null
            ? `${percent}%`
            : usage
              ? formatContextWindowTokens(usage.usedTokens)
              : "–"}
        </span>
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="end"
        width="sm"
        padding="compact"
        {...composerFloatingLayerProps}
      >
        <div className="grid gap-2.5 py-1 text-xs">
          <PopoverTitle>{label}</PopoverTitle>
          {usage ? (
            <>
              <p className="font-medium tabular-nums">
                {capacity !== null
                  ? gt("{used} of {max} tokens", {
                      used: usage.usedTokens.toLocaleString(locale),
                      max: capacity.toLocaleString(locale),
                    })
                  : gt("{usedTokens} tokens used", {
                      usedTokens: usage.usedTokens.toLocaleString(locale),
                    })}
              </p>
              {percent !== null ? (
                <div
                  aria-hidden="true"
                  className={cn("h-1.5 overflow-hidden rounded-full bg-muted", tone)}
                >
                  <div
                    className="h-full rounded-full bg-current"
                    style={{ width: `${usage.usedPercentage}%` }}
                  />
                </div>
              ) : null}
              {parts.length > 0 ? (
                <dl className="grid grid-cols-[1fr_auto] gap-x-2 gap-y-1 border-t border-border pt-2">
                  {parts.map(({ label: part, value, subset }) => (
                    <div key={part} className="contents">
                      <dt className={cn("text-muted-foreground", subset && "ps-2")}>{part}</dt>
                      <dd className="text-end tabular-nums">{value?.toLocaleString(locale)}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {compactAt !== null && compactAt > 0 ? (
                <p className="text-muted-foreground">
                  {formatContextWindowCompactionMessage(compactAt, m)}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-muted-foreground">
              {gt("Context usage appears when the provider reports token counts.")}
            </p>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
