// @vitest-environment jsdom
// Settings v10 A3 (owner: sv10-tools): the Tools page draws 21 rows, the Web search row switch writes the Off contract
// (and asks before bringing back a paid choice), the reader switch writes webRead, and the Which bots sheet writes one tool per request.
import { act, createElement as h } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, settle } from "../../../testing/dom-harness";
import ToolsPage from "./ToolsPage";

const fixture = vi.hoisted(() => ({ state: { config: null as any, bots: [] as any[] }, dispatch: vi.fn(), api: vi.fn(async (_path: string, _init?: RequestInit): Promise<any> => ({})) }));
vi.mock("@/state/store", async original => ({ ...(await original<typeof import("@/state/store")>()), useStore: () => fixture, api: fixture.api }));
vi.mock("../../SearchSettings", () => ({ SearchSettings: () => null }));

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => { fixture.api.mockClear(); fixture.dispatch.mockClear(); fixture.state.bots = [{ id: "b1", name: "Scout" }, { id: "b2", name: "Basil", toolsOff: ["images"] }]; });
afterEach(async () => { cleanup(); await settle(); document.body.replaceChildren(); });
const show = (config: Record<string, unknown>) => { fixture.state.config = config; mount(h(ToolsPage, { page: "tools", mode: "advanced", desktop: true, cloud: false, anchor: null } as never)); };
const row = (id: string) => document.querySelector(`[data-tool-row="${id}"]`)!;

it("draws the 21 rows in page order", () => {
  show({ webSearch: { provider: "engine" } });
  expect([...document.querySelectorAll("[data-tool-row]")].map(r => r.getAttribute("data-tool-row"))).toHaveLength(21);
  expect(document.querySelector("[data-tool-row]")!.getAttribute("data-tool-row")).toBe("web-search");
  expect(row("images").textContent).toContain("Off for 1 bot");
  expect(row("web-search").textContent).toContain("On for every bot");
});

it("the Web search switch writes off and remembers the choice; the reader switch writes webRead", async () => {
  show({ webSearch: { provider: "tavily" } });
  await act(async () => { row("web-search").querySelector<HTMLElement>('[role="switch"]')!.click(); });
  expect(fixture.api).toHaveBeenCalledWith("/api/config", expect.objectContaining({ method: "PUT", body: JSON.stringify({ webSearch: { provider: "off" }, webSearchLast: "tavily" }) }));
  await act(async () => { row("web-read").querySelector<HTMLElement>('[role="switch"]')!.click(); });
  expect(fixture.api).toHaveBeenCalledWith("/api/config", expect.objectContaining({ body: JSON.stringify({ webRead: { enabled: false } }) }));
});

it("turning Web search back on to a paid choice asks first and writes nothing until yes", async () => {
  show({ webSearch: { provider: "off", lastProvider: "tavily" } });
  await act(async () => { row("web-search").querySelector<HTMLElement>('[role="switch"]')!.click(); });
  expect(fixture.api).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("tavily");
  await act(async () => { [...document.querySelectorAll("button")].find(b => b.textContent === "Turn on")!.click(); });
  expect(fixture.api).toHaveBeenCalledWith("/api/config", expect.objectContaining({ body: JSON.stringify({ webSearch: { provider: "tavily" } }) }));
});

it("the Which bots sheet writes one tool for one bot", async () => {
  show({ webSearch: { provider: "engine" } });
  await act(async () => { [...row("images").querySelectorAll("button")].find(b => b.textContent === "Open")!.click(); });
  const sheet = document.querySelector("[data-tools-sheet]")!;
  fixture.api.mockResolvedValueOnce({ bot: { id: "b1", name: "Scout", toolsOff: ["images"] } });
  await act(async () => { sheet.querySelector<HTMLElement>('[aria-label="Scout"]')!.click(); });
  expect(fixture.api).toHaveBeenCalledWith("/api/bots/b1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ toolOff: { tool: "images", off: true } }) }));
});

it("the Web search sheet lists every engine in the routing table, from the table", async () => {
  show({ webSearch: { provider: "engine" } });
  await act(async () => { [...row("web-search").querySelectorAll("button")].find(b => b.textContent === "Open")!.click(); });
  const { WEB_READ_ROUTING } = await import("../../../../shared/web-read-routing");
  const listed = [...document.querySelectorAll("[data-reader]")];
  expect(listed.map(l => l.getAttribute("data-reader"))).toEqual(Object.keys(WEB_READ_ROUTING));
  expect(listed.filter(l => l.getAttribute("data-enforced") === "false")).toHaveLength(Object.values(WEB_READ_ROUTING).filter(r => r.limitation).length);
});
