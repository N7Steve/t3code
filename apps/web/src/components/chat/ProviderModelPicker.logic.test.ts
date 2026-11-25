import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  providerAccountEntries,
  providerGroupRepresentatives,
  resolveAccountSwitchModel,
  retainedModelWhileProviderLocked,
} from "./ProviderModelPicker.logic";

const claude = ProviderDriverKind.make("claudeAgent");
const opus = { slug: "claude-opus-5-5", name: "Claude Opus 5.5", shortName: "Opus 5.5" };
const sonnet = { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", shortName: "Sonnet 5.5" };
const retained = (enabled: boolean, isAvailable: boolean, models = [sonnet, opus]) =>
  retainedModelWhileProviderLocked({ driverKind: claude, enabled, isAvailable, models }, opus.slug);

describe("retainedModelWhileProviderLocked", () => {
  it("shows a hidden saved model while its provider cannot run", () => {
    expect(retained(false, true)).toBe(opus);
    expect(retained(true, false)).toBe(opus);
    expect(retained(false, true, [sonnet])).toEqual({ slug: opus.slug, name: opus.slug });
    expect(retained(true, true)).toBeUndefined();
    expect(retainedModelWhileProviderLocked(null, opus.slug)).toBeUndefined();
  });
});

function provider(
  instanceId: string,
  driver: string,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const entries = deriveProviderInstanceEntries([
  provider("claudeAgent", "claudeAgent", { status: "error" }),
  provider("claude_work", "claudeAgent"),
  provider("claude_off", "claudeAgent", { enabled: false }),
  provider("codex", "codex"),
  provider("devin", "acpRegistry"),
  provider("gemini_agent", "acpRegistry"),
]);
const ids = (list: ReadonlyArray<{ instanceId: string }>) => list.map((entry) => entry.instanceId);

describe("providerGroupRepresentatives", () => {
  it("lists one instance per provider, preferring the active one, then a ready one", () => {
    expect(ids(providerGroupRepresentatives(entries, ProviderInstanceId.make("codex")))).toEqual([
      "claude_work",
      "codex",
      "devin",
      "gemini_agent",
    ]);
    expect(
      ids(providerGroupRepresentatives(entries, ProviderInstanceId.make("claudeAgent"))),
    ).toEqual(["claudeAgent", "codex", "devin", "gemini_agent"]);
  });
});

describe("providerAccountEntries", () => {
  it("offers visible accounts across providers", () => {
    expect(ids(providerAccountEntries(entries, ProviderInstanceId.make("claude_work")))).toEqual([
      "claudeAgent",
      "claude_work",
      "codex",
      "devin",
      "gemini_agent",
    ]);
  });

  it("keeps a disabled active instance so the select can name it", () => {
    expect(ids(providerAccountEntries(entries, ProviderInstanceId.make("claude_off")))).toEqual([
      "claudeAgent",
      "claude_work",
      "claude_off",
      "codex",
      "devin",
      "gemini_agent",
    ]);
  });
});

describe("resolveAccountSwitchModel", () => {
  it("keeps the model the other account offers, else lands on its default", () => {
    const options = [
      { slug: "a" },
      { slug: "b", isDefault: true },
      { slug: "c", isUnavailable: true },
    ];
    expect(resolveAccountSwitchModel({ currentModel: "a", options })).toBe("a");
    expect(resolveAccountSwitchModel({ currentModel: "c", options })).toBe("b");
    expect(resolveAccountSwitchModel({ currentModel: "z", options: [{ slug: "a" }] })).toBe("a");
    expect(resolveAccountSwitchModel({ currentModel: "a", options: [] })).toBeNull();
  });
});
