// Producer: MAIN's live decision authority and scope-trust-r's saved snapshot.
// Consumer: scope-trust-r ACP launch, seed, reply and prompt fences.
import { isAbsolute } from 'node:path';
import { folderTrustKindNames, isUnrecordableTrustRoot } from '../../folder-trust.ts';
import type { FolderTrustActivityReason } from '../../folder-trust-activity.ts';
import type { FolderTrustTurnInput, SendTurnInput } from '../../contracts.ts';

export interface FolderTrustAuthority {
  readonly generation: string;
  /** The No limits owner fact (also what lets a picked folder take Murage's isolated configuration home at dispatch). */
  readonly owner: boolean;
  /** OVERREACH #8: the owner's own turn at any access level. The driver's no-card answers read this; absent, `owner` stands. */
  readonly ownerDirect?: boolean;
  readonly level?: "ask" | "auto" | "full" | "unlimited";
  /** Decision and pick revisions are checked again at every physical write. */
  readonly revision: string;
}
export const folderTrustOwnerNow = (a: FolderTrustAuthority | null | undefined): boolean => (a?.ownerDirect ?? a?.owner) === true;
export const rejectFolderConfiguration = () => ({ outcome: 'reject' as const });
export const explicitFolderConsent = () => ({ outcome: 'trust' as const, scope: 'configAndCommands' as const });
// This constructor has no duration-less form.
export const processFolderChoice = () => ({ outcome: 'trust' as const, scope: 'configAndCommands' as const, duration: 'process' as const });

/** F15 (1.0.24): what a picked folder loads silently at any level: instruction files, rules and skills (text the model reads; it runs
 * nothing on its own). Everything else (hooks, plugins, MCP and LSP servers, agents, roles, permission rules, settings files, .envrc,
 * and any kind this list does not name) follows the bot's level and loads only at Full access or No limits. An allowlist, so a new
 * kind fails closed. */
export const FOLDER_TEXT_SOURCE = /^(?:.*\/)?(?:AGENTS?\.md|CLAUDE(?:\.local)?\.md)$|^(?:.*\/)?\.(?:fuigo|claude|cursor)\/rules$|^(?:.*\/)?\.(?:fuigo|agents|claude|cursor)\/(?:skills|commands)$|^AGENTS\.md \/ CLAUDE\.md$|^project skills$/i;
export const folderSourcesRunCommands = (sources: readonly string[] | undefined): boolean => (sources ?? []).some((source) => !FOLDER_TEXT_SOURCE.test(source));
/** What the scan found at dispatch and what the engine itself names in its request (`configKinds`): either one is enough. */
export const commandsFollowLevel = (authority: FolderTrustAuthority, gate: FolderTrustTurnInput, configKinds: unknown) =>
  authority.level !== "full" && authority.level !== "unlimited" && authority.owner !== true
  && (folderSourcesRunCommands(gate.sources) || folderSourcesRunCommands(folderTrustKindNames(Array.isArray(configKinds) ? configKinds : [])));

export function safeFuigoTrustKey(key: unknown, unrecordable: (key: string) => boolean = isUnrecordableTrustRoot): key is string {
  return typeof key === 'string' && isAbsolute(key) && Buffer.byteLength(key, 'utf8') <= 4096
    && !/[\u0000-\u001f\u007f\p{Cs}]/u.test(key) && !unrecordable(key);
}

export function liveFolderTrustAuthority(turn: SendTurnInput): FolderTrustAuthority | null {
  try { return turn.folderTrustAuthorityNow?.() ?? null; } catch { return null; }
}

/** OVERREACH #8 (MAIN 2026-11-26): the owner's own turn, at any access level, takes the same no-card answer for a folder the owner picked
 * that No limits took: the access level no longer decides it. A saved no, an unpicked folder and every other check below still reject.
 * Configuration authority is separate from ordinary command permission. No
 * branch here upgrades a saved choice or changes the immutable seed snapshot. */
export function automaticFolderChoice(input: {
  turn: SendTurnInput; gate: FolderTrustTurnInput | undefined; key: unknown; scope: unknown;
  realCwd: string; processReply: boolean; live: boolean; launchAuthority: FolderTrustAuthority | null;
  /** The engine's own `configKinds` from its request, when there is one. */
  configKinds?: unknown;
  /** The launch's precomputed answer (no file call on the serving thread, 1.0.24 S03); defaults to the live check. */
  unrecordable?: (key: string) => boolean;
}): ReturnType<typeof processFolderChoice> | ReturnType<typeof rejectFolderConfiguration> {
  const { turn, gate, key, scope, realCwd, processReply, live, launchAuthority, configKinds, unrecordable } = input;
  const authority = liveFolderTrustAuthority(turn);
  const source = gate?.sourceNow?.();
  if (!live || turn.prewarm || !gate || !authority || !launchAuthority || !folderTrustOwnerNow(authority) || !folderTrustOwnerNow(launchAuthority)
    || !authority.generation || authority.generation !== launchAuthority.generation || authority.revision !== launchAuthority.revision
    || !processReply
    || scope !== 'configAndCommands' || !safeFuigoTrustKey(key, unrecordable) || key !== gate.key
    || (source ? !source.picked : gate.noCardPickKeys?.includes(key) !== true) || (source ? !source.readable : gate.upstreamReadable !== true) || (source ? source.declined : gate.upstreamDeclined)
    || (source ? !source.seedComplete : gate.seedComplete !== true) || gate.decision === 'reject' || gate.storedNoPick
    || !gate.snapshot || gate.snapshot.hasDescendantDecline(key)
    || gate.snapshot?.rejectFor(key, realCwd)
    || commandsFollowLevel(authority, gate, configKinds)) return rejectFolderConfiguration();
  return processFolderChoice();
}

/** Why a rejected automatic choice was rejected, in the order the checks above
 * run. A reason names the first failing precondition and never claims a cause
 * the evidence does not show; "none" is only for a reject with no failed check. */
export function automaticRejectReason(input: Parameters<typeof automaticFolderChoice>[0]): FolderTrustActivityReason {
  const { turn, gate, key, scope, realCwd, processReply, live, launchAuthority, configKinds, unrecordable } = input;
  const authority = liveFolderTrustAuthority(turn);
  const source = gate?.sourceNow?.();
  if (!live || turn.prewarm) return 'inactive-turn';
  if (!gate || !authority || !launchAuthority || !folderTrustOwnerNow(authority) || !folderTrustOwnerNow(launchAuthority) || !authority.generation
    || authority.generation !== launchAuthority.generation || authority.revision !== launchAuthority.revision) return 'authority-unavailable';
  if (!processReply) return 'version-unsupported';
  if (scope !== 'configAndCommands') return 'unsupported-scope';
  if (!safeFuigoTrustKey(key, unrecordable) || key !== gate.key) return 'unsafe-key';
  if (source ? !source.readable : gate.upstreamReadable !== true) return 'store-unreadable';
  if (source ? !source.picked : gate.noCardPickKeys?.includes(key) !== true) return 'not-picked';
  if ((source ? source.declined : gate.upstreamDeclined) || gate.decision === 'reject' || gate.storedNoPick
    || !gate.snapshot || gate.snapshot.hasDescendantDecline(key)
    || gate.snapshot?.rejectFor(key, realCwd)) return 'saved-decline';
  if (source ? !source.seedComplete : gate.seedComplete !== true) return 'seed-not-durable';
  // the engine asked for configAndCommands; at this level that scope is not granted (F15 hooks follow the level)
  if (commandsFollowLevel(authority, gate, configKinds)) return 'unsupported-scope';
  return 'none';
}
