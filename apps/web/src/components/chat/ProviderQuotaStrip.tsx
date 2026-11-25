import { type ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { remainingPercent } from "@t3tools/shared/usageLimits";
import { formatResetsIn } from "@t3tools/shared/usageLimitsCopy";
import { useGT, useMessages } from "gt-react";
import { GaugeIcon } from "lucide-react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { providerClients } from "../settings/providerDriverMeta";
import { ComposerControl } from "./ComposerControl";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  getSelectedProviderQuota,
  type QuotaMeter,
  quotaResetsIn,
  type QuotaTone,
  quotaTone,
} from "./ProviderQuotaStrip.logic";

const TONE_RING: Record<QuotaTone, string> = {
  plenty: "stroke-success",
  medium: "stroke-warning",
  low: "stroke-error",
};

interface LabeledMeter extends QuotaMeter {
  readonly label: string;
}

const RING_RADIUS = 5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function QuotaRing({ left }: { readonly left: number }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 14 14" className="size-3.5 shrink-0 -rotate-90">
      <circle
        cx="7"
        cy="7"
        r={RING_RADIUS}
        fill="none"
        strokeWidth="2"
        className="stroke-muted-foreground/25"
      />
      <circle
        cx="7"
        cy="7"
        r={RING_RADIUS}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={RING_CIRCUMFERENCE * (1 - Math.max(left, 3) / 100)}
        className={TONE_RING[quotaTone(left)]}
      />
    </svg>
  );
}

function MeterSummary({ meter, now }: { readonly meter: LabeledMeter; readonly now: number }) {
  const m = useMessages();
  const tone = quotaTone(meter.left);
  const resetsIn = quotaResetsIn(meter.window, now, m) ?? formatResetsIn(meter.window, now, m);
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <QuotaRing left={meter.left} />
      <span>{meter.label}</span>
      <span
        className={cn(
          "font-ident tabular-nums",
          tone === "low" ? "text-error-foreground" : "text-foreground/80",
        )}
      >
        {meter.left}%
      </span>
      {resetsIn ? (
        <span className="border-s border-border ps-1.5 tabular-nums">{resetsIn}</span>
      ) : null}
    </span>
  );
}

function MeterDetail({ meter, now }: { readonly meter: LabeledMeter; readonly now: number }) {
  const gt = useGT();
  const m = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const resetsAt = meter.window.resetsAt
    ? formatUpcomingTimestamp(meter.window.resetsAt, timestampFormat, now, undefined, m)
    : null;
  const resetsIn = formatResetsIn(meter.window, now, m);
  return (
    <div className="flex flex-col">
      <span className="text-foreground">
        {gt("{label}: {left}% left", { label: meter.label, left: meter.left })}
      </span>
      {resetsAt ? (
        <span className="text-muted-foreground">
          {resetsIn
            ? gt("Resets {resetsAt} · {resetsIn}", { resetsAt, resetsIn })
            : gt("Resets {resetsAt}", { resetsAt })}
        </span>
      ) : null}
    </div>
  );
}

function useQuotaMeters(
  providers: readonly ServerProvider[],
  selectedInstanceId: ProviderInstanceId | null,
) {
  const m = useMessages();
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const quota = getSelectedProviderQuota(providers, selectedInstanceId);
  if (!quota) return null;
  const meters: LabeledMeter[] = [
    ...(quota.session ? [{ ...quota.session, label: quota.session.window.label }] : []),
    ...(quota.weekly ? [{ ...quota.weekly, label: quota.weekly.window.label }] : []),
    ...quota.other.map((window) => ({
      left: remainingPercent(window),
      window,
      label: window.label,
    })),
  ];
  const summary = meters
    .map((meter) => {
      const reset = formatResetsIn(meter.window, now, m);
      return `${meter.label} ${meter.left}%${reset ? `, ${reset}` : ""}`;
    })
    .join(", ");
  return { quota, meters, summary, now };
}

export function ProviderQuotaMeters({
  providers,
  selectedInstanceId,
  onOpenDetails,
}: {
  readonly providers: readonly ServerProvider[];
  readonly selectedInstanceId: ProviderInstanceId | null;
  readonly onOpenDetails?: (() => void) | undefined;
}) {
  const gt = useGT();
  const state = useQuotaMeters(providers, selectedInstanceId);
  if (!state) {
    return onOpenDetails ? (
      <ComposerControl size="xs" onClick={onOpenDetails}>
        <GaugeIcon />
        {gt("Usage limits")}
      </ComposerControl>
    ) : (
      <span className="inline-flex min-w-0 items-center gap-1.5 px-1.5 text-xs">
        <GaugeIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="truncate">{gt("No limits reported.")}</span>
      </span>
    );
  }
  const { quota, meters, summary, now } = state;
  return (
    <div className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
      {meters.length > 0 ? (
        <Tooltip>
          <TooltipTrigger
            render={
              onOpenDetails ? (
                <button
                  type="button"
                  aria-label={gt("Usage limits: {summary}", { summary })}
                  className="flex min-h-7 min-w-0 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 py-1 text-start rounded-(--control-radius) px-1.5 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  onClick={onOpenDetails}
                />
              ) : (
                <span
                  role="group"
                  aria-label={gt("Usage limits: {summary}", { summary })}
                  className="flex min-h-7 min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-1.5 py-1"
                />
              )
            }
          >
            {meters.map((meter) => (
              <MeterSummary key={meter.window.id} meter={meter} now={now} />
            ))}
          </TooltipTrigger>
          <TooltipPopup side="top">
            <div className="flex flex-col gap-1.5">
              <span className="font-medium text-foreground">
                {providerClients.get(quota.provider.driver)?.label ?? quota.provider.driver}
              </span>
              {meters.map((meter) => (
                <MeterDetail key={meter.window.id} meter={meter} now={now} />
              ))}
            </div>
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {quota.externalUsage && (meters.length === 0 || !onOpenDetails) ? (
        <button
          type="button"
          className="cursor-pointer rounded-(--control-radius) px-1.5 underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={() => void ensureLocalApi().shell.openExternal(quota.externalUsage!.url)}
        >
          {gt("Manage usage")}
        </button>
      ) : null}
    </div>
  );
}
