// design1019-approval-attention section 7, U cases: the generation-scoped attention table, driven with the real driver
// human wait (noteHumanWait/humanWaitOpen) and a real TurnWatchdog, plus injected activity/board/notification ports.
import { describe, expect, it } from "vitest";
import { cardAttention, serviceCardWaiting, type AttentionKey, type AttentionOpen, type AttentionScope } from "./approval-attention.ts";
import { humanWaitOpen, noteHumanWait } from "./harness/human-wait.ts";
import { TurnWatchdog } from "./turn-watchdog.ts";

let seq = 0;
function world() {
  const T = `thread-u${++seq}`;
  const owners = new Map<string, string>();
  const activity = new Map<string, string>();
  const board = new Map<string, { activeRequestId: string | undefined; state: string; waitingOn?: string }>();
  const notified: string[] = [];
  const open = new Set<string>();
  const boardThrows = { on: false };
  const dog = new TurnWatchdog({ stallMs: 60_000, checkMs: 60_000, onStall: () => {}, now: () => 0 });
  const attention = cardAttention({
    ownsActivity: (threadId, generation) => owners.get(threadId) === generation,
    activity: (botId, threadId) => activity.get(`${botId}:${threadId}`),
    setActivity: (botId, threadId, to) => { activity.set(`${botId}:${threadId}`, to); },
    boardRun: id => board.get(id),
    parkBoard: id => { if (boardThrows.on) throw new Error("board down"); board.set(id, { ...board.get(id)!, state: "waiting", waitingOn: "owner_approval" }); },
    resumeBoard: id => { board.set(id, { ...board.get(id)!, state: "doing", waitingOn: undefined }); },
    notify: ask => { notified.push(ask.requestId); },
    wait: (threadId, generation, requestId, waiting) => { dog.setWaitingOnHuman(threadId, waiting, requestId, generation); noteHumanWait(threadId, requestId, waiting, generation); },
  });
  const admit = (generation: string, threadId = T) => { owners.set(threadId, generation); dog.watch(threadId, "bot-a", { generation }); return attention.admit(threadId, generation); };
  const run = (id: string) => { board.set(id, { activeRequestId: id, state: "doing" }); return id; };
  const card = (requestId: string, opts: { key?: AttentionKey; threadId?: string; project?: string; bot?: string } = {}): AttentionOpen => {
    open.add(requestId);
    return { key: opts.key ?? { kind: "engine", approvalId: `approval-${requestId}` }, threadId: opts.threadId ?? T, botId: opts.bot ?? "bot-a", requestId,
      ...(opts.project ? { projectRequestId: opts.project } : {}), isOpen: () => open.has(requestId) };
  };
  /** register -> present -> ask, the usual engine path. */
  const waiting = (scope: AttentionScope, ask: AttentionOpen) => {
    expect(attention.register(scope, ask)).toBe("moved");
    expect(attention.present(scope, ask.key, `message-${ask.requestId}`)).toBe("moved");
    return attention.ask(scope, ask.key);
  };
  const act = (threadId = T, bot = "bot-a") => activity.get(`${bot}:${threadId}`);
  return { T, attention, owners, activity, act, board, notified, open, dog, boardThrows, admit, run, card, waiting };
}

