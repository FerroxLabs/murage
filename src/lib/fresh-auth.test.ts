import { afterEach, describe, expect, it, vi } from "vitest";
import { approvalDigest } from "../../shared/approval-digest";
import { en } from "../locales";
import { allLocalePacks } from "../locales/testing";
import { isComputerOnly } from "./approval-surface";
import { resetNativeShellForTest } from "./native-shell";
import { approvalAnswer } from "./call-answers";
import { decideWithFreshAuth, FreshAuthError, freshAuthCopy, freshAuthReason, freshAuthSpoken, respondWithFreshAuth } from "./fresh-auth";

const card = { title: "Approval needed", subtitle: "{\"command\":\"ls\"}", tool: "Bash", summary: "ls" };
const ctx = { threadId: "t1", requestId: "req-1", decision: "allow" as const, card, reason: "r" };
const challengeError = async (over: object = {}) => Object.assign(new Error("Confirm it's you on this phone to allow this."), {
  status: 403,
  body: { code: "fresh_auth", challenge: { v: 1, nonce: "n".repeat(43), digest: await approvalDigest("t1", "req-1", card), decision: "allow", expiresAt: 99, ...over } },
});
const native = (approve: (args: unknown) => unknown) => vi.stubGlobal("murageNative", { hello: async () => ({ version: 1, methods: ["approveWithDevice"] }), approveWithDevice: approve });
const refusal = (status: number, code: string) => Object.assign(new Error("server words"), { status, body: { code } });

afterEach(() => { vi.unstubAllGlobals(); resetNativeShellForTest(); });

