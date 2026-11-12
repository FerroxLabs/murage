import committedProbes from "../../shared/native-deny-probes.json" with { type: "json" };
import { matchProbeRegistry, nonempty, record, validBuild, validLaunchMode, validRevisions,
  type ProbeRevisions, type ShellMode, type Transport } from "./registry.ts";

export type LaunchProfile = "today" | "native-skip";
// Structural boundary types keep this work-ahead slice independent of 1.0.19 modules.
// I6 passes noLimitsInitiator(bot, context) from upstream.ts; never a message label.
export type NoLimitsInitiator = "owner" | "owner-channel" | "routine" | "other" | "unproven";
export interface EligibilityInput {
  engine: string;
  build: { version: string; binarySha256: string };
  platform: NodeJS.Platform;
  arch: string;
  osRelease: string;
  launchMode: { transport: Transport; shellMode: ShellMode };
  uid: number | null;
  level: "ask" | "auto" | "full" | "no-limits";
  /** Trusted stored provenance, recomputed for this item/turn, including retries and drains. */
  initiator: NoLimitsInitiator;
  pairedDmAuthenticated: boolean;
  proposalOnly: boolean;
  draftOnly: boolean;
  /** mediated is server-derived proof that a non-Murage route keeps today's gate. */
  mounts: { id: string; enforcing: boolean; mediated?: boolean }[];
  conversationProfile: LaunchProfile | null;
  emitter: "ok" | "unexpressible";
}
export const DEFAULT_NATIVE_SKIP_FLAGS = Object.freeze({
  claude: false, codex: false, antigravity: false, cursor: false, grok: false,
  fuigo: false, pi: false, opencode: false, hermes: false, openclaw: false,
});
export interface ProfileControls {
  /** Explicit server configuration; every omitted engine stays off. */
  flags?: Readonly<Record<string, boolean>>;
  /** Current artifact revisions, computed server-side, never copied from client requests. */
  revisions?: ProbeRevisions;
  /** D2 is opt-in; an authenticated pairing alone does not enable the rollout. */
  pairedDmEnabled?: boolean;
}
interface ProfileDecision { profile: LaunchProfile; reason: string }
function today(reason: string): ProfileDecision { return { profile: "today", reason }; }
function validInput(value: unknown): value is EligibilityInput {
  if (!record(value) || !nonempty(value.engine) || !validBuild(value.build) || !validLaunchMode(value.launchMode)) return false;
  if (!["linux", "darwin", "win32"].includes(value.platform as string) || !nonempty(value.arch)) return false;
  if (typeof value.osRelease !== "string" || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)*(?:[-+][a-zA-Z0-9._+-]+)?$/.test(value.osRelease)) return false;
  if (value.platform === "win32" ? value.uid !== null : !Number.isSafeInteger(value.uid) || (value.uid as number) < 0) return false;
  if (!["ask", "auto", "full", "no-limits"].includes(value.level as string)
    || !["owner", "owner-channel", "routine", "other", "unproven"].includes(value.initiator as string)) return false;
  if (typeof value.pairedDmAuthenticated !== "boolean" || typeof value.proposalOnly !== "boolean" || typeof value.draftOnly !== "boolean") return false;
  if (value.conversationProfile !== null && value.conversationProfile !== "today" && value.conversationProfile !== "native-skip") return false;
  if (value.emitter !== "ok" && value.emitter !== "unexpressible") return false;
  if (!Array.isArray(value.mounts) || !value.mounts.every(m => record(m) && nonempty(m.id) && typeof m.enforcing === "boolean"
    && (m.mediated === undefined || typeof m.mediated === "boolean"))) return false;
  return new Set(value.mounts.map(m => m.id)).size === value.mounts.length;
}
/** No argv/env/config writes: 'today' delegates unchanged to released 1.0.19 at integration.
 * Only the committed probe registry can authorize a switch. Call on every turn; do not cache
 * by conversation. A 'today' result for an already native conversation requires refusing
 * or migrating to a fresh session before execution, never reusing its bypass process.
 * A changed configRev also requires a fresh policy session for Fuigo/opencode even
 * when the profile label stays native-skip. Liveness/integrity/rollback are integration gates.
 */
export function launchProfile(input: EligibilityInput, controls: ProfileControls = {}): ProfileDecision {
  try {
    if (!validInput(input) || !record(controls)) return today("invalid-input");
    if (input.level !== "no-limits" || input.proposalOnly || input.draftOnly) return today("level");
    if (input.initiator !== "owner" && !(input.initiator === "owner-channel"
      && input.pairedDmAuthenticated && controls.pairedDmEnabled === true)) return today("initiator");
    if (input.engine === "cursor" || !Object.hasOwn(DEFAULT_NATIVE_SKIP_FLAGS, input.engine)) return today("engine");
    if (process.env.MURAGE_NATIVE_SKIP === "0") return today("kill-switch");
    if (!record(controls.flags) || !Object.hasOwn(controls.flags, input.engine) || controls.flags[input.engine] !== true) return today("flag-off");
    if (!validRevisions(controls.revisions)) return today("revisions");
    if (input.emitter !== "ok") return today("unexpressible");
    if (input.engine === "claude") {
      if (input.launchMode.shellMode !== "murage-exec") return today("shell-mode");
      if (input.uid === null || input.uid === 0) return today("root-or-unknown-uid");
      if (input.mounts.some(m => !m.enforcing)) return today("mount-not-enforcing");
    }
    if (input.mounts.some(m => !m.enforcing && m.mediated !== true)) return today("mount-not-mediated");
    if ((input.engine === "fuigo" || input.engine === "opencode") && input.conversationProfile === "today") return today("conversation-profile");
    if (!matchProbeRegistry(committedProbes, {
      ...controls.revisions, engine: input.engine, version: input.build.version,
      binarySha256: input.build.binarySha256, platform: input.platform, arch: input.arch,
      osMajor: input.osRelease.split(/[.\-+]/)[0]!,
      transport: input.launchMode.transport, shellMode: input.launchMode.shellMode,
    })) return today("probe-registry");
    return { profile: "native-skip", reason: "eligible" };
  } catch {
    return today("invalid-input");
  }
}
