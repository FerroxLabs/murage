// EnginesSettings renders ClaudeAccountsSettings under the Claude engine
// family (or once, standalone, when no Claude engine is listed) and hands it
// the store's refreshInstances as onChanged: the "fleet" the section refreshes
// after each of its own changes (CLAC3). This pins that wiring by rendering
// the page over a fake store and reading the props the section received,
// not by matching the component's source text (FOLLOW4, CLAC3 verifier).
// The interactive half of the contract — busy spans only the section's own
// request, the fleet refresh runs after busy clears, serialized, and a failed
// fleet refresh is reported — is pinned at the hook level in
// src/components/ClaudeAccountsSettings.test.ts ("claudeAccountChanger"), over
// the wire below (a fake fetch stands in for `api`, and a fake refreshInstances
// does what the store's does: one GET /api/instances per call — FOLLOW6), and
// in the browser by src/e2e/claude-accounts.human.spec.ts ("stays usable while
// the engine list re-probes", "reports an engine list that could not refresh");
// the renderer suite has no DOM to click in.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstanceInfo } from "@/state/store";

const { store, sections } = vi.hoisted(() => ({
  store: { instances: [] as unknown[], shellEnvironment: null as unknown, refreshInstances: async () => {}, dispatch: () => {} },
  sections: [] as Array<{ onChanged?: () => Promise<void> }>,
}));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({ state: { ...original.initialState, instances: store.instances, shellEnvironment: store.shellEnvironment as never }, dispatch: store.dispatch, refreshInstances: store.refreshInstances, flushBotPatches: async () => {} }),
    api: async () => { throw new Error("no network in this test"); },
  };
});
vi.mock("./ClaudeAccountsSettings", async (importOriginal) => {
  const original = await importOriginal<typeof import("./ClaudeAccountsSettings")>();
  return {
    ...original,
    ClaudeAccountsSettings: (props: { onChanged?: () => Promise<void> }) => { sections.push(props); return createElement("section", { "aria-label": "Claude accounts" }); },
  };
});
import { EnginesSettings, shellEnvironmentLine } from "./EnginesSettings";
import { AdvancedHost } from "./SettingsPrimitives";
import { claudeAccountChanger } from "./ClaudeAccountsSettings";

const instance = (instanceId: string, driverKind: string, displayName: string): InstanceInfo => ({
  instanceId, driverKind, displayName, enabled: true, cliDefault: driverKind,
  snapshot: { state: "available", authenticated: true, version: "1.0.0" },
  models: { default: "m", options: [{ id: "m", label: "Model" }] },
} as InstanceInfo);

afterEach(() => { sections.length = 0; store.instances = []; store.shellEnvironment = null; });

// Gap (b) of steps 1..3 (Rule 74a): the server sends a kept or fallback capture, and the panel says so
describe("the shell environment line", () => {
  it("says nothing for this session's capture and names a kept or fallback one with its cause", () => {
    expect(shellEnvironmentLine(null)).toBeNull();
    expect(shellEnvironmentLine({ capture: "session" })).toBeNull();
    const kept = shellEnvironmentLine({ capture: "kept", capturedAt: Date.UTC(2026, 9, 1, 12, 0), cause: "the shell exited 3" }, "en-US")!;
    expect(kept).toMatch(/^Using your shell environment from .*2026.*; Murage could not re-read it: the shell exited 3$/);
    expect(shellEnvironmentLine({ capture: "fallback", cause: "timed out" })).toBe("Murage could not read your shell startup; commands run with the app's own environment: timed out");
    for (const line of [kept, shellEnvironmentLine({ capture: "fallback" })!]) expect(line).not.toMatch(/—|\bsafe|unsafe|safety/i);
  });

  it("shows the line at the top of the Engines panel", () => {
    store.instances = [instance("codex", "codex", "Codex")];
    store.shellEnvironment = { capture: "fallback", cause: "no HOME" };
    const markup = renderToStaticMarkup(createElement(EnginesSettings));
    expect(markup).toContain("commands run with the app&#x27;s own environment: no HOME");
    store.shellEnvironment = { capture: "session" };
    expect(renderToStaticMarkup(createElement(EnginesSettings))).not.toContain("shell startup");
  });

  // APP-GRANT-FIXPLAN-r6 (e)+(h) displaced-settings rule: one line per replaced owner ssh setting
  it("shows each ssh line the server sends, on a session capture too", () => {
    store.instances = [instance("codex", "codex", "Codex")];
    store.shellEnvironment = { capture: "session", sshNotes: ["Engines use plain ssh for git instead of your GIT_SSH_COMMAND (ssh; id), because it runs more than one command and Murage could not stop it asking for a password. Your own git is unchanged."] };
    const markup = renderToStaticMarkup(createElement(EnginesSettings));
    expect(markup).toContain("instead of your GIT_SSH_COMMAND (ssh; id)");
  });
});

