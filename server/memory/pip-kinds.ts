/** PIP kinds: the one list every reader, guard and purge shares (P2 v5.1 §1.1).
 * These rows live in the identity partition. They reach a model only through
 * the bundle's own slots (and, from P3, memory_self), never through search,
 * recent recall, agent get, a pin, skills or the shared index (PIP A1, I-10,
 * I-15). The exclusion lives in the eligibility predicates themselves so these
 * rows are never ranked and never take a top-k slot. */

/** The owner-authored kinds P1 shipped. The brief is a PIP kind too (V4-9) but
 * keeps its own write and render contract, so code that means "an owner row
 * that mounts in the self slot" names this list. */
export const PIP_OWNER_KINDS = ["commitment","self-trait","relation"] as const;

export const PIP_ALL_KINDS = [
  "continuity-brief","commitment","self-trait","relation",
  "pip-proposal","pip-counter","concern","episode",
] as const;
export type PipKind = typeof PIP_ALL_KINDS[number];
export const PIP_ALL_KINDS_SQL = `(${PIP_ALL_KINDS.map(kind=>`'${kind}'`).join(",")})`;

export const isPipKind = (kind:unknown):kind is PipKind => typeof kind==="string" && (PIP_ALL_KINDS as readonly string[]).includes(kind);
export const isPipOwnerKind = (kind:unknown):boolean => typeof kind==="string" && (PIP_OWNER_KINDS as readonly string[]).includes(kind);

/** Tier tag in `memory_record_details.confidence_basis`, written as `pip:<tier>` (design §1). */
export const PIP_TIERS = ["attested","observed","proposal","counter","self","hypothetical","summary"] as const;
export type PipTier = typeof PIP_TIERS[number];
export function pipTierOf(basis:unknown):PipTier|undefined {
  if(typeof basis!=="string")return undefined;
  const match=/^pip:([a-z]+)/.exec(basis);
  return match&&(PIP_TIERS as readonly string[]).includes(match[1])?match[1] as PipTier:undefined;
}

/** The render cache row id (`memory_scope_bindings`, design §2.1); every PIP writer drops it. */
export const pipRenderId = (botId: string): string => "pip-render:" + botId;

// Deterministic ids for the lived-family rows (design 1.2). Pure, so any reader can recompute them.
import { createHash as pipHash } from "node:crypto";
const pipSha = (parts: unknown[]) => pipHash("sha256").update(JSON.stringify(parts)).digest("hex");
export const pipProposalId = (botId: string, targetKind: string, targetKey: string, statement: string): string => "pip-proposal:" + pipSha([botId, targetKind, targetKey, statement]);
export const pipCounterId = (targetRecordId: string, generation: number): string => "pip-counter:" + pipSha([targetRecordId, generation]);
export const pipEpisodeId = (botId: string, threadId: string, closingMessageId: string): string => "episode:" + pipSha([botId, threadId, closingMessageId]);
