import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { providersWithLimits, remainingPercent, resetCountdown } from "@t3tools/shared/usageLimits";
import { formatDuration } from "@t3tools/shared/usageLimitsCopy";
import type { MessageResolver } from "../../i18n/messages";

export interface QuotaMeter {
  readonly left: number;
  readonly window: ServerProviderUsageWindow;
}

export type QuotaTone = "plenty" | "medium" | "low";

export function quotaTone(left: number): QuotaTone {
  if (left > 50) return "plenty";
  return left >= 20 ? "medium" : "low";
}

/** Compact time until the window resets. Null when unknown or already past (a stale snapshot). */
export function quotaResetsIn(
  window: ServerProviderUsageWindow,
  now: number,
  resolve?: MessageResolver,
): string | null {
  const countdown = resetCountdown(window, now);
  if (countdown === null || countdown.kind === "now") return null;
  return formatDuration(countdown.kind === "in" ? countdown.ms : 60_000, resolve);
}

function tightest(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  kind: "session" | "weekly",
): QuotaMeter | null {
  let best: QuotaMeter | null = null;
  for (const window of windows) {
    if (window.kind !== kind) continue;
    const left = remainingPercent(window);
    if (best === null || left < best.left) best = { left, window };
  }
  return best;
}

export function getSelectedProviderQuota(
  providers: readonly ServerProvider[],
  selectedInstanceId: ProviderInstanceId | null,
) {
  const selected = providers.find((provider) => provider.instanceId === selectedInstanceId);
  if (!selected?.usageLimits || providersWithLimits([selected]).length === 0) return null;
  const limits = selected.usageLimits;
  const windows = limits.unavailable ? [] : limits.windows;
  const session = tightest(windows, "session");
  const weekly = tightest(
    selected.driver === "claudeAgent"
      ? windows.filter((window) => window.id === "seven_day")
      : windows,
    "weekly",
  );
  const other = windows.filter((window) => window.kind !== "session" && window.kind !== "weekly");
  const externalUsage = selected.auth.status === "authenticated" ? limits.externalUsage : undefined;
  if (!session && !weekly && other.length === 0 && !externalUsage) return null;
  return { provider: selected, session, weekly, other, externalUsage };
}
