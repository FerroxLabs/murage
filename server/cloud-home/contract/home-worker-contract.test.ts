// The home side of the home <-> Worker wire contract. The Worker-side twin pins the same JSON (see the contract file's note).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const here = (p: string) => new URL(p, import.meta.url);
const contract = JSON.parse(readFileSync(here("./home-worker-contract.json"), "utf8"));
const auth = readFileSync(here("../../cloud-request-auth.ts"), "utf8");
const sessions = readFileSync(here("../../cloud-sessions.ts"), "utf8");
const identity = readFileSync(here("../b1b-identity.ts"), "utf8");

describe("home <-> Worker contract (home side)", () => {
  it("serves every pinned route name", () => {
    for (const [name, r] of Object.entries(contract.homeRoutes as Record<string, { path: string }>)) {
      expect(auth.includes(`"${r.path}"`), `route ${name} ${r.path}`).toBe(true);
    }
  });

  it("pairing reads every pinned field and answers code + expiresIn", () => {
    const p = contract.pairingRequestFields;
    for (const f of [...p.signedEnvelope, ...p.addDevice, ...p.recovery]) {
      // ttl and generation are read through input.ttl / input.generation; the rest as input.<f> or a destructured name.
      expect(auth.includes(`input.${f}`) || sessions.includes(`input.${f}`) || auth.includes(`${f}:`), `pairing field ${f}`).toBe(true);
    }
    for (const f of p.device) expect(auth.includes(`input.${f}`), `device field ${f}`).toBe(true);
    for (const f of contract.pairingResponseFields) expect(auth.includes(f), `response ${f}`).toBe(true);
    expect(sessions).toContain("input.timestamp");
    expect(sessions).toMatch(/input\.nonce\.length < 16 \|\| input\.nonce\.length > 128/);
    expect(sessions).toContain(">300");
    expect(auth).toContain("x-murage-signature");
  });

  it("device revoke takes deviceId and answers revoked", () => {
    for (const f of contract.devicesRevokeRequestFields) expect(auth).toContain(`input.${f}`);
    for (const f of contract.devicesRevokeResponseFields) expect(auth).toContain(`{${f}:true}`);
  });

  it("the door ticket schema is exactly the pinned v2 ticket", () => {
    const d = contract.doorTicket;
    const block = identity.slice(identity.indexOf("const doorTicketSchema"), identity.indexOf(".strict();", identity.indexOf("const doorTicketSchema")));
    expect(block).toContain(`z.literal("${d.type}")`);
    const keys = [...block.matchAll(/(?:^|[\s,{])([a-zA-Z]+): z\./g)].map((m) => m[1]);
    expect(keys.sort()).toEqual([...d.fields].sort());
    expect(identity.slice(identity.indexOf("const doorTicketSchema"))).toContain(".strict();");
    expect(block).toContain("/^[0-9a-f]{64}$/");
    for (const k of d.kinds) expect(block).toContain(`"${k}"`);
  });
});
