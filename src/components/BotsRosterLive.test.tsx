// @vitest-environment jsdom
// Settings v10 A9-bots: the Bots container's confirm handler. Only bots the owner ticked "Set to Auto" for on this computer
// are saved; an unticked one never sees a PATCH, so its this-computer answer is never recorded.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BotsRosterLive from "./BotsRosterLive";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
const bots = [
  { id: "n1", name: "Nova", computer: "local", autoApprove: false, fullAccess: false, noLimits: false },
  { id: "n2", name: "Orion", computer: "local", autoApprove: false, fullAccess: false, noLimits: false },
  { id: "n3", name: "Vega", computer: "local", autoApprove: false, fullAccess: false, noLimits: false },
];
vi.mock("@/state/store", () => ({
  api: mocks.api,
  fromAnswer: () => ({}),
  useStore: () => ({ state: { bots, config: null } }),
  useStoreActions: () => ({ dispatch: vi.fn(), flushBotPatches: async () => {} }),
}));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: { host: { platform: "darwin" } } }) }));

let root: Root, host: HTMLDivElement;
const q = (selector: string) => document.querySelector<HTMLElement>(selector)!;
const click = async (el: HTMLElement) => { await act(async () => el.click()); };
const patches = () => mocks.api.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH").map(([path, init]) => ({ path: String(path), body: JSON.parse(String((init as RequestInit).body)) }));

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.api.mockReset();
  mocks.api.mockImplementation(async (_path: string, init?: RequestInit) =>
    init?.method === "PATCH" ? { permissionRev: 2 } : { previewId: "p", botRev: 1, rosterId: "r", targetLevel: "auto", botLevel: "ask", eligible: [], skipped: [], routines: [] });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(BotsRosterLive)));
  for (const name of ["Nova", "Orion", "Vega"]) await click(q(`input[aria-label="Select ${name}"]`));
  await click(q('[data-bots-action="apply"]'));
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); });

describe("BotsRosterLive confirm", () => {
  it("saves only the bots ticked Set to Auto and leaves the unticked ones at Ask without a PATCH", async () => {
    await click(q('input[aria-label="Set Orion to Auto on this computer"]'));
    await click(q('[data-level-review="confirm"]'));
    const sent = patches();
    expect(sent.map((p) => p.path)).toEqual(["/api/bots/n2"]);
    expect(sent[0]!.body).toMatchObject({ autoApprove: true, acknowledgeLocalAuto: true });
    expect(document.body.textContent).toContain("Nova: left at Ask");
    expect(document.body.textContent).toContain("Vega: left at Ask");
  });
  it("sends nothing when no bot is ticked", async () => {
    await click(q('[data-level-review="confirm"]'));
    expect(patches()).toEqual([]);
    expect(document.body.textContent).toContain("Orion: left at Ask");
  });
});
