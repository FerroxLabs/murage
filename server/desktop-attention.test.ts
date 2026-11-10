import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { HeldDuringQuiet, cleanReply, closedOutsideMap, judgeOutsideCard, outsideDisplay, outsideOk, outsideOkMap, parseOutsideBody } from "./desktop-attention.ts";

const card = (over: Record<string, unknown> = {}) => ({ requestId: "r1", tool: "Bash", title: "Run a command", subtitle: "ls -la", summary: "ls -la", ...over }) as never;
const D = "a".repeat(64);
const body = (over: Record<string, unknown> = {}) => ({ requestId: "r1", behavior: "allow", outside: { digest: D, surface: "pill" }, ...over });

describe("outsideDisplay and outsideOk", () => {
  it("shows the card's FULL detail, not the summary", () => {
    expect(outsideDisplay(card({ subtitle: "rm a\nrm b", summary: "rm ..." }), "Sable")).toEqual({ botName: "Sable", title: "Run a command", willRun: "rm a\nrm b" });
  });
  it("is null when the name, title or detail is missing", () => {
    expect(outsideDisplay(card({ subtitle: "" }), "Sable")).toBeNull();
    expect(outsideDisplay(card({ title: " " }), "Sable")).toBeNull();
    expect(outsideDisplay(card(), "")).toBeNull();
    expect(outsideDisplay(undefined, "Sable")).toBeNull();
  });
  it("before S0 OS banners and the menu are never ok; our own windows are", () => {
    const map = outsideOkMap(card(), { botName: "Sable" });
    expect(map).toMatchObject({ "banner-mac": false, "banner-win": false, "banner-linux": false, menu: false, pill: true, flyout: true, bubble: true, dock: true });
  });
  it("every trayQuickAnswer exclusion closes every surface", () => {
    const bad: Record<string, unknown>[] = [
      { answered: true }, { dismissed: true }, { expired: true }, { folderTrust: {} }, { routineRequest: {} }, { skillRequest: {} }, { intake: {} }, { setup: {} },
      { taskAllowKey: "k" }, { approvalScope: {} }, { toolInputTruncated: true }, { subtitle: "", summary: "" }, { summary: "x".repeat(241), subtitle: "x".repeat(241) },
      { subtitle: "cat ~/.ssh/id_rsa" }, { subtitle: "rm -rf /", summary: "rm -rf /" }, { requestId: undefined }, { tool: undefined },
    ];
    for (const over of bad) expect(Object.values(outsideOkMap(card(over), { botName: "Sable" })).some(Boolean), JSON.stringify(over)).toBe(false);
    expect(Object.values(outsideOkMap(card(), { botName: "Sable", stopHit: true })).some(Boolean)).toBe(false);
  });
  it("a missing subtitle or an over-long title or bot name is refused per surface", () => {
    expect(outsideOk(card({ subtitle: undefined }), { botName: "Sable" }, "pill")).toBe(false);
    expect(outsideOk(card({ title: "t".repeat(121) }), { botName: "Sable" }, "pill")).toBe(false);
    expect(outsideOk(card(), { botName: "n".repeat(61) }, "pill")).toBe(false);
  });
  it("multi-line over maxLines, a long wrapping line, tabs and control characters", () => {
    expect(outsideOk(card({ subtitle: Array.from({ length: 61 }, () => "x").join("\n") }), { botName: "S" }, "flyout")).toBe(false);
    expect(outsideOk(card({ subtitle: "word ".repeat(2000) }), { botName: "S" }, "flyout")).toBe(false);
    expect(outsideOk(card({ subtitle: "a\tb" }), { botName: "S" }, "flyout")).toBe(false);
    expect(outsideOk(card({ subtitle: "a\u0007b" }), { botName: "S" }, "flyout")).toBe(false);
    expect(outsideOk(card({ subtitle: "echo 日本" }), { botName: "S" }, "dock")).toBe(true);
  });
  it("unknown surface and closed map", () => {
    expect(outsideOk(card(), { botName: "S" }, "toaster" as never)).toBe(false);
    expect(Object.values(closedOutsideMap()).some(Boolean)).toBe(false);
  });
});

describe("parseOutsideBody", () => {
  it("accepts allow, deny and reply", () => {
    expect(parseOutsideBody(body())).toMatchObject({ ok: true, behavior: "allow", surface: "pill" });
    expect(parseOutsideBody(body({ behavior: "deny" }))).toMatchObject({ ok: true, behavior: "deny" });
    expect(parseOutsideBody(body({ behavior: "deny", message: "  not now \u0007 " }))).toMatchObject({ ok: true, message: "not now" });
  });
  it("refuses allowForTask, skip, answer, undo, extra fields and a message on allow", () => {
    for (const over of [{ allowForTask: true }, { behavior: "skip" }, { behavior: "answer" }, { behavior: "undo" }, { reviewedSha256: "x" }, { freshAuth: {} }, { message: "hi" }]) expect(parseOutsideBody(body(over)), JSON.stringify(over)).toMatchObject({ ok: false, status: 400 });
  });
  it("refuses a bad digest, bad surface, extra outside field, empty or oversize reply", () => {
    for (const outside of [{ digest: "zz", surface: "pill" }, { digest: D, surface: "nope" }, { digest: D, surface: "pill", extra: 1 }, { digest: D }, null, []]) expect(parseOutsideBody(body({ outside })).ok).toBe(false);
    expect(parseOutsideBody(body({ behavior: "deny", message: "   " })).ok).toBe(false);
    expect(parseOutsideBody(body({ behavior: "deny", message: "x".repeat(2001) })).ok).toBe(false);
    expect(parseOutsideBody(body({ behavior: "deny", message: "x".repeat(2000) })).ok).toBe(true);
    expect(cleanReply("a\nb")).toBe("a\nb");
  });
});

