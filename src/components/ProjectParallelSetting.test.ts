// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useState: (v: unknown) => [v, () => {}] }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: { features: { projectsLead: true, roomsQueue: true, projectsParallelCards: true } } }, dispatch: vi.fn() }), api: vi.fn(async () => ({})) }));
import { api } from "@/state/store";
import { ProjectAutonomySetting } from "./ProjectAutonomySetting";
import { Switch } from "./SettingsPrimitives";
function nodes(node: unknown): ReactElement<Record<string, any>>[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  const element = node as ReactElement<Record<string, any>>;
  return [element, ...nodes(element.props?.children)];
}
it("changes parallel cards through the existing project feature settings", async () => {
  // a Switch since 0.1.62: one setting, one switch
  const control = nodes(ProjectAutonomySetting()).find(n => n.type === Switch && n.props["aria-label"] === "Parallel project cards");
  expect(control).toBeDefined(); expect(control!.props.checked).toBe(true);
  control!.props.onClick();
  await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/config", { method: "PATCH", body: JSON.stringify({ features: { projectsParallelCards: false } }) }));
});
