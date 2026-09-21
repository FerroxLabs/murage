// THE RAIL IS A LIST, NOT A GATE.
//
// The shape is what is worth pinning here. The version this replaces put a
// modal over an app the person had not met yet, and its buttons walked them
// into a settings pane. So: no backdrop, no dialog role, no focus trap, a
// close control that is reachable from the keyboard, and one sentence saying
// out loud that closing it stops nothing.
//
// Rendered rather than read, because "it says six steps" and "it says the
// right six steps in the right order" are not the same claim. The store and
// the harness are mocked away: what the rail draws from a given view is the
// whole subject.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({
  api: async () => ({}),
  useStore: () => ({ state: {}, dispatch: () => {} }),
}));

const { FirstRunRailBody } = await import("./FirstRunRail");
const { FIRST_RUN_RAIL, firstRunRailRows } = await import("@/lib/first-run");
const { SETUP_STEPS } = await import("../../shared/setup");

type View = Parameters<typeof FirstRunRailBody>[0]["view"];
type Status = View["steps"][number]["status"];

const source = readFileSync(fileURLToPath(new URL("./FirstRunRail.tsx", import.meta.url)), "utf8");
/** The component with its prose removed. Its comments name the things it
 *  deliberately is NOT, so a scan for those names has to read the code and
 *  not the explanation of the code. */
const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");

function view(statuses: Partial<Record<string, Status>> = {}): View {
  const steps = SETUP_STEPS.map((id) => {
    const status = statuses[id] ?? "open";
    return { id, done: status === "done", ...(status === "skipped" ? { skipped: true } : {}), status };
  });
  const done = steps.filter((step) => step.done).length;
  return {
    version: 2,
    startedAt: 1,
    ownerName: "",
    engine: { ready: true },
    agents: [],
    signedOutAgents: [],
    routines: { total: 0, briefId: null, briefRan: false },
    crewSize: 0,
    fluxReady: false,
    firstRun: true,
    progress: { done, total: steps.length },
    blocked: [],
    next: steps.find((step) => !step.done && step.status !== "skipped")?.id ?? null,
    steps,
  } as View;
}

const render = (v: View = view()) =>
  renderToStaticMarkup(createElement(FirstRunRailBody, { view: v, onClose: vi.fn() }));

/** Names a row the way the product names it, rather than repeating its copy
 *  into the test and pinning the words instead of the behaviour. */
const LABELS = new Map(firstRunRailRows(view()).map((row) => [row.id as string, row.label]));
const labelFor = (id: string): string => LABELS.get(id) ?? id;

describe("the rail lists the server's six steps", () => {
  it("draws a row per step, in the order the view sent them", () => {
    const html = render();
    const positions = SETUP_STEPS.map((id) => html.indexOf(labelFor(id)));
    expect(positions.every((at) => at > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(html.match(/<li/g) ?? []).toHaveLength(SETUP_STEPS.length);
  });

  it("says how far along it is, in steps", () => {
    expect(render(view({ hello: "done", agents: "done" }))).toContain("2 of 6 done");
  });

  it("marks what is done, what was passed over and what they are on", () => {
    const html = render(view({ hello: "done", agents: "skipped" }));
    expect(html).toContain(FIRST_RUN_RAIL.state.done);
    expect(html).toContain(FIRST_RUN_RAIL.state.skipped);
    expect(html).toContain(FIRST_RUN_RAIL.state.now);
  });

  it("builds the list from the view and never from a list of its own", () => {
    // A hard-coded step list here would go stale the moment the server's
    // did, and would be able to claim progress the workspace has not earned.
    expect(code).toContain("firstRunRailRows(view)");
    for (const id of SETUP_STEPS) expect(code, id).not.toContain(`"${id}"`);
  });
});

describe("it is not a gate", () => {
  it("renders no backdrop, no dialog and no modal", () => {
    const html = render();
    expect(html).not.toMatch(/inset-0|fixed/);
    expect(html).not.toMatch(/role="dialog"|aria-modal/);
    expect(code).not.toMatch(/role="dialog"|aria-modal|autoFocus|\.focus\(\)/);
  });

  it("closes from the keyboard, with a control that says what it does", () => {
    const html = render();
    expect(html).toContain('type="button"');
    expect(html).toContain(`aria-label="${FIRST_RUN_RAIL.close}"`);
    expect(html).toContain("focus-visible:ring-2");
  });

  it("says in so many words that closing it stops nothing", () => {
    expect(render()).toContain(FIRST_RUN_RAIL.footer);
  });

  it("holds no key field and no settings road", () => {
    // Everything the first run asks for is asked in the conversation. A rail
    // that grew a second Flux field, or a button into a settings pane, would
    // be the thing this release deleted, rebuilt.
    expect(code).not.toMatch(/<input|type="password"|apiKey/);
    expect(code).not.toContain("toggleAppSettings");
  });
});

describe("it survives a dialog taking focus", () => {
  it("is not conditioned on anything a dialog changes", () => {
    // Onboarding.tsx had to early-return while Settings was open so a trip
    // there did not wipe a half-typed form. Nothing here is conditioned on a
    // panel at all, so there is no state left to lose.
    expect(code).not.toContain("appSettingsOpen");
    expect(code).not.toContain("pluginsOpen");
  });
});
