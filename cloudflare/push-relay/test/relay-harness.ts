import { createRelay, type RelayDeps } from "../src/relay";
import { migrated } from "./d1";

export function relayUnderTest(over: Partial<RelayDeps> = {}) {
  const db = migrated();
  let now = Date.parse("2026-09-27T12:00:00Z");
  const waits: Promise<unknown>[] = [];
  const deps: RelayDeps = { db, verifier: { verify: async () => ({ ok: true }) }, now: () => now, paused: async () => false, ...over };
  const relay = createRelay(deps);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    relay(new Request(`https://push.murage.test${path}`, { method, headers: { "content-type": "application/json", "cf-connecting-ip": "100.64.0.1", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), (p) => waits.push(p));
  return { db, deps, relay, call, tick: (ms: number) => { now += ms; }, waits };
}

export async function registeredDevice(t: ReturnType<typeof relayUnderTest>, pushToken = "a".repeat(64), platform: "ios" | "android" = "ios") {
  const { challenge } = await (await t.call("POST", "/v1/challenges")).json() as { challenge: string };
  const res = await t.call("POST", "/v1/devices", { platform, environment: "production", pushToken, challenge, attestation: platform === "ios" ? { kind: "app-attest", keyId: "k", attestationObject: "o" } : { kind: "play-integrity", token: "t" } });
  return (await res.json()) as { deviceId: string; deviceSecret: string };
}

export async function publisher(t: ReturnType<typeof relayUnderTest>, secret?: string, platform: "ios" | "android" = "ios") {
  const device = secret ? { deviceSecret: secret } : await registeredDevice(t, platform === "ios" ? "a".repeat(64) : "fcm-token-" + "x".repeat(40), platform);
  const binding = await (await t.call("POST", "/v1/bindings", undefined, { authorization: `Bearer ${device.deviceSecret}` })).json() as { bindingId: string; grant: string };
  const redeemed = await (await t.call("POST", "/v1/publishers/redeem", { grant: binding.grant })).json() as { bindingId: string; publisherToken: string };
  return { ...device, ...redeemed };
}
