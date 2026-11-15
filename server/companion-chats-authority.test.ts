import { generateKeyPairSync } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { chatsReader, ownerActs, companionAuthorized } from "./companion-authority.ts";
import { setCloudIdentity } from "./cloud-request-identity.ts";
import { requestSurface } from "./sse-visibility.ts";
afterEach(() => vi.unstubAllEnvs());
const proof = { "x-murage-companion": "1", "x-murage-chats-reader": "c".repeat(64) };
it("H4 reader proof confers no owner-acting or desktop authority", () => {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "");
  expect(chatsReader(proof)).toBe(true);
  expect(ownerActs(proof)).toBe(false); expect(companionAuthorized(proof)).toBe(false); expect(requestSurface(proof)).toBe("remote");
});
it.each([undefined, "owner-desktop", "owner-phone", "browser", "remembered-owner"])("H3 Cloud identity %s gains nothing from reader proof", scope => {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  const headers = { ...proof };
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type:"spki", format:"pem" }).toString();
  if (scope) setCloudIdentity(headers, { scope: scope === "remembered-owner" ? "browser" : scope, ...(scope === "remembered-owner" ? { factor: "remembered-owner", publicKey: key, assertionKey: key } : {}) } as any);
  // Identity is attached to the actual headers: remove the proof in place.
  const admitted = chatsReader(headers), acting = ownerActs(headers), authorized = companionAuthorized(headers);
  delete (headers as Partial<typeof proof>)["x-murage-chats-reader"];
  expect(chatsReader(headers)).toBe(admitted); expect(ownerActs(headers)).toBe(acting); expect(companionAuthorized(headers)).toBe(authorized);
  if (!scope || scope === "browser") expect(admitted).toBe(false);
  if (scope === "remembered-owner") expect(admitted).toBe(true);
});
