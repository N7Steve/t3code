import { createMemoryHistory } from "@tanstack/react-router";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  CLAUDE_PROVIDER,
  CODEX_PROVIDER,
  ENVIRONMENT_ID,
  dispatchedCommands,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const CLAUDE = ProviderInstanceId.make("claudeAgent");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

/** A Claude thread whose 250k-token context went cold long ago, with its native thread kept for handoff. */
function coldClaudeThread(threadId = "thread-claude") {
  const thread = threadWithHistory(threadId, 3, {
    instanceId: CLAUDE,
    model: "claude-opus-4-6",
  });
  const at = DateTime.makeUnsafe("2026-03-17T19:12:28.000Z");
  const providerThread: OrchestrationV2ProviderThread = {
    id: ProviderThreadId.make("provider-thread-claude"),
    driver: CLAUDE_DRIVER,
    providerInstanceId: CLAUDE,
    providerSessionId: null,
    appThreadId: thread.id,
    ownerNodeId: null,
    nativeThreadRef: { driver: CLAUDE_DRIVER, nativeId: "native-claude", strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 3,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    contextUsage: {
      usedTokens: 250_000,
      maxTokens: 1_000_000,
      inputTokens: 240_000,
      cachedInputTokens: 100_000,
      outputTokens: 10_000,
    },
    nativeMetadata: null,
    goal: null,
    createdAt: at,
    updatedAt: at,
  };
  return { ...thread, providerThreads: [providerThread] };
}

it("sends a Codex follow-up on a cold Claude thread without compacting first", async () => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1280, 800);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  const thread = coldClaudeThread();
  const workAccount = ProviderInstanceId.make("codex_work");
  const limits = (usedPercent: number, resetsAt: string) => ({
    checkedAt: CODEX_PROVIDER.checkedAt,
    windows: [{ id: "session", kind: "session", label: "Session", usedPercent, resetsAt }],
  });
  using _environment = installFakeEnvironment([thread], {
    acceptCommands: true,
    providerInstances: {
      [workAccount]: { driver: ProviderDriverKind.make("codex"), config: {} },
    },
    providers: [
      { ...CLAUDE_PROVIDER, usageLimits: limits(15, "2097-01-01T00:00:00.000Z") },
      { ...CODEX_PROVIDER, usageLimits: limits(25, "2098-01-01T00:00:00.000Z") },
      {
        ...CODEX_PROVIDER,
        instanceId: workAccount,
        displayName: "Work",
        usageLimits: limits(35, "2099-01-01T00:00:00.000Z"),
      },
    ],
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText(`Answer 2 for ${thread.id}.`)).toBeVisible();
  const compactAndSend = page.getByRole("button", { name: "Compact and send" });
  await expect.element(compactAndSend).toBeVisible();

  await page.getByRole("button", { name: "Context: 25% used" }).click();
  await expect.element(page.getByText("250,000 of 1,000,000 tokens")).toBeVisible();
  await expect.element(page.getByText("Cached input", { exact: true })).toBeVisible();
  await expect.element(page.getByText("100,000", { exact: true })).toBeVisible();
  await userEvent.keyboard("{Escape}");

  const quota = (remaining: number) =>
    page.getByRole("button", {
      name: new RegExp(`Usage limits: Session ${remaining}%, resets in`, "i"),
    });
  const reset = (remaining: number) =>
    quota(remaining).element().getAttribute("aria-label")?.split(", ")[1];
  await expect.element(quota(85)).toBeVisible();
  const claudeReset = reset(85);
  await quota(85).click();
  const limitsPanel = page.getByRole("button", { name: "Dismiss usage limits" });
  await expect.element(limitsPanel).toBeVisible();

  await page.getByRole("button", { name: /^Account: Claude/ }).click();
  await page.getByRole("menuitemradio", { name: "Codex", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "GPT-5.4", exact: true })).toBeVisible();
  await expect.element(compactAndSend).not.toBeInTheDocument();
  await expect.element(quota(75)).toBeVisible();
  const codexReset = reset(75);
  expect(codexReset).not.toBe(claudeReset);
  await expect.element(limitsPanel).toBeVisible();

  await page.getByRole("button", { name: "Account: Codex", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Work", exact: true }).click();
  await expect.element(quota(65)).toBeVisible();
  expect(reset(65)).not.toBe(codexReset);
  await expect.element(limitsPanel).toBeVisible();
  const accountSections = limitsPanel.element().closest("[data-composer-banner-surface]");
  expect(accountSections?.textContent).toMatch(/Codex · Work.*65% left.*75% left/);

  const editor = page.getByTestId("composer-editor");
  await userEvent.click(editor);
  await userEvent.type(editor, "keep going");
  await userEvent.keyboard("{Enter}");

  const messages = () =>
    dispatchedCommands().flatMap((command) =>
      command.type === "message.dispatch"
        ? [{ text: command.text, instanceId: command.modelSelection?.instanceId }]
        : [],
    );
  const sent = { text: "keep going", instanceId: workAccount };
  await vi.waitFor(() => expect(messages()).toContainEqual(sent));
  expect(messages()).toEqual([sent]);
});

it("drops the compact offer on a cold Claude thread while /clear is armed", async () => {
  // At phone width, dismissing the fresh-session notice collapses the composer and hides the chip.
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1280, 800);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  // The first test's model pick stays on thread-claude's draft, so this one uses its own thread.
  const thread = coldClaudeThread("thread-claude-cleared");
  using _environment = installFakeEnvironment([thread], { providers: [CLAUDE_PROVIDER] });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText(`Answer 2 for ${thread.id}.`)).toBeVisible();
  const chip = page.getByRole("button", { name: "Compact 250k tokens of history before sending" });
  const compactAndSend = page.getByRole("button", { name: "Compact and send" });
  await expect.element(chip).toBeVisible();
  await expect.element(compactAndSend).toBeVisible();

  const editor = page.getByTestId("composer-editor");
  await userEvent.click(editor);
  await userEvent.type(editor, "/clear");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByText("Your next message starts a fresh session")).toBeVisible();
  await expect.element(chip).not.toBeInTheDocument();
  await expect.element(compactAndSend).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Submit message" })).toBeVisible();

  await page.getByRole("button", { name: "Keep the current session" }).click();
  await expect.element(chip).toBeVisible();
  await expect.element(compactAndSend).toBeVisible();
});
