// M9 (BEDROCK-ENGINE-1023 r2 section 3): bedrockLaunch, the one helper every Claude CLI launch on a Bedrock instance goes through.
// ADMIT -> AWAIT_CHECK -> IDENTITY -> R7 (-> caller's sign-in hold) -> FENCE. A refusal is plain text for ClaudeTurnRefused.
// Owner: M9 builder lane (desktop server side). The driver owner calls it at every CLI spawn site.
import { homedir } from "node:os";
import { BEDROCK_R1, BEDROCK_R4, BEDROCK_R5, bedrockAwsFiles, bedrockR2, bedrockR3, bedrockSettingsRefusal, bedrockSetValues, readBedrockSettings, type BedrockBinding, type BedrockFiles, type BedrockSettingsRead } from "./bedrock-env.ts";
import { engineStderrRedacted } from "./drivers/acp/core.ts";
import type { BedrockBindings } from "./bedrock-bindings.ts";
import { BedrockIdentityError, IdentityCache, identityNetwork, resolveBedrockAccount, type NetworkHand } from "./bedrock-identity.ts";

export interface BedrockRuntime {
  bindings: BedrockBindings;
  cache: IdentityCache;
  /** Test seam: replaces the real STS identity call. */
  resolve?: typeof resolveBedrockAccount;
  /** Test seam: the SDK request handler (real fromIni and STSClient still run). */
  requestHandler?: unknown;
  home?: () => string;
}

let runtime: BedrockRuntime | null = null;
/** Injected once by server/index.ts (and by tests). A driver with no runtime refuses every Bedrock launch as unbound (R1). */
export function setBedrockRuntime(next: BedrockRuntime | null): void { runtime = next; }
export function bedrockRuntime(): BedrockRuntime | null { return runtime; }

export type BedrockLaunch =
  | { ok: true; binding: BedrockBinding; files: BedrockFiles; epoch: number; settings: BedrockSettingsRead[]; set: Record<string, string> }
  | { ok: false; cause: string; aborted?: boolean };

export interface BedrockLaunchInput {
  instanceId: string;
  /** The hand: the captured owner shell plus process env, as the turn builds it (step 5). */
  hand: Readonly<Record<string, string | undefined>>;
  /** User, project and local settings paths, and the managed settings paths, the turn already loads. */
  settingsFiles?: readonly string[];
  managedFiles?: readonly string[];
  /** The engine's own user settings path (the first of settingsFiles when the driver passes the claudeSettingsEnvFiles list). */
  userSettingsFile?: string;
  signal?: AbortSignal;
  routingNames?: (name: string) => boolean;
  /** Skip the R7 file read (the probe and text-only paths that load no repo settings). */
  skipSettings?: boolean;
}

export const bedrockCloudHome = (): boolean => process.env.MURAGE_CLOUD_ROLE === "home";

/** ADMIT: R5 on a Cloud home (no STS call), R1 on an unbound instance. */
export function bedrockAdmit(instanceId: string): { ok: true } | { ok: false; cause: string } {
  if (bedrockCloudHome()) return { ok: false, cause: BEDROCK_R5 };
  if (!runtime || !runtime.bindings.read(instanceId)) return { ok: false, cause: BEDROCK_R1 };
  return { ok: true };
}

export async function bedrockLaunch(input: BedrockLaunchInput): Promise<BedrockLaunch> {
  const admitted = bedrockAdmit(input.instanceId);
  if (!admitted.ok) return admitted;
  const rt = runtime!;
  // AWAIT_CHECK: a turn admitted during a re-bind never launches on the binding being replaced.
  await rt.bindings.awaitCheck(input.instanceId);
  const binding = rt.bindings.read(input.instanceId);
  if (!binding) return { ok: false, cause: BEDROCK_R1 };
  const files = bedrockAwsFiles(input.hand, (rt.home ?? homedir)());
  const settings: BedrockSettingsRead[] = input.skipSettings ? [] : [...(input.settingsFiles ?? []), ...(input.managedFiles ?? [])].map((p) => readBedrockSettings(p));
  const managedSet = new Set(input.managedFiles ?? []);
  const managedEnvs = settings.filter((s) => managedSet.has(s.path)).map((s) => s.env);
  const userEnv = settings.find((s) => s.path === (input.userSettingsFile ?? input.settingsFiles?.[0]))?.env ?? {};
  const network: NetworkHand = identityNetwork(input.hand, userEnv, managedEnvs);
  // IDENTITY (cached under the instance, epoch, binding and the two files' stats).
  const key = rt.cache.key(input.instanceId, binding.epoch, binding.profile, binding.region, files);
  let account = rt.cache.get(key);
  if (account === undefined) {
    try {
      account = await (rt.resolve ?? resolveBedrockAccount)({ profile: binding.profile, region: binding.region, files, network, signal: input.signal, requestHandler: rt.requestHandler });
      rt.cache.set(key, account);
    } catch (error) {
      if (error instanceof BedrockIdentityError && error.kind === "aborted") return { ok: false, cause: bedrockR3(binding.profile, "stopped"), aborted: true };
      if (input.signal?.aborted) return { ok: false, cause: bedrockR3(binding.profile, "stopped"), aborted: true };
      return { ok: false, cause: bedrockR3(binding.profile, engineStderrRedacted(error instanceof Error ? error.message : String(error), false)) };
    }
  }
  if (account !== binding.accountId) return { ok: false, cause: bedrockR2(binding.profile, account, binding.accountId) };
  // R7: identity refusal, no noLimits argument, before the caller's sign-in hold.
  const set = bedrockSetValues(binding, files);
  const hand = { ...input.hand, ...set };
  const refused = bedrockSettingsRefusal(settings, hand, input.routingNames);
  if (refused) return { ok: false, cause: refused.text };
  return { ok: true, binding, files, epoch: binding.epoch, settings, set };
}

/** FENCE: the last awaited step before spawn. A different epoch (a re-bind while a sign-in card was pending), or a change of either AWS file
 * since IDENTITY (the cached identity is taken again under the current file stats), is R4. */
export function bedrockFence(instanceId: string, launched: { epoch: number; files: BedrockFiles; binding: BedrockBinding }): string | null {
  const now = runtime?.bindings.read(instanceId);
  if (!now || now.epoch !== launched.epoch) return BEDROCK_R4;
  const key = runtime!.cache.key(instanceId, now.epoch, now.profile, now.region, launched.files);
  return runtime!.cache.get(key) === now.accountId ? null : BEDROCK_R4;
}