describe("approval attention state machine (U)", () => {
  it("W00 register pending in the admitted generation", () => {
    const w = world(); const g = w.admit("g1");
    const ask = w.card("r1", { project: w.run("p1") });
    expect(w.attention.register(g, ask)).toBe("moved");
    expect(w.attention.state(g, ask.key)).toBe("PENDING");
    expect(w.attention.stats()).toMatchObject({ scopes: 1, cards: 1, requests: 1, waits: 0, holds: 0 });
    expect([w.act(), w.notified, humanWaitOpen(w.T), w.board.get("p1")?.state]).toEqual([undefined, [], false, "doing"]);
  });

  it("W01 presentation promotes only the registered pending card", () => {
    const w = world(); const g = w.admit("g1");
    const ask = w.card("r1");
    expect(w.attention.present(g, ask.key, "m1")).toBe("refused");
    expect(w.attention.state(g, ask.key)).toBeUndefined();
    w.attention.register(g, ask);
    expect(w.attention.present(g, ask.key, "m1")).toBe("moved");
    expect(w.attention.state(g, ask.key)).toBe("PRESENTED");
    expect(ask.messageId).toBe("m1");
    expect([w.act(), w.notified, humanWaitOpen(w.T)]).toEqual([undefined, [], false]);
  });

  it("W02 ask the owner once for a live open card", () => {
    const w = world(); const g = w.admit("g1");
    const ask = w.card("r1", { project: w.run("p1") });
    expect(w.waiting(g, ask)).toBe("moved");
    expect([humanWaitOpen(w.T), w.dog.waitingOnHuman(w.T), w.act(), w.board.get("p1")?.waitingOn, w.notified]).toEqual([true, true, "waiting-on-you", "owner_approval", ["r1"]]);
    const before = w.attention.stats();
    expect(w.attention.ask(g, ask.key)).toBe("refused");
    expect(w.notified).toEqual(["r1"]);
    expect(w.attention.stats()).toEqual(before);
  });

  it("W03 pending resolution releases its execution wait", () => {
    const w = world(); const g = w.admit("g1");
    expect(w.attention.acquireWait(g, "r1")).toBe("moved");
    expect([humanWaitOpen(w.T), w.dog.waitingOnHuman(w.T)]).toEqual([true, true]);
    const ask = w.card("r1");
    w.attention.register(g, ask);
    w.open.delete("r1");
    expect(w.attention.settle(g, ask.key)).toBe("moved");
    expect(w.attention.state(g, ask.key)).toBe("SETTLED");
    expect([humanWaitOpen(w.T), w.dog.waitingOnHuman(w.T)]).toEqual([false, false]);
    expect(w.attention.present(g, ask.key, "m1")).toBe("refused");
    expect(w.attention.ask(g, ask.key)).toBe("refused");
    expect([w.act(), w.notified, humanWaitOpen(w.T)]).toEqual([undefined, [], false]);
  });

  it("W04 review allow settles a presented card without asking", () => {
    const w = world(); const g = w.admit("g1");
    w.attention.acquireWait(g, "r1");
    const ask = w.card("r1", { project: w.run("p1") });
    w.attention.register(g, ask); w.attention.present(g, ask.key, "m1");
    expect(w.attention.settle(g, ask.key)).toBe("moved");
    expect(w.attention.ask(g, ask.key)).toBe("refused");
    expect([w.attention.state(g, ask.key), w.act(), w.notified, humanWaitOpen(w.T), w.dog.waitingOnHuman(w.T), w.board.get("p1")?.state]).toEqual(["SETTLED", undefined, [], false, false, "doing"]);
  });

  for (const how of ["Allow", "Deny", "answer", "Approve all", "expiry", "cancel", "supersede"] as const) {
    it(`W05 owner resolution releases waiting once (${how})`, () => {
      const w = world(); const g = w.admit("g1");
      const p = w.run("p1");
      const a = w.card("ra", { project: p }); const b = w.card("rb", { project: p });
      w.waiting(g, a); w.waiting(g, b);
      w.open.delete("ra");
      if (how === "answer" || how === "Approve all") w.attention.settleRequest(g, "ra"); else w.attention.settle(g, a.key);
      expect([w.attention.state(g, a.key), w.act(), w.board.get(p)?.waitingOn, humanWaitOpen(w.T)]).toEqual(["SETTLED", "waiting-on-you", "owner_approval", true]);
      w.open.delete("rb");
      w.attention.settle(g, b.key);
      expect([w.act(), w.board.get(p)?.state, humanWaitOpen(w.T), w.dog.waitingOnHuman(w.T), w.notified]).toEqual(["working", "doing", false, false, ["ra", "rb"]]);
      expect(w.attention.settle(g, a.key)).toBe("refused");
      expect(w.attention.stats().holds).toBe(0);
    });
  }

  for (const service of ["image", "highlevel", "publish"] as const) {
    it(`W08 terminal service replay has no effects (${service})`, () => {
      const w = world(); const g = w.admit("g1");
      const shown = new Set<string>(["s1"]);
      const cb = serviceCardWaiting(w.attention, service, { owner: (_t, bot) => bot, isOpen: (_t, id) => shown.has(id) });
      cb(w.T, true, "s1", "m1", "bot-a", { generation: "g1" });
      expect([humanWaitOpen(w.T), w.dog.waitingOnHuman(w.T), w.act()]).toEqual([true, true, "waiting-on-you"]);
      shown.delete("s1");
      cb(w.T, false, "s1", undefined, "bot-a", { generation: "g1" });
      expect([humanWaitOpen(w.T), w.dog.waitingOnHuman(w.T), w.act()]).toEqual([false, false, "working"]);
      shown.add("s1");
      cb(w.T, true, "s1", "m1", "bot-a", { generation: "g1" });
      expect([humanWaitOpen(w.T), w.dog.waitingOnHuman(w.T), w.act(), w.notified]).toEqual([false, false, "working", ["s1"]]);
      w.attention.retireTurn(g, "ended");
      cb(w.T, true, "s1", "m1", "bot-a", { generation: "g1" });
      cb(w.T, true, "s1", "m1", "bot-a", { generation: "g1", scope: g });
      expect([humanWaitOpen(w.T), w.dog.waitingOnHuman(w.T), w.notified, w.attention.stats().cards]).toEqual([false, false, ["s1"], 0]);
    });
  }

  for (const variant of ["absent scope", "retired scope", "different scope same textual identity", "different current generation"] as const) {
    it(`W09 missing or foreign generation cannot register (${variant})`, () => {
      const w = world();
      let scope: AttentionScope | undefined;
      if (variant === "absent scope") { w.admit("g1"); scope = undefined; }
      else if (variant === "retired scope") { scope = w.admit("g1"); w.attention.retireTurn(scope, "ended"); }
      else if (variant === "different scope same textual identity") { scope = w.admit("g1"); w.attention.retireTurn(scope, "ended"); w.admit("g1"); }
      else { scope = w.admit("g1"); w.admit("g2"); }
      const ask = w.card("r1");
      expect(w.attention.register(scope, ask)).toBe("refused");
      expect(w.attention.acquireWait(scope, "r1")).toBe("refused");
      expect(w.attention.present(scope, ask.key, "m1")).toBe("refused");
      expect(w.attention.ask(scope, ask.key)).toBe("refused");
      expect(w.attention.stats()).toMatchObject({ cards: 0, requests: 0, waits: 0, holds: 0 });
      expect([w.act(), w.notified, humanWaitOpen(w.T)]).toEqual([undefined, [], false]);
    });
  }

  it("W10 presentation returning after retirement cannot recreate attention (module presentation adapter)", async () => {
    const w = world(); const old = w.admit("g1");
    let release!: (id: string) => void;
    const shown = new Promise<string>(resolve => { release = resolve; });
    w.attention.acquireWait(old, "r1");
    const pending = w.attention.presentCard(old, w.card("r1"), () => shown);
    expect(w.attention.stats().cards).toBe(1);
    w.attention.retireTurn(old, "ended");
    const next = w.admit("g2");
    const successor = w.card("r2");
    w.waiting(next, successor);
    const snapshot = { stats: w.attention.stats(), act: w.act(), notified: [...w.notified] };
    release("m1");
    expect(await pending).toBe("refused");
    expect(w.attention.ask(old, { kind: "engine", approvalId: "approval-r1" })).toBe("refused");
    expect({ stats: w.attention.stats(), act: w.act(), notified: w.notified }).toEqual(snapshot);
    expect(snapshot.stats).toMatchObject({ scopes: 1, cards: 1, requests: 1, waits: 1 });
    expect([w.attention.state(next, successor.key), humanWaitOpen(w.T), w.dog.waitingOnHuman(w.T)]).toEqual(["WAITING", true, true]);
  });

  it("W17 late old settlement cannot release replacement waits", () => {
    const w = world(); const old = w.admit("g1");
    const shown = new Set(["shared"]);
    const cb = serviceCardWaiting(w.attention, "publish", { owner: (_t, bot) => bot, isOpen: (_t, id) => shown.has(id) });
    w.waiting(old, w.card("shared", { project: w.run("p1") }));
    w.attention.retireTurn(old, "ended");
    const next = w.admit("g2");
    const p2 = w.run("p2");
    const replacement = w.card("shared", { project: p2 });
    w.waiting(next, replacement);
    w.attention.settleRequest(old, "shared");
    w.attention.settle(old, replacement.key);
    w.attention.releaseWait(old, "shared");
    cb(w.T, false, "shared", undefined, "bot-a", { generation: "g1" });
    w.attention.retireTurn(old, "ended");
    expect([w.attention.state(next, replacement.key), humanWaitOpen(w.T), w.dog.waitingOnHuman(w.T), w.act(), w.board.get(p2)?.waitingOn])
      .toEqual(["WAITING", true, true, "waiting-on-you", "owner_approval"]);
  });

  it("W18 one answered card cannot lower another card's attention", () => {
    const w = world(); const g = w.admit("g1");
    const p = w.run("p1");
    const one = w.card("r1", { project: p }); const two = w.card("r2", { project: p });
    const twoAgain = w.card("r2", { key: { kind: "engine", approvalId: "approval-r2-again" }, project: p });
    w.waiting(g, one); w.waiting(g, two); w.waiting(g, twoAgain);
    w.attention.settle(g, one.key);
    expect([w.act(), w.board.get(p)?.waitingOn, humanWaitOpen(w.T)]).toEqual(["waiting-on-you", "owner_approval", true]);
    w.attention.settle(g, two.key);
    expect([w.act(), w.board.get(p)?.waitingOn, humanWaitOpen(w.T), w.attention.state(g, twoAgain.key)]).toEqual(["waiting-on-you", "owner_approval", true, "WAITING"]);
    w.attention.settleRequest(g, "r2");
    expect([w.act(), w.board.get(p)?.state, humanWaitOpen(w.T), w.attention.state(g, twoAgain.key)]).toEqual(["working", "doing", false, "SETTLED"]);
  });

  for (const later of ["successor run", "stopped", "done", "other wait"] as const) {
    it(`W19 captured board run cannot mutate a successor run (${later})`, () => {
      const w = world(); const g = w.admit("g1");
      const p = w.run("p-old");
      const parked = w.card("r1", { project: p });
      w.waiting(g, parked);
      const pending = w.card("r2", { project: p });
      w.attention.register(g, pending); w.attention.present(g, pending.key, "m2");
      const next = later === "successor run" ? { activeRequestId: "p-new", state: "doing" }
        : later === "other wait" ? { activeRequestId: p, state: "waiting", waitingOn: "blocked" } : { activeRequestId: p, state: later };
      w.board.set(p, next);
      w.attention.ask(g, pending.key);
      w.attention.settle(g, parked.key); w.attention.settle(g, pending.key);
      expect(w.board.get(p)).toEqual(next);
    });
  }

  it("W20 request resolution settles only its generation index", () => {
    const w = world(); const g = w.admit("g1"); const other = w.admit("h1", `${w.T}-other`);
    const first = w.card("r1"); const second = w.card("r1", { key: { kind: "engine", approvalId: "approval-r1-b" } });
    const unrelated = w.card("r9"); const sameIdElsewhere = w.card("r1", { threadId: `${w.T}-other` });
    w.waiting(g, first); w.waiting(g, second); w.waiting(g, unrelated); w.waiting(other, sameIdElsewhere);
    w.attention.settleRequest(g, "r1");
    expect([first, second, unrelated].map(card => w.attention.state(g, card.key))).toEqual(["SETTLED", "SETTLED", "WAITING"]);
    expect(w.attention.state(other, sameIdElsewhere.key)).toBe("WAITING");
    const after = w.attention.stats();
    w.attention.settleRequest(g, "r1");
    expect({ ...w.attention.stats(), visited: 0 }).toEqual({ ...after, visited: 0 });
    expect(w.notified).toEqual(["r1", "r1", "r9", "r1"]);
  });

  it("W34 failed waiting acquisition releases partial effects", () => {
    const w = world(); const g = w.admit("g1");
    const p = w.run("p1");
    const ask = w.card("r1", { project: p });
    w.attention.register(g, ask); w.attention.present(g, ask.key, "m1");
    w.boardThrows.on = true;
    expect(w.attention.ask(g, ask.key)).toBe("failed");
    expect([humanWaitOpen(w.T), w.dog.waitingOnHuman(w.T), w.act(), w.notified, w.attention.stats().holds, w.attention.stats().waits]).toEqual([false, false, "working", [], 0, 0]);
    expect(w.attention.register(g, w.card("r2"))).toBe("refused");
    expect(w.attention.ask(g, ask.key)).toBe("refused");
    expect(w.notified).toEqual([]);
  });
});

