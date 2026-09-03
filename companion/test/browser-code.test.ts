// Typed-code sign-in at the browser door.
//
// The defect this covers: a laptop cannot photograph its own screen. Both
// unauthenticated pages named exactly one way in — "scan the code with this
// device" — and there was no typed-code path at all, so the only route onto a
// machine with a keyboard was copying `/enter#<token>` across by hand. The
// same gap is the cloud case: a browser pointed at a machine in a datacentre
// has no camera and no desktop QR beside it either.
//
// Three things are pinned here, and they fail in different ways:
//
//  1. **The served scripts parse.** `browser.ts` emits its pages as template
//     literals, where a backslash is an escape the literal consumes and a
//     backtick ends the string. A `\b` in a served script once became a
//     literal backspace, killed the whole script with a syntax error, and left
//     a page that sat there with no way in — invisible to every test in the
//     suite, because nothing ever executed it. So the scripts are extracted
//     out of the real HTTP responses and run through `node --check`.
//  2. **The credential is the same credential.** Typing the code produces the
//     same session, on the same device record, with the same expiry, that
//     scanning the QR produces. No username, no password, no second store.
//  3. **Guessing is expensive.** Six digits is one in a million, which is the
//     first time an online guess has been worth making at this door.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  codeEntryScript,
  countsAgainstSignIn,
  cookieName,
  createBrowserHandler,
  createSignInLimiter,
  normalizeCredential,
  signInClientKey,
  SIGN_IN_FORGET_MS,
  SIGN_IN_FREE_ATTEMPTS,
  SIGN_IN_LOCKOUT_BASE_MS,
  SIGN_IN_LOCKOUT_FACTOR,
  SIGN_IN_LOCKOUT_MAX_MS,
  SIGN_IN_MAX_CLIENTS,
  type BoundIdentity,
  type BrowserDeviceStore,
  type SignInLimiter,
} from "../src/browser.ts";
import { DeviceRegistry } from "../src/devices.ts";
import { DATA_DIR } from "../src/state.ts";

/** The real registry, reset per test. Real rather than a fake, because the
 * point of the whole change is that the typed code is the SAME credential the
 * QR carries — a fake redeem would let that claim be true only in the test. */
let registry = new DeviceRegistry();
/** Every credential `redeem` was asked about, so "the door never reached the
 * registry" is an assertion about calls rather than about status codes. */
let asked: string[] = [];
/** Swapped by the rate-limit tests; null means the door makes its own. */
let limiter: SignInLimiter | null = null;

const store: BrowserDeviceStore = {
  redeem: (credential, name, pairRequestId) => {
    asked.push(credential);
    return registry.redeem(credential, name, pairRequestId);
  },
  openSession: (deviceId, label) => registry.openSession(deviceId, label),
  resolveSession: (value) => registry.resolveSession(value),
  closeSession: (value) => registry.closeSession(value),
  renewSession: (value) => registry.renewSession(value),
};

const identity: BoundIdentity = {
  scheme: "http",
  hosts: new Set(["macbook.tail0a48a4.ts.net", "127.0.0.1"]),
};

let door: Server | null = null;
let doorPort = 0;

/** A door with no harness behind it. Nothing tested here forwards upstream:
 * `/enter`, the 401 shell and `POST /session` all terminate in the door. */
const openDoor = async (): Promise<void> => {
  await closeDoor();
  door = createServer(
    createBrowserHandler({
      harnessPort: 1,
      identity: () => identity,
      devices: store,
      ...(limiter ? { signInLimiter: limiter } : {}),
    }),
  );
  await new Promise<void>((r) => door!.listen(0, "127.0.0.1", r));
  doorPort = (door!.address() as AddressInfo).port;
};

const closeDoor = async (): Promise<void> => {
  if (!door) return;
  door.closeAllConnections?.();
  const closing = door;
  door = null;
  await new Promise<void>((r) => closing.close(() => r()));
};

beforeEach(async () => {
  rmSync(join(DATA_DIR, "devices.json"), { force: true });
  registry = new DeviceRegistry();
  asked = [];
  limiter = null;
  await openDoor();
});

