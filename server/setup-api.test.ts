import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { setupCardKey } from "../shared/setup-card.ts";
import { SETUP_STEPS, type SetupStep, type SetupView } from "../shared/setup.ts";

// The whole first run, walked on a real server against an engine that NEVER
// answers. `exit-early` makes the fake CLI die before it emits a result, so
// no turn ever produces a settled reply — which is exactly the install this
// design has to survive: the steps the server can still measure go green, the
// ones that depend on an engine stay open, and the card says why.
//
// It is also the install that proves the release's central rule. The brief is
// created and run here and the run cannot succeed, so the brief step stays
// outstanding: a routine that is scheduled has been promised, not proven.
//
// `launchVerificationServer` does not forward FAKE_CLAUDE_* overrides, so the
// mode is set inside the server child by its instrumentation import, before
// anything spawns a CLI.
const NEVER_ANSWERS = `process.env.FAKE_CLAUDE_MODE = "exit-early";\n`;

// Shape only, and never saved anywhere but this fixture's own temp config.
const FLUX_KEY = "sk-flux-Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

let fixture: VerificationServer;
let desktop: Record<string, string>;
let chiefBotId: string;

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${fixture.info.url}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function checklist(): Promise<SetupView> {
  const response = await api("GET", "/api/setup", undefined, desktop);
  expect(response.status).toBe(200);
  return response.body as SetupView;
}

const step = (view: SetupView, id: SetupStep) => view.steps.find((entry) => entry.id === id)!;

/** Every first-run card sitting in the Chief's thread, by key. */
async function setupCards(): Promise<Array<{ key: string; settled?: boolean; title: string }>> {
  const bots = await api("GET", "/api/bots", undefined, desktop);
  const messages: Array<Record<string, any>> = bots.body.bots.find((bot: { id: string }) => bot.id === chiefBotId).messages;
  return messages
    .filter((message) => message.card?.setup)
    .map((message) => ({ key: message.card.setup.key, settled: message.card.setup.settled, title: message.card.title }));
}

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: NEVER_ANSWERS });
  console.info("setup checklist fixture", fixture.info);
  const proof = await api("GET", "/api/desktop-secret");
  expect(proof.status).toBe(200);
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
});

afterAll(async () => { await fixture?.close(); });