// The actual production service callbacks (server/index.ts), executed with injected ports.
import { readFileSync } from "node:fs";
import ts from "typescript";
const indexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const indexAst = ts.createSourceFile("index.ts", indexSource, ts.ScriptTarget.Latest, true);
function serviceCallback(service: "image" | "highlevel" | "publish"): string {
  let found: string | undefined;
  const visit = (node: ts.Node) => {
    if (!found && ts.isPropertyAssignment(node) && node.name.getText(indexAst) === "waiting" && node.initializer.getText(indexAst).includes(`serviceCardWaiting(approvalAttention, "${service}"`)) found = node.initializer.getText(indexAst);
    if (!found) ts.forEachChild(node, visit);
  };
  visit(indexAst);
  if (!found) throw new Error(`missing ${service} waiting callback`);
  return found;
}
type Waiting = (threadId: string, waiting: boolean, requestId: string, messageId?: string, botId?: string, generation?: string, answered?: boolean) => void;
function productionWaiting(w: ReturnType<typeof world>, service: "image" | "highlevel" | "publish", isShown: (id: string) => boolean, liveProjectRun: (threadId: string, generation: string) => string | undefined = () => undefined): Waiting {
  const ports: Record<string, unknown> = {
    askMessageByRequest: new Map<string, string>(), approvalAttention: w.attention, serviceCardWaiting,
    askingBot: (_t: string, bot: string | undefined) => bot, liveProjectRun,
    imageOperations: { answeredApproval: (id: string) => !isShown(id) },
  };
  const code = ts.transpileModule(`return (${serviceCallback(service)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(ports), code)(...Object.values(ports)) as Waiting;
}

describe("service callbacks carry the actor generation (U, production callbacks)", () => {
  for (const service of ["image", "highlevel", "publish"] as const) {
    it(`W21 service presentation uses actor generation before await (${service})`, () => {
      const w = world();
      const channel = `${w.T}-channel`;
      w.admit("actor-gen", channel);
      const shown = new Set(["svc-1"]);
      const cb = productionWaiting(w, service, id => shown.has(id));
      // The producer is held in its presentation; the actor's generation retires and a successor is admitted.
      const old = w.attention.scopeFor(channel, "actor-gen")!;
      w.attention.retireTurn(old, "ended");
      const next = w.admit("successor-gen", channel);
      cb(channel, true, "svc-1", "message-1", "asking-bot", "actor-gen");
      expect([w.attention.stats().cards, humanWaitOpen(channel), w.dog.waitingOnHuman(channel), w.notified]).toEqual([0, false, false, []]);
      // The successor's own card is owned by the bot its actor captured, on a channel thread with no single bot.
      shown.add("svc-2");
      cb(channel, true, "svc-2", "message-2", "asking-bot", "successor-gen");
      expect(w.attention.state(next, { kind: "service", service, requestId: "svc-2" })).toBe("WAITING");
      expect([w.act(channel, "asking-bot"), w.act(channel, "bot-a")]).toEqual(["waiting-on-you", undefined]);
    });
  }

  it("W22 publish uses watchdog and driver wait lifecycle", () => {
    const w = world(); const g = w.admit("g1");
    const shown = new Set(["publish-1"]);
    const cb = productionWaiting(w, "publish", id => shown.has(id));
    cb(w.T, true, "publish-1", "message-1", "bot-a", "g1");
    expect([w.attention.state(g, { kind: "service", service: "publish", requestId: "publish-1" }), humanWaitOpen(w.T), w.dog.waitingOnHuman(w.T)]).toEqual(["WAITING", true, true]);
    shown.delete("publish-1");
    cb(w.T, false, "publish-1", undefined, "bot-a", "g1");
    expect([humanWaitOpen(w.T), w.dog.waitingOnHuman(w.T), w.attention.stats().waits, w.attention.stats().holds]).toEqual([false, false, 0, 0]);
  });

  // A WAITING image card parks its board run on the owner. The close says whether the owner answered (image-operations.ts:
  // result !== "cancelled" && !signal.aborted): an abandoned call (aborted/cancelled) cannot resume work, so the board stays parked
  // for its run owner to settle and only the hold is released; an owner answer (Deny included) resumes the board.
  for (const answered of [false, true] as const) {
    it(`W24 an image close ${answered ? "the owner answered resumes" : "nobody answered leaves"} the parked board run (production image callback)`, () => {
      const w = world(); const g = w.admit("g1");
      const p = w.run("p1");
      const shown = new Set(["img-1"]);
      const cb = productionWaiting(w, "image", id => shown.has(id), (threadId, generation) => (threadId === w.T && generation === "g1" ? p : undefined));
      cb(w.T, true, "img-1", "message-1", "bot-a", "g1");
      expect([w.attention.state(g, { kind: "service", service: "image", requestId: "img-1" }), w.board.get(p)?.state, w.board.get(p)?.waitingOn, humanWaitOpen(w.T)])
        .toEqual(["WAITING", "waiting", "owner_approval", true]);
      expect(w.attention.stats().holds).toBeGreaterThan(0);
      shown.delete("img-1");
      cb(w.T, false, "img-1", undefined, "bot-a", "g1", answered);
      expect([w.board.get(p)?.state, w.board.get(p)?.waitingOn]).toEqual(answered ? ["doing", undefined] : ["waiting", "owner_approval"]);
      expect([w.attention.state(g, { kind: "service", service: "image", requestId: "img-1" }), humanWaitOpen(w.T), w.dog.waitingOnHuman(w.T), w.attention.stats().waits, w.attention.stats().holds])
        .toEqual(["SETTLED", false, false, 0, 0]);
    });
  }

  it("W23 presentation failure releases pending wait", async () => {
    const w = world(); const g = w.admit("g1");
    w.attention.acquireWait(g, "r1");
    const ask = w.card("r1");
    await expect(w.attention.presentCard(g, ask, async () => { throw new Error("presentation failed"); })).rejects.toThrow("presentation failed");
    expect([w.attention.state(g, ask.key), humanWaitOpen(w.T), w.dog.waitingOnHuman(w.T), w.notified, w.act()]).toEqual(["SETTLED", false, false, [], undefined]);
    expect(w.attention.retireTurn(g, "ended")).toBe(true);
    expect(w.attention.stats()).toMatchObject({ scopes: 0, cards: 0, requests: 0, waits: 0, holds: 0 });
  });

  // Review 361e03c3e5 H2: the image close's `answered` flag, through the production image callback (server/index.ts) and the
  // real attention table. An abandoned call (answered=false) releases its holds and wait but leaves the parked board card;
  // an owner answer (answered=true, a Deny included) resumes it.
  const parkedImage = (requestId: string) => {
    const w = world(); const g = w.admit("g1");
    const project = w.run("p1");
    const shown = new Set([requestId]);
    const cb = productionWaiting(w, "image", id => shown.has(id), () => project);
    cb(w.T, true, requestId, "message-1", "bot-a", "g1");
    expect(w.attention.state(g, { kind: "service", service: "image", requestId })).toBe("WAITING");
    expect([w.board.get(project), humanWaitOpen(w.T), w.dog.waitingOnHuman(w.T), w.act(), w.attention.stats().holds])
      .toEqual([{ activeRequestId: project, state: "waiting", waitingOn: "owner_approval" }, true, true, "waiting-on-you", 2]);
    return { w, g, project, shown, cb };
  };
  it("W24 an abandoned image close leaves the parked board card and releases the hold and the wait", () => {
    const { w, g, project, shown, cb } = parkedImage("image-1");
    shown.delete("image-1");
    cb(w.T, false, "image-1", undefined, "bot-a", "g1", false);
    expect(w.board.get(project)).toEqual({ activeRequestId: project, state: "waiting", waitingOn: "owner_approval" });
    expect(w.attention.state(g, { kind: "service", service: "image", requestId: "image-1" })).toBe("SETTLED");
    expect([humanWaitOpen(w.T), w.dog.waitingOnHuman(w.T), w.act(), w.attention.stats().waits, w.attention.stats().holds]).toEqual([false, false, "working", 0, 0]);
  });
  it("W25 an owner answer on the image card resumes the parked board card", () => {
    const { w, g, project, shown, cb } = parkedImage("image-2");
    shown.delete("image-2");
    cb(w.T, false, "image-2", undefined, "bot-a", "g1", true);
    expect(w.board.get(project)).toEqual({ activeRequestId: project, state: "doing", waitingOn: undefined });
    expect(w.attention.state(g, { kind: "service", service: "image", requestId: "image-2" })).toBe("SETTLED");
    expect([humanWaitOpen(w.T), w.dog.waitingOnHuman(w.T), w.act(), w.attention.stats().waits, w.attention.stats().holds]).toEqual([false, false, "working", 0, 0]);
  });
});