describe("respondWithFreshAuth", () => {
  it("passes a plain answer straight through", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    await expect(respondWithFreshAuth(post, ctx)).resolves.toEqual({ ok: true });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("asks native to sign the challenge and re-posts with the proof", async () => {
    const approve = vi.fn(async () => ({ signature: "sig" }));
    native(approve);
    const err = await challengeError();
    const post = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce({ ok: true });
    await expect(respondWithFreshAuth(post, { ...ctx, reason: "Allow Lena: Bash: ls" })).resolves.toEqual({ ok: true });
    expect(approve).toHaveBeenCalledWith({ ...err.body.challenge, threadId: "t1", requestId: "req-1", reason: "Allow Lena: Bash: ls" });
    expect(post).toHaveBeenLastCalledWith({ freshAuth: { nonce: "n".repeat(43), signature: "sig" } });
  });

  it("never asks native when the card on screen is not the card the server holds", async () => {
    const approve = vi.fn();
    native(approve);
    const post = vi.fn().mockRejectedValueOnce(await challengeError({ digest: "f".repeat(64) }));
    await expect(respondWithFreshAuth(post, ctx)).rejects.toMatchObject({ code: "changed", message: freshAuthCopy("changed") });
    expect(approve).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("signs a skill request only when its displayed preview hashes to its sha256", async () => {
    const preview = "# Skill\nDo A";
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(preview))), (b) => b.toString(16).padStart(2, "0")).join("");
    const good = { ...card, skillRequest: { source: "chat", preview, sha256 } };
    const altered = { ...card, skillRequest: { source: "chat", preview: "# Skill\nDo B", sha256 } };
    const challengeFor = async (c: object) => Object.assign(new Error("x"), { status: 403, body: { code: "fresh_auth", challenge: { v: 1, nonce: "n".repeat(43), digest: await approvalDigest("t1", "req-1", c), decision: "allow", expiresAt: 99 } } });
    const approve = vi.fn(async () => ({ signature: "sig" }));
    native(approve);
    await expect(respondWithFreshAuth(vi.fn().mockRejectedValueOnce(await challengeFor(good)).mockResolvedValueOnce({ ok: true }), { ...ctx, card: good })).resolves.toEqual({ ok: true });
    expect(approve).toHaveBeenCalledTimes(1);
    // the server digest matches the altered card the phone shows, but the preview no longer matches its hash
    await expect(respondWithFreshAuth(vi.fn().mockRejectedValueOnce(await challengeFor(altered)), { ...ctx, card: altered })).rejects.toMatchObject({ code: "changed" });
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it("never asks native when the page has no card to compare", async () => {
    const approve = vi.fn();
    native(approve);
    const post = vi.fn().mockRejectedValueOnce(await challengeError());
    await expect(respondWithFreshAuth(post, { ...ctx, card: undefined })).rejects.toMatchObject({ code: "changed" });
    expect(approve).not.toHaveBeenCalled();
  });

  it("says to update when the app has no approveWithDevice", async () => {
    vi.stubGlobal("murageNative", { hello: async () => ({ version: 1, methods: [] }) });
    const post = vi.fn().mockRejectedValueOnce(await challengeError());
    await expect(respondWithFreshAuth(post, ctx)).rejects.toMatchObject({ code: "update", message: freshAuthCopy("update") });
  });

  it("says to update when the page cannot digest (no WebCrypto on a plain-http origin)", async () => {
    const approve = vi.fn();
    native(approve);
    const post = vi.fn().mockRejectedValueOnce(await challengeError());
    vi.stubGlobal("crypto", undefined);
    await expect(respondWithFreshAuth(post, ctx)).rejects.toMatchObject({ code: "update" });
    expect(approve).not.toHaveBeenCalled();
  });

  it.each([["cancelled", "cancelled"], ["no_lock", "noLock"], ["no_key", "noKey"], ["busy", "failed"], ["bad_args", "failed"], ["unavailable", "failed"]])("maps native %s to %s", async (native_, code) => {
    native(async () => { throw new Error(native_); });
    const post = vi.fn().mockRejectedValueOnce(await challengeError());
    const caught = await respondWithFreshAuth(post, ctx).catch((e) => e);
    expect(caught).toBeInstanceOf(FreshAuthError);
    expect(caught).toMatchObject({ code, message: freshAuthCopy(code as never) });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("refuses a reply with no signature without re-posting", async () => {
    native(async () => ({}));
    const post = vi.fn().mockRejectedValueOnce(await challengeError());
    await expect(respondWithFreshAuth(post, ctx)).rejects.toMatchObject({ code: "failed" });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("has no retry loop: a second challenge after the proof goes to the caller", async () => {
    const approve = vi.fn(async () => ({ signature: "sig" }));
    native(approve);
    const second = await challengeError();
    const post = vi.fn().mockRejectedValueOnce(await challengeError()).mockRejectedValueOnce(second);
    await expect(respondWithFreshAuth(post, ctx)).rejects.toBe(second);
    expect(post).toHaveBeenCalledTimes(2);
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it("turns a 409 changed into the changed copy and leaves other errors alone", async () => {
    await expect(respondWithFreshAuth(vi.fn().mockRejectedValueOnce(refusal(409, "fresh_auth_changed")), ctx)).rejects.toMatchObject({ code: "changed" });
    const other = refusal(403, "something_else");
    await expect(respondWithFreshAuth(vi.fn().mockRejectedValueOnce(other), ctx)).rejects.toBe(other);
  });

  it("gives a browser pairing the computer-or-app line", async () => {
    const post = vi.fn().mockRejectedValueOnce(refusal(403, "approve_on_computer"));
    await expect(respondWithFreshAuth(post, ctx)).rejects.toMatchObject({ code: "computerOnly", message: "Approve this on your computer or in the Murage app." });
  });

  it("gives an unattested phone exactly the pair-again line", async () => {
    const post = vi.fn().mockRejectedValueOnce(refusal(403, "fresh_auth_unattested"));
    await expect(respondWithFreshAuth(post, ctx)).rejects.toMatchObject({ code: "pairAgain", message: "Pair this phone again to approve this here." });
  });
});

describe("a refused free-text answer", () => {
  it("has its own code, and its own line that sends the owner to the computer, not to a passcode or a re-pair", async () => {
    const post = vi.fn().mockRejectedValueOnce(refusal(403, "answer_on_computer"));
    await expect(respondWithFreshAuth(post, ctx)).rejects.toMatchObject({ code: "answerOnComputer", message: "Answer this one on your computer." });
    expect(freshAuthCopy("answerOnComputer")).not.toMatch(/passcode|pair/i);
    expect(freshAuthSpoken("answerOnComputer")).toMatch(/computer/);
    expect(freshAuthSpoken("answerOnComputer")).not.toMatch(/passcode|pair/i);
    // only on the status the server sends it with
    const odd = vi.fn().mockRejectedValueOnce(refusal(500, "answer_on_computer"));
    await expect(respondWithFreshAuth(odd, ctx)).rejects.toMatchObject({ status: 500 });
  });

  it("does not hide Allow: the card can still be allowed with Face ID", async () => {
    const { isComputerOnly: only } = await import("./approval-surface");
    const post = vi.fn().mockRejectedValueOnce(refusal(403, "answer_on_computer"));
    await decideWithFreshAuth(post, { threadId: "t-ans", requestId: "r-ans", decision: "allow", card }, { showError: () => {} });
    expect(only("t-ans", "r-ans")).toBe(false);
  });
});

describe("a double tap on Allow", () => {
  it("ignores the second tap while the first is pending, so Face ID is asked once", async () => {
    let release: (v: unknown) => void = () => {};
    const post = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const context = { threadId: "t-dbl", requestId: "r-dbl", decision: "allow" as const, card };
    const first = decideWithFreshAuth(post, context, { showError: () => {} });
    const second = decideWithFreshAuth(post, context, { showError: () => {} });
    expect(post).toHaveBeenCalledTimes(1);
    release({ ok: true });
    await first;
    await second;
    // once settled, a new tap goes through
    const again = vi.fn(async () => ({ ok: true }));
    await decideWithFreshAuth(again, context, { showError: () => {} });
    expect(again).toHaveBeenCalledTimes(1);
  });

  it("a second attempt for the same card joins the pending one and settles with it", async () => {
    let settled = false;
    let release: (v: unknown) => void = () => {};
    const post = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const context = { threadId: "t-join", requestId: "r-join", decision: "allow" as const, card };
    const first = decideWithFreshAuth(post, context, { showError: () => {} });
    const onError = vi.fn();
    const second = decideWithFreshAuth(post, context, { onError, showError: () => {} }).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release({ ok: true });
    await Promise.all([first, second]);
    expect(settled).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("a cancel of the pending prompt reaches the joined attempt as a cancel, with no second prompt", async () => {
    const approve = vi.fn(async () => { throw new Error("cancelled"); });
    native(approve);
    const post = vi.fn().mockRejectedValueOnce(await challengeError());
    const context = { threadId: "t1", requestId: "req-1", decision: "allow" as const, card };
    const firstReport = { onError: vi.fn(), showError: vi.fn() };
    const secondReport = { onError: vi.fn(), showError: vi.fn() };
    const first = decideWithFreshAuth(post, context, firstReport);
    const second = decideWithFreshAuth(post, context, secondReport);
    await Promise.all([first, second]);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(secondReport.onError).toHaveBeenCalledWith("", "cancelled");
    expect(secondReport.showError).not.toHaveBeenCalled();
  });

  it("a refusal of the pending prompt reaches the joined attempt with its code, shown once", async () => {
    const post = vi.fn().mockRejectedValueOnce(refusal(403, "fresh_auth_failed"));
    const context = { threadId: "t-join3", requestId: "r-join3", decision: "allow" as const, card };
    const firstReport = { onError: vi.fn(), showError: vi.fn() };
    const secondReport = { onError: vi.fn(), showError: vi.fn() };
    await Promise.all([decideWithFreshAuth(post, context, firstReport), decideWithFreshAuth(post, context, secondReport)]);
    expect(firstReport.showError).toHaveBeenCalledTimes(1);
    expect(secondReport.showError).not.toHaveBeenCalled();
    expect(secondReport.onError.mock.calls[0][1]).toBe("failed");
  });

  it("frees the card after a refusal, and does not block another card", async () => {
    const context = { threadId: "t-dbl2", requestId: "r-dbl2", decision: "allow" as const, card };
    await decideWithFreshAuth(vi.fn().mockRejectedValueOnce(refusal(403, "fresh_auth_failed")), context, { showError: () => {} });
    const retry = vi.fn(async () => ({ ok: true }));
    await decideWithFreshAuth(retry, context, { showError: () => {} });
    expect(retry).toHaveBeenCalledTimes(1);
    let release: (v: unknown) => void = () => {};
    const slow = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const a = decideWithFreshAuth(slow, { ...context, requestId: "other-1" }, { showError: () => {} });
    const other = vi.fn(async () => ({ ok: true }));
    await decideWithFreshAuth(other, { ...context, requestId: "other-2" }, { showError: () => {} });
    expect(other).toHaveBeenCalledTimes(1);
    release({ ok: true });
    await a;
  });
});

describe("freshAuthCopy", () => {
  it("has one line per refusal, all in the catalog of every language", async () => {
    const codes = ["changed", "failed", "noLock", "noKey", "update", "pairAgain", "computerOnly", "answerOnComputer"] as const;
    const packs = await allLocalePacks();
    for (const code of codes) {
      expect(freshAuthCopy(code)).not.toBe("");
      expect(freshAuthCopy(code)).not.toMatch(/—|\bsafe/i);
      for (const [lang, pack] of Object.entries(packs)) expect(Object.keys(pack).includes(`freshAuth.${code}`), `${lang} ${code}`).toBe(true);
    }
    expect(freshAuthCopy("update")).toBe(en["freshAuth.update"]);
    expect(freshAuthCopy("cancelled")).toBe("");
  });
});

describe("freshAuthReason", () => {
  it("names the bot, the tool and the start of what it will do, with no control characters", () => {
    expect(freshAuthReason(card, "Lena")).toBe("Allow Lena: Bash: ls");
    expect(freshAuthReason({ tool: "Bash", subtitle: "a\nb" }, "Lena")).toBe("Allow Lena: Bash: a b");
    expect(freshAuthReason({ tool: "Bash", summary: "x".repeat(300) }, "Lena")).toBe(`Allow Lena: Bash: ${"x".repeat(60)}`);
    expect(freshAuthReason({ title: "Run a command?" }, "Lena")).toBe("Allow Lena: Run a command?");
    expect(freshAuthReason({ title: "x".repeat(300) }, "Lena").length).toBe(120);
    expect(freshAuthReason(undefined, undefined)).toBe("Allow this request");
  });
});

describe("decideWithFreshAuth", () => {
  const report = () => ({ onError: vi.fn(), showError: vi.fn() });

  it("posts once for a plain answer and reports nothing", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    const r = report();
    await decideWithFreshAuth(post, { threadId: "t1", requestId: "req-1", decision: "allow", card }, r);
    expect(post).toHaveBeenCalledTimes(1);
    expect(r.showError).not.toHaveBeenCalled();
    expect(r.onError).not.toHaveBeenCalled();
  });

  it("tells onSuccess once the answer is posted, after a signed retry too, and never on a failure", async () => {
    const ok = { onError: vi.fn(), onSuccess: vi.fn(), showError: vi.fn() };
    await decideWithFreshAuth(vi.fn(async () => ({ ok: true })), { threadId: "t-s1", requestId: "r-s1", decision: "allow", card }, ok);
    expect(ok.onSuccess).toHaveBeenCalledTimes(1);
    native(async () => ({ signature: "sig" }));
    const signed = { onError: vi.fn(), onSuccess: vi.fn(), showError: vi.fn() };
    await decideWithFreshAuth(vi.fn().mockRejectedValueOnce(await challengeError()).mockResolvedValueOnce({ ok: true }), { threadId: "t1", requestId: "req-1", decision: "allow", card }, signed);
    expect(signed.onSuccess).toHaveBeenCalledTimes(1);
    const bad = { onError: vi.fn(), onSuccess: vi.fn(), showError: vi.fn() };
    await decideWithFreshAuth(vi.fn().mockRejectedValueOnce(refusal(403, "fresh_auth_failed")), { threadId: "t-s2", requestId: "r-s2", decision: "allow", card }, bad);
    expect(bad.onSuccess).not.toHaveBeenCalled();
  });

  it("signs the challenge and re-posts with the proof, naming the bot in the prompt", async () => {
    const approve = vi.fn(async () => ({ signature: "sig" }));
    native(approve);
    const post = vi.fn().mockRejectedValueOnce(await challengeError()).mockResolvedValueOnce({ ok: true });
    const r = report();
    await decideWithFreshAuth(post, { threadId: "t1", requestId: "req-1", decision: "allow", card, botName: "Lena" }, r);
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ reason: "Allow Lena: Bash: ls" }));
    expect(post).toHaveBeenLastCalledWith({ freshAuth: { nonce: "n".repeat(43), signature: "sig" } });
    expect(r.showError).not.toHaveBeenCalled();
  });

  it("leaves the card pending on a Face ID cancel: no error shown, onError told it was a cancel", async () => {
    native(async () => { throw new Error("cancelled"); });
    const post = vi.fn().mockRejectedValueOnce(await challengeError());
    const r = report();
    await decideWithFreshAuth(post, { threadId: "t1", requestId: "req-1", decision: "allow", card }, r);
    expect(r.showError).not.toHaveBeenCalled();
    expect(r.onError).toHaveBeenCalledWith("", "cancelled");
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("shows the refusal copy and passes its code on", async () => {
    const post = vi.fn().mockRejectedValueOnce(refusal(403, "fresh_auth_unattested"));
    const r = report();
    await decideWithFreshAuth(post, { threadId: "t1", requestId: "req-1", decision: "allow", card }, r);
    expect(r.showError).toHaveBeenCalledTimes(1);
    expect(r.onError).toHaveBeenCalledWith("Pair this phone again to approve this here.", "pairAgain");
  });

  it("passes a server error through with no code", async () => {
    const other = refusal(500, "boom");
    const r = report();
    await decideWithFreshAuth(vi.fn().mockRejectedValueOnce(other), { threadId: "t1", requestId: "req-1", decision: "allow", card }, r);
    expect(r.showError).toHaveBeenCalledWith(other);
    expect(r.onError).toHaveBeenCalledWith("server words", undefined);
  });
});

describe("the proof is only for the choice the owner made", () => {
  it("never asks native to sign allow-for-task when the owner chose allow once", async () => {
    const approve = vi.fn();
    native(approve);
    const post = vi.fn().mockRejectedValueOnce(await challengeError({ decision: "allow-task" }));
    await expect(respondWithFreshAuth(post, ctx)).rejects.toMatchObject({ code: "changed" });
    expect(approve).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("never asks native to sign allow once when the owner chose allow for this task", async () => {
    const approve = vi.fn();
    native(approve);
    const post = vi.fn().mockRejectedValueOnce(await challengeError({ decision: "allow" }));
    await expect(respondWithFreshAuth(post, { ...ctx, decision: "allow-task" })).rejects.toMatchObject({ code: "changed" });
    expect(approve).not.toHaveBeenCalled();
  });

  it("signs allow-task when that is what the owner chose and the challenge says", async () => {
    const approve = vi.fn(async () => ({ signature: "sig" }));
    native(approve);
    const post = vi.fn().mockRejectedValueOnce(await challengeError({ decision: "allow-task" })).mockResolvedValueOnce({ ok: true });
    await expect(respondWithFreshAuth(post, { ...ctx, decision: "allow-task" })).resolves.toEqual({ ok: true });
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ decision: "allow-task" }));
  });

  it("signs nothing for a call that is not an allow (no decision given)", async () => {
    const approve = vi.fn();
    native(approve);
    const post = vi.fn().mockRejectedValueOnce(await challengeError());
    await expect(respondWithFreshAuth(post, { ...ctx, decision: undefined })).rejects.toMatchObject({ code: "changed" });
    expect(approve).not.toHaveBeenCalled();
  });
});

describe("the bot name under the Face ID prompt", () => {
  it("strips control characters and line breaks", () => {
    const reason = freshAuthReason({ title: "t", tool: "Bash", summary: "ls" }, "Le\nna\u0007\u202e");
    expect(reason).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    expect(reason).toContain("Le na");
  });

  it("strips bidi overrides and zero-width characters from every part of the reason", () => {
    const reason = freshAuthReason({ title: "t", tool: "Ba\u202esh", summary: "l\u200bs\u2066 -la\ufeff" }, "Le\u202ena\u200f\u{E0001}");
    expect(reason).not.toMatch(/\p{Cf}/u);
    expect(reason).not.toMatch(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/);
    expect(reason).toBe("Allow Lena: Bash: ls -la");
  });

  it("caps a long name", () => {
    const reason = freshAuthReason({ title: "t", tool: "Bash", summary: "ls" }, "L".repeat(500));
    expect(reason.length).toBeLessThanOrEqual(120);
    expect(reason).not.toContain("L".repeat(41));
  });

  it("falls back to the generic name when the name is only control characters", () => {
    expect(freshAuthReason({ title: "t", tool: "Bash", summary: "ls" }, "\n\t ")).toBe(freshAuthReason({ title: "t", tool: "Bash", summary: "ls" }, undefined));
  });
});

describe("a browser pairing's refusal", () => {
  it("is remembered for that request, so the page stops offering Allow", async () => {
    const refused = refusal(403, "approve_on_computer");
    const shown: unknown[] = [];
    await decideWithFreshAuth(vi.fn().mockRejectedValueOnce(refused), { threadId: "t7", requestId: "req-7", card }, { showError: (e) => shown.push(e) });
    expect(isComputerOnly("t7", "req-7")).toBe(true);
    expect(shown).toHaveLength(1);
  });
});

describe("a spoken yes to a high-risk card (SEC-006 Decision 7)", () => {
  const spokenCtx = { threadId: "t1", requestId: "req-1", decision: "allow" as const, card, reason: "Allow Lena: Run a command?" };

  it("reads yes as an allow, posts it once with no proof, and only the phone's signature finishes it", async () => {
    expect(approvalAnswer("yes")).toBe("allow");
    expect(approvalAnswer("yes, go ahead")).toBe("allow");
    const approve = vi.fn(async () => ({ signature: "sig" }));
    native(approve);
    const post = vi.fn().mockRejectedValueOnce(await challengeError()).mockResolvedValueOnce({ ok: true });
    await expect(respondWithFreshAuth(post, spokenCtx)).resolves.toEqual({ ok: true });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]).toEqual([]);
    expect(post.mock.calls[1]).toEqual([{ freshAuth: { nonce: "n".repeat(43), signature: "sig" } }]);
  });

  it.each([["cancelled", "cancelled"], ["no_lock", "noLock"], ["no_key", "noKey"]])(
    "a spoken yes gets no second post when the phone answers %s",
    async (reason, code) => {
      native(async () => { throw new Error(reason); });
      const post = vi.fn().mockRejectedValueOnce(await challengeError());
      await expect(respondWithFreshAuth(post, spokenCtx)).rejects.toMatchObject({ code });
      expect(post).toHaveBeenCalledTimes(1);
    },
  );

  it("a spoken yes for the rest of the call is an allow to the helper, never an allow-task", () => {
    expect(approvalAnswer("yes for the rest of the call")).toBe("allow-for-call");
    expect(approvalAnswer("yes for the rest of the call")).not.toBe("allow-task");
  });

  it("a spoken no is posted once with no phone prompt", async () => {
    expect(approvalAnswer("no")).toBe("deny");
    const approve = vi.fn();
    native(approve);
    const post = vi.fn(async () => ({ ok: true }));
    await respondWithFreshAuth(post, { threadId: "t1", requestId: "req-1", card, reason: "r" });
    expect(post).toHaveBeenCalledTimes(1);
    expect(approve).not.toHaveBeenCalled();
  });

  it("a cancel reaches onError as an empty message with the cancelled code, and shows no error", async () => {
    native(async () => { throw new Error("cancelled"); });
    const onError = vi.fn();
    const showError = vi.fn();
    await decideWithFreshAuth(vi.fn().mockRejectedValueOnce(await challengeError()), { threadId: "t1", requestId: "req-1", decision: "allow", card }, { onError, showError });
    expect(onError).toHaveBeenCalledWith("", "cancelled");
    expect(showError).not.toHaveBeenCalled();
  });
});

describe("freshAuthSpoken", () => {
  const codes = ["changed", "failed", "noLock", "noKey", "update", "pairAgain", "computerOnly", "answerOnComputer", "cancelled", "gone"] as const;

  it("has a short plain line for every code, each leaving a way out", () => {
    for (const code of codes) {
      const line = freshAuthSpoken(code);
      expect(line.length, code).toBeGreaterThan(20);
      expect(line.length, code).toBeLessThan(170);
      expect(line, code).not.toMatch(/—|\bsaf(?:e|ely|ety)\b/i);
      expect(line, code).toMatch(/say no|say yes|computer|deny/i);
    }
    expect(freshAuthSpoken("cancelled")).toBe("Okay, I'll leave that waiting. Say yes when you're ready, or no to deny it.");
    expect(freshAuthSpoken("noLock")).toContain("no passcode");
    expect(freshAuthSpoken("computerOnly")).toContain("Approve this on your computer or in the Murage app");
    expect(freshAuthSpoken("pairAgain")).toContain("Pair this phone again");
  });

  it("is in the catalog of every language", async () => {
    const packs = await allLocalePacks();
    for (const code of codes) {
      for (const [lang, pack] of Object.entries(packs)) {
        expect(Object.keys(pack), `${lang} ${code}`).toContain(`freshAuth.spoken.${code}`);
      }
    }
  });
});

describe("server refusals that end a spoken yes (SEC-006 Decision 7)", () => {
  const spokenCtx = { threadId: "t1", requestId: "req-1", decision: "allow" as const, card, reason: "r" };
  it.each([
    [403, "fresh_auth_failed", "failed"],
    [403, "fresh_auth_unavailable", "noKey"],
    [409, "fresh_auth_gone", "gone"],
    [403, "fresh_auth_unattested", "pairAgain"],
    [403, "answer_on_computer", "answerOnComputer"],
  ])("%i %s is spoken as the %s line, never the generic save line", async (status, serverCode, code) => {
    const post = vi.fn().mockRejectedValueOnce(refusal(status, serverCode));
    await expect(respondWithFreshAuth(post, spokenCtx)).rejects.toMatchObject({ code });
    expect(post).toHaveBeenCalledTimes(1);
    const onError = vi.fn();
    await decideWithFreshAuth(vi.fn().mockRejectedValueOnce(refusal(status, serverCode)), { threadId: "t1", requestId: "req-1", decision: "allow", card }, { onError, showError: () => {} });
    expect(onError.mock.calls[0][1]).toBe(code);
  });
  it("the no-longer-waiting line is in the catalog", () => {
    expect(freshAuthCopy("gone")).toBe(en["freshAuth.gone"]);
    expect(freshAuthSpoken("gone")).toContain("no longer waiting");
  });
});
