import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// THE POLL, DRIVEN RATHER THAN READ.
//
// Both defects here are about a loop: one that never ends, and one that ends
// after a single bad answer. Neither is visible in the source of a component,
// so this drives the real module with a fake clock and a fake `/api/setup`,
// and counts the requests it makes.
let reply: (() => unknown) | null = null;
let calls = 0;
vi.mock("@/state/store", () => ({
  api: async (path: string) => {
    if (path !== "/api/setup") return {};
    calls += 1;
    const answer = reply?.();
    if (answer instanceof Error) throw answer;
    return answer;
  },
  useStore: () => ({ state: {}, dispatch: () => {} }),
}));

const { SETUP_POLL_IDLE_LIMIT, SETUP_READ_RETRY_LIMIT, forgetSetupView, readSetupView, setupPollWanted } =
  await import("./FirstRunChrome");

/** A setup view as the route answers one, with the flow still going. */
const view = (patch: Record<string, unknown> = {}) => ({
  steps: [],
  agents: [],
  signedOutAgents: [],
  ownerName: "",
  conversationLive: true,
  next: "chat",
  ...patch,
});

/** Let every queued timer fire, as many times as they re-queue, so a chain of
 *  timeouts runs the way it does in a browser left open. */
async function letTimeRun(rounds: number): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await vi.advanceTimersByTimeAsync(10_000);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  calls = 0;
  reply = () => view();
});

afterEach(async () => {
  // Leave no timer chained into the next test.
  reply = () => ({ ...view(), next: null });
  await vi.advanceTimersByTimeAsync(20_000);
  vi.useRealTimers();
});

describe("the setup poll", () => {
  it("stops asking once nothing is changing", async () => {
    // THE DEFECT: `schedulePoll` only stopped on `view.next === null`. `chat`
    // and `flow` are settled by the person acting in this renderer, so a
    // person who stops half way has a `next` that is never null, and the app
    // re-read the route every three seconds for the life of the process. That
    // read walks the whole engine fleet and, once a key exists, reaches the
    // connected-apps broker.
    forgetSetupView();
    await letTimeRun(60);
    expect(calls, "the poll never gave up").toBeLessThanOrEqual(SETUP_POLL_IDLE_LIMIT + 2);

    // ...and it really stopped, rather than merely slowing down.
    const settled = calls;
    await letTimeRun(60);
    expect(calls).toBe(settled);
  });

  it("keeps asking while the answers keep changing", async () => {
    // The bound is on a run of IDENTICAL answers, not on time. A machine that
    // is genuinely moving must not be abandoned half way through the flow.
    let tick = 0;
    reply = () => view({ ownerName: `Sean ${(tick += 1)}` });
    forgetSetupView();
    await letTimeRun(40);
    expect(calls).toBeGreaterThan(SETUP_POLL_IDLE_LIMIT + 2);
  });

  it("wakes up again when the person does something", async () => {
    forgetSetupView();
    await letTimeRun(60);
    const asleep = calls;

    forgetSetupView();
    await letTimeRun(60);
    expect(calls, "an action left the poll asleep").toBeGreaterThan(asleep + 1);
  });

  it("stops the moment the flow has nothing left to do", async () => {
    reply = () => view({ next: null });
    forgetSetupView();
    await letTimeRun(30);
    expect(calls).toBe(1);
  });

  it("never polls a thread the first run is not happening in", async () => {
    reply = () => view({ conversationLive: false });
    forgetSetupView();
    await letTimeRun(30);
    expect(calls).toBe(1);
  });

  it("says in one place when a poll is worth making", () => {
    expect(setupPollWanted(view() as never, 0)).toBe(true);
    expect(setupPollWanted(view() as never, SETUP_POLL_IDLE_LIMIT)).toBe(false);
    expect(setupPollWanted(view({ next: null }) as never, 0)).toBe(false);
    expect(setupPollWanted(view({ conversationLive: false }) as never, 0)).toBe(false);
  });
});

describe("a setup read that failed", () => {
  it("asks again rather than ending the flow", async () => {
    // THE DEFECT: failures were swallowed with `.catch(() => null)`, and only
    // a SUCCESSFUL response reached `publish`, which is the only thing that
    // scheduled another read. With nothing cached, the detection and
    // signed-out cards return null, so one bad response left a step heading
    // with nothing under it, permanently, on every surface at once.
    reply = () => new Error("the server was not there");
    forgetSetupView();
    expect(calls).toBe(1);

    await letTimeRun(10);
    expect(calls, "one failed read ended the flow").toBeGreaterThan(1);
  });

  it("recovers the moment the server answers again", async () => {
    let failures = 2;
    reply = () => (failures-- > 0 ? new Error("not yet") : view());
    forgetSetupView();
    await letTimeRun(10);
    expect(await readSetupView()).toMatchObject({ next: "chat" });
  });

  it("gives up on a server that is genuinely gone", async () => {
    reply = () => new Error("gone");
    forgetSetupView();
    await letTimeRun(60);
    expect(calls).toBeLessThanOrEqual(SETUP_READ_RETRY_LIMIT + 1);
  });

  it("treats an answer that is not a setup view as a failure", async () => {
    // A 200 carrying something else is not a reason to stop: the same blank
    // card comes out of it, and the same nothing asks again.
    reply = () => ({ error: "no such route" });
    forgetSetupView();
    await letTimeRun(10);
    expect(calls).toBeGreaterThan(1);
  });
});

describe("a surface that is never shown the first run", () => {
  it("asks once, hears 404, and stops asking for the life of the page", async () => {
    // A phone through the door: the door does not carry /api/setup at all.
    reply = () => Object.assign(new Error("no such route"), { status: 404 });
    forgetSetupView(); // re-reads once, and hears the 404
    await vi.advanceTimersByTimeAsync(0);
    expect(await readSetupView(true)).toBeNull();
    await letTimeRun(10);
    expect(await readSetupView()).toBeNull();
    expect(await readSetupView(true)).toBeNull();
    expect(calls).toBe(1);
    forgetSetupView();
  });

  it("still retries a server that is only restarting", async () => {
    reply = () => Object.assign(new Error("Bad Gateway"), { status: 502 });
    forgetSetupView();
    await readSetupView(true);
    await letTimeRun(3);
    expect(calls).toBeGreaterThan(1);
    reply = () => ({ ...view(), next: null });
    forgetSetupView();
  });
});
