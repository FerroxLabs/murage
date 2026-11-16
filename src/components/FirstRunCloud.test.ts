// THE FIRST RUN ON A CLOUD HOME, AND THE DESKTOP'S STAYING EXACTLY AS IT WAS.
//
// "Cloud" is one check, `isCloudHome()` (src/lib/cloud-workspace.ts): the Cloud window, or a page a Cloud home served, which
// carries a murage-home-id meta tag. These tests stand a fake document behind it, so the same cards render both ways in node.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

let setupReply: unknown = {};
vi.mock("@/state/store", () => ({
  api: async (path: string) => {
    if (path !== "/api/setup") return {};
    if (setupReply instanceof Error) throw setupReply;
    return setupReply;
  },
  useStore: () => ({ state: {}, dispatch: () => {} }),
}));
vi.mock("@/lib/use-surface", () => ({ useDesktopSurface: () => true }));
vi.mock("@/lib/analytics", () => ({ identifyEmail: () => {}, setEmailGateDone: () => {} }));

const { FirstRunCard, cloudPassWanted, cloudPassState, passCloudStep } = await import("./FirstRunCard");
const { readSetupView, forgetSetupView } = await import("./FirstRunChrome");
const { FIRST_RUN_COPY } = await import("@/lib/first-run-copy");
const { sellsOnPrice } = await import("@/lib/first-run-copy-rules");
const { setupCardKey } = await import("../../shared/setup-card");
const { SETUP_DETECT_ANSWER } = await import("../../shared/setup");
const { isCloudHome } = await import("@/lib/cloud-workspace");
const { cloudBookmarkLine, cloudJobCopy, cloudJobRows } = await import("@/lib/first-run-cloud");
const jobs = await import("@/lib/first-run-jobs");
const { remoteConnectionNotice } = await import("./RemoteConnectionBanner");
const cloudStrings = (await import("../locales/en-ux/cloud.json")).default as Record<string, string>;

type AnyMessage = Parameters<typeof FirstRunCard>[0]["message"];
const bot = { id: "chief", threadId: "thread-1", name: "Chief of Staff" } as Parameters<typeof FirstRunCard>[0]["bot"];

/** A page a Cloud home served: its meta tags, and nothing else of a document. */
function cloudPage(site: string | null = "https://murage.ai") {
  return {
    querySelector: (selector: string) => {
      const value = selector.includes("murage-home-id") ? "home_1" : selector.includes("murage-site-origin") ? site : null;
      return value === null ? null : { getAttribute: () => value };
    },
  };
}
const asCloud = (site?: string | null) => { (globalThis as { document?: unknown }).document = cloudPage(site); };
afterEach(() => { delete (globalThis as { document?: unknown }).document; delete (globalThis as { location?: unknown }).location; });

async function machine(view: Record<string, unknown>): Promise<void> {
  setupReply = { steps: [], agents: [], signedOutAgents: [], ownerName: "", ...view };
  forgetSetupView();
  await readSetupView(true);
}
const render = (step: string, variant: string, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(FirstRunCard, {
    bot,
    message: {
      id: `card-${variant}`, role: "bot", kind: "options", at: 1,
      card: { title: "Setup", options: [], setup: { step, variant, key: setupCardKey(step as never, variant as never), ...extra } },
    } as unknown as AnyMessage,
  }));
const asHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

/** Nothing here can sign anything in, nobody to ask, no Flux key: the machine the old first run said the most about. */
const BLANK = { fluxReady: false, nothingToThinkWith: true, nothingCanAnswer: true, connectedJobApps: [] };

describe("the one Cloud check", () => {
  it("is false off a home and true on a page a Cloud home served", () => {
    expect(isCloudHome()).toBe(false);
    expect(isCloudHome({ querySelector: () => null })).toBe(false);
    asCloud();
    expect(isCloudHome()).toBe(true);
  });
  it("is true in the Cloud window too", () => {
    (globalThis as { location?: unknown }).location = { protocol: "murage-home:" };
    expect(isCloudHome()).toBe(true);
  });
});

