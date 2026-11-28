// SPDX-License-Identifier: AGPL-3.0-or-later
// O1 m2 S1a (designs/1021-m2-w0/DESIGN-r5.md F1): the Fuigo mode decision, made once per boot.
//
// Owners: this module and both sides of its contract (the boot call in server/index.ts and the
// test-only arm in server/testing/hosted-override-preload.mjs) belong to the O1 m2 S1a builder
// lane (fix/1022-o1m2). Only slice S1b may set a HOSTED_QUALIFIED entry to true.
//
// HOSTED is off in every shipped build. The decision evaluates condition (3), "this OS is
// qualified in the build", FIRST, and returns COORDINATOR before anything else runs: no host
// spawn, no hello, no core-dump policy call, no custody file. This module reads no environment,
// settings, argv, file or database; the only way on is the override a test preload arms.

/** D1.7 condition (3). S1a ships every entry false; S1b flips one only with its receipts. */
export const HOSTED_QUALIFIED: Readonly<{ linux: false; darwin: false; win32: false }> = Object.freeze({ linux: false, darwin: false, win32: false });

export type FuigoBootMode = "COORDINATOR" | "HOSTED";
/** Id-only reasons; never free text. */
export type FuigoBootReason = "hosted_unqualified" | "dump_policy_unavailable" | "host_no_hello" | "stale_executor" | "exec_gate_unavailable" | "stdin_owner_unconfirmed" | "forwarder_incomplete" | "hosted_ready";
export type FuigoModeDecision = Readonly<{ mode: FuigoBootMode; reason: FuigoBootReason }>;

/** Conditions (1) and (2), run only on the HOSTED branch (never in a production boot). */
export type HostedProbes = Readonly<{
  /** (1) coordinator side: the core-dump policy took effect in this process. */
  coordinatorDumpsDisabled: () => boolean;
  /** (1) host side and (2): the host answered hello and reported its own dump policy. */
  hostHello: () => Promise<Readonly<{ ok: boolean; dumpsDisabled: boolean }>>;
}>;

type Qualified = Readonly<Record<"linux" | "darwin" | "win32", boolean>>;
let armedForTest: { hostedQualifiedOverride: true } | undefined;

/** Called only by server/testing/hosted-override-preload.mjs (T-S1A-NO-SWITCH pins the callers). */
export function armHostedOverrideForTest(arm: { hostedQualifiedOverride: true }): void {
  if (arm?.hostedQualifiedOverride !== true) throw new Error("HOSTED_UNQUALIFIED_BUILD");
  armedForTest = Object.freeze({ hostedQualifiedOverride: true });
}

/** The armed test arm, handed to the forwarder's construction tie on the HOSTED branch; empty in production. */
export function hostedOverrideArm(): { hostedQualifiedOverride?: true } {
  return armedForTest ?? {};
}

function qualified(platform: NodeJS.Platform, table: Qualified): boolean {
  return platform === "linux" || platform === "darwin" || platform === "win32" ? table[platform] === true : false;
}

/** The synchronous half: condition (3). Production boot uses only this, so it can never spawn anything. */
export function decideFuigoBootModeNow(input: { platform: NodeJS.Platform; qualifiedTable?: Qualified }): FuigoModeDecision {
  const table = input.qualifiedTable ?? HOSTED_QUALIFIED;
  if (!qualified(input.platform, table) && armedForTest?.hostedQualifiedOverride !== true) {
    // Windows keeps dump_policy_unavailable (condition 1 is false there by design), which also holds.
    return Object.freeze({ mode: "COORDINATOR", reason: input.platform === "win32" ? "dump_policy_unavailable" : "hosted_unqualified" });
  }
  if (input.platform === "win32") return Object.freeze({ mode: "COORDINATOR", reason: "dump_policy_unavailable" });
  return Object.freeze({ mode: "HOSTED", reason: "hosted_ready" });
}

/** The full decision. Probes run only after condition (3) passed: hello (2) first, then (1). */
export async function decideFuigoBootMode(input: { platform: NodeJS.Platform; qualifiedTable?: Qualified; probes?: HostedProbes }): Promise<FuigoModeDecision> {
  const first = decideFuigoBootModeNow(input);
  if (first.mode === "COORDINATOR") return first;
  if (!input.probes) return Object.freeze({ mode: "COORDINATOR", reason: "host_no_hello" });
  const hello = await input.probes.hostHello().catch(() => ({ ok: false, dumpsDisabled: false }));
  if (!hello.ok) return Object.freeze({ mode: "COORDINATOR", reason: "host_no_hello" });
  // r3.2 A12: the coordinator applies its own core-dump policy after the host is up, on this branch only.
  if (!hello.dumpsDisabled || !input.probes.coordinatorDumpsDisabled()) return Object.freeze({ mode: "COORDINATOR", reason: "dump_policy_unavailable" });
  return first;
}
