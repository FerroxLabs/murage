import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handlePhoneBootstrap, phoneHarnessMinted, PhoneChallenges, type PhoneDoorDevices } from "../src/phone-door.ts";
import { approvalKeyId, phoneJobsMessage, PHONE_TOKEN } from "../src/phone-jobs-shape.ts";

const ORIGIN = "https://desk.example.test";
const PROOF = "e".repeat(64);

function makeKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
  return { point, keyId: approvalKeyId(point)!, signMessage: (m: string) => sign("sha256", Buffer.from(m), { key: privateKey, dsaEncoding: "der" }).toString("base64url") };
}

// A store that behaves like DeviceStore: one token per device, issuing replaces the old one, clearing drops it.
function fixture() {
  const k = makeKey();
  let n = 0;
  const events: string[] = [];
  const tokens = new Map<string, string>();
  let removed = false;
  const mintToken = () => `murage_pj_${String(n).padStart(43, "A")}`;
  const devices: PhoneDoorDevices = {
    deviceByApprovalKeyId: (id) => (id === k.keyId ? { ok: true, deviceId: "d1", point: k.point } : { ok: false, reason: "none" }),
    issuePhoneJobsToken: (id) => { n++; const t = mintToken(); tokens.set(id, t); events.push("issue"); return t; },
    authenticatePhoneJobs: (t) => { for (const [id, held] of tokens) if (held === t && !removed) return { deviceId: id }; return null; },
    clearPhoneJobsToken: (id, onlyToken) => { events.push("clear"); if (onlyToken !== undefined && tokens.get(id) !== onlyToken) return false; return tokens.delete(id); },
  };
  let c = 0;
  const challenges = new PhoneChallenges({ now: () => 1_700_000_000_000, random: () => createHash("sha256").update(`m${c++}`).digest("base64url") });
  const offered = async () => true;
  const q = (s: string) => new URLSearchParams(s);
  async function mint(harness: Parameters<typeof handlePhoneBootstrap>[1]["harness"], extra: { mintedDeadlineMs?: number } = {}) {
    const ch = await handlePhoneBootstrap({ method: "GET", path: "/api/phones/self/challenge", query: q(`key=${k.keyId}`), body: null, source: "s", origin: ORIGIN }, { devices, challenges, offered });
    const { nonce, expiresAt } = ch.body as { nonce: string; expiresAt: number };
    const signature = k.signMessage(phoneJobsMessage({ origin: ORIGIN, keyId: k.keyId, nonce, expiresAt }));
    return handlePhoneBootstrap({ method: "POST", path: "/api/phones/self/token", query: q(""), body: Buffer.from(JSON.stringify({ keyId: k.keyId, nonce, expiresAt, signature })), source: "s", origin: ORIGIN },
      { devices, challenges, offered, harness, doorToken: PROOF, ...extra });
  }
  return { devices, events, tokens, mint, remove: () => { removed = true; }, current: () => mintToken() };
}

type Call = { method: string; path: string; headers: Record<string, string>; body: Buffer | null };