describe("cut 1: the hello card asks for the name only", () => {
  it("on Cloud: Ember's line, a name box, Continue; no email, no Skip, no look around this computer", async () => {
    await machine({});
    asCloud();
    const markup = render("hello", "welcome");
    expect(markup).toContain(asHtml("Hello, I'm Ember. What should I call you?"));
    expect(markup).toContain(FIRST_RUN_COPY.hello.welcome.nameLabel);
    expect(markup).toContain("Continue");
    for (const gone of [FIRST_RUN_COPY.hello.welcome.emailLabel, FIRST_RUN_COPY.hello.welcome.emailHelper, FIRST_RUN_COPY.hello.welcome.skip, FIRST_RUN_COPY.hello.welcome.detecting, FIRST_RUN_COPY.hello.welcome.learnLine, FIRST_RUN_COPY.hello.welcome.chief]) {
      expect(markup).not.toContain(asHtml(gone));
    }
    expect(markup).not.toContain('type="email"');
    expect(markup.match(/<input/g)?.length).toBe(1);
  });
  it("on the desktop: unchanged, and the same with or without a document that is not a home's", async () => {
    await machine({});
    const bare = render("hello", "welcome");
    (globalThis as { document?: unknown }).document = { querySelector: () => null };
    expect(render("hello", "welcome")).toBe(bare);
    for (const kept of [FIRST_RUN_COPY.hello.welcome.chief, FIRST_RUN_COPY.hello.welcome.emailLabel, FIRST_RUN_COPY.hello.welcome.skip, FIRST_RUN_COPY.hello.welcome.detecting, FIRST_RUN_COPY.hello.welcome.learnLine]) {
      expect(bare).toContain(asHtml(kept));
    }
  });
});

describe("cut 2 and 3: detect and the Flux card are passed over on Cloud", () => {
  const cards: Array<[string, string]> = [["detect", "found"], ["detect", "bare"], ["detect", "signed-out"], ["flux", "key"], ["flux", "no-key"]];
  it("draws none of them on Cloud, settled or not", async () => {
    await machine({ ...BLANK, agents: [{ id: "claude", name: "Claude", installed: true }] });
    asCloud();
    for (const [step, variant] of cards) {
      expect(render(step, variant), `${variant} open`).toBe("");
      expect(render(step, variant, { settled: true }), `${variant} settled`).toBe("");
    }
  });
  it("still draws every one of them on the desktop", async () => {
    await machine({ ...BLANK, nothingToThinkWith: false, agents: [{ id: "claude", name: "Claude", installed: true }] });
    for (const [step, variant] of cards) expect(render(step, variant), variant).not.toBe("");
  });
  it("detect is answered the way its own button answers it, flux is skipped", async () => {
    const calls: string[] = [];
    const deps = { answer: async (step: string, answer: string) => { calls.push(`answer ${step} ${answer}`); }, skip: async (step: string) => { calls.push(`skip ${step}`); } };
    await passCloudStep("detect", deps as never);
    await passCloudStep("flux", deps as never);
    expect(calls).toEqual([`answer detect ${SETUP_DETECT_ANSWER}`, "skip flux"]);
  });
  it("waits for the view, leaves a settled step alone, and never skips Flux while a key is saved", () => {
    expect(cloudPassWanted("detect", null, false)).toBe(false);
    expect(cloudPassWanted("detect", { fluxReady: false }, true)).toBe(false);
    expect(cloudPassWanted("detect", { fluxReady: false }, false)).toBe(true);
    expect(cloudPassWanted("flux", { fluxReady: false }, false)).toBe(true);
    const fluxStep = (status: string) => ({ fluxReady: true, steps: [{ id: "flux", status }] });
    expect(cloudPassWanted("flux", fluxStep("done"), false)).toBe(false);
    expect(cloudPassWanted("flux", fluxStep("skipped"), false)).toBe(false);
    expect(cloudPassWanted("detect", { fluxReady: true }, false)).toBe(true);
  });
});