describe("judgeOutsideCard", () => {
  const base = { card: card(), special: false, digestNow: D, digestAsked: D, stopHit: false, botName: "Sable", surface: "pill" as const };
  it("passes an open, ordinary, unchanged card", () => expect(judgeOutsideCard(base)).toEqual({ ok: true }));
  it("409s a changed digest, a settled card, a special card, a stop-line hit and a surface that does not fit", () => {
    expect(judgeOutsideCard({ ...base, digestNow: "b".repeat(64) })).toMatchObject({ status: 409, code: "card_changed" });
    expect(judgeOutsideCard({ ...base, card: card({ answered: true }) })).toMatchObject({ code: "card_changed" });
    expect(judgeOutsideCard({ ...base, card: undefined })).toMatchObject({ code: "card_changed" });
    expect(judgeOutsideCard({ ...base, special: true })).toMatchObject({ code: "outside_refused" });
    expect(judgeOutsideCard({ ...base, stopHit: true })).toMatchObject({ code: "outside_refused" });
    expect(judgeOutsideCard({ ...base, surface: "menu" })).toMatchObject({ code: "outside_refused" });
  });
});

describe("module is synchronous", () => {
  it("has no await and no async function", () => {
    const source = readFileSync(new URL("./desktop-attention.ts", import.meta.url), "utf8");
    expect(source.replace(/\/\/.*$/gm, "")).not.toMatch(/\bawait\b|\basync\b/);
  });
});

describe("answerOutside (static guard on server/index.ts)", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("function answerOutside(");
  const body = source.slice(start, source.indexOf("\n}\n", start)).replace(/\/\/.*$/gm, "");
  it("exists", () => expect(start).toBeGreaterThan(0));
  it("has no await and is not async, so nothing can change between its checks and the delivery", () => {
    expect(body).not.toMatch(/\bawait\b/);
    expect(source.slice(start - 10, start)).not.toMatch(/async\s*$/);
  });
  it("calls answerRequest last and never enters a special resolver", () => {
    expect(body).toMatch(/answerRequest\(/);
    for (const name of ["answerLimitCard", "answerEmailCard", "answerVenuePostCard", "answerAsSendReply", "questionReply", "resolveSkillRequest", "resolveAndSendRoutine", "resolvePeerComms", "answerCard", "resolveHostComputerConsent", "freshAuthRefusal"]) expect(body, name).not.toContain(`${name}(`);
    expect(body).not.toMatch(/allowForTask|batch:/);
    expect(body).toContain("desktop: true");
  });
  it("respondToCard hands off to it before any await", () => {
    const respond = source.slice(source.indexOf("async function respondToCard("));
    const hook = respond.indexOf("answerOutside(io, threadId, body)");
    expect(hook).toBeGreaterThan(0);
    expect(respond.slice(0, hook)).not.toMatch(/\bawait\b/);
  });
});

describe("HeldDuringQuiet", () => {
  const entry = (n: number) => ({ kind: "approval", botId: "b", threadId: "t", requestId: `r${n}`, at: n });
  it("keeps the newest 100 and drops the oldest", () => {
    const held = new HeldDuringQuiet();
    for (let n = 0; n < 130; n += 1) held.add(entry(n));
    expect(held.size).toBe(100);
    expect(held.list()[0]!.requestId).toBe("r30");
  });
  it("acks up to a time, or everything", () => {
    const held = new HeldDuringQuiet();
    for (let n = 1; n <= 5; n += 1) held.add(entry(n));
    held.ack(3);
    expect(held.list().map(e => e.at)).toEqual([4, 5]);
    held.ack();
    expect(held.size).toBe(0);
  });
  it("returns copies and carries ids only", () => {
    const held = new HeldDuringQuiet();
    held.add({ ...entry(1), title: "SECRET" } as never);
    const first = held.list()[0] as unknown as Record<string, unknown>;
    expect(first.title).toBeUndefined();
    first.at = 99;
    expect(held.list()[0]!.at).toBe(1);
  });
});

describe("in-app answer racing an outside answer (static guard on server/index.ts)", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  it("refuses with a distinct 409 in_flight BEFORE recording an attempt, and again right before each engine delivery", () => {
    const marker = source.indexOf("// Kept only if this route accepts the answer (AnsweredWhere.attempt).");
    expect(marker).toBeGreaterThan(0);
    const before = source.slice(marker - 420, marker);
    expect(before).toMatch(/outsideFlights\.has\([^)]*\)\) return json\(res, 409, \{[^}]*code: "in_flight"/);
    const deliveries = source.match(/if \(outsideFlights\.has\([^)]*\)\) return json\(res, 409, \{[^}]*code: "in_flight"[^}]*\}\);\n\s*const outcome = await answerRequest\(threadId, asked\.instanceId/g) ?? [];
    expect(deliveries.length).toBe(2);
  });
});

describe("outsideOk validates the surface's envelope at the decision point", () => {
  it("calls envelopeValid before fitsEnvelope", () => {
    const source = readFileSync(new URL("./desktop-attention.ts", import.meta.url), "utf8");
    expect(source).toMatch(/envelopeValid\(surface, envelope\)[\s\S]{0,80}return false;[\s\S]{0,80}fitsEnvelope\(/);
  });
});