describe("S5b: a fresh mint clears the harness barrier", () => {
  it("success: issue, then minted with the launch proof and { deviceId }, then the token answers and authenticates", async () => {
    const f = fixture();
    const calls: Call[] = [];
    const r = await f.mint(async (call: Call) => { f.events.push("minted"); calls.push(call); return { status: 200, body: { ok: true } }; });
    expect(f.events).toEqual(["issue", "minted"]);
    expect(r.status).toBe(200);
    const token = (r.body as { token: string }).token;
    expect(token).toMatch(PHONE_TOKEN);
    expect(f.devices.authenticatePhoneJobs!(token)).toEqual({ deviceId: "d1" });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toBe("/api/phones/minted");
    expect(calls[0].headers["x-murage-companion-token"]).toBe(PROOF);
    expect(JSON.parse(calls[0].body!.toString("utf8"))).toEqual({ deviceId: "d1" });
  });

  it("harness 500: the new token is cleared, the phone is told 503 unavailable, the old token stays dead", async () => {
    const f = fixture();
    const first = await f.mint(async () => ({ status: 200, body: { ok: true } }));
    const old = (first.body as { token: string }).token;
    const r = await f.mint(async () => ({ status: 500, body: {} }));
    expect(r).toEqual({ status: 503, body: { error: "unavailable" } });
    expect(JSON.stringify(r.body)).not.toContain("murage_pj_");
    expect(f.events.slice(-2)).toEqual(["issue", "clear"]);
    expect(f.devices.authenticatePhoneJobs!(old)).toBeNull();
    expect(f.devices.authenticatePhoneJobs!(f.current())).toBeNull();
  });

  it("harness 404 (phones not offered): 403 and no valid token", async () => {
    const f = fixture();
    const r = await f.mint(async () => ({ status: 404, body: {} }));
    expect(r.status).toBe(403);
    expect(f.devices.authenticatePhoneJobs!(f.current())).toBeNull();
    expect(f.events).toEqual(["issue", "clear"]);
  });

  it("a 200 without ok:true is a failure", async () => {
    const f = fixture();
    const r = await f.mint(async () => ({ status: 200, body: {} }));
    expect(r.status).toBe(503);
    expect(f.devices.authenticatePhoneJobs!(f.current())).toBeNull();
  });

  it("a timeout (harness never answers): 503 and no valid token", async () => {
    const f = fixture();
    const r = await f.mint(() => new Promise(() => {}), { mintedDeadlineMs: 20 });
    expect(r).toEqual({ status: 503, body: { error: "unavailable" } });
    expect(f.devices.authenticatePhoneJobs!(f.current())).toBeNull();
    expect(f.events).toEqual(["issue", "clear"]);
  });

  it("a throw from the harness: 503 and no valid token", async () => {
    const f = fixture();
    const r = await f.mint(async () => { throw new Error("boom"); });
    expect(r.status).toBe(503);
    expect(f.devices.authenticatePhoneJobs!(f.current())).toBeNull();
  });

  it("the device removed while minted is in flight: 503, no token", async () => {
    const f = fixture();
    const r = await f.mint(async () => { f.remove(); return { status: 200, body: { ok: true } }; });
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).not.toContain("murage_pj_");
    expect(f.events.at(-1)).toBe("clear");
  });

  it("a missing launch proof or harness never answers a token", async () => {
    const f = fixture();
    expect((await f.mint(undefined)).status).toBe(503);
    expect(f.devices.authenticatePhoneJobs!(f.current())).toBeNull();
    expect(await phoneHarnessMinted(async () => ({ status: 200, body: { ok: true } }), undefined, "d1")).toBe("failed");
  });

  it("retry: after a failed mint the phone mints again and the second token authenticates", async () => {
    const f = fixture();
    expect((await f.mint(async () => ({ status: 502, body: {} }))).status).toBe(503);
    const r = await f.mint(async () => ({ status: 200, body: { ok: true } }));
    expect(r.status).toBe(200);
    expect(f.devices.authenticatePhoneJobs!((r.body as { token: string }).token)).toEqual({ deviceId: "d1" });
  });
});

describe("S5b: overlapping bootstraps (Opus L5)", () => {
  it("a failing first request clears only its own token, never the newer one a retry holds", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = f.mint(async () => { await gate; return { status: 503, body: {} }; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await f.mint(async () => ({ status: 200, body: { ok: true } }));
    expect(second.status).toBe(200);
    const newer = (second.body as { token: string }).token;
    release();
    const failed = await first;
    expect(failed.status).toBe(503);
    expect(f.devices.authenticatePhoneJobs!(newer)).toEqual({ deviceId: "d1" });
    expect(f.tokens.get("d1")).toBe(newer);
  });
});