describe("cut 3: the jobs card on Cloud has no Flux and works with no key", () => {
  const world = (cloud: boolean) => jobs.firstRunJobWorld(BLANK as never, "anonymous", cloud ? cloudJobRows() : undefined);
  it("no job waits on Flux, and no tag, connect row or status line names it", () => {
    const w = world(true);
    for (const id of jobs.FIRST_RUN_JOB_IDS) expect(jobs.missingForJob(jobs.FIRST_RUN_JOB_SHAPES[id], w)).not.toContain("flux");
    const text = JSON.stringify([jobs.firstRunJobRows(w), jobs.chiefStatusLine(w, ""), jobs.chiefLead(w), jobs.firstRunConnectScreen(jobs.FIRST_RUN_JOB_SHAPES.brief, w)]);
    expect(text).not.toMatch(/flux|router|api key|provider|this computer/i);
  });
  it("the desktop world is the object it always was: no cloud key, Flux still asked for", () => {
    const w = world(false);
    expect("cloud" in w).toBe(false);
    expect(jobs.missingForJob(jobs.FIRST_RUN_JOB_SHAPES.brief, w)[0]).toBe("flux");
    expect(jobs.chiefStatusLine(w, "")).toBe(FIRST_RUN_COPY.chat.jobs.status.noBrain);
    expect(jobs.chiefLead(w)).toBe(FIRST_RUN_COPY.chat.jobs.leadNoBrain);
    expect(jobs.firstRunJobRows(w).map((row) => [row.id, row.title, row.sub])).toEqual(FIRST_RUN_COPY.chat.jobs.rows.map((row) => [row.id, row.title, row.sub]));
  });
  it("renders the whole card with nothing of Flux in it", async () => {
    await machine(BLANK);
    asCloud();
    const markup = render("chat", "jobs");
    expect(markup).not.toMatch(/flux|router|api key|provider|this computer/i);
    expect(markup).toContain(asHtml(cloudJobCopy("business").title));
  });
});

describe("cut 3: the research result names no Flux on Cloud", () => {
  it("drops the on-local line on a home and keeps it on desktop", async () => {
    const { researchResult } = await import("@/lib/first-run-flow");
    const world = (cloud: boolean) => jobs.firstRunJobWorld(BLANK as never, "anonymous", cloud ? cloudJobRows() : undefined);
    expect(researchResult({ ...world(true), fluxReady: false, nothingToThinkWith: false }).onLocal).toBeNull();
    expect(researchResult({ ...world(false), fluxReady: false, nothingToThinkWith: false }).onLocal).toContain("Flux Router");
  });
});

describe("cut 4: plain examples on the jobs card", () => {
  it("Cloud rows are in everyday words, one per job, in the same order and ids", async () => {
    const w = jobs.firstRunJobWorld({ ...BLANK, fluxReady: true } as never, "anonymous", cloudJobRows());
    const rows = jobs.firstRunJobRows(w);
    expect(rows.map((row) => row.id)).toEqual(FIRST_RUN_COPY.chat.jobs.rows.map((row) => row.id));
    expect(rows.map((row) => row.sub)).toEqual(jobs.FIRST_RUN_JOB_IDS.map((id) => cloudJobCopy(id).sub));
    const text = rows.map((row) => `${row.title} ${row.sub}`).join(" ");
    expect(text).not.toMatch(/\b(crew|owns them|who owns|routine|agent|engine|workflow|pipeline)\b/i);
    expect(text).toMatch(/dishwasher/);
  });
  it("the rows before the view answers are the Cloud ones too, and the desktop's otherwise", async () => {
    asCloud();
    setupReply = null; forgetSetupView();
    expect(render("chat", "jobs")).toContain(asHtml(cloudJobCopy("notes").title));
    delete (globalThis as { document?: unknown }).document;
    expect(render("chat", "jobs")).toContain(asHtml(FIRST_RUN_COPY.chat.jobs.rows[2]!.title));
  });
});

