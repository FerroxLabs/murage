// Producer: MAIN's live decision authority and scope-trust-r's saved snapshot.
// Consumer: scope-trust-r ACP launch, seed, reply and prompt fences.
import { isAbsolute } from 'node:path';
import { folderTrustDeclinesFor, folderTrustRejectFor, isUnrecordableTrustRoot } from '../../folder-trust.ts';
import type { FolderTrustActivityReason } from '../../folder-trust-activity.ts';
import type { FolderTrustTurnInput, SendTurnInput } from '../../contracts.ts';

export interface FolderTrustAuthority {
  readonly generation: string;
  readonly owner: boolean;
  readonly level?: "ask" | "auto" | "full" | "unlimited";
  /** Decision and pick revisions are checked again at every physical write. */
  readonly revision: string;
}
export const rejectFolderConfiguration = () => ({ outcome: 'reject' as const });
export const explicitFolderConsent = () => ({ outcome: 'trust' as const, scope: 'configAndCommands' as const });
// This constructor has no duration-less form.
export const processFolderChoice = () => ({ outcome: 'trust' as const, scope: 'configAndCommands' as const, duration: 'process' as const });

export function safeFuigoTrustKey(key: unknown): key is string {
  return typeof key === 'string' && isAbsolute(key) && Buffer.byteLength(key, 'utf8') <= 4096
    && !/[\u0000-\u001f\u007f\p{Cs}]/u.test(key) && !isUnrecordableTrustRoot(key);
}

export function liveFolderTrustAuthority(turn: SendTurnInput): FolderTrustAuthority | null {
  try { return turn.folderTrustAuthorityNow?.() ?? null; } catch { return null; }
}

/** Configuration authority is separate from ordinary command permission. No
 * branch here upgrades a saved choice or changes the immutable seed snapshot. */
export function automaticFolderChoice(input: {
  turn: SendTurnInput; gate: FolderTrustTurnInput | undefined; key: unknown; scope: unknown;
  realCwd: string; processReply: boolean; live: boolean; launchAuthority: FolderTrustAuthority | null;
}): ReturnType<typeof processFolderChoice> | ReturnType<typeof rejectFolderConfiguration> {
  const { turn, gate, key, scope, realCwd, processReply, live, launchAuthority } = input;
  const authority = liveFolderTrustAuthority(turn);
  const source = gate?.sourceNow?.();
  if (!live || turn.prewarm || !gate || !authority?.owner || !launchAuthority?.owner
    || !authority.generation || authority.generation !== launchAuthority.generation || authority.revision !== launchAuthority.revision
    || (turn.permissionNow?.() ?? turn).noLimits !== true || !processReply
    || scope !== 'configAndCommands' || !safeFuigoTrustKey(key) || key !== gate.key
    || (source ? !source.picked : gate.noCardPickKeys?.includes(key) !== true) || (source ? !source.readable : gate.upstreamReadable !== true) || (source ? source.declined : gate.upstreamDeclined)
    || (source ? !source.seedComplete : gate.seedComplete !== true) || gate.decision === 'reject' || gate.storedNoPick
    || (gate.snapshot ? gate.snapshot.hasDescendantDecline(key) : folderTrustDeclinesFor(gate.rejects ?? [], key).length > 0)
    || (gate.snapshot ? gate.snapshot.rejectFor(key, realCwd) : folderTrustRejectFor(gate.rejects ?? [], key, realCwd))) return rejectFolderConfiguration();
  return processFolderChoice();
}

/** Why a rejected automatic choice was rejected, in the order the checks above
 * run. A reason names the first failing precondition and never claims a cause
 * the evidence does not show; "none" is only for a reject with no failed check. */
export function automaticRejectReason(input: Parameters<typeof automaticFolderChoice>[0]): FolderTrustActivityReason {
  const { turn, gate, key, scope, realCwd, processReply, live, launchAuthority } = input;
  const authority = liveFolderTrustAuthority(turn);
  const source = gate?.sourceNow?.();
  if (!live || turn.prewarm) return 'inactive-turn';
  if (!gate || !authority?.owner || !launchAuthority?.owner || !authority.generation
    || authority.generation !== launchAuthority.generation || authority.revision !== launchAuthority.revision) return 'authority-unavailable';
  if (!processReply) return 'version-unsupported';
  if (scope !== 'configAndCommands') return 'unsupported-scope';
  if (!safeFuigoTrustKey(key) || key !== gate.key) return 'unsafe-key';
  if (source ? !source.readable : gate.upstreamReadable !== true) return 'store-unreadable';
  if (source ? !source.picked : gate.noCardPickKeys?.includes(key) !== true) return 'not-picked';
  if ((source ? source.declined : gate.upstreamDeclined) || gate.decision === 'reject' || gate.storedNoPick
    || (gate.snapshot ? gate.snapshot.hasDescendantDecline(key) : folderTrustDeclinesFor(gate.rejects ?? [], key).length > 0)
    || (gate.snapshot ? gate.snapshot.rejectFor(key, realCwd) : folderTrustRejectFor(gate.rejects ?? [], key, realCwd))) return 'saved-decline';
  if (source ? !source.seedComplete : gate.seedComplete !== true) return 'seed-not-durable';
  return 'none';
}