describe("the first run on a real server whose engine never answers", () => {
  it("seats the bot of a fresh install as the Chief when the checklist is opened", async () => {
    // Before setup is opened, nothing has been rewired: the seeded bot holds
    // no role, because an installation nobody has run setup on must not be
    // reorganised behind their back.
    const before = await api("GET", "/api/bots", undefined, desktop);
    expect(before.status).toBe(200);
    expect(before.body.bots).toHaveLength(1);
    chiefBotId = before.body.bots[0].id;
    expect(before.body.bots[0].chiefOfStaff).toBeFalsy();

    const view = await checklist();
    const after = await api("GET", "/api/bots", undefined, desktop);
    expect(after.body.bots[0]).toMatchObject({ id: chiefBotId, chiefOfStaff: true, chiefScope: "workspace" });

    expect(view.chiefBotId).toBe(chiefBotId);
    expect(view.steps.map((entry) => entry.id)).toEqual([...SETUP_STEPS]);
    expect(view.progress.total).toBe(6);
    expect(view.next).toBe("hello");
  });

  it("knows this install has never been used, and opens the conversation in the Chief's thread", async () => {
    const view = await checklist();
    expect(view.firstRun).toBe(true);

    const cards = await setupCards();
    expect(cards.map((card) => card.key)).toContain(setupCardKey("hello", "welcome"));
    // The opening card is a real bot-authored message, so it reads correctly
    // in an exported transcript with no renderer at all.
    expect(cards.find((card) => card.key === setupCardKey("hello", "welcome"))?.title).toBeTruthy();
  });

  it("does not collect a second copy of a card on every poll", async () => {
    const before = await setupCards();
    await checklist();
    await checklist();
    const after = await setupCards();
    expect(after.map((card) => card.key)).toEqual(before.map((card) => card.key));
    expect(new Set(after.map((card) => card.key)).size).toBe(after.length);
  });

  it("is not reachable from a paired phone", async () => {
    const remote = { "x-murage-companion": "1" };
    expect(await api("GET", "/api/setup", undefined, remote)).toMatchObject({ status: 404, body: { error: "no such route" } });
    expect(await api("POST", "/api/setup/answer", { step: "hello", answer: "anything" }, remote))
      .toMatchObject({ status: 404, body: { error: "no such route" } });
    expect(await api("POST", "/api/setup/skip", { step: "apps" }, remote)).toMatchObject({ status: 404 });
    expect(await api("POST", "/api/setup/routine", { template: "brief" }, remote))
      .toMatchObject({ status: 404, body: { error: "no such route" } });
  });

  it("refuses an unknown step and an empty answer", async () => {
    expect(await api("POST", "/api/setup/answer", { step: "not-a-step", answer: "x" }, desktop))
      .toMatchObject({ status: 400 });
    expect(await api("POST", "/api/setup/answer", { step: "hello", answer: "" }, desktop))
      .toMatchObject({ status: 400 });
    expect(await api("POST", "/api/setup/skip", { step: "hello", answer: "x" }, desktop))
      .toMatchObject({ status: 400 });
    const plain = await fetch(`${fixture.info.url}/api/setup/answer`, {
      method: "POST", headers: { "content-type": "text/plain", ...desktop }, body: "{}",
    });
    expect(plain.status).toBe(415);
  });

  it("records the Flux answer without ticking it, then ticks it when a key is actually saved", async () => {
    const answered = await api("POST", "/api/setup/answer", { step: "flux", answer: "I have one" }, desktop);
    expect(answered.status).toBe(200);
    expect(step(answered.body as SetupView, "flux")).toMatchObject({ done: false, note: "I have one" });

    // The key goes in the way the app actually saves it, through the Flux
    // connection card's own transaction — `PATCH /api/config` refuses a Flux
    // key outright, and the step has to agree with whatever that card says.
    const connection = await api("GET", "/api/flux-connection", undefined, desktop);
    expect(connection.status).toBe(200);
    expect(connection.body.configured).toBe(false);
    const saved = await api("POST", "/api/flux-connection/mutate", { action: "connect", revision: connection.body.revision, key: FLUX_KEY }, desktop);
    expect(saved.status).toBe(200);
    expect(saved.body.configured).toBe(true);
    expect(JSON.stringify(saved.body)).not.toContain(FLUX_KEY);
    expect(step(await checklist(), "flux").done).toBe(true);
  });

  it("answers hello, which is the one step a name settles", async () => {
    const view = await api("POST", "/api/setup/answer", { step: "hello", answer: "Sean" }, desktop);
    expect(step(view.body as SetupView, "hello")).toMatchObject({ done: true, note: "Sean" });
    // A used workspace is no longer a first run. The conversation carries on
    // because it demonstrably started in this thread.
    expect((view.body as SetupView).firstRun).toBe(false);
    // Cards are said on the READ, which is what the panel polls: the answer
    // records, the next read notices and settles the card that asked.
    await checklist();
    expect((await setupCards()).find((card) => card.key === setupCardKey("hello", "welcome"))?.settled).toBe(true);
  });
});