afterAll(async () => {
  await closeDoor();
});

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const knock = (
  method: string,
  path: string,
  extra: Record<string, string> = {},
  body?: string,
): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      host: `macbook.tail0a48a4.ts.net:${doorPort}`,
      "sec-fetch-site": "same-origin",
      ...extra,
    };
    if (body !== undefined) headers["content-type"] ??= "application/json";
    const req = request({ hostname: "127.0.0.1", port: doorPort, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });

/** Exactly what the served page sends: a same-origin POST carrying Origin,
 * which is what the door's rule 4 requires of every write. */
const submitCode = (code: string): Promise<Answer> =>
  knock("POST", "/session", { origin: `http://macbook.tail0a48a4.ts.net:${doorPort}` }, JSON.stringify({ credential: code }));

const bodyOf = (answer: Answer): Record<string, unknown> => JSON.parse(answer.body);

/** Every inline script in a document. */
const inlineScripts = (html: string): string[] =>
  [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

// ─────────────────────────────────────────────────────────────────────────
// 1. THE HAZARD: a served script that does not parse is a blank page
// ─────────────────────────────────────────────────────────────────────────
describe("the scripts these pages serve are real JavaScript", () => {
  const scratch = mkdtempSync(join(tmpdir(), "murage-door-script-"));

  /** Parse it the way a browser would have to, in a separate process. An
   * assertion about the string's contents is a proxy; this is the thing. */
  const parses = (source: string, name: string): void => {
    const file = join(scratch, `${name}.js`);
    writeFileSync(file, source);
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  };

  it("parses the typed-code script on its own", () => {
    expect(() => parses(codeEntryScript(), "code-entry")).not.toThrow();
  });

  it("carries no backslash and no backtick, which the template literal would eat", () => {
    // The failure this prevents is silent: the literal consumes the escape,
    // the emitted script is malformed, and nothing on the server side ever
    // notices because the server never runs it.
    expect(codeEntryScript()).not.toContain("\\");
    expect(codeEntryScript()).not.toContain("`");
  });

  it("parses every script the door actually serves, from the real responses", async () => {
    const enter = await knock("GET", "/enter", { "sec-fetch-mode": "navigate" });
    expect(enter.status).toBe(200);
    const signIn = await knock("GET", "/", { "sec-fetch-mode": "navigate" });
    expect(signIn.status).toBe(401);

    const scripts = [...inlineScripts(enter.body), ...inlineScripts(signIn.body)];
    // One block per page, and `/enter`'s carries both halves — the typed-code
    // wiring and the fragment redemption. A page that lost its script would
    // pass a parse check vacuously, so what is in them is asserted first.
    expect(scripts.length).toBe(2);
    expect(scripts[0]).toContain("location.hash");
    expect(scripts[0]).toContain('getElementById("cf")');
    expect(scripts[1]).toContain('getElementById("cf")');
    scripts.forEach((source, i) => {
      expect(() => parses(source, `served-${i}`)).not.toThrow();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. THE COPY: neither page may assume a camera
// ─────────────────────────────────────────────────────────────────────────
describe("both unauthenticated pages name both ways in", () => {
  it("offers the sign-in page a typed-code field, not just a QR instruction", async () => {
    const page = await knock("GET", "/", { "sec-fetch-mode": "navigate" });
    expect(page.status).toBe(401);

    // The old copy, which a laptop cannot act on.
    expect(page.body).not.toContain("scan the code with this device");
    // Both routes named.
    expect(page.body).toMatch(/[Ss]can/);
    expect(page.body).toContain("six-digit code");
    // And the field itself, typable.
    expect(page.body).toContain('id="cc"');
    expect(page.body).toContain('inputmode="numeric"');
    // Never a form: a form whose script failed to load would navigate with
    // the credential in the query string, which is the one place the whole
    // fragment design exists to keep it out of.
    expect(page.body).not.toContain("<form");
  });

  it("gives the sign-in page a nonce policy that permits its own script and nothing else", async () => {
    const page = await knock("GET", "/", { "sec-fetch-mode": "navigate" });
    const csp = String(page.headers["content-security-policy"] ?? "");
    const nonce = /<script nonce="([^"]+)">/.exec(page.body)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain(`script-src 'nonce-${nonce}'`);
    // The one call the page makes.
    expect(csp).toContain("connect-src 'self'");
    // Still nowhere for a form to post, and still unframeable.
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("turns /enter with no credential into a place a keyboard can finish", async () => {
    const page = await knock("GET", "/enter", { "sec-fetch-mode": "navigate" });
    // The dead end it used to be.
    expect(page.body).not.toContain("Nothing to sign in with");
    expect(page.body).not.toContain("scan the code again");
    // The field is present but hidden until the fragment turns out to be
    // empty — a page reached WITH a credential must not also ask for one.
    expect(page.body).toContain('id="cf" class="cf" hidden');
    expect(page.body).toContain('document.getElementById("cf").hidden = false;');
    expect(page.body).toContain("type the six-digit code");
  });

  it("falls back to the field when a scanned link turns out to be spent", async () => {
    const page = await knock("GET", "/enter", { "sec-fetch-mode": "navigate" });
    // A QR link that fails — expired, already used, guessed to death — used
    // to end at a sentence. The person is standing at the computer that can
    // show them a fresh code, so the field appears instead.
    const failure = page.body.slice(page.body.indexOf('say("Could not sign in"'));
    expect(failure.slice(0, 400)).toContain('document.getElementById("cf").hidden = false;');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. THE CREDENTIAL: the same one, presented a second way
// ─────────────────────────────────────────────────────────────────────────
describe("a typed code is the same credential as the scanned one", () => {
  it("signs in, with the spacing a person actually types", async () => {
    const { code } = registry.openPairing();
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}\n`;

    const answer = await submitCode(spaced);
    expect(answer.status).toBe(201);
    // The registry saw the digits, not what the person's fingers produced.
    // Answering a stray space as a wrong code costs one of five attempts.
    expect(asked).toEqual([code]);

    const set = String(answer.headers["set-cookie"]?.[0] ?? "");
    expect(set.startsWith(`${cookieName("http")}=`)).toBe(true);
    expect(set).toContain("HttpOnly");
    // The cookie is a session against a real device record — the same record
    // a scan would have made, in the same file, revocable the same way.
    const value = set.slice(set.indexOf("=") + 1, set.indexOf(";"));
    expect(registry.resolveSession(value)?.device.id).toBe(registry.list()[0].id);
    expect(registry.list()).toHaveLength(1);
  });

  it("burns the QR token with it — one window, two forms, one redemption", async () => {
    const { code, token } = registry.openPairing();
    expect((await submitCode(code)).status).toBe(201);

    // The scanned half of the same window is spent too, and says so.
    const second = await submitCode(token);
    expect(second.status).toBe(401);
    expect(String(bodyOf(second).error)).toContain("already signed a device in");
    expect(registry.list()).toHaveLength(1);
  });

  it("never sends the raw bearer token back to the page", async () => {
    const { code } = registry.openPairing();
    const answer = await submitCode(code);
    expect(answer.body).not.toContain("murage_");
    expect(bodyOf(answer)).toEqual({ ok: true, device: { name: "Browser" } });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. THE FOUR FAILURES, each with its own sentence
// ─────────────────────────────────────────────────────────────────────────
describe("every way a typed code can fail gets its own answer", () => {
  const wrongFor = (code: string) => (code === "000000" ? "111111" : "000000");

  it("says a wrong code is wrong", async () => {
    const { code } = registry.openPairing();
    const answer = await submitCode(wrongFor(code));
    expect(answer.status).toBe(401);
    expect(bodyOf(answer).error).toBe("that pairing credential is not right");
  });

  it("says an expired code expired, rather than that pairing is not happening", async () => {
    const { code } = registry.openPairing();
    registry.closePairing();

    const answer = await submitCode(code);
    expect(answer.status).toBe(401);
    // The distinction is the whole point: "no pairing is in progress" reads
    // as a fault in the app and sends people hunting. "It expired, show a new
    // one" is an instruction.
    expect(String(bodyOf(answer).error)).toContain("expired");
    expect(String(bodyOf(answer).error)).not.toContain("no pairing is in progress");
  });

  it("says an already-used code was used, and by what to do next", async () => {
    const { code } = registry.openPairing();
    expect((await submitCode(code)).status).toBe(201);

    const answer = await submitCode(code);
    expect(answer.status).toBe(401);
    expect(String(bodyOf(answer).error)).toContain("already signed a device in");
  });

  it("says a code guessed to death was cancelled, not merely absent", async () => {
    const { code } = registry.openPairing();
    const wrong = wrongFor(code);
    // Five wrong guesses burn the window. Done against the registry directly:
    // the door's own limiter would lock this client out first, which is
    // exactly what it is for and is asserted below on its own.
    for (let i = 0; i < 5; i++) registry.redeem(wrong, "attacker");
    expect(registry.pairing()).toBeNull();

    const answer = await submitCode(code);
    expect(answer.status).toBe(401);
    expect(String(bodyOf(answer).error)).toContain("too many wrong guesses");
  });

  it("says nothing is in progress only when nothing ever was", async () => {
    const answer = await submitCode("424242");
    expect(answer.status).toBe(401);
    expect(bodyOf(answer).error).toBe("no pairing is in progress — open Phone settings on your computer");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. THE LOCKOUT
// ─────────────────────────────────────────────────────────────────────────
describe("repeated wrong codes from one client stop being free", () => {
  it("locks the client out after the free attempts, and says for how long", async () => {
    registry.openPairing();
    const answers: Answer[] = [];
    for (let i = 0; i <= SIGN_IN_FREE_ATTEMPTS; i++) answers.push(await submitCode("000001"));

    // The free ones say what was wrong and nothing about waiting.
    for (const early of answers.slice(0, SIGN_IN_FREE_ATTEMPTS)) {
      expect(early.status).toBe(401);
      expect(bodyOf(early).retryAfter).toBeUndefined();
    }
    const locked = answers[SIGN_IN_FREE_ATTEMPTS];
    expect(locked.status).toBe(401);
    expect(locked.headers["retry-after"]).toBe(String(Math.ceil(SIGN_IN_LOCKOUT_BASE_MS / 1000)));
    expect(bodyOf(locked).retryAfter).toBe(Math.ceil(SIGN_IN_LOCKOUT_BASE_MS / 1000));
  });

  it("refuses the next attempt without ever reaching the registry", async () => {
    const { code } = registry.openPairing();
    for (let i = 0; i <= SIGN_IN_FREE_ATTEMPTS; i++) await submitCode("000001");
    const before = asked.length;

    // Even the RIGHT code, because the door cannot know it is right without
    // spending one of the window's five attempts to find out. That is the
    // fail-closed direction, and it is what stops an unauthenticated peer
    // burning the window somebody is mid-way through typing.
    const answer = await submitCode(code);
    expect(answer.status).toBe(429);
    expect(asked.length).toBe(before);
    expect(Number(answer.headers["retry-after"])).toBeGreaterThan(0);
    expect(bodyOf(answer).retryAfter).toBeGreaterThan(0);
    // And the window is still there for the person, once the wait is over.
    expect(registry.pairing()).not.toBeNull();
  });

  it("does not punish the one person holding a correct code when the fleet is full", () => {
    // `full` and `save-failed` mean the credential was RIGHT. Counting them
    // would lock somebody out for a condition they fix at the keyboard.
    expect(countsAgainstSignIn("full")).toBe(false);
    expect(countsAgainstSignIn("save-failed")).toBe(false);
    expect(countsAgainstSignIn("wrong")).toBe(true);
    expect(countsAgainstSignIn("expired")).toBe(true);
    expect(countsAgainstSignIn("used")).toBe(true);
    // Fail closed on anything nobody has classified yet.
    expect(countsAgainstSignIn(undefined)).toBe(true);
    expect(countsAgainstSignIn("something-invented-next-year")).toBe(true);
  });
});

describe("the sign-in limiter's arithmetic", () => {
  it("is free until the free attempts are gone, then backs off exponentially", () => {
    const limit = createSignInLimiter();
    let now = 1_000_000;
    for (let i = 0; i < SIGN_IN_FREE_ATTEMPTS; i++) {
      expect(limit.check("peer", now)).toBeNull();
      expect(limit.fail("peer", now)).toBeNull();
    }
    expect(limit.fail("peer", now)).toEqual({ retryAfterMs: SIGN_IN_LOCKOUT_BASE_MS });
    expect(limit.check("peer", now)).toEqual({ retryAfterMs: SIGN_IN_LOCKOUT_BASE_MS });

    now += SIGN_IN_LOCKOUT_BASE_MS;
    expect(limit.check("peer", now)).toBeNull();
    expect(limit.fail("peer", now)).toEqual({
      retryAfterMs: SIGN_IN_LOCKOUT_BASE_MS * SIGN_IN_LOCKOUT_FACTOR,
    });
  });

  it("caps the wait rather than growing it forever", () => {
    const limit = createSignInLimiter();
    const now = 5_000;
    for (let i = 0; i < 40; i++) limit.fail("peer", now);
    expect(limit.check("peer", now)).toEqual({ retryAfterMs: SIGN_IN_LOCKOUT_MAX_MS });
  });

  it("forgets a client that stops failing, and forgets one that succeeds at once", () => {
    const limit = createSignInLimiter();
    let now = 10_000;
    for (let i = 0; i <= SIGN_IN_FREE_ATTEMPTS; i++) limit.fail("peer", now);
    expect(limit.check("peer", now)).not.toBeNull();

    now += SIGN_IN_LOCKOUT_MAX_MS + SIGN_IN_FORGET_MS + 1;
    expect(limit.check("peer", now)).toBeNull();
    // A fresh failure starts from zero rather than from where it left off.
    expect(limit.fail("peer", now)).toBeNull();

    limit.fail("peer", now);
    limit.fail("peer", now);
    expect(limit.fail("peer", now)).not.toBeNull();
    limit.succeed("peer");
    expect(limit.check("peer", now)).toBeNull();
    expect(limit.fail("peer", now)).toBeNull();
  });

  it("refuses an untracked client when the table is full, rather than admitting it", () => {
    const limit = createSignInLimiter();
    const now = 1;
    for (let i = 0; i < SIGN_IN_MAX_CLIENTS; i++) limit.fail(`peer-${i}`, now);
    // Fail closed: an attempt nobody can count is an attempt nobody can
    // limit, and evicting to make room would let a flood clear its own
    // lockout.
    expect(limit.check("someone-new", now)).not.toBeNull();
    // The clients already being tracked are unaffected.
    expect(limit.check("peer-0", now)).toBeNull();
  });

  it("charges the socket's peer, never a header a client can write", () => {
    const spoofed = {
      headers: { "x-forwarded-for": "203.0.113.9", "x-real-ip": "203.0.113.9" },
      socket: { remoteAddress: "100.79.121.109" },
    } as unknown as Parameters<typeof signInClientKey>[0];
    expect(signInClientKey(spoofed)).toBe("100.79.121.109");
  });
});

describe("normalising what a person typed", () => {
  it("keeps digits and drops the separators people put between them", () => {
    expect(normalizeCredential("123456")).toBe("123456");
    expect(normalizeCredential(" 123 456 \n")).toBe("123456");
    expect(normalizeCredential("123-456")).toBe("123456");
    expect(normalizeCredential("123 456")).toBe("123456");
  });

  it("leaves a QR token exactly as it is", () => {
    const token = "murage_pair_abcDEF-123_xyz";
    expect(normalizeCredential(` ${token} `)).toBe(token);
    expect(normalizeCredential(undefined)).toBe("");
    expect(normalizeCredential(42)).toBe("42");
  });
});