describe("cut 5: the unreachable banner", () => {
  const base = { connected: false, signedOut: false, offlineSince: 0, now: 60_000, everConnected: true };
  it("says the Cloud words, exactly, on Cloud", () => {
    expect(remoteConnectionNotice({ ...base, cloud: true })).toBe("Can't reach your Murage right now. Anything you type is kept, and this reconnects by itself.");
  });
  it("is the desktop sentence, character for character, off Cloud", () => {
    expect(remoteConnectionNotice(base)).toBe("Can't reach your Murage right now. Anything you type is kept, and this reconnects by itself once your computer is awake and online.");
    expect(remoteConnectionNotice({ ...base, cloud: false })).toBe(remoteConnectionNotice(base));
  });
  it("keeps the same grace and the same silences", () => {
    expect(remoteConnectionNotice({ ...base, now: 1_000, cloud: true })).toBeNull();
    expect(remoteConnectionNotice({ ...base, connected: true, cloud: true })).toBeNull();
    expect(remoteConnectionNotice({ ...base, signedOut: true, cloud: true })).toBeNull();
  });
});

describe("cut 6: the bookmark line", () => {
  it("names the door when the home told the page its site", () => {
    expect(cloudBookmarkLine(cloudPage("https://murage.ai"))).toBe("Bookmark this page so you can come back. You can always return at murage.ai/home/cloud.");
  });
  it("says only the bookmark part when there is no site origin, rather than invent an address", () => {
    expect(cloudBookmarkLine(cloudPage(null))).toBe("Bookmark this page so you can come back.");
  });
  it("is nothing off a home and nothing in the Cloud window, which is an app", () => {
    expect(cloudBookmarkLine({ querySelector: () => null })).toBeNull();
    (globalThis as { location?: unknown }).location = { protocol: "murage-home:" };
    expect(cloudBookmarkLine(cloudPage())).toBeNull();
  });
  it("is on the jobs card on Cloud and absent on the desktop", async () => {
    await machine(BLANK);
    asCloud();
    expect(render("chat", "jobs")).toContain("murage.ai/home/cloud");
    delete (globalThis as { document?: unknown }).document;
    expect(render("chat", "jobs")).not.toContain("Bookmark");
  });
});

describe("the Cloud words obey the house rules", () => {
  const firstRun = Object.entries(cloudStrings).filter(([key]) => key.startsWith("ux.cloud.firstRun."));
  it("has them", () => { expect(firstRun.length).toBeGreaterThanOrEqual(15); });
  it("no em or en dash, never safe, unsafe or safety, no price words, nothing of Flux, keys or routers", () => {
    for (const [key, text] of firstRun) {
      expect(text, key).not.toMatch(/[–—]/);
      expect(text, key).not.toMatch(/\b(safe|unsafe|safety)\b/i);
      expect(sellsOnPrice(text), key).toBeNull();
      expect(text, key).not.toMatch(/flux|router|api key|provider|this computer/i);
    }
  });
});

describe("review fix 1: a saved key with a refused payment never holds a Cloud customer on the hidden Flux step", () => {
  const blocked = { fluxReady: true, steps: [{ id: "detect", status: "skipped" }, { id: "flux", status: "blocked" }] };
  it("passes the Flux step over when it is blocked or open, even with a key saved", () => {
    expect(cloudPassWanted("flux", blocked, false)).toBe(true);
    expect(cloudPassWanted("flux", { fluxReady: true, steps: [{ id: "flux", status: "open" }] }, false)).toBe(true);
    expect(cloudPassWanted("flux", { fluxReady: true }, false)).toBe(true);
  });
  it("still leaves a finished or settled step alone", () => {
    expect(cloudPassWanted("flux", { fluxReady: true, steps: [{ id: "flux", status: "done" }] }, false)).toBe(false);
    expect(cloudPassWanted("flux", blocked, true)).toBe(false);
  });
});