describe("POST /api/setup/routine", () => {
  let routineId: string;

  it("refuses a body it does not recognise, and a body that is not JSON", async () => {
    expect(await api("POST", "/api/setup/routine", { template: "nonsense" }, desktop)).toMatchObject({ status: 400 });
    expect(await api("POST", "/api/setup/routine", { template: "brief", time: "7am" }, desktop)).toMatchObject({ status: 400 });
    expect(await api("POST", "/api/setup/routine", { template: "brief", extra: true }, desktop)).toMatchObject({ status: 400 });
    expect(await api("POST", "/api/setup/routine", { template: "watch" }, desktop)).toMatchObject({ status: 400 });
    const plain = await fetch(`${fixture.info.url}/api/setup/routine`, {
      method: "POST", headers: { "content-type": "text/plain", ...desktop }, body: "{}",
    });
    expect(plain.status).toBe(415);
  });

  it("creates the morning brief on the Chief, bound to the Chief's own thread, and runs it once", async () => {
    const created = await api("POST", "/api/setup/routine", { template: "brief", time: "07:15", weekdaysOnly: true }, desktop);
    expect(created.status).toBe(201);
    expect(typeof created.body.routineId).toBe("string");
    expect(typeof created.body.runId).toBe("string");
    routineId = created.body.routineId;

    const chief = (await api("GET", "/api/bots", undefined, desktop)).body.bots
      .find((bot: { id: string }) => bot.id === chiefBotId);
    const listed = await api("GET", "/api/routines", undefined, desktop);
    const routine = listed.body.routines.find((entry: { id: string }) => entry.id === routineId);
    expect(routine).toMatchObject({
      botId: chiefBotId,
      target: "bot",
      runOn: "ember",
      enabled: true,
      // Bound to the Chief's OWN thread. Nothing in the request named it: the
      // route read it out of the store, which is why this cannot redirect.
      sourceThreadId: chief.threadId,
      schedule: { type: "daily", time: "07:15", weekdays: [1, 2, 3, 4, 5] },
    });
    // The prompt is user-visible in the routines list, so it obeys the copy
    // rules the release is held to.
    expect(routine.prompt).not.toMatch(/—/);
    expect(routine.prompt).toMatch(/calendar/i);

    const run = listed.body.runs.find((entry: { id: string }) => entry.id === created.body.runId);
    expect(run).toMatchObject({ routineId, manual: true });
  });

  it("does not call the brief step done just because it is scheduled", async () => {
    // The engine in this fixture cannot answer, so the run it was given can
    // never complete. Scheduled is a promise; only a run that finished is
    // proof, and the step says so.
    const view = await checklist();
    expect(view.routines.briefId).toBe(routineId);
    expect(view.routines.briefRan).toBe(false);
    expect(step(view, "brief")).toMatchObject({ done: false });
    expect(step(view, "brief").detail).toMatch(/has not run yet/);
    expect((await setupCards()).map((card) => card.key)).not.toContain(setupCardKey("brief", "brief-ran"));
  });

  it("leaves the person with one morning brief however many times the button is pressed", async () => {
    const again = await api("POST", "/api/setup/routine", { template: "brief", time: "07:15", weekdaysOnly: true }, desktop);
    expect(again.status).toBe(200);
    expect(again.body.routineId).toBe(routineId);
    const listed = await api("GET", "/api/routines", undefined, desktop);
    expect(listed.body.routines.filter((entry: { botId: string; name: string }) => entry.name === "Morning brief")).toHaveLength(1);
  });

  it("creates the extra routines without running them, and counts them towards the couple", async () => {
    const triage = await api("POST", "/api/setup/routine", { template: "triage", time: "08:00" }, desktop);
    expect(triage.status).toBe(201);
    expect(triage.body.runId).toBeUndefined();

    const watch = await api("POST", "/api/setup/routine", { template: "watch", subject: "the pricing page", time: "09:30" }, desktop);
    expect(watch.status).toBe(201);
    expect(watch.body.runId).toBeUndefined();

    const listed = await api("GET", "/api/routines", undefined, desktop);
    const created = listed.body.routines.filter((entry: { id: string }) =>
      [routineId, triage.body.routineId, watch.body.routineId].includes(entry.id));
    expect(created).toHaveLength(3);
    for (const routine of created) {
      expect(routine.botId).toBe(chiefBotId);
      expect(routine.prompt, routine.name).not.toMatch(/—/);
      expect(routine.prompt, routine.name).not.toMatch(/composio/i);
    }
    // Sending email is graduated trust, never a capability described as a
    // limit: triage drafts and waits to be told, it does not refuse forever.
    const triageRoutine = created.find((entry: { id: string }) => entry.id === triage.body.routineId);
    expect(triageRoutine.prompt).toMatch(/approve/i);
    expect(watch.body.routineId && created.find((entry: { id: string }) => entry.id === watch.body.routineId).prompt)
      .toMatch(/the pricing page/);

    const view = triage.body as SetupView;
    expect(view.routines.total).toBeGreaterThanOrEqual(2);
    expect(step(await checklist(), "routines").done).toBe(true);
  });

  it("puts the brief step back when the brief is deleted", async () => {
    expect(await api("DELETE", `/api/routines/${routineId}`, undefined, desktop)).toMatchObject({ status: 200 });
    const view = await checklist();
    expect(view.routines.briefId).toBeNull();
    expect(step(view, "brief").done).toBe(false);
    // `apps` is still outstanding and comes first, so the brief is back on the
    // list rather than at the front of it.
    expect(view.next).toBe("apps");
    expect(view.steps.filter((entry) => !entry.done && !entry.skipped).map((entry) => entry.id)).toContain("brief");
  });
});

describe("the rest of the walk", () => {
  it("moves past a skipped step without calling it done", async () => {
    const skipped = await api("POST", "/api/setup/skip", { step: "apps" }, desktop);
    expect(skipped.status).toBe(200);
    expect(step(skipped.body as SetupView, "apps")).toMatchObject({ done: false, skipped: true });
    expect((skipped.body as SetupView).next).toBe("brief");
  });

  it("re-opens a step by re-deriving it, so nothing is reinstalled and nothing is un-done", async () => {
    const flux = await api("POST", "/api/setup/reopen", { step: "flux" }, desktop);
    expect(step(flux.body as SetupView, "flux")).toMatchObject({ done: true });
    expect(step(flux.body as SetupView, "flux").note).toBeUndefined();

    const hello = await api("POST", "/api/setup/reopen", { step: "hello" }, desktop);
    expect(step(hello.body as SetupView, "hello")).toMatchObject({ done: false, status: "open" });
    expect(step(hello.body as SetupView, "hello").note).toBeUndefined();
    expect((hello.body as SetupView).next).toBe("hello");
  });

  it("finishes honestly: what live state supports is done, the rest says why", async () => {
    await api("POST", "/api/setup/answer", { step: "hello", answer: "Sean" }, desktop);
    const view = await checklist();
    expect(step(view, "hello").done).toBe(true);
    expect(step(view, "flux").done).toBe(true);
    expect(step(view, "apps").skipped).toBe(true);
    expect(step(view, "brief").done).toBe(false);
    // Whether the included engine can run here is genuinely machine state: a
    // developer box has its own `fuigo` on PATH, a clean install has only the
    // packaged one, which this fixture does not stage. What must hold
    // everywhere is that the view says which, and never reports "not ready"
    // without the resolver's own sentence for why.
    expect(typeof view.engine.ready).toBe("boolean");
    expect(view.engine.ready
      ? view.engine.reason === undefined
      : /fuigo is unavailable/.test(view.engine.reason ?? "")).toBe(true);
  });

  it("never says a word the release forbids, on any card it put in the thread", async () => {
    for (const card of await setupCards()) {
      expect(card.title, card.key).not.toMatch(/—/);
      expect(card.title, card.key).not.toMatch(/composio/i);
    }
  });
});

