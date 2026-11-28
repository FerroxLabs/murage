// Both the proposal and execution sides are owned by the skill-switch build lane.
import { createHash } from "node:crypto";
import type { SkillListing } from "./skills.ts";
import { redactSecretsInText } from "./redact.ts";
import { isSkillSwitchAction, type SkillSwitchAction } from "../shared/skill-request.ts";
import type { SkillScan } from './skill-guard/types.ts';
import { SWITCH_LIMITS, SkillSwitchLimit } from './skill-switch-bounds.ts';
export type { SkillSwitchAction } from "../shared/skill-request.ts";

export interface SwitchInput {
  schema?: 1;
  action: SkillSwitchAction;
  name: string;
  skillSha256: string;
  enabledBefore: boolean;
  /** Snapshot only: recording a proposal does not acknowledge its findings. */
  scanContentHash?: string;
  previewSha256?: string;
  verdictHash?: string;
  source?: string;
  shared?: boolean;
  acknowledged?: string;
}
/** Every semantic finding field is bound; only the wall-clock scan time is excluded. */
export function skillVerdictHash(scan: SkillScan | undefined): string | undefined {
  if (!scan) return;
  if (scan.findings.length > SWITCH_LIMITS.findings) throw new SkillSwitchLimit();
  const findings = scan.findings.map(f => ({ rule: f.rule, category: f.category, severity: f.severity,
    confidence: f.confidence, message: f.message, evidence: f.evidence, file: f.file, source: f.source }));
  if (Buffer.byteLength(JSON.stringify(findings)) > SWITCH_LIMITS.findingBytes) throw new SkillSwitchLimit();
  return createHash('sha256').update(JSON.stringify({ schema: 1, verdict: scan.verdict,
    contentHash: scan.contentHash, scannerVersion: scan.scannerVersion, findings })).digest('hex');
}
export type SwitchPlan = ({ ok: true; source: string; shared: boolean; preview: string; previewSha256: string;
  title: string; subtitle: string; allowLabel: "Turn on" | "Turn off" | "Delete" } & SwitchInput)
  | { ok: false; status: 404 | 409 | 422; error: string };

export function skillSwitchCopy(action: SkillSwitchAction, name: string, source: string, botName = "this bot") {
  const shared = /^(collection|library):/.test(source);
  const allowLabel = action === "turn_on" ? "Turn on" : action === "turn_off" ? "Turn off" : "Delete";
  return {
    shared, allowLabel,
    title: action === "delete"
      ? shared ? `Take skill "${name}" off ${botName}?` : `Delete skill "${name}" from ${botName}?`
      : `${allowLabel} skill "${name}"?`,
    subtitle: action === "delete"
      ? shared ? "Your other bots and the shared copy keep it. You can add it again from Skills." : "This is the only copy. It can't be undone."
      : "Review the current skill before approving this change.",
  } as const;
}

export function planSkillSwitch(listing: SkillListing | undefined, text: string | null, action: SkillSwitchAction, name: string, botName?: string, revision?:{rawHash:string;preview:string;previewSha256:string}): SwitchPlan {
  if (!listing || listing.name !== name) return { ok: false, status: 404, error: "That isn't one of this bot's skills. Built-in guides are switched by the owner in Skills." };
  if (!isSkillSwitchAction(action)) return { ok: false, status: 422, error: "Choose turn_on, turn_off or delete." };
  if (action === "turn_on" && listing.scan?.verdict === "blocked") return { ok: false, status: 409, error: "This skill was blocked by the skill check and can't be switched on." };
  if (text === null) return { ok: false, status: 422, error: "The skill's SKILL.md could not be read. Nothing was changed." };
  if ((revision?.rawHash ?? createHash("sha256").update(text).digest("hex")) !== listing.sha256) return { ok: false, status: 422, error: "The stored SKILL.md changed after review. Remove and import or learn it again." };
  if (!listing.scan) return { ok: false, status: 422, error: "The skill check is unavailable. Nothing was changed." };
  if (action === "turn_on" && listing.enabled || action === "turn_off" && !listing.enabled) return { ok: false, status: 409, error: `Already ${listing.enabled ? "on" : "off"}: nothing to change.` };
  const preview = revision?.preview ?? redactSecretsInText(text);
  const copy = skillSwitchCopy(action, name, listing.source, botName);
  const verdictHash=skillVerdictHash(listing.scan);
  const previewSha256=revision?.previewSha256 ?? createHash('sha256').update(preview).digest('hex');
  if(Buffer.byteLength(JSON.stringify({schema:1,action,name,source:listing.source,shared:copy.shared,skillSha256:listing.sha256,
    enabledBefore:listing.enabled,scanContentHash:listing.scan.contentHash,verdictHash,previewSha256}))>SWITCH_LIMITS.snapshot)
    return {ok:false,status:422,error:'This skill change exceeds the review limit. Nothing was changed.'};
  const findings = listing.scan?.verdict === "review"
    ? [...new Set(listing.scan.findings.map(finding => finding.message))].map(line => `- ${redactSecretsInText(line)}`).join("\n") : "";
  return { ok: true, schema: 1, action, name, source: listing.source, enabledBefore: listing.enabled, skillSha256: listing.sha256,
    preview, previewSha256, ...copy,
    subtitle: copy.subtitle + (findings ? `\n\nThe skill check found:\n${findings}` : ""),
    verdictHash, scanContentHash: listing.scan.contentHash,
  };
}

export function checkSkillSwitchSnapshot(listing: SkillListing | undefined, input: SwitchInput): string | null {
  const changed = "The skill changed after you saw it: nothing was changed. Ask the bot again.";
  if (input.schema !== 1 || !input.previewSha256 || !input.verdictHash || !isSkillSwitchAction(input.action) || !listing || listing.name !== input.name || listing.sha256 !== input.skillSha256 || listing.enabled !== input.enabledBefore) return changed;
  if (listing.source !== input.source || /^(collection|library):/.test(listing.source) !== input.shared) return changed;
  if (!listing.scan || listing.scan.contentHash !== input.scanContentHash || skillVerdictHash(listing.scan) !== input.verdictHash) return changed;
  if (input.action === "turn_on" && listing.scan.verdict === "blocked") return changed;
  return null;
}

/** Owner acceptance additionally proves acknowledgement of the current scan. */
export function checkSkillSwitchStillValid(listing: SkillListing | undefined, input: SwitchInput): string | null {
  return checkSkillSwitchSnapshot(listing, input) ?? (input.action === "turn_on" && listing?.scan?.contentHash !== input.acknowledged
    ? "The skill changed after you saw it: nothing was changed. Ask the bot again." : null);
}
