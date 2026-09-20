import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { SETUP_STEPS, type SetupStep, type SetupView } from "../shared/setup.ts";

// The whole checklist, walked on a real server against an engine that NEVER
// answers. `exit-early` makes the fake CLI die before it emits a result, so
// no turn ever produces a settled reply — which is exactly the install this
// design has to survive: the steps the server can still measure go green,
// the two that depend on an engine stay open, and the card says why.
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

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: NEVER_ANSWERS });
  console.info("setup checklist fixture", fixture.info);
  const proof = await api("GET", "/api/desktop-secret");
  expect(proof.status).toBe(200);
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
});

afterAll(async () => { await fixture?.close(); });

describe("the first-run checklist on a real server whose engine never answers", () => {
  it("opens on the eight steps, with the bot of a fresh install already recorded as the Chief", async () => {
    const bots = await api("GET", "/api/bots", undefined, desktop);
    expect(bots.status).toBe(200);
    expect(bots.body.bots).toHaveLength(1);
    chiefBotId = bots.body.bots[0].id;
    expect(bots.body.bots[0].chiefOfStaff).toBe(true);
    expect(bots.body.bots[0].chiefScope).toBe("workspace");

    const view = await checklist();
    expect(view.chiefBotId).toBe(chiefBotId);
    expect(view.steps.map((entry) => entry.id)).toEqual([...SETUP_STEPS]);
    expect(view.progress).toEqual({ done: 0, total: 8 });
    expect(view.next).toBe("flux");
  });

  it("is not reachable from a paired phone", async () => {
    const remote = { "x-murage-companion": "1" };
    expect(await api("GET", "/api/setup", undefined, remote)).toMatchObject({ status: 404, body: { error: "no such route" } });
    expect(await api("POST", "/api/setup/answer", { step: "purpose", answer: "anything" }, remote))
      .toMatchObject({ status: 404, body: { error: "no such route" } });
    expect(await api("POST", "/api/setup/skip", { step: "apps" }, remote)).toMatchObject({ status: 404 });
  });

  it("refuses an unknown step and an empty answer", async () => {
    expect(await api("POST", "/api/setup/answer", { step: "not-a-step", answer: "x" }, desktop))
      .toMatchObject({ status: 400 });
    expect(await api("POST", "/api/setup/answer", { step: "purpose", answer: "" }, desktop))
      .toMatchObject({ status: 400 });
    expect(await api("POST", "/api/setup/skip", { step: "purpose", answer: "x" }, desktop))
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
    expect((answered.body as SetupView).steps.find((entry) => entry.id === "flux")?.detail)
      .toMatch(/No Flux Router key is saved/);

    const saved = await api("PATCH", "/api/config", { flux: { apiKey: FLUX_KEY } }, desktop);
    expect(saved.status).toBe(200);
    const view = await checklist();
    expect(step(view, "flux").done).toBe(true);
    expect(view.progress.done).toBe(1);
  });

  it("answers the purpose step, which is the one thing an answer alone does settle", async () => {
    const view = await api("POST", "/api/setup/answer", { step: "purpose", answer: "keep on top of my inbox" }, desktop);
    expect(step(view.body as SetupView, "purpose")).toMatchObject({ done: true, note: "keep on top of my inbox" });
  });

  it("says the Chief's brain has not answered, and why, after a real turn that produced nothing", async () => {
    const sent = await api("POST", `/api/bots/${chiefBotId}/messages`, { text: "Say hello" }, desktop);
    expect(sent.status).toBe(202);
    await expect.poll(async () => {
      const bots = await api("GET", "/api/bots", undefined, desktop);
      return bots.body.bots.find((bot: { id: string }) => bot.id === chiefBotId)?.busy ?? true;
    }, { timeout: 15_000 }).toBe(false);

    // The engine really ran and really failed — this is not "no turn was
    // ever dispatched" dressed up as honesty.
    const bots = await api("GET", "/api/bots", undefined, desktop);
    const messages: Array<Record<string, any>> = bots.body.bots.find((bot: { id: string }) => bot.id === chiefBotId).messages;
    expect(messages.some((message) => message.role === "bot" && message.kind === "activity" && message.tool?.ok === false)).toBe(true);
    expect(messages.some((message) => message.turnTerminal === true)).toBe(false);

    const view = await checklist();
    expect(step(view, "brain")).toMatchObject({ done: false, status: "open" });
    expect(step(view, "first-task")).toMatchObject({ done: false, status: "open" });
    expect(step(view, "brain").detail).toMatch(/has not answered yet/);
    expect(step(view, "first-task").detail).toMatch(/No bot has produced a real reply yet/);
    // Whether the included brain can run here is genuinely machine state —
    // a developer box has its own `fuigo` on PATH, a clean install has only
    // the packaged one, which this fixture does not stage. What must hold
    // everywhere is that the view says which, and never reports "not ready"
    // without the resolver's own sentence for why.
    expect(typeof view.engine.ready).toBe("boolean");
    expect(view.engine.ready
      ? view.engine.reason === undefined
      : /fuigo is unavailable/.test(view.engine.reason ?? "")).toBe(true);
  });

  it("moves past a skipped step without calling it done", async () => {
    const skipped = await api("POST", "/api/setup/skip", { step: "apps" }, desktop);
    expect(skipped.status).toBe(200);
    expect(step(skipped.body as SetupView, "apps")).toMatchObject({ done: false, skipped: true });
    expect((skipped.body as SetupView).next).toBe("brain");
  });

  it("counts a teammate installed after the Chief as the crew, and leaves the Chief in post", async () => {
    const mate = await api("POST", "/api/bots", { name: "Setup fixture teammate" }, desktop);
    expect(mate.status).toBe(201);
    expect(mate.body.bot.chiefOfStaff).toBeFalsy();

    const view = await checklist();
    expect(step(view, "crew").done).toBe(true);
    expect(view.chiefBotId).toBe(chiefBotId);
  });

  it("wraps up only once the Chief's notebook actually holds the lines", async () => {
    const confirmed = await api("POST", "/api/setup/answer", { step: "wrap", answer: "confirmed" }, desktop);
    expect(step(confirmed.body as SetupView, "wrap")).toMatchObject({ done: false });
    expect(step(confirmed.body as SetupView, "wrap").detail).toMatch(/notebook is still empty/);

    const written = await api("PUT", `/api/bots/${chiefBotId}/memory`, { text: "- Sean runs a small team.\n" }, desktop);
    expect(written.status).toBe(200);
    expect(step(await checklist(), "wrap").done).toBe(true);
  });

  it("finishes the walk honestly: every step live state supports is done, the engine's two are not", async () => {
    expect(step(await api("POST", "/api/setup/answer", { step: "voice", answer: "direct, no waffle" }, desktop)
      .then((response) => response.body as SetupView), "voice").done).toBe(true);

    const view = await checklist();
    const done = view.steps.filter((entry) => entry.done).map((entry) => entry.id);
    expect(done.sort()).toEqual(["crew", "flux", "purpose", "voice", "wrap"]);
    expect(view.progress).toEqual({ done: 5, total: 8 });
    // Nothing is blocked here: this engine simply never answered, which is
    // an open step, not a refusal the person can do nothing about.
    expect(view.blocked).toEqual([]);
    // The checklist has run out of things to present: what is left is
    // outstanding or deliberately passed over, and neither is a claim of
    // success.
    expect(view.next).toBe("brain");
    expect(step(view, "apps").skipped).toBe(true);
  });

  it("re-opens a step by re-deriving it, so nothing is reinstalled and nothing is un-done", async () => {
    const flux = await api("POST", "/api/setup/reopen", { step: "flux" }, desktop);
    expect(step(flux.body as SetupView, "flux")).toMatchObject({ done: true });
    expect(step(flux.body as SetupView, "flux").note).toBeUndefined();

    const purpose = await api("POST", "/api/setup/reopen", { step: "purpose" }, desktop);
    expect(step(purpose.body as SetupView, "purpose")).toMatchObject({ done: false, status: "open" });
    expect(step(purpose.body as SetupView, "purpose").note).toBeUndefined();
    expect((purpose.body as SetupView).next).toBe("purpose");
    expect((purpose.body as SetupView).progress.done).toBe(4);
  });
});
