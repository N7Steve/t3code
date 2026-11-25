import { createMemoryHistory } from "@tanstack/react-router";
import { ProjectId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The thread route loads ChatView lazily; its first transform would eat the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { useUiStateStore } from "~/uiStateStore";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

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

it("reorders project folders by dropping a handle and keeps the manual order", async () => {
  await page.viewport(1400, 900);
  const thread = threadWithHistory("project-drag", 1);
  using _environment = installFakeEnvironment([thread], {
    extraProjects: [
      { id: ProjectId.make("project-alpha"), title: "alpha" },
      { id: ProjectId.make("project-zeta"), title: "zeta" },
    ],
  });
  const initial = useUiStateStore.getState();
  using _order = {
    [Symbol.dispose]: () =>
      useUiStateStore.setState({
        projectOrder: initial.projectOrder,
        sidebarProjectScopeKeys: initial.sidebarProjectScopeKeys,
      }),
  };
  useUiStateStore.setState({ projectOrder: [], sidebarProjectScopeKeys: [] });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    sidebarProjectFoldersEnabled: true,
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

  const folderNames = () =>
    page
      .getByTestId("sidebar-project-folder")
      .elements()
      .map((folder) => folder.querySelector("[data-sidebar-row] > span.truncate")?.textContent);
  await vi.waitFor(() => expect(folderNames()).toEqual(["alpha", "render", "zeta"]));
  const handle = page.getByRole("button", { name: "Reorder project zeta" });
  await expect.element(handle).toBeInTheDocument();
  const transfer = new DataTransfer();
  const dispatch = (element: Element, type: string) =>
    element.dispatchEvent(
      new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  const target = page.getByTestId("sidebar-project-folder").first().element();
  await act(() => {
    dispatch(handle.element(), "dragstart");
    dispatch(target, "dragover");
    dispatch(target, "drop");
    dispatch(handle.element(), "dragend");
  });
  await vi.waitFor(() => expect(folderNames()).toEqual(["zeta", "alpha", "render"]));
  expect(useUiStateStore.getState().projectOrder).toHaveLength(3);
  handle.element().focus();
  await userEvent.keyboard("{ArrowDown}");
  await vi.waitFor(() => expect(folderNames()).toEqual(["alpha", "zeta", "render"]));
});