describe("EnginesSettings", () => {
  it("renders one Claude accounts section under the Claude family, with the store's refreshInstances as its fleet", () => {
    const refreshInstances = vi.fn(async () => {});
    store.refreshInstances = refreshInstances;
    store.instances = [instance("claude", "claudeAgent", "Claude"), instance("claude-work", "claudeAgent", "Work"), instance("codex", "codex", "Codex")];
    const markup = renderToStaticMarkup(createElement(EnginesSettings));
    expect(markup.match(/aria-label="Claude accounts"/g)).toHaveLength(1);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.onChanged).toBe(refreshInstances);
    // Inside the Claude family's section, after its rows, not after Codex.
    const claude = markup.indexOf(">Claude<"), codex = markup.indexOf(">Codex<"), accounts = markup.indexOf('aria-label="Claude accounts"');
    expect(claude).toBeGreaterThanOrEqual(0);
    expect(accounts).toBeGreaterThan(claude);
    expect(codex).toBeGreaterThan(accounts);
  });

  // The family eyebrow repeated the row directly beneath it: `engineFamilies`
  // picks `primary` out of `members`, so a family of one drew its engine's
  // name as an uppercase heading and then again as its only row ("DROID /
  // Droid"). Same defect, and now the same rule, as the model picker's engine
  // list (`engineFamilyHeader`). The card's own border is the section
  // boundary, so nothing is left unanchored by dropping it.
  it("gives a family of one no eyebrow, so the card does not print the engine's name twice", () => {
    store.instances = [instance("droid", "droidAgent", "Droid"), instance("codex", "codex", "Codex")];
    // Inside the page's Advanced host: the command lines wait in Advanced and are not drawn on the first screen.
    const markup = renderToStaticMarkup(createElement(AdvancedHost, null, createElement(EnginesSettings)));
    // Drawn text only (tags stripped): the truncation `title` on the row is
    // not something a person reads off the screen.
    const drawn = markup.replace(/<[^>]*>/g, "|");
    expect(drawn.match(/Droid/g)).toHaveLength(1);
    expect(drawn.match(/Codex/g)).toHaveLength(1);
    expect(markup).not.toContain("uppercase tracking-[0.08em]");
  });

  it("keeps the eyebrow for a family that groups more than one connection, where it is the only thing grouping them", () => {
    store.instances = [instance("claude", "claudeAgent", "Claude"), instance("claude-work", "claudeAgent", "Claude work"), instance("codex", "codex", "Codex")];
    const markup = renderToStaticMarkup(createElement(EnginesSettings));
    // One eyebrow in the whole pane, and it is Claude's.
    expect(markup.match(/uppercase tracking-\[0\.08em\]/g)).toHaveLength(1);
    const eyebrow = markup.indexOf("uppercase tracking-[0.08em]");
    expect(markup.slice(eyebrow, eyebrow + 200)).toContain("Claude");
    expect(markup).toContain("Other accounts and installations");
  });

  it("renders the section once, standalone, when no Claude engine is listed", () => {
    const refreshInstances = vi.fn(async () => {});
    store.refreshInstances = refreshInstances;
    store.instances = [instance("codex", "codex", "Codex")];
    const markup = renderToStaticMarkup(createElement(EnginesSettings));
    expect(markup.match(/aria-label="Claude accounts"/g)).toHaveLength(1);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.onChanged).toBe(refreshInstances);
    expect(markup.indexOf('aria-label="Claude accounts"')).toBeGreaterThan(markup.indexOf(">Codex<"));
  });
});

