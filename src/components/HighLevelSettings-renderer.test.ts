// @vitest-environment jsdom
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { defaultHighLevelFamilies, type HighLevelBotAccess } from "../../shared/highlevel";
import { HighLevelSettings, type HighLevelView } from "./HighLevelSettings";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const fake = vi.hoisted(() => ({ api: vi.fn(), bots: [{ id: "b1", name: "Fixture bot" }] }));
vi.mock("@/state/store", () => ({ api: fake.api, useStore: () => ({ state: { bots: fake.bots } }) }));
let root: Root | undefined, container: HTMLDivElement;
const connectionId = "hl_fixture";
const families = () => ({ ...defaultHighLevelFamilies(), contacts: "full" as const, forms: "off" as const, payments: "change" as const });
const scope = { present: ["contacts.write"], missing: [], missingNames: [], canRead: true, canChange: true, canFull: true };
async function mount(patch: Partial<HighLevelView> = {}) {
  const access = { grantsVersion: 2, roleBinding: "owner", revision: 1, denyRules: [], grants: [{ toolkit: "highlevel", accountId: connectionId, botId: "b1", revision: 1,
    ceiling: "propose", tools: [], families: families(), operations: { contacts: ["contacts.get", "contacts.tags.add"] } }] } as HighLevelBotAccess;
  const view: HighLevelView = { tokenSaved: true, redacted: false, connection: { connectionId, locationId: "loc_fixture", state: "connected", confirmedAt: "fixture" },
    bots: [{ botId: "b1", offered: true, access }], familyScopes: { contacts: scope, payments: scope }, ...patch };
  fake.api.mockReset(); fake.api.mockResolvedValue(view);
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(HighLevelSettings)));
  return view;
}
async function click(element: Element | undefined | null) {
  expect(element).toBeTruthy(); await act(async () => (element as HTMLElement).click());
}
const button = (text: string) => [...container.querySelectorAll("button")].find(row => row.textContent === text);
const writes = () => fake.api.mock.calls.filter(([, init]) => init?.method === "PUT");
const payload = () => JSON.parse(writes().at(-1)![1].body);
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; container?.remove(); });

it("Simple downgrade preserves Off families and downgrades every existing write family to read", async () => {
  await mount();
  expect(container.querySelectorAll('[role="switch"]')).toHaveLength(1);
  expect(container.querySelectorAll("select")).toHaveLength(0);
  await click(container.querySelector('[role="switch"]'));
  expect(payload()).toEqual({ grants: [{ connectionId, families: { ...families(), contacts: "read", payments: "read" } }] });
  expect(payload().grants[0]).not.toHaveProperty("broaden");
});

it("Advanced downgrade preserves operation restrictions and revokes explicitly", async () => {
  await mount(); await click(button("Advanced"));
  const select = container.querySelector('select[aria-label="Contacts"]') as HTMLSelectElement;
  expect(select.value).toBe("full");
  await act(async () => { select.value = "change"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(payload().grants[0].families).toEqual({ ...families(), contacts: "change" });
  expect(payload().grants[0]).not.toHaveProperty("broaden");
  await click(button("Remove access")); expect(payload()).toEqual({ grants: [] });
});

it("Advanced explicitly upgrades one family to Full control", async () => {
  await mount({ familyScopes: { contacts: scope, payments: scope, users: scope } }); await click(button("Advanced"));
  const select = container.querySelector('select[aria-label="Users"]') as HTMLSelectElement;
  await act(async () => { select.value = "full"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(payload().grants[0].families).toEqual({ ...families(), users: "full" });
  expect(payload().grants[0].broaden).toEqual({ users: true });
});

it("unverified scopes disable write upgrades while an owner can still revoke", async () => {
  await mount({ familyScopes: {}, bots: [{ botId: "b1", offered: true }] });
  expect((container.querySelector('[role="switch"]') as HTMLButtonElement).disabled).toBe(true);
  await click(button("Advanced"));
  for (const option of container.querySelectorAll('option[value="change"], option[value="full"]')) expect((option as HTMLOptionElement).disabled).toBe(true);
  await click(button("Remove access")); expect(payload()).toEqual({ grants: [] });
});

it("redacted phone status cannot enable changes", async () => {
  await mount({ redacted: true, familyScopes: undefined, bots: [{ botId: "b1", offered: true, level: "read" }] });
  await click(container.querySelector('[role="switch"]')); expect(writes()).toHaveLength(0);
  await click(button("Advanced"));
  for (const select of container.querySelectorAll("select")) expect(select.disabled).toBe(true);
});
