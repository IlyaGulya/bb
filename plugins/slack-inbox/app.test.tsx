// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  defaultConfiguration,
  LIMITATIONS,
  type Status,
} from "./src/contract.js";
import { SlackInboxPanel } from "./app.js";

const rpc = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  definePluginApp: (factory: unknown) => factory,
  useRpc: () => rpc,
  useRealtime: () => undefined,
}));
afterEach(() => {
  cleanup();
  rpc.call.mockReset();
});
const status: Status = {
  configuration: defaultConfiguration,
  credentials: { appToken: false, botToken: false },
  connection: "disabled",
  error: null,
  lastEventAt: null,
  pending: 2,
  receivedDiscussions: 3,
  deliveryError: "inbox_delivery_failed; durable source retained for retry",
  coverage: [
    {
      id: "CTEST",
      kind: "private",
      state: "unavailable",
      error: "missing_scope",
      checkedAt: 1000,
      lastEventAt: null,
    },
  ],
  gaps: [
    {
      startedAt: 1000,
      endedAt: null,
      reason: "socket_disconnected; no history backfill",
    },
  ],
  limitations: LIMITATIONS,
};
it("shows missing setup, partial coverage and durable failures without implying acceptance", async () => {
  rpc.call.mockResolvedValue(status);
  render(<SlackInboxPanel />);
  expect(
    await screen.findByText("missing_scope", { exact: false }),
  ).toBeTruthy();
  expect(screen.getByText("Not recorded; intake blocked")).toBeTruthy();
  expect(
    screen.getByText("Received discussions (not accepted tasks)"),
  ).toBeTruthy();
  expect(
    screen.getByText("never; subscription unverified", { exact: false }),
  ).toBeTruthy();
  expect(
    screen.getByText("ongoing / unverified", { exact: false }),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("link", { name: "Review and link in Inbox" })
      .getAttribute("href"),
  ).toBe("/plugins/tasks/tasks/inbox");
  fireEvent.click(
    screen.getByRole("button", { name: "Retry connection / delivery" }),
  );
  await waitFor(() => expect(rpc.call).toHaveBeenCalledWith("retry", null));
  fireEvent.click(
    screen.getByRole("button", { name: "Recheck conversation access" }),
  );
  await waitFor(() =>
    expect(rpc.call).toHaveBeenCalledWith("checkCoverage", null),
  );
});
it("reports status failure as unavailable instead of empty coverage success", async () => {
  rpc.call.mockRejectedValue(
    new Error("private content must not be displayed"),
  );
  render(<SlackInboxPanel />);
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Slack Inbox status unavailable. No complete coverage can be assumed.",
  );
  expect(
    screen.queryByText("private content must not be displayed"),
  ).toBeNull();
});