// The sequence the wiring above commits to, driven over a fake fetch rather
// than through the hooks the other test fakes. `fetch` answers each request
// when the test says so, so the order of departures and of busy is observable:
// busy spans the change request and the section's own GET /api/claude-accounts
// only; GET /api/instances (the store's refreshInstances) leaves after busy
// clears; and a second change made while the first fleet probe is still out
// sends its own probe only after the first answered.
describe("claudeAccountChanger over the wire (EnginesSettings wiring)", () => {
  type Pending = { url: string; method: string; resolve: (body: unknown) => void; reject: (cause: unknown) => void };
  const wire = () => {
    const log: string[] = [], pending: Pending[] = [];
    const fetch = (url: string, init?: { method?: string }) => new Promise<unknown>((resolve, reject) => {
      const method = init?.method ?? "GET";
      log.push(`→ ${method} ${url}`);
      pending.push({ url, method, resolve, reject });
    });
    const answer = (method: string, url: string, body: unknown = {}) => {
      const index = pending.findIndex(request => request.method === method && request.url === url);
      if (index < 0) throw new Error(`no pending ${method} ${url}; pending: ${pending.map(r => `${r.method} ${r.url}`).join(", ") || "none"}`);
      const [request] = pending.splice(index, 1);
      log.push(`← ${method} ${url}`);
      if (body instanceof Error) request!.reject(body); else request!.resolve(body);
    };
    // What the store's refreshInstances does, minus the dispatch: one GET
    // /api/instances per call, rejecting when it fails (FOLLOW4).
    const refreshInstances = async () => { await fetch("/api/instances"); };
    const change = claudeAccountChanger({
      request: (method, id, body) => fetch(`/api/claude-accounts${id ? `/${id}` : ""}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }),
      draw: method => log.push(`draw ${method}`),
      load: async () => { await fetch("/api/claude-accounts"); },
      fleet: () => refreshInstances(),
      busy: value => log.push(`busy ${value}`),
      error: message => log.push(`error ${message}`),
    });
    const inFlight = () => pending.map(request => `${request.method} ${request.url}`);
    return { log, change, answer, inFlight };
  };
  const account = { instanceId: "claude-work", displayName: "Work", managed: true, isDefault: false, configDir: "/fixture/claude-work", signInCommand: "claude login", signInShell: "sh" };
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  it("greys the section for its own request and list only; the fleet probe leaves after busy clears", async () => {
    const { log, change, answer, inFlight } = wire();
    const done = change("POST", undefined, { displayName: "Work" });
    await settle();
    expect(log).toEqual(["busy true", "→ POST /api/claude-accounts"]);
    answer("POST", "/api/claude-accounts", { account });
    await settle();
    expect(log.slice(2)).toEqual(["← POST /api/claude-accounts", "draw POST", "→ GET /api/claude-accounts"]);
    expect(inFlight()).toEqual(["GET /api/claude-accounts"]);
    answer("GET", "/api/claude-accounts", { accounts: [account] });
    await settle();
    // busy is cleared before the fleet probe is requested, not after it answers.
    expect(log.slice(5)).toEqual(["← GET /api/claude-accounts", "busy false", "→ GET /api/instances"]);
    expect(inFlight()).toEqual(["GET /api/instances"]);
    let finished = false; void done.then(() => { finished = true; });
    await settle();
    expect(finished).toBe(false);
    answer("GET", "/api/instances", { instances: [] });
    await done;
    expect(log.filter(entry => entry.startsWith("busy"))).toEqual(["busy true", "busy false"]);
    expect(log.filter(entry => entry.startsWith("error"))).toEqual([]);
  });

  it("serializes the fleet probe across two rapid changes: the second GET /api/instances leaves only after the first answered", async () => {
    const { log, change, answer, inFlight } = wire();
    const first = change("POST", undefined, { displayName: "Work" });
    await settle();
    answer("POST", "/api/claude-accounts", { account });
    await settle();
    answer("GET", "/api/claude-accounts", { accounts: [account] });
    await settle();
    expect(inFlight()).toEqual(["GET /api/instances"]);
    // The section is usable again while the first probe is out: the rename
    // is taken, greys the section for its own request and list, and clears.
    const second = change("PATCH", "claude-work", { displayName: "Work renamed" });
    await settle();
    expect(inFlight()).toEqual(["GET /api/instances", "PATCH /api/claude-accounts/claude-work"]);
    answer("PATCH", "/api/claude-accounts/claude-work", { account: { ...account, displayName: "Work renamed" } });
    await settle();
    answer("GET", "/api/claude-accounts", { accounts: [{ ...account, displayName: "Work renamed" }] });
    await settle();
    // Only one fleet probe is out; the second waits for the first to answer.
    expect(inFlight()).toEqual(["GET /api/instances"]);
    expect(log.filter(entry => entry === "→ GET /api/instances")).toHaveLength(1);
    answer("GET", "/api/instances", { instances: [] });
    await first;
    await settle();
    expect(inFlight()).toEqual(["GET /api/instances"]);
    expect(log.filter(entry => entry === "→ GET /api/instances")).toHaveLength(2);
    answer("GET", "/api/instances", { instances: [] });
    await second;
    expect(log).toEqual([
      "busy true", "→ POST /api/claude-accounts", "← POST /api/claude-accounts", "draw POST", "→ GET /api/claude-accounts", "← GET /api/claude-accounts", "busy false",
      "→ GET /api/instances",
      "busy true", "→ PATCH /api/claude-accounts/claude-work", "← PATCH /api/claude-accounts/claude-work", "draw PATCH", "→ GET /api/claude-accounts", "← GET /api/claude-accounts", "busy false",
      "← GET /api/instances", "→ GET /api/instances", "← GET /api/instances",
    ]);
  });

  it("reports a fleet probe that failed as the engine list's problem, after the change was saved and drawn", async () => {
    const { log, change, answer } = wire();
    const done = change("DELETE", "claude-work");
    await settle();
    answer("DELETE", "/api/claude-accounts/claude-work", { removed: true });
    await settle();
    answer("GET", "/api/claude-accounts", { accounts: [] });
    await settle();
    answer("GET", "/api/instances", new Error("Failed to fetch"));
    await done;
    expect(log).toEqual([
      "busy true", "→ DELETE /api/claude-accounts/claude-work", "← DELETE /api/claude-accounts/claude-work", "draw DELETE", "→ GET /api/claude-accounts", "← GET /api/claude-accounts", "busy false",
      "→ GET /api/instances", "← GET /api/instances",
      "error Saved, but the engine list could not refresh. Switch to another window and back to probe the engines again.",
    ]);
  });
});

describe("the engine command lines", () => {
  it("draw inline without a page host, with Set CLI and Reset out of the engine rows", () => {
    store.instances = [{ ...instance("codex", "codex", "Codex"), cli: "/opt/codex" } as InstanceInfo];
    const markup = renderToStaticMarkup(createElement(EnginesSettings));
    expect(markup).toContain('id="engine-command-lines-heading"');
    expect(markup).toContain("Engine command lines");
    expect(markup.match(/Choose location…/g)).toHaveLength(1);
    const hosted = renderToStaticMarkup(createElement(AdvancedHost, null, createElement(EnginesSettings)));
    expect(hosted).not.toContain("Choose location…");
    expect(hosted).not.toContain("Engine command lines");
  });
});
