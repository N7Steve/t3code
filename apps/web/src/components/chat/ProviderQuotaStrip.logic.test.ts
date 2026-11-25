import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getSelectedProviderQuota, quotaResetsIn, quotaTone } from "./ProviderQuotaStrip.logic";

function provider(
  instance: string,
  driver: string,
  windows: NonNullable<ServerProvider["usageLimits"]>["windows"],
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instance),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-03T11:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt: "2026-09-03T11:00:00.000Z", windows },
  };
}

const session = (usedPercent: number) =>
  ({ id: "s", kind: "session", label: "Session", usedPercent }) as const;
const weekly = (usedPercent: number) =>
  ({ id: "w", kind: "weekly", label: "Weekly", usedPercent }) as const;

describe("getSelectedProviderQuota", () => {
  const fable = { ...weekly(95), id: "seven_day_fable", label: "Weekly · Fable" };
  const providers = [
    provider("claudeAgent", "claudeAgent", [
      session(30),
      fable,
      { ...weekly(60), id: "seven_day" },
    ]),
    provider("codex", "codex", [session(10), weekly(20)]),
    provider("codex_second", "codex", [session(70), weekly(90)]),
    provider("antigravity", "antigravity", [
      { ...session(20), id: "a" },
      { ...session(90), id: "b" },
    ]),
    provider("cursor", "cursor", [
      { id: "total", kind: "monthly", label: "Overall", usedPercent: 50 },
    ]),
  ];

  it.each([
    ["codex", 90, 80],
    ["codex_second", 30, 10],
    ["claudeAgent", 70, 40],
  ])("shows only the selected account %s", (instance, sessionLeft, weeklyLeft) => {
    const quota = getSelectedProviderQuota(providers, ProviderInstanceId.make(instance));
    expect(quota?.provider.instanceId).toBe(instance);
    expect(quota?.session?.left).toBe(sessionLeft);
    expect(quota?.weekly?.left).toBe(weeklyLeft);
  });

  it("shows the tightest window when a driver reports several", () => {
    const antigravity = getSelectedProviderQuota(providers, ProviderInstanceId.make("antigravity"));
    expect(antigravity?.session?.left).toBe(10);
    expect(antigravity?.weekly).toBeNull();
  });

  it("keeps Claude's Fable limit out of the summary when the general weekly limit is absent", () => {
    const claude = provider("claude_fable_only", "claudeAgent", [session(30), fable]);
    const quota = getSelectedProviderQuota([claude], claude.instanceId);
    expect(quota?.weekly).toBeNull();
    expect(quota?.other).toEqual([]);
  });

  it("shows other quota windows from the selected provider", () => {
    const quota = getSelectedProviderQuota(providers, ProviderInstanceId.make("cursor"));
    expect(quota?.other).toMatchObject([{ label: "Overall", usedPercent: 50 }]);
  });

  it("shows the external usage link for the selected ChatGPT connection", () => {
    const managed = provider("codex_managed", "codex", []);
    const externalUsage = { label: "ChatGPT usage", url: "https://chatgpt.com/#settings/Usage" };
    const quota = getSelectedProviderQuota(
      [
        ...providers,
        {
          ...managed,
          usageLimits: {
            checkedAt: managed.checkedAt,
            windows: [],
            unavailable: { reason: "unsupported" },
            externalUsage,
          },
        },
      ],
      managed.instanceId,
    );
    expect(quota).toMatchObject({
      provider: { instanceId: managed.instanceId },
      session: null,
      weekly: null,
      externalUsage,
    });
  });

  it("does not fall back when the selected account has no limits or selection is missing", () => {
    const withoutLimits = provider("codex_empty", "codex", []);
    const allProviders = [...providers, withoutLimits];
    expect(getSelectedProviderQuota(allProviders, withoutLimits.instanceId)).toBeNull();
    expect(getSelectedProviderQuota(allProviders, null)).toBeNull();
  });
});

describe("quotaTone", () => {
  it.each([
    [100, "plenty"],
    [51, "plenty"],
    [50, "medium"],
    [20, "medium"],
    [19, "low"],
    [0, "low"],
  ] as const)("%i%% left is %s", (left, tone) => {
    expect(quotaTone(left)).toBe(tone);
  });
});

describe("quotaResetsIn", () => {
  const now = Date.parse("2026-09-03T12:00:00.000Z");
  const resetting = (resetsAt: string | undefined) => ({
    ...session(40),
    ...(resetsAt ? { resetsAt } : {}),
  });

  it.each([
    ["2026-09-03T13:20:00.000Z", "1h 20m"],
    ["2026-09-06T16:00:00.000Z", "3d 4h"],
    ["2026-09-03T12:00:30.000Z", "1m"],
    ["2026-09-03T11:00:00.000Z", null],
    [undefined, null],
  ])("resetsAt %s shows %s", (resetsAt, expected) => {
    expect(quotaResetsIn(resetting(resetsAt), now)).toBe(expected);
  });
});
