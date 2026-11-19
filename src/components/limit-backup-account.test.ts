// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LimitBackupRow } from "./ThreadFollowControls";

const fixture = vi.hoisted(() => ({ api: vi.fn(), instances: [] as any[] }));
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({ state: { instances: fixture.instances } }) }));
let root: Root, host: HTMLDivElement;
const model = (id: string, extra = {}) => ({ id, label: id.toUpperCase(), enabled: true, chatEligible: true, capabilities: { chat: true }, outputModalities: ["text"], ...extra });
const connection = (id: string, models: any[]) => ({ id, label: `Account ${id}`, preset: "deepseek", protocol: "openai", enabled: true, configured: true, catalog: { models } });
const bot = { id: "bot", modelSelection: { instanceId: "claude", model: "main" }, limitBackup: { selection: { instanceId: "fuigo", connectionId: "mine", model: "old" }, routines: true } };
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.instances = [{ instanceId: "fuigo", displayName: "Fuigo", driverKind: "fuigoAgent", snapshot: { state: "available", authenticated: true }, models: { default: "native", options: [model("native")] } }];
  fixture.api.mockReset().mockResolvedValue({ connections: [connection("mine", [model("new"), model("disabled", { enabled: false }), model("image", { chatEligible: false })]), connection("other", [model("foreign")])] });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
it("offers the saved account's eligible models and saves the account identity and routines", async () => {
  await act(async () => root.render(createElement(LimitBackupRow, { bot: bot as never })));
  const select = host.querySelectorAll("select")[1];
  expect(select, "account backups need a model control").toBeDefined();
  expect([...select.options].map(option => option.value)).toEqual(["old", "new"]);
  expect(select.value).toBe("old");
  expect(fixture.api.mock.calls.filter(([, options]) => options?.method === "PUT")).toHaveLength(0);
  await act(async () => { select.value = "new"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(fixture.api).toHaveBeenLastCalledWith("/api/bots/bot/limit-backup", { method: "PUT", body: JSON.stringify({ selection: { ...bot.limitBackup.selection, model: "new" }, routines: true }) });
});
it("refreshes after account changes and never substitutes the engine catalog for a removed account", async () => {
  await act(async () => root.render(createElement(LimitBackupRow, { bot: bot as never })));
  fixture.api.mockResolvedValue({ connections: [] });
  await act(async () => window.dispatchEvent(new Event("murage:provider-connections-changed")));
  const select = host.querySelectorAll("select")[1];
  expect(select, "the saved model remains visible").toBeDefined();
  expect([...select.options].map(option => option.value)).toEqual(["old"]);
  expect(select.disabled).toBe(true);
  expect(select.value).toBe("old");
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
  expect(host.textContent).toContain("Current model: old");
  expect(fixture.api.mock.calls.filter(([, options]) => options?.method === "PUT")).toHaveLength(0);
  const routines = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await act(async () => routines.click());
  expect(fixture.api).toHaveBeenLastCalledWith("/api/bots/bot/limit-backup", { method: "PUT", body: JSON.stringify({ selection: bot.limitBackup.selection, routines: false }) });
});
