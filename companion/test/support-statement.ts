import { createHash, createPrivateKey, sign } from "node:crypto";
import vector from "./fixtures/approval-statement-vector.json" with { type: "json" };

export const KEYS = { [vector.testKid]: vector.testPublicKey };
export const NOW = vector.issuedAt + 1000;
export const testKey = createPrivateKey({ key: Buffer.from(vector.testPkcs8, "base64url"), format: "der", type: "pkcs8" });
export const hashOf = (point: string) => createHash("sha256").update(Buffer.from(point, "base64url")).digest("hex");

/** A statement as the relay would sign it; `over` replaces payload lines, `signer` forges. */
export function statement(
  installId: string,
  point: string,
  over: Partial<Record<"tag" | "kid" | "platform" | "env" | "install" | "hash" | "issued" | "expires", string>> = {},
  signer = testKey,
) {
  const issued = over.issued ?? String(vector.issuedAt);
  const lines = [over.tag ?? "murage-approval-attestation/1", over.kid ?? vector.testKid, over.platform ?? "ios", over.env ?? "production", over.install ?? installId, over.hash ?? hashOf(point), issued, over.expires ?? String(Number(issued) + 600_000)];
  const payload = Buffer.from(lines.join("\n"), "utf8");
  return `${payload.toString("base64url")}.${sign(null, payload, signer).toString("base64url")}`;
}
