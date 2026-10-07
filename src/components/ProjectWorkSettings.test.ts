// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import en from "@/locales/en.json";
it("pins admission wording and lazy work settings",()=>{
  const settings=readFileSync(new URL("./ProjectWorkSettings.tsx",import.meta.url),"utf8");
  // The copy lives in the en catalogue; the component must read it from there.
  expect(en["projects.work.budgetHint"]).toContain("stops starting new work at your limit");
  expect(en["projects.work.foldersHint"]).toContain("Work folders limit what Murage approves for you.");
  expect(settings).toContain('t("projects.work.budgetHint")');
  expect(settings).toContain('t("projects.work.foldersHint")');
  expect(readFileSync(new URL("./ProjectStripDetails.tsx",import.meta.url),"utf8")).toContain('import("./ProjectWorkSettings")');
});

// Render the existing component with hook state fixed, then invoke the actual handlers.

import type { ReactElement } from "react";
import type { ProjectRead } from "@/lib/project-client";
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useId: () => "profile", useState: (value: unknown) => [value, () => {}] }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { groups: [], bots: [] } }) }));
vi.mock("@/lib/use-project", () => ({ projectClient: { parallelCards: vi.fn(async () => ({ ok: true })), roots: vi.fn(async () => ({ ok: true })) }, refreshProject: vi.fn() }));
import ProjectWorkSettings from "./ProjectWorkSettings";
import { projectClient } from "@/lib/use-project";
function nodes(node: unknown): ReactElement<Record<string, any>>[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  const element = node as ReactElement<Record<string, any>>;
  return [element, ...nodes(element.props?.children)];
}
const read = () => ({ lifecycle: "open", settings: { revision: 1, runState: "paused", workRoots: [{ path: "/work/one", label: "One", dev: "1", ino: "2", addedAt: 1 }, { path: "/work/two", label: "Two", dev: "1", ino: "3", addedAt: 1 }] }, goal: { id: "current", state: "working" }, budgets: [] }) as unknown as ProjectRead;
it("F12 add and remove send only root paths and labels", async () => {
  Object.assign(globalThis, { window: { muragebox: { pickFolder: async () => "/work/new" } } });
  const tree = nodes(ProjectWorkSettings({ groupId: "g", project: read() }));
  tree.find(n => n.type === "button" && n.props.children === "Remove One")!.props.onClick();
  await vi.waitFor(() => expect(projectClient.roots).toHaveBeenCalledWith("g", 1, [{ path: "/work/two", label: "Two" }]));
  tree.find(n => n.type === "button" && n.props.children === "Choose folder")!.props.onClick();
  await vi.waitFor(() => expect(projectClient.roots).toHaveBeenLastCalledWith("g", 1, [{ path: "/work/one", label: "One" }, { path: "/work/two", label: "Two" }, { path: "/work/new", label: "new" }]));
});
it("F13 Resume ignores stopped goals but respects the current goal and period budgets", () => {
  Object.assign(globalThis, { window: {} });
  const project = read();
  const disabled = () => nodes(ProjectWorkSettings({ groupId: "g", project })).find(n => n.type === "button" && n.props.children === "Resume project")!.props.disabled;
  project.budgets = [{ id: "old", goalId: "stopped", state: "paused" }] as ProjectRead["budgets"];
  expect(disabled()).toBe(false);
  project.budgets.push({ id: "live", goalId: "current", state: "paused" } as ProjectRead["budgets"][number]);
  expect(disabled()).toBe(true);
  project.budgets = [{ id: "period", goalId: null, state: "paused" }] as ProjectRead["budgets"];
  expect(disabled()).toBe(true);
});

it('C11 hides Resume while closing', () => {
  const project={...read(),closing:true,closeStep:1};
  expect(nodes(ProjectWorkSettings({groupId:'g',project})).filter(n=>n.type==='button'&&n.props.children==='Resume project')).toHaveLength(0);
});

it("Cards at once sends a revision-fenced setting and is unavailable off desktop", async () => {
  Object.assign(globalThis, { window: { muragebox: { pickFolder: async () => null } } });
  const project = read(); project.settings.parallelCards = 3;
  const control = () => nodes(ProjectWorkSettings({ groupId: "g", project })).find(n => n.type === "select" && n.props.value === 3)!;
  expect(control()).toBeDefined();
  expect(nodes(control()).filter(n => n.type === "option").map(n => n.props.value)).toEqual([1, 2, 3, 4, 5]);
  control().props.onChange({ target: { value: "5" } });
  await vi.waitFor(() => expect(projectClient.parallelCards).toHaveBeenCalledWith("g", 1, 5));
  Object.assign(globalThis, { window: {} }); expect(control().props.disabled).toBe(true);
  Object.assign(globalThis, { window: { muragebox: { pickFolder: async () => null } } });
  project.lifecycle = "closed"; expect(control().props.disabled).toBe(true);
});

it("saves a language-neutral fallback folder name, whatever the app language", async () => {
  const { setLocale } = await import("@/lib/i18n");
  await setLocale("de");
  try {
    Object.assign(globalThis, { window: { muragebox: { pickFolder: async () => "/" } } });
    (projectClient.roots as ReturnType<typeof vi.fn>).mockClear();
    const tree = nodes(ProjectWorkSettings({ groupId: "g", project: read() }));
    tree.find(n => n.type === "button" && n.props.children === "Ordner auswählen")!.props.onClick();
    await vi.waitFor(() => expect(projectClient.roots).toHaveBeenCalledWith("g", 1, [{ path: "/work/one", label: "One" }, { path: "/work/two", label: "Two" }, { path: "/", label: "Work folder" }]));
  } finally { await setLocale("en"); }
});