// A PRISTINE FIRST RUN, ON ITS OWN SERVER.
//
// The suite above shares one fixture and walks it forward through the whole
// checklist, which is the right way to test the checklist and the wrong way
// to test the FIRST moments of it: by the time those tests finish, every card
// has already been said, so "did answering this say anything new" can only
// ever answer no. These two need a workspace nobody has touched.
describe("the opening moments, on a workspace nobody has touched", () => {
  let box: VerificationServer;
  let keys: Record<string, string>;
  let chief: string;

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${box.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };

  const chiefMessages = async (): Promise<Array<Record<string, any>>> => {
    const bots = await call("GET", "/api/bots", undefined, keys);
    return bots.body.bots.find((bot: { id: string }) => bot.id === chief).messages;
  };
  const cardKeys = async () => (await chiefMessages()).filter((m) => m.card?.setup).map((m) => m.card.setup.key as string);

  beforeAll(async () => {
    box = await launchVerificationServer(process.env, undefined, { instrumentationSource: NEVER_ANSWERS });
    const proof = await call("GET", "/api/desktop-secret");
    keys = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
    const opened = await call("GET", "/api/setup", undefined, keys);
    chief = (opened.body as SetupView).chiefBotId!;
    expect(chief).toBeTruthy();
  });

  afterAll(async () => { await box?.close(); });

  // THE BUG THIS TEST EXISTS FOR.
  //
  // Answering the first card recorded the step and then said nothing. Only
  // the READ drove the conversation, and nothing was reading: the card posts
  // its answer and waits. So a person typed their name, watched a tick appear
  // beside a finished step, and sat there looking at a conversation that had
  // stopped talking to them.
  //
  // Answering a step is exactly the moment the Chief has something new to
  // say, so this asserts the next card arrives with NO read in between.
  it("says the next thing the moment a step is answered, with no read in between", async () => {
    const before = await cardKeys();
    expect(before).toContain(setupCardKey("hello", "welcome"));

    const answered = await call("POST", "/api/setup/answer", { step: "hello", answer: "Sean" }, keys);
    expect(answered.status).toBe(200);

    // Deliberately no GET /api/setup here: a read would drive the
    // conversation itself and hide the whole defect.
    const after = await cardKeys();
    const added = after.filter((key) => !before.includes(key));
    expect(added, "answering hello said nothing new in the thread").not.toHaveLength(0);
    // What this machine already has, reported rather than asked.
    expect(added.some((key) => key.startsWith("agents:"))).toBe(true);
  });

  it("marks the answered card settled, so it is not left looking live", async () => {
    const welcome = (await chiefMessages()).find((m) => m.card?.setup?.key === setupCardKey("hello", "welcome"));
    expect(welcome?.card.setup.settled).toBe(true);
  });

  // THE FIRST THING IN THE THREAD IS THE FIRST THING THE FLOW SAYS.
  //
  // The first bot used to be seeded with a greeting and a card asking what
  // you wanted it for, both written at bot creation, so both landed ABOVE the
  // welcome card. The person met a second hello and an unanswerable question
  // before anyone had asked their name. There is nothing above it now.
  it("opens with the flow's own first card and nothing above it", async () => {
    const messages = await chiefMessages();
    expect(messages.length, "the Chief's thread is empty").toBeGreaterThan(0);
    expect(messages[0]?.card?.setup?.key).toBe(setupCardKey("hello", "welcome"));
    // Belt and braces for a workspace that was seeded by an older build: any
    // intake card that does exist has been put away.
    for (const message of messages.filter((m) => m.card?.intake)) {
      expect(message.card.dismissed, "a live intake card is sitting in the first run").toBe(true);
    }
  });
});
