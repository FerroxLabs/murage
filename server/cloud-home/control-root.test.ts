// SPDX-License-Identifier: AGPL-3.0-or-later
import { generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import cloudControlShapes from "../../shared/cloud-control-shapes.json" with { type: "json" };
import { removeTempDirSync } from "../testing/cleanup.ts";

const program = fileURLToPath(new URL("../../deploy/cloud-home/murage-control", import.meta.url));
const fixture = fileURLToPath(new URL("./control-root.fixture.py", import.meta.url));
const clockSource = fileURLToPath(new URL("../../deploy/cloud-home/murage-clock.c", import.meta.url));
const credential = Buffer.alloc(32, 11).toString("base64");
const clock = { wallMs: 2_000_000_000_000, bootMs: 100_000, monoMs: 99_000, bootId: "11111111-1111-1111-1111-111111111111", ntpSynced: true };
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicJwk = publicKey.export({ format: "jwk" });
const payload = Buffer.from(JSON.stringify({ type: "murage-home-key-v1", homeId: "home-test", generation: 1, homeKey: "fixture-home-key", publicOrigin: "https://home.murage.test", issuedAt: clock.wallMs, expiresAt: clock.wallMs + 3_600_000 })).toString("base64url");
const homeKey = { algorithm: "ES256", payload, signature: sign("sha256", Buffer.from(payload), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
const lease = { wire: 1, installationId: "installation-test", holder: "home-test", generation: 1, expiresAt: clock.wallMs + 3_600_000, renewAfterMs: 60_000, ttlMs: 3_600_000, skewMs: 120_000 };
const desired = { wire: 1, homeId: "home-test", generation: 1, desiredState: "ready", engineSubscriptionGates: { claudeAgent: true, codex: true, grokAgent: true, kimiAgent: true, opencodeGo: true }, lease: { holder: "home-test", generation: 1, expiresAt: lease.expiresAt }, executionAllowed: true, heartbeatFresh: true, heartbeatEveryMs: 60_000, homeKey };
interface Snapshot { homeId: string; cpGeneration: number; requestSend: { wallMs: number; bootMs: number; monoMs: number }; conservativeDeadlineBootMs: number; receivedAt: number; desired: typeof desired }
interface Result { refused: boolean; invalidated: boolean; requests: Array<{ operation: string; body: unknown }>; snapshots: Snapshot[]; files: Record<string, unknown>; clock?: typeof clock; ticks?: number; publicationOrder?: string[]; extra?: { pending: [string, string] | null; tree: Record<string, string | [string, string]>; logs: string[]; subkey: string; environ: string } }

interface Shape {
  type?: string; const?: unknown; enum?: unknown[]; anyOf?: Shape[];
  required?: string[]; additionalProperties?: boolean; properties?: Record<string, Shape>;
  minimum?: number; maximum?: number; maxLength?: number; pattern?: string;
}
// This fixture validates the exact schema features present in the frozen wire.
// It checks actual Python output, including nested strict keys and lease bounds.
function matchesShape(value: unknown, shape: Shape): boolean {
  if (shape.anyOf) return shape.anyOf.some(branch => matchesShape(value, branch));
  if ("const" in shape && value !== shape.const) return false;
  if (shape.enum && !shape.enum.includes(value)) return false;
  if (shape.type === "null") return value === null;
  if (shape.type === "boolean") return typeof value === "boolean";
  if (shape.type === "string") return typeof value === "string" && (shape.maxLength === undefined || value.length <= shape.maxLength) && (shape.pattern === undefined || new RegExp(shape.pattern).test(value));
  if (shape.type === "number" || shape.type === "integer") return typeof value === "number" && Number.isFinite(value) && (shape.type !== "integer" || Number.isInteger(value)) && (shape.minimum === undefined || value >= shape.minimum) && (shape.maximum === undefined || value <= shape.maximum);
  if (shape.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>, properties = shape.properties ?? {};
    return (shape.required ?? []).every(key => Object.hasOwn(object, key))
      && (shape.additionalProperties !== false || Object.keys(object).every(key => Object.hasOwn(properties, key)))
      && Object.entries(properties).every(([key, child]) => !Object.hasOwn(object, key) || matchesShape(object[key], child));
  }
  return true;
}

function run(scenario: string, helper?: string, homeEnvExtra = ""): Result {
  // Actual Linux descriptor traversal runs as H's unprivileged fixture UID.
  // Production expected_uid stays zero; writable /tmp remains a negative case.
  const root = mkdtempSync(join(process.cwd(), ".control-root-fixture-"));
  chmodSync(root, 0o755);
  try {
    for (const name of ["state", "config", "public"]) mkdirSync(join(root, name), { mode: name === "state" ? 0o700 : 0o755 });
    writeFileSync(join(root, "state/credential"), credential + "\n", { mode: 0o600 });
    writeFileSync(join(root, "state/generation"), "1\n", { mode: 0o600 });
    writeFileSync(join(root, "config/home.env"), "MURAGE_CLOUD_ROLE=home\nMURAGE_CLOUD_MACHINE_ID=home-test\nMURAGE_CLOUD_ADMIN_URL=https://admin.murage.test\nMURAGE_PUBLIC_ORIGIN=https://home.murage.test\n" + homeEnvExtra, { mode: 0o600 });
    writeFileSync(join(root, "config/control-plane-public-key.json"), JSON.stringify(publicJwk), { mode: 0o644 });
    const result = spawnSync("python3", ["-I", fixture, program, root, scenario], { windowsHide: true, input: JSON.stringify({ credential, clock, lease, desired, helper }), encoding: "utf8", timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0); expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(credential);
    return JSON.parse(result.stdout) as Result;
  } finally { removeTempDirSync(root); }
}

it("real root poller uses strict machine wire in order and publishes matching nonsecret metadata", () => {
  const result = run("valid"); expect(result.refused).toBe(false);
  expect(result.requests).toEqual([{ operation: "lease", body: { generation: 1, holder: "home-test" } }, { operation: "heartbeat", body: { generation: 1 } }, { operation: "desired", body: null }]);
  expect(result.files["home-generation.json"]).toEqual({ homeId: "home-test", generation: 1 });
  expect(result.files["home-identity.json"]).toEqual(homeKey);
  expect(result.files["state.json"]).toEqual(result.snapshots[0]);
  expect(result.publicationOrder).toEqual(["home-generation.json", "home-identity.json", "state.json"]);
  expect(result.snapshots[0].conservativeDeadlineBootMs).toBe(clock.bootMs + 3_480_000);
});
it("actual Python snapshot and requests satisfy the frozen shared control schema", () => {
  const result = run("valid"), definitions = cloudControlShapes.$defs;
  expect(result.refused).toBe(false);
  expect(matchesShape(result.files["state.json"], definitions.controlSnapshot)).toBe(true);
  expect(matchesShape(result.snapshots[0].desired, definitions.desiredResponse)).toBe(true);
  expect(matchesShape(result.requests[0].body, definitions.leaseRequest)).toBe(true);
  expect(matchesShape(result.requests[1].body, definitions.heartbeatRequest)).toBe(true);
  // Guard against a vacuous validator: mutations of actual output must fail.
  expect(matchesShape({ ...result.snapshots[0], cpGeneration: 0 }, definitions.controlSnapshot)).toBe(false);
  expect(matchesShape({ ...result.snapshots[0], requestSend: { ...result.snapshots[0].requestSend, unknownClock: 1 } }, definitions.controlSnapshot)).toBe(false);
  expect(matchesShape({ ...result.snapshots[0].desired, heartbeatEveryMs: 60_001 }, definitions.desiredResponse)).toBe(false);
  expect(matchesShape({ ...result.snapshots[0].desired, lease: { ...result.snapshots[0].desired.lease, unknown: true } }, definitions.desiredResponse)).toBe(false);
});
it("actual machine request fixes URL/method/body and keeps bearer out of environment", () => {
  const result = run("transport-valid"); expect(result.refused).toBe(false);
  expect(result.requests).toEqual([{ url: "https://admin.murage.test/v1/machines/home-test/heartbeat", method: "POST", body: { generation: 1 }, bearerPresent: true, secretInEnvironment: false }]);
});
it.each(["transport-oversize", "transport-redirect", "transport-operation"])("%s is refused by production transport boundary", scenario => expect(run(scenario).refused).toBe(true));
it("delayed response cannot extend immutable request-send deadline", () => {
  const result = run("delay"); expect(result.refused).toBe(false);
  expect(result.snapshots[0].requestSend.bootMs).toBe(clock.bootMs);
  expect(result.snapshots[0].receivedAt).toBe(clock.wallMs + 10_000);
  expect(result.snapshots[0].conservativeDeadlineBootMs).toBe(clock.bootMs + 3_480_000);
});
it.each(["suspend", "jump-forward", "jump-backward", "ntp", "boot-change", "unknown-clock"])("%s removes prior authority and retains invalidation", scenario => {
  const result = run(scenario); expect(result.refused).toBe(true); expect(result.invalidated).toBe(true);
  expect(result.files["state.json"]).toBeUndefined(); expect(result.snapshots).toHaveLength(1);
});
it("only subsequent successful renewal clears a clock invalidation", () => {
  const result = run("renew-after-invalidation"); expect(result.refused).toBe(false); expect(result.invalidated).toBe(false);
  expect(result.snapshots).toHaveLength(2); expect(result.snapshots[1].requestSend.wallMs).toBe(clock.wallMs + 5001);
});
it("30 minute ordinary outage keeps prior immutable conservative authority", () => {
  const result = run("ordinary-outage"); expect(result.refused).toBe(false); expect(result.invalidated).toBe(false);
  expect(result.snapshots).toHaveLength(1); expect(result.files["state.json"]).toEqual(result.snapshots[0]);
});
it.each(["authorization-401", "authorization-403"])("%s fences existing authority immediately", scenario => {
  const result = run(scenario); expect(result.refused).toBe(true); expect(result.invalidated).toBe(true);
  expect(result.snapshots).toHaveLength(1); expect(result.files["state.json"]).toBeUndefined();
});
it("reader restart leaves existing request-send deadline unchanged", () => {
  const result = run("restart"); expect(result.refused).toBe(false);
  expect(result.files["state.json"]).toEqual(result.snapshots[0]);
});
it.each(["lease-generation", "lease-unknown", "desired-generation", "desired-expiry", "secret-body"])("%s fences inconsistent or unknown machine response", scenario => {
  const result = run(scenario); expect(result.refused).toBe(true); expect(result.invalidated).toBe(true);
  expect(result.files["state.json"]).toBeUndefined();
});
it.each(["lease", "heartbeat", "desired"].flatMap(op => ["wire-missing", "wire-2", "wire-true", "fake-only"].map(v => `${op}-${v}`)))("%s fences: only wire 1 is accepted, the fakeOnly literal alone is refused", scenario => {
  const result = run(scenario); expect(result.refused).toBe(true); expect(result.invalidated).toBe(true);
  expect(result.files["state.json"]).toBeUndefined();
});
it.each(["secure-mode", "secure-symlink", "secure-parent", "secure-parent-symlink", "secure-generation", "secure-trust", "secure-missing-trust", "secure-world-parent"])("%s refuses root binding before network use", scenario => {
  const result = run(scenario); expect(result.refused).toBe(true); expect(result.requests).toEqual([]);
});
it("binding readiness is bounded to 120s without a request", () => {
  const result = run("readiness"); expect(result.refused).toBe(true); expect(result.ticks).toBe(120); expect(result.requests).toEqual([]);
});
it("real run startup obtains authority without a home-ready cycle", () => {
  const result = run("startup-run"); expect(result.refused).toBe(false);
  expect(result.requests.map(row => row.operation)).toEqual(["lease", "heartbeat", "desired"]);
  expect(result.files["state.json"]).toMatchObject({ homeId: "home-test", cpGeneration: 1 });
});
// murage-clock.c is Linux-only (CLOCK_BOOTTIME, adjtimex, /proc boot_id): it cannot compile on macOS or Windows.
it.skipIf(process.platform !== "linux")("Linux helper compiles and executes actual read-only BOOTTIME/adjtimex protocol", () => {
  const root = mkdtempSync(join(process.cwd(), ".clock-fixture-")); chmodSync(root, 0o755);
  try {
    const helper = join(root, "murage-clock");
    const built = spawnSync("cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", clockSource, "-o", helper], { windowsHide: true, encoding: "utf8" });
    expect(built.status, built.stderr).toBe(0); chmodSync(helper, 0o755);
    const result = run("helper", helper); expect(result.clock).toMatchObject({ ntpSynced: expect.any(Boolean), bootId: expect.any(String) });
    expect(result.clock!.bootMs).toBeGreaterThanOrEqual(result.clock!.monoMs - 1);
    expect(result.clock!.wallMs).toBeGreaterThan(0);
    const source = readFileSync(clockSource, "utf8");
    for (const term of ["CLOCK_REALTIME", "CLOCK_BOOTTIME", "CLOCK_MONOTONIC", "adjtimex(&health)", "TIME_ERROR", "STA_UNSYNC", "STA_CLOCKERR"]) expect(source).toContain(term);
    expect(source).not.toMatch(/clock_settime|ADJ_SETOFFSET|ADJ_OFFSET|setuid|capset/);
  } finally { removeTempDirSync(root); }
});
it("binding set check: 4 fields and 4 plus the optional site origin are accepted; any other 5th field is refused", () => {
  expect(run("valid").refused).toBe(false);
  expect(run("valid", undefined, "MURAGE_SITE_ORIGIN=https://murage.ai\n").refused).toBe(false);
  const unknown = run("valid", undefined, "MURAGE_SITE_ORIGIN_X=https://murage.ai\n"); expect(unknown.refused).toBe(true); expect(unknown.requests).toEqual([]);
});

describe("Flux sub-key delivery through the root poller", () => {
  it("fetches the sub-key when renewal is due, hands it over only in a 0770 dir / 0640 file (group = the supervisor, no chown), and sends NO ack before the supervisor's receipt", () => {
    const result = run("renewal-due"); expect(result.refused).toBe(false);
    expect(result.requests.map(r => r.operation)).toEqual(["lease", "heartbeat", "desired", "flux/subkey"]);
    expect(result.requests.at(-1)!.body).toEqual({ generation: 1, op_id: "renew:home-test:1:1" });
    const tree = result.extra!.tree, delivered = tree["flux-subkey/key.json"] as [string, string];
    expect(tree["flux-subkey"]).toBe("0o770");
    expect(delivered[0]).toBe("0o640");
    expect(JSON.parse(delivered[1])).toEqual({ key: result.extra!.subkey, generation: 2, expiresAt: "2030-01-01T00:00:00Z", capUsd: 5, op_id: "renew:home-test:1:1" });
    // The root-only pending record (0600) survives a restart and carries identifiers, never the key.
    expect(result.extra!.pending![0]).toBe("0o600");
    expect(JSON.parse(result.extra!.pending![1])).toMatchObject({ generation: 1, op_id: "renew:home-test:1:1", key_generation: 2 });
    expect(result.extra!.pending![1]).not.toContain(result.extra!.subkey);
  });
  it("finding 8: further polls with no supervisor receipt mint nothing and acknowledge nothing", () => {
    const ops = run("renewal-unsealed").requests.map(r => r.operation);
    expect(ops.filter(op => op === "flux/subkey")).toHaveLength(1);
    expect(ops.filter(op => op === "flux/subkey/ack")).toHaveLength(0);
  });
  it("finding 8: once the receipt exists the next poll acknowledges, once, and clears the pending record and receipt", () => {
    const result = run("renewal-sealed");
    expect(result.requests.map(r => r.operation)).toEqual(["lease", "heartbeat", "desired", "flux/subkey", "lease", "heartbeat", "desired", "flux/subkey/ack"]);
    expect(result.requests.find(r => r.operation === "flux/subkey/ack")!.body).toEqual({ generation: 1, op_id: "renew:home-test:1:1", key_generation: 2 });
    expect(result.extra!.pending).toBeNull();
    expect(result.extra!.tree["flux-subkey/receipt.json"]).toBeUndefined();
  });
  it("never puts the key in a snapshot, a published file, a log line or the environment; snapshots stay 0644", () => {
    const result = run("renewal-due"), key = result.extra!.subkey;
    for (const [name, row] of Object.entries(result.extra!.tree)) {
      if (!Array.isArray(row)) continue;
      if (name === "flux-subkey/key.json") continue;
      expect(row[1], name).not.toContain(key);
      expect(row[0], name).toBe("0o644");
    }
    expect(JSON.stringify(result.files)).not.toContain(key);
    expect(JSON.stringify(result.snapshots)).not.toContain(key);
    expect(JSON.stringify(result.snapshots)).not.toContain("flux_renewal_due");
    expect(result.extra!.logs.join("")).not.toContain(key);
    expect(result.extra!.environ).not.toContain(key);
  });
  it("does not call the sub-key route when renewal is not due", () => {
    const result = run("renewal-not-due");
    expect(result.requests.map(r => r.operation)).toEqual(["lease", "heartbeat", "desired"]);
    expect(result.extra!.tree["flux-subkey"]).toBeUndefined();
  });
  it("honours flux_renewal_due: no cue from the control plane means no renewal question at all (dark)", () => {
    const result = run("renewal-flag-absent");
    expect(result.requests.map(r => r.operation)).toEqual(["lease", "heartbeat", "desired"]);
    expect(result.extra!.logs.join("")).not.toContain("renewal unavailable");
    expect(result.extra!.tree["flux-subkey"]).toBeUndefined();
  });
  it("hole 11: a lost ack is retried on the next poll without minting another key", () => {
    const result = run("renewal-ack-fails");
    const ops = result.requests.map(r => r.operation);
    expect(ops.filter(op => op === "flux/subkey")).toHaveLength(1);
    expect(ops.filter(op => op === "flux/subkey/ack")).toHaveLength(2);
    expect(ops.lastIndexOf("flux/subkey/ack")).toBeGreaterThan(ops.indexOf("flux/subkey"));
  });
  it("refuses a response that is not a home key, logs nothing about it, and still publishes authority", () => {
    const result = run("renewal-bad-response");
    expect(result.extra!.tree["flux-subkey/key.json"]).toBeUndefined();
    expect(result.requests.map(r => r.operation)).not.toContain("flux/subkey/ack"); // nothing delivered, nothing acknowledged
    expect(result.extra!.logs.join("")).toBe("Cloud control Flux renewal unavailable\n");
    expect(result.files["state.json"]).toEqual(result.snapshots[0]);
  });
});
