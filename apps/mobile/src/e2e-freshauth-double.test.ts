// SEC-006 P7: the native-channel test double that drives the phone e2e must
// build exactly the bytes the contract names, sign them the way a platform
// keystore does (ECDSA P-256, ASN.1 DER, high-S left alone), and refuse every
// argument set native refuses. If the double drifted from the contract the
// e2e would prove nothing, so this runs without a server.
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Args = Record<string, unknown>;
interface Vector { name?: string; args: Args; message?: string; why?: string; expect?: { code?: string } }
const contract = JSON.parse(readFileSync(new URL("../contract/approval-proof.json", import.meta.url), "utf8")) as { accepted: Vector[]; refused: Vector[] };
const source = readFileSync(new URL("../e2e/freshauth/native-double.js", import.meta.url), "utf8");

interface Double {
  hello(): { version: number; methods: string[] };
  approveWithDevice(args: Args): Promise<{ signature: string }>;
  message(args: Args): string;
}
type Mode = "sign" | "cancel" | "no_lock" | "no_key";

async function makeDouble(mode: Mode = "sign") {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const scope: { __makeMurageDouble?: (config: unknown) => Double } = {};
  new Function("globalThis", source)(Object.assign(scope, { crypto: globalThis.crypto, TextEncoder, btoa, atob }));
  const double = scope.__makeMurageDouble!({ privateJwk, mode });
  return { double, raw };
}

const b64u = (data: Uint8Array) => Buffer.from(data).toString("base64url");

describe("the e2e native double", () => {
  it("advertises approveWithDevice", async () => {
    const { double } = await makeDouble();
    expect(double.hello()).toMatchObject({ version: 1 });
    expect(double.hello().methods).toContain("approveWithDevice");
  });

  it("builds the contract's message bytes and signs them as ASN.1 DER that Node verifies", async () => {
    const { double, raw } = await makeDouble();
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: Buffer.from(raw.slice(1, 33)).toString("base64url"), y: Buffer.from(raw.slice(33)).toString("base64url") }, format: "jwk" });
    for (const vector of contract.accepted) {
      expect(double.message(vector.args), vector.name).toBe(vector.message);
      const { signature } = await double.approveWithDevice(vector.args);
      const der = Buffer.from(signature, "base64url");
      expect(b64u(der), "base64url, unpadded").toBe(signature);
      expect(der[0], "DER sequence, not raw r||s").toBe(0x30);
      expect(verify("sha256", Buffer.from(vector.message!, "utf8"), { key, dsaEncoding: "der" }, der), vector.name).toBe(true);
    }
  });

  it("refuses what the contract says native refuses", async () => {
    const { double } = await makeDouble();
    for (const vector of contract.refused) {
      await expect(double.approveWithDevice(vector.args), vector.why).rejects.toThrow(/^bad_args$/);
    }
  });

  it("rejects with the codes the page maps", async () => {
    const accepted = contract.accepted[0].args;
    for (const mode of ["cancel", "no_lock", "no_key"] as const) {
      const { double } = await makeDouble(mode);
      await expect(double.approveWithDevice(accepted)).rejects.toThrow(mode === "cancel" ? /^cancelled$/ : new RegExp(`^${mode}$`));
    }
  });
});
