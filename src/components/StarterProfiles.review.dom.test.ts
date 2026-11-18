// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, settle } from "../testing/dom-harness";
import { StarterProfiles } from "./StarterProfiles";
const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({ dispatch: fixture.dispatch }) }));
const packages = ["starter-personal-home", "starter-solo-business", "starter-business-team"].map(id => JSON.parse(readFileSync(`library/packages/${id}.json`, "utf8")).package);
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(() => { cleanup(); vi.clearAllMocks(); });
for (const pkg of packages) it(`FB1 ${pkg.id}: Review profile opens instructions before any import or setup`, async () => {
  const profiles = packages.map(p => ({ ...p, id: p.id, members: p.agents.length, routines: p.routines ?? [], connectionsRequired: false }));
  fixture.api.mockImplementation(async (_path, init) => {
    const body = JSON.parse(init.body);
    if (body.action === "catalog") return { profiles };
    if (body.action === "preview") return { archiveSha256: "archive", reviewHash: "review", summary: { agents: pkg.agents.length, routines: 0 }, missingDependencies: [], scan: { blocked: false, reviewRequired: false, findings: [] }, profileText: "---\ninternal: fixture-only\n---\n\n" + pkg.playbooks.map((p: any) => p.instructions).join("\n") };
    throw new Error("Review must not import");
  });
  const app = mount(h(StarterProfiles)); await settle();
  const button = (text: string) => [...app.container.querySelectorAll("button")].find(b => b.textContent?.includes(text))!;
  await act(async () => button(pkg.name).click());
  await act(async () => button("Review profile").click());
  const review = app.container.querySelector('[aria-label="Starter profile instructions"]');
  expect(review).not.toBeNull();
  expect(review!.textContent).not.toContain("internal: fixture-only");
  expect(document.activeElement).toBe(app.container.querySelector('[aria-label="Starter import review"]'));
  for (const playbook of pkg.playbooks) expect(review!.textContent).toContain(playbook.instructions);
  expect(fixture.api.mock.calls.map(([, init]) => JSON.parse(init.body).action)).toEqual(["catalog", "preview"]);
  expect(fixture.dispatch).not.toHaveBeenCalled();
});