describe("review fix 2: a failed setup read on Cloud ends on a line and a Try again button, and recovers by itself", () => {
  const passed: Array<[string, string]> = [["detect", "found"], ["detect", "bare"], ["detect", "signed-out"], ["flux", "key"]];
  it("every state of a passed step is quiet only while a pass is really coming; the rest carry a visible control", () => {
    for (const settled of [true, false]) for (const view of [null, {}]) for (const readGaveUp of [true, false]) for (const failure of ["", "x"]) {
      const state = cloudPassState({ settled, view, readGaveUp, failure });
      if (settled) expect(state).toBe("settled");
      else if (failure) expect(state).toBe("passFailed");
      else if (view === null && readGaveUp) expect(state).toBe("readFailed");
      else expect(state).toBe("passing");
    }
  });
  it("after five failed reads: the plain line and Try again on every passed card; before that, nothing; the desktop never", async () => {
    vi.useFakeTimers();
    try {
      asCloud();
      setupReply = new Error("down");
      forgetSetupView();
      await vi.advanceTimersByTimeAsync(1);
      for (const [step, variant] of passed) expect(render(step, variant), `${variant} early`).toBe("");
      await vi.advanceTimersByTimeAsync(40_000);
      for (const [step, variant] of passed) {
        const markup = render(step, variant);
        expect(markup, variant).toContain(asHtml(cloudStrings["ux.cloud.firstRun.stepFailed"]));
        expect(markup, variant).toContain(asHtml(cloudStrings["ux.cloud.firstRun.tryAgain"]));
        expect(markup, variant).toContain("<button");
      }
      expect(render("detect", "found", { settled: true })).toBe("");
      // the home comes back: the slow re-read finds it by itself, and the line goes
      setupReply = { steps: [], agents: [], signedOutAgents: [], ownerName: "", ...BLANK };
      await vi.advanceTimersByTimeAsync(20_000);
      for (const [step, variant] of passed) expect(render(step, variant), `${variant} recovered`).toBe("");
    } finally {
      setupReply = {};
      forgetSetupView();
      vi.useRealTimers();
    }
  });
  it("off Cloud the read gives up quietly as it always did: no line, no slow timer", async () => {
    vi.useFakeTimers();
    try {
      setupReply = new Error("down");
      forgetSetupView();
      await vi.advanceTimersByTimeAsync(40_000);
      expect(vi.getTimerCount()).toBe(0);
      expect(render("detect", "found")).not.toContain(asHtml(cloudStrings["ux.cloud.firstRun.tryAgain"]));
    } finally {
      setupReply = {};
      forgetSetupView();
      vi.useRealTimers();
    }
  });
});

describe("review fix 3: every Cloud job line is true for a customer with nothing connected", () => {
  const sub = (id: string) => cloudStrings[`ux.cloud.firstRun.job.${id}.sub`];
  it("the day is worked from the lines they type, so it never claims to read a calendar or email", () => {
    expect(sub("day")).not.toMatch(/calendar|email|inbox|mail/i);
    expect(sub("day")).toMatch(/type/i);
  });
  it("the brief promises calendar and email only once they are connected", () => {
    expect(sub("brief")).toMatch(/once you connect/i);
  });
  it("notes promise next steps, not decisions the job never extracts", () => {
    expect(sub("notes")).not.toMatch(/decid/i);
  });
  it("research does not claim a lookup, business does not claim invoices or receipts", () => {
    expect(sub("research")).not.toMatch(/look it up/i);
    expect(sub("business")).not.toMatch(/invoice|receipt|email/i);
  });
});
