// THE PHASE BAR IS A LIST, NOT A GATE.
//
// The shape is what is worth pinning here. The version this replaces put a
// modal over an app the person had not met yet, and its buttons walked them
// into a settings pane. So: no backdrop, no dialog role, no focus trap, a
// close control that is reachable from the keyboard, and one sentence saying
// out loud that closing it stops nothing.
//
// AND THE NUMBERS, which are the reason this is a bar of pills and not the
// 272px column it replaced. They are computed from the phases actually shown,
// so a machine with nothing to think with is numbered one to four rather than
// being shown a phase it will never be offered.
//
// Rendered rather than read, because "it says five phases" and "it says the
// right five phases in the right order" are not the same claim. The store and
// the harness are mocked away: what the bar draws from a given view is the
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

const { FirstRunPhasesBody } = await import("./FirstRunPhases");
const { FIRST_RUN_PHASES, firstRunPhaseRows } = await import("@/lib/first-run");
const { SETUP_STEPS } = await import("../../shared/setup");

type View = Parameters<typeof FirstRunPhasesBody>[0]["view"];
type Status = View["steps"][number]["status"];

const source = readFileSync(fileURLToPath(new URL("./FirstRunPhases.tsx", import.meta.url)), "utf8");
/** The component with its prose removed. Its comments name the things it
 *  deliberately is NOT, so a scan for those names has to read the code and
 *  not the explanation of the code. */
const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");

function view(statuses: Partial<Record<string, Status>> = {}, over: Partial<View> = {}): View {
  const steps = SETUP_STEPS.map((id) => {
    const status = statuses[id] ?? "open";
    return { id, done: status === "done", ...(status === "skipped" ? { skipped: true } : {}), status };
  });
  const done = steps.filter((step) => step.done).length;
  return {
    version: 3,
    startedAt: 1,
    ownerName: "",
    engine: { ready: true },
    agents: [],
    signedOutAgents: [],
    routines: { total: 0, briefId: null, briefRan: false },
    crewSize: 0,
    fluxReady: false,
    nothingToThinkWith: false,
    connectedJobApps: [],
    firstRun: true,
    progress: { done, total: steps.length },
    blocked: [],
    next: steps.find((step) => !step.done && step.status !== "skipped")?.id ?? null,
    steps,
    ...over,
  } as View;
}

const render = (v: View = view()) =>
  renderToStaticMarkup(createElement(FirstRunPhasesBody, { view: v, onClose: vi.fn() }));

/** Names a pill the way the product names it, rather than repeating its copy
 *  into the test and pinning the words instead of the behaviour. */
const LABELS = new Map(firstRunPhaseRows(view()).map((row) => [row.id as string, row.label]));
const labelFor = (id: string): string => LABELS.get(id) ?? id;

describe("the bar lists the server's five phases", () => {
  it("draws a pill per step, in the order the view sent them", () => {
    const html = render();
    const positions = SETUP_STEPS.map((id) => html.indexOf(labelFor(id)));
    expect(positions.every((at) => at > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(html.match(/<li/g) ?? []).toHaveLength(SETUP_STEPS.length);
  });

  it("numbers them from one, in the order they are shown", () => {
    const rows = firstRunPhaseRows(view());
    expect(rows.map((row) => row.number)).toEqual([1, 2, 3, 4, 5]);
    const html = render();
    for (const row of rows) expect(html, row.label).toContain(row.label);
  });

  it("marks what is done, what was passed over and what they are on", () => {
    const html = render(view({ hello: "done", detect: "skipped" }));
    expect(html).toContain(FIRST_RUN_PHASES.state.done);
    expect(html).toContain(FIRST_RUN_PHASES.state.skipped);
    expect(html).toContain(FIRST_RUN_PHASES.state.now);
    // ...and the one they are on is said in the word ARIA has for it, not
    // only in a border colour.
    expect(html.match(/aria-current="step"/g) ?? []).toHaveLength(1);
  });

  it("builds the list from the view and never from a list of its own", () => {
    // A hard-coded step list here would go stale the moment the server's
    // did, and would be able to claim progress the workspace has not earned.
    expect(code).toContain("firstRunPhaseRows(view)");
    for (const id of SETUP_STEPS) expect(code, id).not.toContain(`"${id}"`);
  });
});

// THE MACHINE WITH NOTHING ON IT SEES FOUR, NOT FIVE.
//
// A clean install used to dead-end: it was held on a step that needed a usable
// model, and the key that would have provided one sat behind that step. The
// five-step cut fixes it by skipping detection entirely on such a machine, and
// the bar has to agree. A second pill sitting crossed off, for a report that
// was never written, says the flow did something it did not do.
describe("a machine with nothing to think with", () => {
  const blank = () =>
    view({ detect: "done" }, { nothingToThinkWith: true, next: "flux" });

  it("drops the phase that is never shown and renumbers what is left", () => {
    const rows = firstRunPhaseRows(blank());
    expect(rows.map((row) => row.id)).toEqual(["hello", "flux", "chat", "flow"]);
    expect(rows.map((row) => row.number)).toEqual([1, 2, 3, 4]);
    const html = render(blank());
    expect(html.match(/<li/g) ?? []).toHaveLength(4);
    expect(html).not.toContain(labelFor("detect"));
  });

  it("still draws it when the server says that phase is open", () => {
    // `nothingToThinkWith` with an unsettled `detect` is a contradiction, and
    // hiding a step the person is still being asked to take is the worse of
    // the two answers to one.
    const rows = firstRunPhaseRows(view({}, { nothingToThinkWith: true, next: "detect" }));
    expect(rows.map((row) => row.id)).toEqual([...SETUP_STEPS]);
    expect(rows.find((row) => row.id === "detect")?.mark).toBe("now");
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
    expect(html).toContain(`aria-label="${FIRST_RUN_PHASES.close}"`);
    expect(html).toContain("focus-visible:ring-2");
  });

  it("says in so many words that closing it stops nothing", () => {
    // Said to the accessibility tree rather than printed across a strip of
    // pills, and wired to the bar so it is actually announced: an orphan
    // paragraph nothing points at is not a promise anybody hears.
    const html = render();
    expect(html).toContain(FIRST_RUN_PHASES.footer);
    const described = html.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(described).toBeTruthy();
    expect(html).toContain(`id="${described}"`);
    const paragraph = html.slice(html.indexOf(`id="${described}"`));
    expect(paragraph.slice(0, paragraph.indexOf("</p>"))).toContain(FIRST_RUN_PHASES.footer);
  });

  it("holds no key field and no settings road", () => {
    // Everything the first run asks for is asked in the conversation. A bar
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
