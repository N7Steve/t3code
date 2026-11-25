import { createMemoryHistory } from "@tanstack/react-router";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
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

// Its own file: the app's shell subscription outlives a test, and it must list this thread.
it("a model picked for an existing thread reaches the server before any message is sent", async () => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1280, 800);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  const stored = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  const thread = { ...threadWithHistory("thread-model-pick", 1), modelSelection: stored };
  const aliasThread = {
    ...threadWithHistory("thread-model-alias", 1),
    modelSelection: { ...stored, model: "gpt-5-codex" },
  };
  const resetsAt = "2099-01-01T00:00:00.000Z";
  using _environment = installFakeEnvironment([thread, aliasThread], {
    acceptCommands: true,
    providerInstances: {
      [ProviderInstanceId.make("codex_work")]: {
        driver: ProviderDriverKind.make("codex"),
        config: {},
      },
      [ProviderInstanceId.make("claude_work")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: {},
      },
    },
    providers: [
      CLAUDE_PROVIDER,
      {
        ...CODEX_PROVIDER,
        usageLimits: {
          checkedAt: CODEX_PROVIDER.checkedAt,
          windows: [
            { id: "session", kind: "session", label: "Session", usedPercent: 10, resetsAt },
          ],
        },
      },
      {
        ...CODEX_PROVIDER,
        instanceId: "codex_work",
        displayName: "Work account",
        models: [{ ...CODEX_PROVIDER.models[0], slug: "gpt-work", name: "Work model" }],
      },
      { ...CLAUDE_PROVIDER, instanceId: "claude_work", displayName: "Claude Work" },
    ],
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    favorites: [{ provider: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-4-6" }],
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText("Answer 0 for thread-model-pick.")).toBeVisible();

  const modelSets = () =>
    dispatchedCommands().filter((command) => command.type === "thread.model-selection.set");

  const usage = page.getByRole("button", { name: /Usage limits: Session 90%, resets in/i });
  await expect.element(usage).toBeVisible();
  await usage.click();
  const dismissUsage = page.getByRole("button", { name: "Dismiss usage limits" });
  await expect.element(dismissUsage).toBeVisible();
  const usageCard = dismissUsage.element().closest("[data-composer-banner-surface]");
  const composer = page
    .getByRole("button", { name: "GPT-5.4", exact: true })
    .element()
    .closest("[data-chat-composer-main-surface]");
  expect(usageCard?.getBoundingClientRect().width).toBeLessThan(
    composer?.getBoundingClientRect().width ?? 0,
  );
  await dismissUsage.click();

  await page.getByRole("button", { name: "Context window" }).click();
  await expect
    .element(page.getByText("Context usage appears when the provider reports token counts."))
    .toBeVisible();
  await userEvent.keyboard("{Escape}");

  const account = page.getByRole("button", { name: /^Account: Codex/ });
  await expect.element(account).toBeEnabled();
  await account.click();
  const accountMenu = page.getByRole("group", { name: "Account" });
  await expect.element(accountMenu.getByRole("separator")).toBeVisible();
  expect(
    Array.from(accountMenu.element().querySelectorAll('[data-slot="menu-label"]'), (label) => ({
      name: label.textContent,
      hasIcon: label.querySelector("svg") !== null,
    })),
  ).toEqual([
    { name: "Claude", hasIcon: true },
    { name: "Codex", hasIcon: true },
  ]);
  await expect.element(page.getByRole("menuitemradio", { name: /Work account/ })).toBeVisible();
  await expect
    .element(page.getByRole("menuitemradio", { name: /Claude.*Start a new thread/ }).first())
    .toBeVisible();
  await expect.element(page.getByRole("menuitemradio", { name: /Claude Work/ })).toBeVisible();
  await userEvent.keyboard("{Escape}");

  await page.getByRole("button", { name: "GPT-5.4", exact: true }).click();
  const search = page.getByPlaceholder("Search models...");
  await userEvent.type(search, "Work model");
  await expect.element(page.getByRole("option", { name: /Work model/ })).not.toBeInTheDocument();
  await search.fill("");
  await page.getByRole("option", { name: /GPT-5\.5/ }).click();
  await vi.waitFor(() =>
    expect(modelSets()).toEqual([
      expect.objectContaining({
        threadId: thread.id,
        modelSelection: { instanceId: "codex", model: "gpt-5.5" },
      }),
    ]),
  );

  // A thread stored under an alias keeps its options when its canonical model is picked.
  await userEvent.keyboard("{Escape}");
  const chatColumn = document.querySelector("[data-chat-column]");
  using animations = vi.spyOn(Element.prototype, "animate");
  await router.navigate({ href: `/${ENVIRONMENT_ID}/${aliasThread.id}` });
  await expect.element(page.getByText("Answer 0 for thread-model-alias.")).toBeVisible();
  expect(document.querySelector("[data-chat-column]")).toBe(chatColumn);
  expect(animations.mock.contexts).toContain(chatColumn);
  await page.getByRole("button", { name: "GPT-5.4", exact: true }).click();
  await page.getByRole("option", { name: /GPT-5\.4/ }).click();
  await vi.waitFor(() =>
    expect(modelSets().at(-1)).toEqual(
      expect.objectContaining({ threadId: aliasThread.id, modelSelection: stored }),
    ),
  );
});
