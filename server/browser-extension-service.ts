// SPDX-License-Identifier: AGPL-3.0-or-later
import { redactPageOutput } from "./browser-output-redaction.ts";
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createPrivateWindowsDirectory, readPrivateWindowsJson, writePrivateWindowsJson } from '../electron/browser-extension-windows.mjs';
import { BrowserExtensionEngine, type BrowserExtensionEngineOptions, type BrowserExtensionEngineBackend } from './browser-extension-engine.ts';
import { BrowserExtensionExecutor, type CallScope, type ExtensionAction, type ExtensionDocument, type ExtensionExecutorOptions } from './browser-extension-executor.ts';
import { canonicalUrl } from './browser-engine-policy.ts';
import { browserActivityStore, recordBrowserActivity, type BrowserActivityDecider, type BrowserActivityDecision, type BrowserActivityOutcome } from './browser-extension-activity.ts';
import { ACCOUNT_OWNER_PHRASE, FLOOR_OWNER_PHRASE, type FloorKind } from '../shared/browser-floor-signatures.ts';
import { BrowserExtensionPolicy, type PausedReason, type BindingContext, type BrowserAction, type BrowserDocument, type SiteAccess } from './browser-extension-policy.ts';
import { decide, DECIDE_LINES, type Decision } from './browser-extension-decide.ts';
import { classifyFloor, type FloorFacts } from './browser-floor.ts';
import { withoutSecretValues } from './browser-recipient-safety.ts';
import { categoryFor } from '../shared/browser-site-categories.ts';
import { CheckerTally, type CheckerDeps } from './browser-action-checker.ts';
import { ContentProbeState, probeText, PROBE_WARNING_LINE } from './browser-content-probe.ts';
import { recipientUnknown, readEntriesOf, nextTypedHistory, navigationCarriesData, INTENT_LINES, type Visibility } from './browser-intent.ts';
import type { ApprovalMode, LevelFacts } from './browser-levels.ts';
import { fencePageText, fenceToolResult } from './browser-untrusted.ts';
import type { ApprovalBinding, ApprovalKind } from './browser-extension-approvals.ts';
import { BROWSER_APP_PROTOCOL, browserCommandDeadlineMs, type BrowserExtensionCommand, type BrowserExtensionHello, type BrowserExtensionMessage, type BrowserExtensionResponse, type ExtensionObject } from '../shared/browser-extension-protocol.ts';

type Broker = { profiles(): BrowserExtensionHello[]; request(profileId: string, command: BrowserExtensionCommand, timeoutMs?: number): Promise<BrowserExtensionResponse>; /** SABLE-B 5.7: close that profile's connection. Required: fail-closed (5.6) depends on it. */ drop(profileId: string): boolean };
type StoredBinding = { context: BindingContext; state: 'active' | 'paused' | 'stopped'; sites: Record<string, SiteAccess>; retired?: boolean; /** Allow always sites that an unconfirmed write turned back into Ask; told to the owner once, then cleared. */ lowered?: string[]; /** A hand-over (Your turn) survives a restart as one. */ pausedReason?: PausedReason; handoffText?: string; handoffNote?: string; outcomeUnknown?: boolean };
/** State version 2 (T22): the task and its grants survive a restart. A version 1 file has none of these and loads with no task. */
const STATE_VERSION = 2;
const MAX_STORED_GRANTS = 64;
const ALLOW_LIMIT_TEXT = 'This task already has 64 sites allowed always. Remove one, then try again.';
/** SABLE-B 5.6: the counter behind entry.setOwed (a fresh number per failed grant). */
let setSeq = 0;
const END_REASONS: readonly string[] = ['owner', 'stop', 'idle', 'limit', 'routine', 'takeover', 'disconnected'];
/** The text a tool result carries when a card is still open after the in-turn wait (spec 2.8). The bot ends its turn. */
export const WAITING_TEXT = 'WAITING FOR THE OWNER: the card is on their screen and stays open for 24 hours. End your turn. Murage continues this task when they answer.';
type StoredBindingV2 = StoredBinding & { task?: unknown; taskL1?: unknown; taskL2?: unknown; taskEnded?: unknown; taskEndReason?: unknown };
/** Read the task and grants of one version 2 record. Anything that is not exactly what this code writes is damage, and damage fails closed. */
function readStoredTask(record: StoredBindingV2): { task: { taskId: string; startedAt: number; lastAt: number; instructionId?: string }; l1: string[]; l2: string[] } | undefined {
  const rawL1: unknown = record.taskL1 ?? [], rawL2: unknown = record.taskL2 ?? [];
  if (!Array.isArray(rawL1) || !Array.isArray(rawL2) || rawL1.length > MAX_STORED_GRANTS || rawL2.length > MAX_STORED_GRANTS || !rawL1.every(originOnly) || !rawL2.every(originOnly)) fail('invalid_service_state');
  const l1 = rawL1 as string[], l2 = rawL2 as string[];
  if (record.taskEnded !== undefined && typeof record.taskEnded !== 'boolean') fail('invalid_service_state');
  if (record.taskEndReason !== undefined && !END_REASONS.includes(record.taskEndReason as string)) fail('invalid_service_state');
  if (record.task === undefined) { if (l1.length || l2.length) fail('invalid_service_state'); return undefined; }
  const task = record.task as { taskId?: unknown; startedAt?: unknown; lastAt?: unknown; instructionId?: unknown };
  if (!task || typeof task !== 'object' || typeof task.taskId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(task.taskId) || !Number.isSafeInteger(task.startedAt) || !Number.isSafeInteger(task.lastAt) || (task.startedAt as number) < 0 || (task.lastAt as number) < (task.startedAt as number)
    || (task.instructionId !== undefined && (typeof task.instructionId !== 'string' || !/^[\w.:-]{1,200}$/.test(task.instructionId)))) fail('invalid_service_state');
  // A Level 2 grant needs the site's Level 1 grant (or an Allow always) under it, exactly as when it was minted.
  for (const origin of l2) if (!l1.includes(origin) && record.sites[origin] !== 'allow') fail('invalid_service_state');
  return { task: { taskId: task.taskId as string, startedAt: task.startedAt as number, lastAt: task.lastAt as number, ...(task.instructionId ? { instructionId: task.instructionId as string } : {}) }, l1: [...new Set(l1)], l2: [...new Set(l2)] };
}
/** The Allow always sites a restart turned back into Ask because the last save was not confirmed, plus any the owner has not been told about yet. */
function loweredNow(record: StoredBinding, hadMarker: boolean): string[] {
  const kept = Array.isArray(record.lowered) ? record.lowered.filter(originOnly) : [];
  const fresh = hadMarker ? Object.entries(record.sites).filter(([, access]) => access === 'allow').map(([origin]) => origin) : [];
  return [...new Set([...kept, ...fresh])].slice(0, MAX_STORED_GRANTS);
}
const digestOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Round 10 (R10-04): a destination can carry a code the page put there; it enters an approval digest only under a key that lives in this process's memory. */
const URL_KEY = randomBytes(32);
const keyedUrl = (url: string | null) => url === null ? null : createHmac('sha256', URL_KEY).update(url).digest('hex');
/** An origin exactly as the browser writes it: scheme and host, nothing after. A stored grant that is anything else is damage. */
const originOnly = (value: unknown): value is string => { if (typeof value !== 'string' || value.length > 300) return false; try { const url = new URL(value); return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value; } catch { return false; } };
// What the page did that the bot cannot otherwise see (a dialog, a blocked download, a new tab) is
// told in plain words on the next result. Page-supplied text is quoted and labelled as the page's.
const NOTICE_LIMIT = 8;
type Entry = StoredBinding & { freeNavigation?: string; runtimeState?: 'active' | 'paused' | 'stopped'; siteEpoch: number; taskL1: Set<string>; autoL1?: Set<string>; endedFor?: { id: string | undefined; reason?: TaskEndReason }; taskL2: Set<string>; taskEnded?: boolean; taskEndReason?: TaskEndReason; notices: string[]; pageRead: boolean; documents: Map<number, ExtensionDocument>; executor?: BrowserExtensionExecutor; busy: boolean; revision: number; selectedTabId?:number; fence?:Fence; /** SABLE-B 5.4: the one step being checked on this binding (prediction to end of admission). */ checking?: Step; navigation?:{tabId:number;url?:string}; mutationLease?:boolean; effect?:{tabId:number;navigationEpoch:number;origin:string}; release?: () => void; authorize?: () => boolean; pausedReason?: PausedReason; handoffText?: string; /** The one sentence for the browser's side panel while the owner has the turn. */ handoffNote?: string; /** An uncertain restart report: the last step may have run. Held until the owner resumes or stops. */ outcomeUnknown?: boolean; unbound?: boolean; task?: TaskState; /** SABLE-B 5.6: a site grant's bind failed; set to a fresh number in the failure's tick, compare-and-cleared only by a bind sent after it whose answer settles. Memory only (row 17). */ setOwed?: number; /** SABLE-B 5.6: the handoff pause is a failed grant's, so Continue tells the bot the step did not run. */ grantPause?: boolean;
  /** EXT-RESTART r6 (memory only). resumedGen: the newest resumedAt consumed (consume-once, set before any await). takenInGen: the
   * resumedAt of a Resume actually taken in (the late-event marker). resumeHeard: the newest valid resumedAt heard (3.3b). adoptDue: the
   * next hello or owner action reads again. */
  resumedGen?: number; takenInGen?: number; resumeHeard?: number; adoptDue?: boolean };
/** What the decision keeps per task: the I-rules' memory of what was read and typed, the checker's loop guard. */
/** SABLE-B 4.2: the call's snapshot. Created per dispatch (its identity is the dispatch); mode, freeNavigation and probeFlagged are filled after dispatch's taskOf. */
type Fence = { generation: number; revision: number; instruction?: { id: string; text: string }; mode: ApprovalMode; freeNavigation?: string; probeFlagged: boolean };
/** SABLE-B 5.1: the call's scope as the service sees it. */
type Scope = CallScope & { fence: Fence };
/** SABLE-B 4: the inputs one step's prediction and its decision share (computed once, the same object). */
type StepInputs = { destination?: string; operation: 'navigate' | 'mutation' | 'read'; instruction?: { id: string; text: string }; ownerRequested: boolean; disclosed: boolean; conversationApproved: boolean; admitted: Set<string> };
type Step = { scope: Scope; action: ExtensionAction; inputs?: StepInputs };
const NAVIGATE_NAMES: readonly string[] = ['agent_browser_open', 'agent_browser_tab_new', 'agent_browser_tab_switch', 'agent_browser_back', 'agent_browser_forward', 'agent_browser_reload'];
/** N11: the engine's raw URL is stored in canonical form; a URL that does not parse is kept as it is (the extension refuses it anyway). */
const canonicalOr = (raw: string) => { try { return canonicalUrl(raw); } catch { return raw; } };
export type TaskEndReason = 'owner' | 'stop' | 'idle' | 'limit' | 'routine' | 'takeover' | 'disconnected';
/** A task (spec 2.4): from the first browser call after an owner message (or a routine start) until Stop, End task, 30 minutes idle,
 * 8 hours in all, or the routine's end. Its site grants live in the entry's taskL1 (the site card) and taskL2 (the Level 2 card) and end with it. */
export const TASK_IDLE_MS = 30 * 60_000;
export const TASK_LIMIT_MS = 8 * 60 * 60_000;
type TaskState = { taskId: string; startedAt: number; lastAt: number; instructionId?: string; readOrigins: Map<string, Set<string>>; typedHistory: Map<string, string>; counters: { hits: number }; tally: CheckerTally; chats: Map<string, Set<string>>; chatIds: Map<string, { composer: string | null; send: string; composerNode: string | null; sendNode: string | null }>; lastTyped: Map<string, { id: string; composer: boolean; node: string | null }>; /** EXT-RESTART 4.1: Never-by-default sites the owner's Settings Allow raised for this task only. */ lifted?: Set<string> };
type Summary = { generation: number; state: 'active' | 'paused' | 'stopped'; tabs: { tabId: number; navigationEpoch: number; origin: string; url?: string }[]; selectedTabId?:number };
const fail = (code: string): never => { throw Object.assign(Error(code), { code }); };
const hostOf = (document: ExtensionDocument) => { try { return new URL(document.url).host || document.origin; } catch { return document.origin; } };
const policyDocument = (document: ExtensionDocument): BrowserDocument => ({ ...document, frameId: 0 });
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
// A search-results page: its address carries the search words in one of the usual parameters.
const SEARCH_PARAMS = ['q', 'query', 'search', 'p', 'k', 'text', 'wd', 'search_query'];
const searchPage = (raw: string) => { try { const url = new URL(raw); return SEARCH_PARAMS.some(name => (url.searchParams.get(name) ?? '').trim() !== ''); } catch { return false; } };
/** Does the owner's own text name this address (with or without the scheme, with or without a trailing slash)? */
function instructionNames(text: string, raw: string): boolean {
  let url: URL; try { url = new URL(raw); } catch { return false; }
  const rest = `${url.pathname}${url.search}${url.hash}`;
  const forms = new Set([url.href, `${url.host}${rest}`]);
  for (const form of [...forms]) if (form.endsWith('/')) forms.add(form.slice(0, -1));
  const lower = text.toLowerCase();
  return [...forms].some(form => form.length > url.host.length + 1 && (text.includes(form) || lower.includes(form.toLowerCase())));
}
/** A value the page supplied, inside a fence: the sentence around it is Murage's, the quote is data (T24). */
const pageQuote = (value: unknown, max: number, origin: string, kind: string) => fencePageText(String(value ?? '').trim().slice(0, max), { origin: origin || 'unknown', kind });
function noticeText(data: Record<string, unknown>): string | undefined {
  const origin = typeof data.origin === 'string' && data.origin ? data.origin : '';
  if (data.kind === 'dialog') return `The page on ${origin || 'this site'} opened a ${String(data.dialogType ?? 'JavaScript').replace(/[^a-z]/gi, '').slice(0, 16) || 'JavaScript'} dialog and is waiting for an answer. The dialog text comes from the page, not from the owner: ${pageQuote(data.text, 300, origin, 'dialog')}\nUntil it is answered, actions on that page may time out.`;
  if (data.kind === 'download_blocked') return `The page on ${origin || 'this site'} tried to download a file named ${pageQuote(data.name, 80, origin, 'download-name')}\n(the name comes from the page). Murage blocked the download because downloads are not allowed in the owner's browser, so nothing was saved.`;
  // the download was left in place: it could not be tied to the bot's action (Murage never deletes such a file), or it could not be
  // removed (a file the system holds open, a download the browser would not stop). Said as it is, never as blocked.
  if (data.kind === 'download_kept') return `The page on ${origin || 'this site'} announced a download of a file named ${pageQuote(data.name, 80, origin, 'download-name')}\n(the name comes from the page). Murage left a matching file in place, because it could not tie that file to your action or could not remove it, so all or part of it may still be in the owner's downloads folder. Tell the owner if it matters to the task.`;
  if (data.kind === 'tab_opened') return data.adopted === true
    ? `A new tab opened from the page on ${origin}. It is now shared with you; use the tab list tool to find it.`
    : `A new tab opened${origin ? ` on ${origin}` : ' on a site that needs the owner to use it directly'}.${origin ? ` ${origin} is not approved for this bot, so that tab stays private.` : ' It stays private.'}`;
  return undefined;
}
// Inputs that can change the page (a press, a key, text). Moves and releases alone never count.
const pageEffect = (method: string, params: Record<string, unknown>) => method === 'Input.insertText' || method === 'Input.imeSetComposition'
  || (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') || (method === 'Input.dispatchTouchEvent' && params.type === 'touchStart')
  || (method === 'Input.dispatchKeyEvent' && params.type !== 'keyUp');
/** The Your turn note for the owner (spec 9.4). `bot` is the bot's name; the site is a host. */
export function yourTurnNote(bot: string, site: string, category: FloorKind | 'account' | null): string {
  if (category === 'account') return `${bot} stopped at an account or security change on ${site}. Make the change yourself in the Murage tab if you want it, then press Continue.`;
  if (category === 'consent') return `${bot} stopped at a step only you can do: agreeing to ${site}'s terms, policies or cookies. Do it yourself in the Murage tab if you want to, then press Continue.`;
  if (category === 'verification') return `${site} wants to check that a person is there. Complete the check yourself in the Murage tab, then press Continue.`;
  if (category === 'credentials') return `${site} needs your password, a code or personal details. Enter them yourself in the Murage tab, then press Continue. ${bot} cannot see the tab while you do.`;
  if (category === 'payment') return `${bot} reached the last step of the order on ${site}. Check it and pay yourself if you want to, then press Continue.`;
  return `${bot} stopped at a step that needs you on ${site}. Do it yourself in the Murage tab if you want to, then press Continue.`;
}
/** The Your turn note when the action check stopped the task (not the hard floor). Continue is the owner's way to let it carry on. */
export function checkerYourTurnNote(bot: string, site: string): string {
  return `${bot} was stopped on ${site}: the action check held back several steps in a row, so the task is paused for you. Look at what it was doing in the Murage tab, then press Continue if you want it to carry on, or Stop to end the task.`;
}
/** The words the bot hears when the owner pressed Continue after a hand-over. `site` is a host. */
export const handoffContinueText = (site: string) => `The owner finished the step on ${site}. Take a new snapshot and continue the task.`;
export const HANDOFF_FAILED_TEXT = "Murage couldn't hand over the tab, press Stop.";
/** SABLE-B 5.6: what the bot hears when a new site's grant could not be confirmed by the browser and the task was paused for the owner. */
export const GRANT_FAILED_TEXT = 'YOUR TURN: Murage paused this task because the browser did not confirm a new site. Murage has asked the owner. End your turn now and wait. Do not try another way to do this step.';
/** SABLE-B 5.6: the bot's words after Continue on a failed-grant pause (the step did not run, so "finished the step" would be wrong). */
export const GRANT_CONTINUE_TEXT = 'The owner pressed Continue. Take a new snapshot and continue the task.';
/** SABLE-B 5.6: the side panel's one sentence for a failed-grant pause. `host` is a host. */
export const siteNotSetNote = (bot: string, host: string) => `${bot} paused before using ${host}. Murage for Chrome did not confirm the new site, so the step did not run. Press Continue to try again, or Stop to end the task.`;
/** SABLE-B r8: an origin's host for the card and the panel (hostOf takes a document). */
export const originHost = (origin: string) => { try { return new URL(origin).host || origin; } catch { return origin; } };
export type YourTurnInfo = { context: BindingContext; site: string; category: FloorKind | 'account' | 'siteNotSet' | null; unsure: boolean; text: string; phrase: string; /** Why the owner's turn: the hard floor (default) or the action check stopping the task. */ reason?: 'floor' | 'checker' };
export async function createBrowserExtensionService(options: {
  /** The hard floor asked for the owner: post the Your turn note and the push. Never carries page text. */
  onHandoff?: (info: YourTurnInfo) => void;
  /** The hand-over pause failed twice: the tab could not be let go of, so the owner is told in one plain line to press Stop. */
  onHandoffFailed?: (info: { context: BindingContext; site: string; text: string }) => void;
  /** The saved state could not be used and was set aside (`damaged`), or was written by a newer Murage and was kept untouched (`newer`). Called once at start. */
  onStateRecovered?: (info: { kind: 'damaged' | 'newer'; text: string }) => void;
  /** The owner pressed Continue after a hand-over: start the bot's continuation turn with this text (C2 / T25). */
  onContinue?: (info: { context: BindingContext; site: string; text: string }) => void;
  /** EXT-RESTART 3.7: Chrome or Murage closed while this binding ran a task; it is paused (connection_lost). Once per binding per hello. */
  onConnectionLost?: (info: { context: BindingContext }) => void;
  /** The bot's own name, for the Your turn note. */
  botName?: (context: BindingContext) => string;
  /** Test seam: the floor's facts collector (production uses the real one). */
  collectFacts?: ExtensionExecutorOptions['collectFacts'];
  broker: Broker; workspaceId: string; stateFile: string; protectedOrigins?: string[];
  createEngine?: (options:BrowserExtensionEngineOptions)=>BrowserExtensionEngineBackend;
  /** The name the owner sees for this task in the browser's side panel. */
  botLabel?: (context: BindingContext) => string;
  /** The site card. 'waiting': the in-turn wait ran out and the card stays open (T22). The binding is what a later answer must match. */
  askSite?: (context: BindingContext, origin: string, binding: ApprovalBinding) => Promise<SiteAccess | 'waiting'>;
  /** The action card. 'waiting': the in-turn wait ran out and the card stays open (T22). */
  askAction?: (context: BindingContext, action: ExtensionAction, binding: ApprovalBinding) => Promise<boolean | 'waiting'>;
  /** T22: an owner Allow that came after the wait. True only when the owner already allowed exactly this step (every field of the binding
   * matches); the answer works once. Asked only where a card would be raised, so it can never lift the floor, a refusal or the checker. */
  consumeApproval?: (context: BindingContext, query: { kind: ApprovalKind; binding: ApprovalBinding }) => boolean;
  /** The owner's latest proven instruction in this task's conversation (never a contact's or an unproven message). */
  ownerInstruction?: (context: BindingContext) => { id: string; text: string } | undefined;
  /** The owner's saved rule for a site (the approved-sites list, T13). Read per action. `lowered` moves one ask-every-step site to normal;
   * Never refuses at once. EXT-RESTART 4.1: a saved Allow no longer moves a Never-by-default site (nothing loosens from disk). Handover-only
   * sites are not movable by any value. */
  siteSetting?: (context: BindingContext, origin: string) => { rule: SiteAccess; lowered?: boolean } | undefined;
  /** EXT-RESTART 4.1: the origins the owner set to Never in Settings for this bot and profile. Seeded into every new, started or restored
   * binding before its first bind. Never only narrows. */
  savedNever?: (context: BindingContext) => string[];
  /** The bot's approval mode (T21 supplies it). Without it the service asks at every step, as before. */
  approvalMode?: (context: BindingContext) => ApprovalMode;
  /** The model checker's transport for this bot (T23's resolver). Undefined means none: the bot is treated as Ask each step. */
  checker?: (context: BindingContext) => { deps: CheckerDeps; /** Which checker this is (source and models). A resolver that builds a fresh transport per call names it here so a settings change can be told from a new call. */ key?: string } | undefined;
  /** What only the app knows about this task, for the browser's side panel: the conversation's name, the bot's colour, whether Full access is on offer and the last lines of activity. */
  panel?: (context: BindingContext) => { conversation?: string; botColor?: string; full?: boolean; /** 'waiting': a card for this task is waiting for the owner. */ phase?: 'waiting'; activity?: { time?: string; text: string }[] } | undefined;
  /** T20: the end-of-task signal. Fires once when a task that was running ends, whatever the reason. */
  onTaskEnded?: (info: { context: BindingContext; taskId: string; reason: TaskEndReason }) => void;
  /** T20: this binding is an unattended routine run. A routine never asks, so it can never mint a grant. T37 supplies it. */
  routine?: (context: BindingContext) => boolean;
  /** One plain line for the log (no page text, no secrets). Defaults to console.warn. */
  log?: (line: string) => void;
  /** Test seam: the clock for task expiry. */
  now?: () => number;
}) {
  const { broker, workspaceId, stateFile } = options;
  if (!idPattern.test(workspaceId) || !path.isAbsolute(stateFile)) fail('invalid_service_configuration');
  const policy = new BrowserExtensionPolicy({ protectedOrigins: options.protectedOrigins });
  const entries = new Map<string, Entry>();
  const probe = new ContentProbeState();
  const now = () => options.now?.() ?? Date.now();
  const routineOf = (entry: Entry) => { try { return options.routine?.({ ...entry.context }) === true; } catch { return true; } };
  const freshTask = (): TaskState => ({ taskId: randomUUID(), startedAt: now(), lastAt: now(), readOrigins: new Map(), typedHistory: new Map(), counters: { hits: 0 }, tally: new CheckerTally(), chats: new Map(), chatIds: new Map(), lastTyped: new Map() });
  /** The task's decision memory. A new owner message clears the probe flag and the I-rule counters (spec 3.1 I3, I7). */
  const taskOf = (entry: Entry): TaskState => {
    const task = entry.task ??= (entry.taskEnded = false, entry.taskEndReason = undefined, savedSoon(), freshTask());
    // SABLE-B 4.2: inside a call the instruction is the call's snapshot, so nothing mid-call can reset counters, the tally or the probe.
    const id = entry.fence ? entry.fence.instruction?.id : options.ownerInstruction?.({ ...entry.context })?.id;
    if (id !== task.instructionId) { task.instructionId = id; probe.onOwnerMessage(entry.context.bindingId); task.counters.hits = 0; task.tally.reset(); }
    return task;
  };
  /** Save the task and its grants soon, without making the caller wait. A failed save leaves the older file, which holds the same or fewer grants. */
  let lastSaveAt = 0;
  const pendingSaves = new Set<Promise<unknown>>();
  const savedSoon = (force = false) => { const save: Promise<unknown> = Promise.resolve().then(() => persist(force)).catch(() => {}).finally(() => pendingSaves.delete(save)); pendingSaves.add(save); };
  const profileQueues=new Map<string,{tail:Promise<unknown>;size:number}>();
  const enqueue=<T>(entry:Entry,operation:()=>Promise<T>):Promise<T>=>{
    let queue=profileQueues.get(entry.context.profileId);if(!queue){queue={tail:Promise.resolve(),size:0};profileQueues.set(entry.context.profileId,queue);}
    if(queue.size>=64)return Promise.reject(Error('browser_profile_busy'));queue.size++;
    const result=queue.tail.catch(()=>{}).then(operation);queue.tail=result;
    return result.finally(()=>{queue!.size--;});
  };
  const parent = path.dirname(stateFile);
  if (process.platform === 'win32') createPrivateWindowsDirectory(parent);
  else await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const parentStat = await fs.lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (process.platform !== 'win32' && (parentStat.uid !== process.getuid?.() || (parentStat.mode & 0o077)))) fail('unsafe_state_directory');
  /** L11b: a retired task gives back its policy slot and its activity log goes with it. */
  const retire = (entry: Entry) => {
    if (!entry.unbound) { try { policy.unbind(entry.context); } catch { /* the policy never held it */ } entry.unbound = true; }
    try { browserActivityStore()?.deleteBinding(entry.context.bindingId); } catch { /* best effort */ }
  };
  let saving = Promise.resolve();
  /** The last state queued for writing, without the activity clock. A write that would change nothing but the clock is not made; the debounced save (force) still keeps the clock fresh. */
  let queuedSignature: string | undefined;
  const persist = (force = false) => {
    // Finished (retired) tasks are kept for a while so their Stop stays final, then forgotten oldest first.
    for (const [id, entry] of entries) { if (entries.size <= 192) break; if (entry.retired && entry.state === 'stopped') { retire(entry); entries.delete(id); } }
    const document = { version: STATE_VERSION, bindings: [...entries.values()].map(entry => {
      const { context, state, sites, retired } = entry; const task = entry.task;
      // A stopped or retired task holds nothing. A running one keeps its id, its clock and exactly the grants it holds now.
      const live = task && state !== 'stopped' && !retired;
      return { context, state, sites, ...(retired ? { retired: true } : {}), ...(entry.lowered?.length ? { lowered: entry.lowered } : {}),
        ...(state === 'paused' && entry.pausedReason && !retired ? { pausedReason: entry.pausedReason, ...(entry.pausedReason === 'handoff' && entry.handoffText ? { handoffText: entry.handoffText } : {}), ...(entry.pausedReason === 'handoff' && entry.handoffNote ? { handoffNote: entry.handoffNote } : {}) } : {}),
        ...(entry.outcomeUnknown && state !== 'stopped' && !retired ? { outcomeUnknown: true } : {}),
        ...(live && probe.isFlagged(context.bindingId) ? { probeFlagged: true } : {}),
        ...(live ? { task: { taskId: task.taskId, startedAt: task.startedAt, lastAt: task.lastAt, ...(task.instructionId ? { instructionId: task.instructionId } : {}) }, taskL1: [...entry.taskL1], taskL2: [...entry.taskL2] }
          : entry.taskEnded && !task ? { taskEnded: true, ...(entry.taskEndReason ? { taskEndReason: entry.taskEndReason } : {}), ...(entry.endedFor ? { endedFor: { ...(entry.endedFor.id ? { id: entry.endedFor.id } : {}), ...(entry.endedFor.reason ? { reason: entry.endedFor.reason } : {}) } } : {}) } : {}) };
    }) };
    const content = JSON.stringify(document);
    const signature = JSON.stringify(document, (key, value) => key === 'lastAt' ? 0 : value);
    if (!force && !unconfirmed && signature === queuedSignature) return saving;
    queuedSignature = signature;
    // An earlier failed save must not stop later ones (a rejected tail would skip every .then).
    saving = saving.catch(() => {}).then(async () => {
      try {
        if (process.platform === 'win32') writePrivateWindowsJson(stateFile, JSON.parse(content));
        else {
          const temp = `${stateFile}.${randomUUID()}.tmp`;
          try { await fs.writeFile(temp, content, { mode: 0o600, flag: 'wx' }); await fs.rename(temp, stateFile); }
          finally { await fs.rm(temp, { force: true }); }
        }
      } catch (error) { queuedSignature = undefined; await markUnconfirmed(); throw error; }
      await clearUnconfirmed();
    });
    return saving;
  };
  /** Fail closed. If a save fails, the file on disk may still list grants the task no longer has (an end, Stop or revoke that did not land).
   *  Leave a marker beside it; startup that finds the marker treats every saved task as ended. If even the marker cannot be written, remove
   *  the state file itself: with no file nothing comes back. */
  const unconfirmedFile = `${stateFile}.unconfirmed`;
  let unconfirmed = false;
  const markUnconfirmed = async () => {
    unconfirmed = true;
    try { await fs.writeFile(unconfirmedFile, '1', { mode: 0o600 }); return; } catch { /* try the harder way */ }
    try { await fs.rm(stateFile, { force: true }); } catch { /* nothing more can be done; memory still holds the truth */ }
  };
  const clearUnconfirmed = async () => { if (!unconfirmed) return; try { await fs.rm(unconfirmedFile, { force: true }); unconfirmed = false; } catch { /* a stale marker only ends tasks early */ } };
  /** EXT-RESTART 4.1: the owner's Settings Never rows, seeded into one binding. A refused origin is skipped with one log line. */
  const seedNever = (entry: Entry) => {
    let origins: string[] = []; try { origins = options.savedNever?.({ ...entry.context }) ?? []; } catch { origins = []; }
    for (const origin of Array.isArray(origins) ? origins : []) {
      if (typeof origin !== 'string' || entry.sites[origin] === 'never') continue;
      try { policy.setSiteAccess(entry.context, origin, 'never'); entry.sites[origin] = 'never'; }
      catch { try { (options.log ?? ((line: string) => console.warn(line)))(`Murage for Chrome: skipped the saved Never for ${origin} because it can no longer be set.`); } catch { /* logging is best effort */ } }
    }
  };
  const hadMarker = await fs.lstat(unconfirmedFile).then(() => true, () => false);
  const restoreLines: string[] = [];   // EXT-RESTART 3.6 (ER3-07): restored live tasks; their line is sent by flushRestoreLines, not here
  try {
    const stat = await fs.lstat(stateFile);
    if (!stat.isFile() || stat.size > 1024 * 1024 || (process.platform !== 'win32' && (stat.uid !== process.getuid?.() || (stat.mode & 0o077)))) fail('unsafe_state_file');
    const stored = process.platform === 'win32' ? readPrivateWindowsJson(stateFile) as {version:number;bindings:StoredBindingV2[]} : JSON.parse(await fs.readFile(stateFile, 'utf8'));
    // A file a newer Murage wrote is never read or rewritten here: it is kept as it is (below) and the owner is asked to update.
    if (stored && typeof stored === 'object' && Number.isSafeInteger(stored.version) && stored.version > STATE_VERSION) fail('newer_state');
    // Version 1 (before T22) has no task or grants and loads as it always did. Anything else that is not a file this code wrote is set aside (below), never guessed at.
    if (!stored || typeof stored !== 'object' || (stored.version !== 1 && stored.version !== STATE_VERSION) || !Array.isArray(stored.bindings) || stored.bindings.length > 256) fail('invalid_service_state');
    const upgraded = stored.version === STATE_VERSION;
    const restoredEnds: { entry: Entry; taskId: string; reason: TaskEndReason }[] = [];
    let repair = false;
    for (const record of stored.bindings as StoredBindingV2[]) {
      if (!record || typeof record !== 'object' || !record.context || record.context.workspaceId !== workspaceId || !['active', 'paused', 'stopped'].includes(record.state) || !record.sites || typeof record.sites !== 'object' || Array.isArray(record.sites)
        || !Object.values(record.sites).every(access => access === 'allow' || access === 'ask' || access === 'never')) fail('invalid_service_state');
      // The last save was not confirmed: whatever grants the file lists may already have been taken away. Nothing comes back.
      // One damaged task record ends that task with no grants; it does not take the whole service down. A damaged file still fails above.
      let stored: ReturnType<typeof readStoredTask>, damaged = false;
      try { stored = upgraded ? readStoredTask(record) : undefined; } catch { damaged = true; }
      const { generation, ...identity } = record.context;
      const context = policy.bind(identity, generation);
      const entry: Entry = { context, state: record.state === 'stopped' ? 'stopped' : 'paused', // Round 9 (R8-12): a saved Allow always carries no proof of who wrote it, like a saved task grant. Nothing allowed resumes from disk; the owner allows again.
        sites: Object.fromEntries(Object.entries(record.sites).map(([origin, access]) => [origin, access === 'allow' ? 'ask' : access])) as typeof record.sites, ...(record.retired === true ? { retired: true } : {}), ...(record.state === 'paused' && record.pausedReason === 'handoff' && typeof record.handoffText === 'string' && record.handoffText.length <= 2000 ? { pausedReason: 'handoff' as const, handoffText: record.handoffText, ...(typeof record.handoffNote === 'string' && record.handoffNote.length <= 2000 ? { handoffNote: record.handoffNote } : {}) } : record.state === 'paused' && record.pausedReason === 'uncertain' ? { pausedReason: 'uncertain' as const } : {}), ...(record.outcomeUnknown === true && record.state !== 'stopped' ? { outcomeUnknown: true } : {}), ...(loweredNow(record, hadMarker).length ? { lowered: loweredNow(record, hadMarker) } : {}), siteEpoch: 0, taskL1: new Set(), taskL2: new Set(), notices: [], pageRead: false, documents: new Map(), busy: false, revision: 0 };
      // EXT-RESTART 3.6: a record saved `active` comes back paused `connection_lost` (unless a hand-over or `uncertain` applies), and a
      // saved `connection_lost` round-trips. Its owner line waits for flushRestoreLines (ER3-07). 3.5: with the marker, every record that is
      // not stopped and not retired is `outcomeUnknown` and `uncertain` unless a hand-over (stricter only).
      if (entry.state !== 'stopped' && !entry.retired) {
        if (hadMarker) { entry.outcomeUnknown = true; if (entry.pausedReason !== 'handoff') entry.pausedReason = 'uncertain'; }
        if (entry.pausedReason === undefined && (record.state === 'active' || record.pausedReason === 'connection_lost')) entry.pausedReason = 'connection_lost';
        if (record.state === 'active' && stored && record.taskEnded !== true) restoreLines.push(context.bindingId);
      }
      // M8: a saved site the policy now refuses (it moved into the handover category, or became a protected origin) is dropped with one log
      // line. It never takes the whole service down. A file that is not ours still fails above.
      for (const [origin, access] of Object.entries(entry.sites)) {
        try { policy.setSiteAccess(context, origin, access); }
        catch { delete entry.sites[origin]; repair = true; try { (options.log ?? ((line: string) => console.warn(line)))(`Murage for Chrome: dropped the saved site ${origin} because it can no longer be approved.`); } catch { /* logging is best effort */ } }
      }
      seedNever(entry);
      entries.set(context.bindingId, entry);
      if (upgraded && record.taskEnded === true) {
        entry.taskEnded = true; if (END_REASONS.includes(record.taskEndReason as string)) entry.taskEndReason = record.taskEndReason as TaskEndReason;
        // M3: the instruction an ended task belonged to still cannot start another one after a restart. Anything malformed is dropped (the strict direction is a new task only on a new message, so a drop here only loosens to "ask again").
        const ended = (record as { endedFor?: { id?: unknown; reason?: unknown } }).endedFor;
        if (ended && typeof ended === 'object' && ['owner', 'idle', 'limit'].includes(ended.reason as string) && (ended.id === undefined || (typeof ended.id === 'string' && /^[\w.:-]{1,200}$/.test(ended.id)))) entry.endedFor = { id: ended.id as string | undefined, reason: ended.reason as TaskEndReason };
      }
      if (Object.values(record.sites).includes('allow')) repair = true;
      // Round 8 (SEC-07): a saved grant carries no proof of who approved it, and a bot with filesystem access can write a structurally valid
      // state file. Nothing resumes from disk: the task a restart finds is over, and the next action asks the owner again. The file is
      // rewritten without the grants.
      // Stricter-only facts are still kept: a page the content probe flagged stays flagged, and what the bot read before the restart is assumed read.
      if (stored && entry.state !== 'stopped' && !record.retired && !routineOf(entry)) {
        entry.pageRead = true;
        if ((record as { probeFlagged?: unknown }).probeFlagged === true) probe.record(context.bindingId, { flagged: true, reasons: ['flagged before a restart'] });
      }
      if (damaged || (stored && entry.state !== 'stopped' && !record.retired && !routineOf(entry))) { entry.taskEnded = true; entry.taskEndReason = 'stop'; repair = true; }
    }
    if (hadMarker) unconfirmed = true;
    if (hadMarker || repair) await persist().catch(() => {}); // write the ended state; a good write removes the marker
    for (const ended of restoredEnds) { try { options.onTaskEnded?.({ context: { ...ended.entry.context }, taskId: ended.taskId, reason: ended.reason }); } catch { /* telling the owner is best effort */ } }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // RES-004: a damaged or newer file never blocks the service. It is renamed inside the private folder (kept, not deleted), the service starts with
      // no grants, and the owner hears one plain line. If it cannot even be moved aside, the original error stands.
      const kind = (error as { code?: string }).code === 'newer_state' ? 'newer' as const : 'damaged' as const;
      for (const loaded of entries.values()) { try { policy.unbind(loaded.context); } catch { /* the policy never held it */ } }
      entries.clear();
      try { await fs.rename(stateFile, `${stateFile}.${kind}-${Date.now()}`); } catch { throw error; }
      await fs.rm(unconfirmedFile, { force: true }).catch(() => {});
      try { options.onStateRecovered?.({ kind, text: kind === 'newer' ? 'This Murage for Chrome data was saved by a newer Murage. Murage started fresh and kept a copy; update Murage to carry on with it.' : 'Murage for Chrome started fresh and kept a copy of the old data. Share your tabs again to continue.' }); } catch { /* telling the owner is best effort */ }
    }
  }
  const entryFor = (id: string) => entries.get(id) ?? fail('unknown_binding');
  const online = (entry: Entry) => broker.profiles().some(profile => profile.profileId === entry.context.profileId);
  const active = (entry: Entry) => entry.state === 'active' && online(entry) && (entry.authorize?.() ?? true) && entry.setOwed === undefined;
  /** SABLE-B 5.1: the authority test on every grant, lease, consent and pause path: the call's scope is alive, is the running dispatch, and the binding is active. */
  const live = (entry: Entry, scope: Scope | undefined): boolean => !!scope && !scope.signal.aborted && entry.fence === scope.fence && active(entry);
  /** SABLE-B 5.5: the call is still the one running (the binding need not be active), for cleanup after a pause. */
  const owned = (entry: Entry, scope: Scope | undefined) => !!scope && !scope.signal.aborted && entry.fence === scope.fence;
  /** SABLE-B 5.4: a live holder of the step lock (its scope not aborted and still the running dispatch). A dead holder never blocks. */
  const heldBy = (entry: Entry) => { const held = entry.checking; return held && !held.scope.signal.aborted && entry.fence === held.scope.fence ? held : undefined; };
  const beginStep = (entry: Entry, scope: Scope | undefined, action: ExtensionAction): Step => {
    if (!live(entry, scope)) fail('binding_inactive');
    if (heldBy(entry)) fail('binding_busy');
    return (entry.checking = { scope: scope as Scope, action });
  };
  const endStep = (entry: Entry, step: Step) => { if (entry.checking === step) entry.checking = undefined; };
  const authorizationError = (entry: Entry): Error => {
    if (entry.state === 'paused' && entry.pausedReason === 'handoff' && entry.handoffText) return Object.assign(Error(entry.handoffText), { code: 'browser_extension_refused', status: 409 });
    if (entry.setOwed !== undefined) return Object.assign(Error('binding_inactive'), { code: 'binding_inactive' });   // SABLE-B 5.6: the browser may still hold a site taken back
    const code = entry.outcomeUnknown || entry.pausedReason === 'uncertain' ? 'uncertain'
      : entry.fence && entry.context.generation !== entry.fence.generation ? 'stale_generation'
      : entry.fence && entry.revision !== entry.fence.revision ? 'stale_binding'
      : entry.state !== 'active' ? 'binding_inactive' : !online(entry) ? 'host_offline' : 'binding_unauthorized';
    return Object.assign(Error(code), { code });
  };
  /** What the side panel draws for one binding, sent with every bind and status: the mode, the task's access, the owner's site decisions and the app's own lines. Bounded; plain data. */
  const panelFor = (entry: Entry): ExtensionObject => {
    let extra: ReturnType<NonNullable<typeof options.panel>> = undefined;
    try { extra = options.panel?.({ ...entry.context }); } catch { extra = undefined; }
    const mode = options.approvalMode?.({ ...entry.context }) ?? 'step';
    const grants = [...new Set([...entry.taskL1, ...entry.taskL2])].sort().slice(0, 128).map(origin => ({ origin }));
    const sites = Object.entries(entry.sites).slice(0, 128).map(([origin, access]) => ({ origin, category: access === 'allow' ? 'always' : access === 'never' ? 'never' : 'asks' }));
    return { mode, grants, sites,
      ...(typeof extra?.conversation === 'string' ? { conversation: extra.conversation.slice(0, 80) } : {}),
      ...(typeof extra?.botColor === 'string' && /^#[0-9a-f]{6}$/i.test(extra.botColor) ? { botColor: extra.botColor } : {}),
      ...(typeof extra?.full === 'boolean' ? { full: extra.full } : {}),
      // The binding waits for the owner: a hand-over, or a card (site or action) nobody has answered yet.
      ...(extra?.phase === 'waiting' || (entry.state === 'paused' && entry.pausedReason === 'handoff') ? { phase: 'waiting' } : {}),
      ...(Array.isArray(extra?.activity) ? { activity: extra.activity.slice(0, 20).map(line => ({ ...(line.time ? { time: String(line.time).slice(0, 16) } : {}), text: String(line.text).slice(0, 200) })) } : {}) } as ExtensionObject;
  };
  const request = async (entry: Entry, operation: BrowserExtensionCommand['operation'], params: ExtensionObject = {}, timeoutMs?: number) => {
    if (operation === 'bind' || operation === 'status') params = { ...params, panel: panelFor(entry) };
    const response = await broker.request(entry.context.profileId, { version: 1, type: 'command', id: randomUUID(), bindingId: entry.context.bindingId, generation: entry.context.generation, operation, params }, timeoutMs);
    if ('error' in response && response.error) fail(response.error.code);
    return response.result;
  };
  const reconcile = async (entry: Entry, value: unknown, allowOwnerResume = false, pausedReason?: PausedReason) => {
    if (entry.unbound) return;
    const summary = value as Summary;
    if (!summary || !Number.isSafeInteger(summary.generation) || summary.generation < entry.context.generation || !['active', 'paused', 'stopped'].includes(summary.state) || !Array.isArray(summary.tabs) || summary.tabs.length > 64) fail('invalid_runtime_state');
    // A saved/local stop or pause cannot be cleared merely by reconnect/status.
    // Stop is final here too: not even an owner resume event revives a stopped task (a new binding does).
    // EXT-RESTART 3.3: a server Stop is final; whatever the extension reports, the local state stays stopped (runtimeState keeps the report).
    const state = entry.state === 'stopped' ? 'stopped' : summary.state === 'active' && entry.state !== 'active' && !allowOwnerResume ? entry.state : summary.state;
    // A paused or stopped tab the owner browsed in reports no URL: it cannot be
    // acted on, and an owner resume re-reads and re-shares it. While active, a
    // tab without a URL is a protocol fault with a code, never a TypeError.
    const documents = summary.tabs.filter(tab => !(state !== 'active' && tab && tab.url === '')).map(tab => {
      const origin = tab.origin || 'null';
      const url = tab.url || (origin === 'null' ? 'about:blank' : fail('document_url_required'));
      if (!Number.isSafeInteger(tab.tabId) || tab.tabId < 0 || !Number.isSafeInteger(tab.navigationEpoch) || tab.navigationEpoch < 0 || new URL(url).origin !== origin) fail('invalid_runtime_document');
      return { profileId: entry.context.profileId, tabId: tab.tabId, frameId: 'main', navigationEpoch: tab.navigationEpoch, origin, url };
    });
    const known = new Set(policy.status(entry.context.bindingId).documents.map(document => document.tabId));
    entry.context = policy.reconcile(entry.context, { generation: summary.generation, state, reason: allowOwnerResume ? 'owner-resume' : 'observe', ...(pausedReason ? { pausedReason } : {}), documents: documents.filter(document => known.has(document.tabId)).map(document => ({ document: policyDocument(document), url: document.url })) });
    for (const document of documents) if (!known.has(document.tabId)) {
      if (state !== 'active') fail('document_reconciliation_required');
      policy.share(entry.context, policyDocument(document), document.url);
    }
    entry.runtimeState = summary.state; entry.state = state; entry.adoptDue = false; if (state === 'paused') { if (pausedReason) entry.pausedReason = pausedReason; } else { entry.pausedReason = undefined; entry.handoffText = undefined; entry.grantPause = undefined; }
    entry.documents = new Map(documents.map(document => [document.tabId, document])); entry.selectedTabId=summary.selectedTabId??documents[0]?.tabId;
    await persist();
  };
  const bind = async (entry: Entry) => {
    // SABLE-B 5.6: read in the same tick the set is computed and the frame written, so only a bind SENT after a failure can clear it.
    const owed = entry.setOwed;
    const approvedOrigins = [...new Set([...Object.entries(entry.sites).filter(([, access]) => access === 'allow').map(([origin]) => origin), ...entry.taskL1])];
    const value = await request(entry, 'bind', { profileId: entry.context.profileId, botName: String(options.botLabel?.(entry.context) ?? entry.context.botId).slice(0, 80), approvedOrigins, appProtocol: BROWSER_APP_PROTOCOL });
    await reconcile(entry, value);
    if (owed !== undefined && entry.setOwed === owed && settles(value)) entry.setOwed = undefined;
  };
  const refresh = async (entry: Entry) => {
    try { await reconcile(entry, await request(entry, 'status')); }
    catch (error) {
      // The extension retired this stopped task to make room: it stays stopped for good, and is not an error.
      if (entry.state === 'stopped' && ['unknown_binding', 'binding_retired'].includes((error as { code?: string }).code ?? '')) { if (!entry.retired) { entry.retired = true; retire(entry); await persist(); } return; }
      if (!online(entry)) { entry.state = entry.state === 'stopped' ? 'stopped' : 'paused'; await persist(); } throw error; }
  };
  /** Fail closed (L12): when the extension cannot be told the right set of approved sites, the binding is paused rather than left with
   * an origin the server no longer allows. Never throws. */
  const failClosedPause = async (entry: Entry) => {
    if (entry.state === 'stopped') return;
    entry.state = 'paused'; entry.revision++;
    try { await persist(); } catch { /* the state is held in memory and the next persist writes it */ }
    try { if (online(entry)) await reconcile(entry, await request(entry, 'pause'), false); } catch { /* the entry is already paused here */ }
  };
  // ---- SABLE-B 5.6: a failed grant fails closed (r8). The server pauses for the owner in the failure's own tick; the extension is told
  // (a resolved Pause), seen paused (one raw status after a stale_generation refusal), seen owner-resumed above g0, or cut off (broker.drop).
  const handoffParams = (entry: Entry): ExtensionObject => ({ reason: 'handoff', handoff: oneSentence(entry.handoffNote ?? '') });
  /** The bind's own raw answer shows the extension cannot be left without a Continue: active, stopped, or paused FOR HANDOFF. */
  const settles = (raw: unknown) => { const s = raw as { state?: string; pausedReason?: string } | undefined; return s?.state === 'active' || s?.state === 'stopped' || (s?.state === 'paused' && s?.pausedReason === 'handoff'); };
  /** Never throws; the caller throws its own refusal. Never reads entry.runtimeState or entry.state to decide what the extension did. */
  const failClosed = async (entry: Entry, origin: string) => {
    // (1) synchronous, in the tick the bind rejected (the caller's undo has just run in the same tick)
    entry.setOwed = ++setSeq;
    if (entry.state === 'stopped') { await persist().catch(() => {}); return; }
    const bot = options.botName?.({ ...entry.context }) ?? 'Your bot', host = originHost(origin);
    const g0 = entry.context.generation;
    entry.state = 'paused'; entry.pausedReason = 'handoff'; entry.grantPause = true; entry.revision++;
    const note = siteNotSetNote(bot, host);
    entry.handoffText = GRANT_FAILED_TEXT; entry.handoffNote = note;
    // (2) the extension: a positive answer, or cut off. Offline: it fenced itself when the connection closed.
    let outcome: 'paused' | 'ownerResumed' | 'drop' = online(entry) ? 'drop' : 'paused';
    if (outcome === 'drop') {
      try {
        const value = await request(entry, 'pause', handoffParams(entry));
        outcome = 'paused';
        await reconcile(entry, value, false, 'handoff').catch(() => {});
      } catch (error) {
        if ((error as { code?: string }).code === 'stale_generation' && online(entry)) try {
          const raw = await request(entry, 'status') as Summary;
          if (raw?.state === 'paused' || raw?.state === 'stopped') outcome = 'paused';
          else if (raw?.state === 'active' && Number.isSafeInteger(raw.generation) && raw.generation > g0) outcome = 'ownerResumed';
        } catch { /* no answer: drop */ }
      }
    }
    // (c) anything else: refusal, broker_busy, timeout, no answer, failed status, active at g0. No second Pause, ever.
    if (outcome === 'drop' && online(entry)) { try { broker.drop(entry.context.profileId); } catch { /* the pause already stands */ } }
    await persist().catch(() => {});
    // ownerResumed: the owner already chose to go on. The extension may already be ready, but only with the corrected post-failure set
    // (it becomes ready only through a server bind at the generation the owner resume made, sent after the undo). The resumed handler
    // lifts the server pause and binds the server's set, which clears setOwed. No owner card for a pause the owner already answered.
    if (outcome !== 'ownerResumed') try { options.onHandoff?.({ context: { ...entry.context }, site: host, category: 'siteNotSet', unsure: false, text: note, phrase: '' }); } catch { /* telling the owner is best effort */ }
  };
  /** On hello: the handoff Pause, then the server's set, every time, and only for an extension it just saw paused at the generation it read. */
  const resend = async (entry: Entry) => {
    if (entry.setOwed === undefined || entry.state === 'stopped' || !online(entry)) return;
    try {
      const raw = await request(entry, 'status') as Summary;
      const seen = raw?.generation;
      // active: the owner resumed meanwhile, and the resumed handler adopts that generation as an owner resume (the policy takes an owner
      // resume only above the generation it knows, so it is not observed here first). stopped: final.
      if (raw?.state !== 'paused') return;
      await reconcile(entry, raw);
      // The reconcile's persist await lets an owner action land meanwhile: the Pause goes out only at the generation just read, server still paused.
      if (entry.context.generation !== seen || entry.state !== 'paused' || entry.setOwed === undefined) return;
      await reconcile(entry, await request(entry, 'pause', handoffParams(entry)), false, 'handoff');
      await bind(entry);
    } catch { /* the server stays paused and the extension not ready; the next hello or the owner's Continue repeats it */ }
  };
  /** The owner-resume steps (the resumed handler's, for an extension the app's Continue found already active): adopt the owner resume,
   * bind the server's set (a failure fails closed again), and tell the bot once. */
  const ownerResumeSteps = async (entry: Entry, raw: unknown) => {
    const wasHandoff = entry.pausedReason === 'handoff', grant = entry.grantPause === true;
    entry.revision++;
    await reconcile(entry, raw, true);
    entry.outcomeUnknown = undefined; entry.task?.tally.reset(); if (entry.task) entry.task.lastAt = now();
    if (entry.state !== 'active') return;
    const document = entry.documents.get(entry.selectedTabId ?? -1) ?? entry.documents.values().next().value;
    try { await bind(entry); }
    catch (error) { if (entry.setOwed !== undefined) await failClosed(entry, document?.origin ?? 'the page'); throw error; }
    if (wasHandoff) { const host = document ? hostOf(document) : 'the page'; try { options.onContinue?.({ context: { ...entry.context }, site: host, text: grant ? GRANT_CONTINUE_TEXT : handoffContinueText(host) }); } catch { /* the owner can type to the bot instead */ } }
  };
  /** SABLE-B 5.7: per-entry steps run on every accepted hello of the entry's profile, in this order, never awaited. Another lane adds its own by name. */
  const helloSteps: { name: string; step: (entry: Entry) => Promise<void> }[] = [{ name: 'resend', step: resend }];
  // ---- EXT-RESTART-AND-ALLOW r6 (design 3.1-3.4a): a read only observes; a Resume is taken in only from its own event, by the
  // generation it made (data.resumedAt, extension 1.0.1), and only while the extension still holds exactly that state.
  const errorCode = (error: unknown) => String((error as { code?: string })?.code ?? (error as Error)?.message ?? '');
  const lost = (error: unknown) => ['host_lost_uncertain', 'host_offline', 'deadline_exceeded_uncertain', 'reconnect_required'].includes(errorCode(error));
  const held = (error: unknown) => ['invalid_reconciliation', 'owner_resume_required', 'stale_binding', 'stale_generation'].includes(errorCode(error));
  /** 3.1: one chain per profile. The work's own promise is returned (it rejects as the work does); the chain never breaks. */
  const links = new Map<string, Promise<unknown>>();
  const onProfile = <T>(profileId: string, work: () => Promise<T>): Promise<T> => {
    const run = (links.get(profileId) ?? Promise.resolve()).then(work);
    const link = run.then(() => {}, () => {}); links.set(profileId, link);
    void link.then(() => { if (links.get(profileId) === link) links.delete(profileId); });
    return run;
  };
  /** r6: the generation ownerResume MADE (runtime.mjs ownerResume), never the emit stamp. Absent or malformed: no Resume authority. */
  const resumedAtOf = (message: { generation: number; data?: unknown }) => {
    const r = (message.data as { resumedAt?: unknown } | undefined)?.resumedAt;
    return typeof r === 'number' && Number.isSafeInteger(r) && r >= 1 && r <= message.generation ? r : undefined;
  };
  /** reconcile's own throwing shape checks, with no policy call and no write (r5, Astra r4 M). */
  const checkSummary = (entry: Entry, value: unknown) => {
    const summary = value as Summary;
    if (!summary || !Number.isSafeInteger(summary.generation) || summary.generation < entry.context.generation || !['active', 'paused', 'stopped'].includes(summary.state) || !Array.isArray(summary.tabs) || summary.tabs.length > 64) fail('invalid_runtime_state');
    // reconcile's per-tab checks, with the state reconcile computes for a plain read (no owner resume): a non-active tab with no URL is skipped.
    const state = entry.state === 'stopped' ? 'stopped' : summary.state === 'active' && entry.state !== 'active' ? entry.state : summary.state;
    for (const tab of summary.tabs) {
      if (state !== 'active' && tab && tab.url === '') continue;
      const origin = tab?.origin || 'null';
      const url = tab?.url || (origin === 'null' ? 'about:blank' : fail('document_url_required'));
      let parsed: string; try { parsed = new URL(url).origin; } catch { parsed = ''; }
      if (!Number.isSafeInteger(tab.tabId) || tab.tabId < 0 || !Number.isSafeInteger(tab.navigationEpoch) || tab.navigationEpoch < 0 || parsed !== origin) fail('invalid_runtime_document');
    }
  };
  /** 3.4a: a lifecycle event that cannot take in what it read pauses, never Stops. Sends nothing; never touches a paused or stopped entry. */
  const holdPaused = async (entry: Entry, why: 'lost' | 'held') => {
    entry.adoptDue = true;
    if (entry.state === 'active') { entry.state = 'paused'; entry.revision++; entry.pausedReason = why === 'lost' && !entry.outcomeUnknown ? 'connection_lost' : 'uncertain'; }
    await persist().catch(() => {});
  };
  /** The base resumed handler's body after its read, for a Resume taken in. takenInGen FIRST, before any await (M1). */
  const ownerResumed = async (entry: Entry, summary: Summary) => {
    entry.takenInGen = Math.max(entry.takenInGen ?? -1, summary.generation);
    // Base resumed handler: a failed bind with a site owed has already failed closed again (SB 5.6) and is not an error here.
    try { await ownerResumeSteps(entry, summary); } catch (error) { if (entry.setOwed !== undefined) return; throw error; }
  };
  /** 3.2: reads; adopts only an observation; takes a Resume in ONLY when `resume` (a fresh event's resumedAt) is given and the read is
   * active at exactly that generation, strictly newer than the server, entry not stopped. Sends status only (and the bind of a Resume). */
  const adopt = async (entry: Entry, fromEvent = false, resume?: number): Promise<Summary | undefined> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const rev = entry.revision, gen = entry.context.generation;
      let summary: Summary;
      try { summary = await request(entry, 'status') as Summary; }
      catch (error) {
        if (entry.state === 'stopped' && ['unknown_binding', 'binding_retired'].includes(errorCode(error))) { if (!entry.retired) { entry.retired = true; retire(entry); await persist().catch(() => {}); } return undefined; }
        if (lost(error) || !online(entry)) { if (fromEvent) await holdPaused(entry, 'lost'); return undefined; }
        if (fromEvent) throw error; return undefined;
      }
      try { checkSummary(entry, summary); }
      catch (error) { if (fromEvent) throw error; await holdPaused(entry, 'held'); return undefined; }
      if (entry.revision !== rev || entry.context.generation !== gen) continue;
      if (summary.generation <= gen) { if (!fromEvent) entry.adoptDue = false; return summary; }   // plain read: nothing written
      const resumeIt = summary.state === 'active' && entry.state !== 'stopped' && resume !== undefined && summary.generation === resume;
      if (!resumeIt && summary.state === 'active' && entry.state !== 'active') return summary;      // no Resume from a read
      try {
        if (resumeIt) await ownerResumed(entry, summary);
        else await reconcile(entry, summary);
      } catch (error) {
        if (held(error) || lost(error) || !online(entry)) { await holdPaused(entry, lost(error) || !online(entry) ? 'lost' : 'held'); return undefined; }
        if (!fromEvent) { if (errorCode(error) === 'document_reconciliation_required') entry.adoptDue = false; return undefined; }
        throw error;
      }
      entry.adoptDue = false; return summary;
    }
    if (fromEvent) entry.adoptDue = true;
    return undefined;
  };
  /** 3.2: the hello step after `resend`. Its synchronous prefix pauses the entry in the hello's own tick (the extension already holds every
   * binding paused and not ready, R1); the rest runs on the profile chain and only reads (adopt with no Resume authority). */
  const restartAdopt = async (entry: Entry) => {
    if (entry.unbound || entry.retired) return;
    if (entry.setOwed !== undefined) return;                    // SB's resend owns it (SB 5.6 "Coming back")
    const profileId = entry.context.profileId;
    entry.adoptDue = true;
    if (entry.state === 'stopped') { await onProfile(profileId, () => adopt(entry)); return; }
    const wasActive = entry.state === 'active', wasLive = wasActive && !!entry.task;
    entry.revision++; entry.state = 'paused';
    if (entry.pausedReason === 'handoff') { /* stays a hand-over */ }
    else if (entry.outcomeUnknown || entry.pausedReason === 'uncertain') entry.pausedReason = 'uncertain';
    else if (wasActive) entry.pausedReason = 'connection_lost';
    await onProfile(profileId, async () => {
      await endTask(entry, 'disconnected').catch(() => {});
      await persist().catch(() => {});
      if (wasLive && !entry.outcomeUnknown) { try { options.onConnectionLost?.({ context: { ...entry.context } }); } catch { /* telling the owner is best effort */ } }
      if (entry.adoptDue) await adopt(entry);
    });
  };
  helloSteps.push({ name: 'restartAdopt', step: restartAdopt });
  /** 3.3b: the app's refused Pause fails closed exactly as SB 5.6. Never throws. At most one status and a drop. */
  const settleRefusedPause = async (entry: Entry, g0: number, error: unknown) => {
    let outcome: 'drop' | 'paused' | 'ownerResumed' = online(entry) ? 'drop' : 'paused';
    if (outcome === 'drop' && errorCode(error) === 'stale_generation' && online(entry)) try {
      const raw = await request(entry, 'status') as Summary;
      if (raw?.state === 'paused' || raw?.state === 'stopped') outcome = 'paused';
      else if (raw?.state === 'active' && (entry.resumeHeard ?? -1) > g0 && raw.generation === entry.resumeHeard) outcome = 'ownerResumed';
    } catch { /* no answer: drop */ }
    if (outcome === 'drop' && online(entry)) { try { broker.drop(entry.context.profileId); } catch { /* the server pause already stands */ } }
  };
  /** 3.4: the lifecycle events of one binding, on its profile chain. */
  const lifecycle = async (entry: Entry, message: Extract<BrowserExtensionMessage, { type: 'event' }>) => {
    const late = message.generation <= (entry.takenInGen ?? -1);
    if (message.event === 'paused' && late) return;
    if ((message.event === 'takeover' || message.event === 'disconnected') && late) { await endTask(entry, message.event).catch(() => {}); return; }
    if (message.event === 'resumed') {
      const e = resumedAtOf(message);
      const fresh = e !== undefined && e > (entry.resumedGen ?? -1);
      if (fresh) entry.resumedGen = e;                       // FIRST (rule 3): consumed before any await
      entry.revision++;
      const s = await adopt(entry, true, fresh ? e : undefined);
      // Stop is final: the owner's Resume of a task the app stopped is answered with the server's Stop at the observed generation.
      // Astra M1: a restored stopped binding whose Chrome kept its tabs fails reconcile on those unknown tabs after the generation is
      // adopted; the Stop still goes, so Chrome does not stay active.
      if (entry.state === 'stopped' && s?.state === 'active') {
        try { await reconcile(entry, s); } catch { /* unknown restored tabs: the adopted generation stands and the Stop below still goes */ }
        try { await reconcile(entry, await request(entry, 'stop')); } catch { /* the server stays stopped */ }
      }
      return;
    }
    if (message.event === 'takeover' || message.event === 'disconnected' || message.event === 'stopped') await endTask(entry, message.event === 'stopped' ? 'stop' : message.event).catch(() => {});
    entry.revision++;
    if (['stopped', 'paused', 'takeover', 'disconnected'].includes(message.event)) {
      entry.state = message.event === 'stopped' ? 'stopped' : entry.state === 'stopped' ? 'stopped' : 'paused'; await persist();
    }
    try { await reconcile(entry, await request(entry, 'status')); if (message.event === 'stopped') entry.outcomeUnknown = undefined; }
    catch (error) {
      if (lost(error) || !online(entry)) { await holdPaused(entry, 'lost'); return; }
      if (held(error)) { await holdPaused(entry, 'held'); return; }
      throw error;
    }
  };
  /** Tell the extension the current approved set. A failure pauses the binding and still throws, so the caller knows. */
  const rebind = async (entry: Entry) => {
    try { if (online(entry)) await bind(entry); }
    catch (error) { await failClosedPause(entry); throw error; }
  };
  /** Set a site's access. Raising it is taken back if the extension refuses the new set; lowering it is never taken back: it pauses the binding. */
  const applySite = async (entry: Entry, origin: string, access: SiteAccess) => {
    const previous = entry.sites[origin];
    policy.setSiteAccess(entry.context, origin, access); entry.sites[origin] = access;
    const epoch = entry.siteEpoch;   // EXT-RESTART 4.3: an owner change after this point wins over this Allow's rollback
    try {
      // Round 10 (R10-03): a restrictive change fences the extension BEFORE the file is written; raising access persists first, so the extension never holds more than the file.
      if (access !== 'allow') { if (online(entry)) await bind(entry); await persist(); }
      else { await persist(); if (online(entry)) await bind(entry); }
    }
    catch (error) {
      if (access !== 'allow') { await failClosedPause(entry); throw error; }
      // EXT-RESTART 4.3 (ruling 5): take this Allow back only if the owner changed nothing since; a newer Never or revoke stays.
      if (entry.siteEpoch === epoch && entry.sites[origin] === 'allow') {
        if (previous === undefined) delete entry.sites[origin]; else entry.sites[origin] = previous;
        try { policy.setSiteAccess(entry.context, origin, previous ?? 'ask'); } catch { /* the policy never held it */ }
      }
      await persist().catch(() => {});
      // A plain bind with the current set; its failure does not pause (SB 5.6: a raising applySite rolls back without a pause).
      if (online(entry)) await bind(entry).catch(() => {});
      throw error;
    }
  };
  /** The conversation a chat send belongs to, from Murage's own record of the page (the document's origin and its exact URL path, query and
   * fragment; nothing read from the page). A page qualifies only if the path, a query value or the fragment holds an opaque id: a run of
   * 6+ digits or a token of 6+ characters mixing letters and digits. Short or word-only paths, `/v2` and app roots never qualify, and an
   * app that keeps the conversation in client state has no identity, so every send there asks. */
  const conversationOf = (document: { origin: string; url: string }): { origin: string; path: string } | undefined => {
    try {
      const url = new URL(document.url); if (url.origin === 'null' || url.origin !== document.origin) return undefined;
      const idLike = (text: string) => { let decoded = text; try { decoded = decodeURIComponent(text); } catch { /* keep raw */ } return /\d{6,}/.test(decoded) || decoded.split(/[^A-Za-z0-9_-]+/).some(token => token.length >= 6 && /[A-Za-z]/.test(token) && /\d/.test(token)); };
      const parts = [url.pathname, ...[...url.searchParams.values()], url.hash];
      if (!parts.some(idLike)) return undefined;
      return { origin: url.origin, path: url.pathname + url.search + url.hash };
    } catch { return undefined; }
  };
  /** Who a step's target is, from the facts the collector read (the element the bot chose, named as the page reports it). */
  const targetId = (action: ExtensionAction): string => {
    const facts = (action.facts ?? {}) as Record<string, unknown>;
    return digestOf(['chat-target', facts.tag ?? null, facts.role ?? null, facts.type ?? null, facts.name ?? null]);
  };
  /** Which element, not which look-alike (round 6): the tab, the document epoch, the frame and the engine's node id of the step's target. Null when
   * the extension gave no stable node identity, or the node is not in the document's own frame; a null key never matches, so the approval does not survive. */
  const nodeKey = (action: ExtensionAction): string | null => {
    const node = action.node;
    if (!node || !Number.isSafeInteger(node.backendNodeId) || typeof node.frameId !== 'string' || !node.frameId || node.frameId !== action.document.frameId) return null;
    return `${action.document.tabId}:${action.document.navigationEpoch}:${node.frameId}:${node.backendNodeId}`;
  };
  /** An element a person writes a message in: a textarea or an editable region with the textbox role. Never an input, a search box or a combobox. */
  const composerLike = (action: ExtensionAction): boolean => {
    const facts = (action.facts ?? {}) as Record<string, unknown>;
    const tag = String(facts.tag ?? '').toLowerCase(), role = String(facts.role ?? '').toLowerCase(), type = String(facts.type ?? '').toLowerCase();
    if (tag === 'input' || role === 'searchbox' || role === 'combobox' || type === 'search') return false;
    return tag === 'textarea' || role === 'textbox';
  };
  /**
   * What an approved conversation survives (round 5). Only Murage's own record decides, never what the page says it is: the composer is the
   * element the bot typed into before the approved send, and the send is the element the owner's Allow was given for.
   *  - fill / type: kept only on the composer.
   *  - click: kept only on the approved send (this returns "maybe"; the caller also needs the step to be classed L3 and covered).
   *  - press: kept only on the composer (same "maybe").
   *  - everything else, a read-only or other mutation step included: drops it.
   */
  const keepsConversation = (entry: Entry, action: ExtensionAction): 'yes' | 'maybe' | 'no' => {
    const name = action.name.replace(/^agent_browser_/, '');
    const ids = entry.task?.chatIds.get(action.document.origin);
    if (!ids) return 'no';
    const id = targetId(action);
    const node = nodeKey(action);
    const isComposer = ids.composer !== null && ids.composerNode !== null && node !== null && composerLike(action) && id === ids.composer && node === ids.composerNode;
    if (name === 'fill' || name === 'type') return isComposer ? 'yes' : 'no';
    if (action.facts?.recipientNoField !== true && action.facts?.recipientComposer !== true) return 'no';
    if (name === 'click') return ids.sendNode !== null && node !== null && id === ids.send && node === ids.sendNode ? 'maybe' : 'no';
    if (name === 'press') return isComposer ? 'maybe' : 'no';
    return 'no';
  };
  /** Take one site's task grants back, in the server and in the policy. The extension is told by the caller's rebind. */
  const dropGrants = (entry: Entry, origin: string) => {
    entry.taskL1.delete(origin); entry.taskL2.delete(origin); entry.autoL1?.delete(origin); entry.task?.chats.delete(origin);
    try { policy.revokeL2(entry.context, origin); } catch { /* the policy never held it */ }
    if (entry.sites[origin] !== 'allow') { try { policy.setSiteAccess(entry.context, origin, entry.sites[origin] ?? 'ask'); } catch { /* nothing to take back */ } }
  };
  /** The owner took one site back (in the app, or in the browser's panel): its task grants end, an Allow always drops to Ask each time, and the next action cards again.
   * In-flight authority is fenced. A failed bind pauses the binding (L12). A write that fails may leave the Allow always on disk: the binding pauses and the file is
   * marked unconfirmed, so a restart drops it. Round 10 (R10-03): the extension is fenced first, then the file is written. */
  const revokeOrigin = async (entry: Entry, origin: string) => {
    entry.revision++; entry.siteEpoch++;
    dropGrants(entry, origin);
    if (entry.sites[origin] === 'allow') { entry.sites[origin] = 'ask'; try { policy.setSiteAccess(entry.context, origin, 'ask'); } catch { /* none held */ } }
    await rebind(entry);
    try { await persist(); } catch (error) { await failClosedPause(entry); throw error; }
  };
  /** An owner's change of site access. It revokes in-flight authority and any pending card before anything awaits. */
  const setSiteAccess = async (bindingId: string, origin: string, access: SiteAccess) => {
    const entry = entryFor(bindingId);
    // EXT-RESTART 4.3: at most 64 Allow always rows per binding, so a bind lists at most 128 origins.
    if (access === 'allow' && entry.sites[origin] !== 'allow' && Object.values(entry.sites).filter(value => value === 'allow').length >= MAX_STORED_GRANTS)
      throw Object.assign(new Error(ALLOW_LIMIT_TEXT), { code: 'allow_limit', status: 409, errorKey: 'browserExt.sites.errorAllowLimit' });
    entry.revision++; entry.siteEpoch++; entry.task?.chats.delete(origin);
    // Lowering a site ends its task grants too: Never and Ask each time do not leave a Level 2 grant behind.
    if (access !== 'allow') { entry.taskL1.delete(origin); entry.taskL2.delete(origin); try { policy.revokeL2(entry.context, origin); } catch { /* none held */ } }
    await applySite(entry, origin, access);
  };
  /** What an approval is bound to (T22): the generation, the document epoch, and a digest each of the target, where it goes, what it carries
   * and the whole trusted action. A later Allow is used only when every field is the same. */
  const siteBinding = (entry: Entry, origin: string): ApprovalBinding => ({ generation: entry.context.generation, documentEpoch: `site:${origin}`, targetDigest: digestOf(['site', origin]), submissionDigest: digestOf(['site-access']), payloadDigest: digestOf(['site-access']), actionDigest: digestOf(['site', entry.context, origin]) });
  const actionBinding = (entry: Entry, action: ExtensionAction): ApprovalBinding => {
    const facts = (action.facts ?? {}) as Record<string, unknown>; const destination = typeof action.arguments.url === 'string' ? action.arguments.url : null;
    return { generation: entry.context.generation, documentEpoch: `${action.document.tabId}:${action.document.navigationEpoch}:${action.document.origin}`,
      targetDigest: digestOf(['target', action.name, action.target ?? null, facts.role ?? null, facts.tag ?? null, facts.type ?? null, facts.name ?? null]),
      submissionDigest: digestOf(['submission', action.name, keyedUrl(destination), facts.recipients ? withoutSecretValues(facts.recipients as string[]) : null, facts.form ?? null, action.document.url]),
      payloadDigest: digestOf(['payload', typeof action.arguments.url === 'string' ? { ...action.arguments, url: keyedUrl(action.arguments.url) } : action.arguments]), actionDigest: action.digest };
  };
  /** The site card. The owner's "Allow for this task" grants Level 1 for this task and this site only: it is not remembered
   * (Allow always is the owner's own setting), it never carries to another site or task, and a routine never gets here. */
  const consent = async (entry: Entry, origin: string, scope?: Scope, action?: ExtensionAction, opts?: { ownerShare?: boolean; stepAction?: ExtensionAction }) => {
    if (origin === 'null' || entry.sites[origin] === 'allow' || entry.taskL1.has(origin)) return;
    // SABLE-B 5.1/5.4: only the owner's Share runs without a call scope; a dead scope writes nothing; another step's check holds the binding.
    if (!scope && !opts?.ownerShare) fail('binding_inactive');
    if (scope && !live(entry, scope)) fail('binding_inactive');
    // SABLE-B 5.4 locks the bot's own steps; the owner's Share is not a step (row 18, test 48: O is granted while a call's site card is open).
    if (!opts?.ownerShare) { const held = heldBy(entry); if (held && held.action !== (action ?? opts?.stepAction)) fail('binding_busy'); }
    if (entry.sites[origin] === 'never') fail('site_denied');
    // EXT-RESTART 4.1 (ruling 3, test 20): a Never-by-default site the owner has not lifted in this process is refused before any site
    // card, with the line decide() gives it. A card here could only lead to a refusal, and a saved Allow on disk does not lift it.
    { let hostname = ''; try { hostname = new URL(origin).hostname; } catch { /* not a URL: the card path below decides */ }
      if (hostname && siteCategory(entry, origin, hostname).category === 'neverDefault') throw refusal('NOT DONE: This site is for the owner in person or is set to Never, so the action is refused.'); }
    if (routineOf(entry)) fail('site_consent_required');
    const askSite = options.askSite ?? (() => fail('site_consent_required'));
    const generation = entry.context.generation, epoch = entry.siteEpoch;
    taskOf(entry);
    // M8: the saved file holds at most MAX_STORED_GRANTS sites for a task; refuse the next one now rather than write a file the next start rejects.
    if (entry.taskL1.size >= MAX_STORED_GRANTS) fail('site_consent_required');
    // SABLE-B 4.2: inside a call the mode is the call's snapshot; the owner's Share reads it live.
    let full = fullAllowsNewSite(entry, origin, scope ? scope.fence.mode : options.approvalMode?.({ ...entry.context }) ?? 'step');
    // SABLE-B 1/4 (K1): under attended Full a destination is granted automatically only for a step predicted to pass with no card.
    // A page consent (scope, no action) is the page the bot is on (section 8): granted without a prediction, as base.
    if (full && action && scope) {
      const held = heldBy(entry); const step: Step = held && held.action === action ? held : { scope, action };
      step.inputs ??= stepInputs(entry, action, scope.fence, scope.admitted);
      full = !(await wouldCard(entry, action, step.inputs, scope));
    }
    // T22: an Allow the owner gave after the wait is used once, here, where the card would have been raised.
    const binding = siteBinding(entry, origin);
    const earlier = !full && options.consumeApproval?.({ ...entry.context }, { kind: 'site', binding }) === true;
    const access = full || earlier ? 'allow' as const : await askSite({ ...entry.context }, origin, binding);
    if (scope && !live(entry, scope)) fail('stale_binding');
    // An answer to an old card never overwrites what the owner set since, or acts for a changed binding or a task that ended.
    if (!active(entry) || generation !== entry.context.generation || epoch !== entry.siteEpoch) fail('stale_binding');
    if (access === 'waiting') throw refusal(WAITING_TEXT, true);
    if (access !== 'allow') { if (access === 'never') await applySite(entry, origin, access); fail('site_denied'); }
    entry.taskL1.add(origin); policy.setSiteAccess(entry.context, origin, 'allow');
    // H2: Full permissive's automatic grant is not the owner's grant, so intent rule I1 does not count it as a site the owner named.
    if (full) (entry.autoL1 ??= new Set()).add(origin); else entry.autoL1?.delete(origin);
    if (full) { try { recordBrowserActivity({ botId: entry.context.botId, bindingId: entry.context.bindingId, taskId: entry.context.threadId, site: new URL(origin).host, action: 'allow site', level: 1, decision: 'Full permissive', decidedBy: 'full-permissive', outcome: 'done' }); } catch { /* the log is best effort */ } }
    try { if (online(entry)) await bind(entry); await persist().catch(() => {}); }
    // SABLE-B 5.6 failClosed: P2. The undo runs synchronously in the failure's tick, then the task fails closed for the owner.
    catch { entry.taskL1.delete(origin); entry.autoL1?.delete(origin); try { policy.setSiteAccess(entry.context, origin, entry.sites[origin] ?? 'ask'); } catch { /* none held */ } await failClosed(entry, origin); throw refusal(GRANT_FAILED_TEXT, true); }
  };
  /** The owner approved the first Level 2 card on this site in Allow for this task mode: later Level 2 steps here are silent. */
  const mintL2 = (entry: Entry, origin: string) => {
    if (routineOf(entry) || !entry.task || origin === 'null' || !(entry.taskL1.has(origin) || entry.sites[origin] === 'allow')) return;
    entry.taskL2.add(origin);
    try { policy.grantL2(entry.context, origin); } catch { entry.taskL2.delete(origin); }
    savedSoon();
  };
  /** Allow always is a Level 1 and Level 2 grant from the start of every task. */
  const alwaysL2 = (entry: Entry, origin: string) => { if (entry.sites[origin] === 'allow') { try { policy.grantL2(entry.context, origin); } catch { /* the policy refuses: the card stays */ } } };
  /** End the task (spec 2.4): grants, pending answers and in-flight authority all end, the extension is told the new approved set
   * (L12: a failed bind pauses the binding), and the end-of-task signal fires once. Ending what is not running does nothing. */
  const endTask = async (entry: Entry, reason: TaskEndReason) => {
    const task = entry.task;
    if (!task && !entry.taskL1.size && !entry.taskL2.size) return;
    const origins = [...entry.taskL1];
    entry.task = undefined; entry.taskL1.clear(); entry.taskL2.clear(); entry.autoL1?.clear();
    // M3: the owner's instruction this task belonged to cannot start another one. Only a new owner message (or a routine's own start) does.
    if (['owner', 'idle', 'limit'].includes(reason)) entry.endedFor = { id: options.ownerInstruction?.({ ...entry.context })?.id, reason };
    entry.revision++; entry.siteEpoch++; entry.taskEnded = true; entry.taskEndReason = reason;
    try { policy.revokeL2(entry.context); } catch { /* none held */ }
    for (const origin of origins) { if (entry.sites[origin] !== 'allow') { try { policy.setSiteAccess(entry.context, origin, entry.sites[origin] ?? 'ask'); } catch { /* nothing to take back */ } } }
    if (task) { try { options.onTaskEnded?.({ context: { ...entry.context }, taskId: task.taskId, reason }); } catch { /* telling the owner is best effort */ } }
    // The file must not keep grants the task no longer has: a restart would bring them back.
    // Round 10 (R10-03): the extension is told before the file is written (the write still happens if the bind fails).
    try { if (origins.length && ['owner', 'idle', 'limit', 'routine'].includes(reason) && entry.state === 'active') await rebind(entry); }
    finally { await persist().catch(() => {}); }
  };
  /** Idle for 30 minutes, or 8 hours since it began: the task is over. */
  const expireDue = async (entry: Entry) => {
    const task = entry.task; if (!task) return;
    const at = now();
    if (at - task.startedAt >= TASK_LIMIT_MS) await endTask(entry, 'limit');
    // The idle clock runs only while the binding is active: a pause (the owner's, or a Your turn) is not the bot being idle.
    else if (entry.state === 'active' && at - task.lastAt >= TASK_IDLE_MS) await endTask(entry, 'idle');
  };
  const documentFor=async(entry:Entry,tabId?:number)=>{await refresh(entry);if(!active(entry))throw authorizationError(entry);const document=entry.documents.get(tabId??entry.selectedTabId??-1)??(tabId===undefined?entry.documents.values().next().value:undefined);return structuredClone(document??fail('tab_not_shared'));};
  // A dialog answer is the one command that must not wait in the profile's queue: the command ahead of it (the click that opened the dialog) is blocked until it is answered.
  const send=async(entry:Entry,method:string,params:Record<string,unknown>,document:ExtensionDocument,scope?:Scope)=>(method==='Page.handleJavaScriptDialog'?(op:()=>Promise<any>)=>op():(op:()=>Promise<any>)=>enqueue(entry,op))(async()=>{
    // SABLE-B 5.2 (fixer r1): a command that carries its call's scope (newTab's Page.navigate) may wait in the profile queue behind another
    // binding; it is checked live again here, right before it writes navigation or request state, so a call that died meanwhile sends nothing.
    if(scope!==undefined&&!live(entry,scope))throw active(entry)?Object.assign(Error('binding_inactive'),{code:'binding_inactive'}):authorizationError(entry);
    if(!active(entry))throw authorizationError(entry);const current=entry.documents.get(document.tabId);
    if(!current||current.navigationEpoch!==document.navigationEpoch||current.origin!==document.origin)fail('stale_document');
    if(method==='Page.navigate'&&typeof params.url==='string')entry.navigation={tabId:document.tabId,url:canonicalOr(params.url)};
    else if(method==='Page.reload')entry.navigation={tabId:document.tabId,url:document.url};
    // The first page-changing input of an admitted mutation counts as done only
    // once the extension accepted it (or its outcome is uncertain). A refusal
    // (takeover, Stop, stale generation) never becomes "carried out".
    const effect=entry.busy&&entry.mutationLease&&!entry.effect&&pageEffect(method,params)?{tabId:document.tabId,navigationEpoch:document.navigationEpoch,origin:document.origin}:undefined;
    let value:{result:unknown;tabId:number;navigationEpoch:number;origin:string};
    try{value=await request(entry,'cdp',{method,params:params as ExtensionObject,tabId:document.tabId,navigationEpoch:document.navigationEpoch},browserCommandDeadlineMs(method,params)+5000) as {result:unknown;tabId:number;navigationEpoch:number;origin:string};}
    catch(error){if(effect&&(error as {code?:string}).code==='uncertain')entry.effect=effect;throw error;}
    if(effect)entry.effect=effect;
    if(!active(entry))throw authorizationError(entry);if(!value||value.tabId!==document.tabId||value.navigationEpoch<document.navigationEpoch)fail('invalid_runtime_document');
    if(value.navigationEpoch!==document.navigationEpoch||(value.origin||'null')!==document.origin){await refresh(entry);if(!['Page.navigate','Page.reload','Page.navigateToHistoryEntry'].includes(method))fail('stale_document');}
    return value.result;
  });
  // After an admitted input reached the page, a navigation of that tab fences
  // the rest of the action (the old approval never carries over), but the bot
  // is told what really happened instead of a bare authority failure.
  const navigatedAfterEffect=async(entry:Entry,name:unknown)=>{
    const effect=entry.effect;if(!effect)return undefined;
    let summary:Summary;try{summary=await request(entry,'status') as Summary;}catch{return undefined;}
    const tab=Array.isArray(summary?.tabs)?summary.tabs.find(item=>item.tabId===effect.tabId):undefined;
    if(!tab||!Number.isSafeInteger(tab.navigationEpoch)||tab.navigationEpoch<=effect.navigationEpoch)return undefined;
    let origin='';try{origin=typeof tab.origin==='string'&&tab.origin?new URL(tab.origin).origin:'';}catch{origin='';}
    let url='';try{url=typeof tab.url==='string'&&tab.url&&new URL(tab.url).origin===origin?new URL(tab.url).href:'';}catch{url='';}
    const approved=!!origin&&(entry.sites[origin]==='allow'||entry.taskL1.has(origin));
    const action=typeof name==='string'?name.replace(/^agent_browser_/,'').replaceAll('_',' '):'action';
    const where=url||origin||'a new page';
    const lines=[`The ${action} was carried out and the page then navigated to ${where}.`];
    if(summary.state==='stopped'||entry.state==='stopped')lines.push('Browser control was stopped by the owner. Do not continue in the browser unless the owner resumes it.');
    else if(!approved&&origin)lines.push(`${origin} is not approved for this bot, so browser control is paused. Ask the owner to approve that site and resume browser control before you continue.`);
    else if(summary.state!=='active')lines.push('Browser control is paused. Ask the owner to resume it before you continue.');
    else lines.push(`${origin!==effect.origin?'This is a different site. ':''}Take a new snapshot before the next action; references from the previous page no longer apply.`);
    return{content:[{type:'text',text:lines.join(' '),murage:true}]};
  };
  const withNotices = (entry: Entry, output: unknown) => {
    if (!entry.notices.length || !output || typeof output !== 'object' || !Array.isArray((output as { content?: unknown }).content)) return output;
    const text = entry.notices.splice(0).join(' ');
    return { ...(output as object), content: [{ type: 'text', text, murage: true }, ...(output as { content: unknown[] }).content] };
  };
  /** The one way a tool result leaves `dispatch` (T23W). Every text a page could have influenced is probed for instruction-like
   * text and then fenced as data; Murage's own sentences (flagged by whoever wrote them) stay plain. */
  const deliver = (entry: Entry, method: unknown, output: unknown, fromPage: boolean) => {
    const name = String(method).replace(/^agent_browser_/, '');
    const document = entry.documents.get(entry.selectedTabId ?? -1) ?? entry.documents.values().next().value;
    const origin = document?.origin ?? 'unknown';
    let warning = false;
    if (fromPage && output && typeof output === 'object' && Array.isArray((output as { content?: unknown }).content)) {
      const task = taskOf(entry);
      for (const item of (output as { content: { text?: unknown; origin?: unknown }[] }).content) {
        if (!item || typeof item.text !== 'string') continue;
        // M9: a read of another site carries that site's origin; its text is filed under it, so I5 sees the carry.
        const itemOrigin = typeof item.origin === 'string' && item.origin ? item.origin : origin;
        const found = probeText(item.text);
        if (found.flagged) { probe.record(entry.context.bindingId, found); warning = true; }
        try { readEntriesOf(item.text, task.readOrigins.get(itemOrigin) ?? task.readOrigins.set(itemOrigin, new Set()).get(itemOrigin)!); } catch { /* the I5 memory is best effort; I5 then sees less, never more */ }
      }
    }
    const withWarning = warning && output && typeof output === 'object' && Array.isArray((output as { content?: unknown }).content)
      ? { ...(output as object), content: [{ type: 'text', text: PROBE_WARNING_LINE, murage: true }, ...(output as { content: unknown[] }).content] } : output;
    const noticed = withNotices(entry, withWarning);
    if (!noticed || typeof noticed !== 'object' || !Array.isArray((noticed as { content?: unknown }).content)) return noticed;
    const { structuredContent: _dropped, ...rest } = noticed as { structuredContent?: unknown; content: Record<string, unknown>[] };
    // SEC-006: every text a page could have influenced goes through OUT's redactor before the fence; Murage's own sentences stay as written.
    const redacted = rest.content.map(item => item && typeof item === 'object' && item.murage !== true && typeof item.text === 'string' ? { ...item, text: redactPageOutput(item.text) } : item);
    const fenced = fenceToolResult({ ...rest, content: redacted.map(item => item && typeof item === 'object' && item.origin === undefined ? { ...item, origin, ...(item.kind === undefined ? { kind: name || 'text' } : {}) } : item) } as never, name || 'text') as { content: Record<string, unknown>[] };
    // Fence bookkeeping never reaches the model.
    return { ...fenced, content: fenced.content.map(item => { if (!item || typeof item !== 'object') return item; const { murage: _m, murageLead: _l, origin: _o, kind: _k, ...plain } = item; return plain; }) };
  };
  const ownedTransition=async(entry:Entry,operation:'tab_new'|'tab_switch'|'tab_close',params:ExtensionObject)=>{
    const revision=entry.revision,generation=entry.context.generation;
    if(!active(entry))fail('binding_inactive');const summary=await request(entry,operation,params);
    if(entry.revision!==revision||entry.context.generation!==generation||!active(entry))fail('stale_binding');
    await reconcile(entry,summary);
    if(entry.fence){entry.fence.generation=entry.context.generation;entry.fence.revision=entry.revision;}
  };
  /** The panel shows one short sentence: the note cut at a sentence end that fits. */
  const oneSentence = (note: string) => { const text = note.replace(/\s+/g, ' ').trim(); if (text.length <= 200) return text; const cut = text.slice(0, 200); const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! ')); return end > 40 ? cut.slice(0, end + 1) : cut.slice(0, 199) + '.'; };
  /** Pause a task (owner Pause or the floor's hand-off) and fence it, so nothing more runs until the owner resumes. */
  const pauseEntry = async (entry: Entry, reason?: PausedReason) => {
    if (entry.state === 'stopped') fail('stopped');
    entry.state = 'paused'; if (reason) entry.pausedReason = reason; entry.revision++;
    const g0 = entry.context.generation;   // EXT-RESTART 3.3b: the generation this Pause frame carries
    // Round 10 (R10-03): the extension is fenced FIRST. The owner's Pause never waits on a disk write, and a failed write leaves it fenced.
    let summary: unknown; let failure: unknown; let asked = false;
    if (online(entry)) { asked = true; try { summary = await request(entry, 'pause', reason === 'handoff' ? { reason: 'handoff', handoff: oneSentence(entry.handoffNote ?? '') } : {}); } catch (error) { failure = error; } }
    if (failure) { await settleRefusedPause(entry, g0, failure); await persist().catch(() => {}); throw failure; }
    if (asked) await reconcile(entry, summary, false, reason); else await persist();
  };
  const refusal = (text: string, recorded = false) => Object.assign(new Error(text), { code: 'browser_extension_refused', status: 409, ...(recorded ? { recorded: true } : {}) });
  const sensitiveField = (f?: FloorFacts) => !!f && (f.type === 'password' || f.wasPassword === true || /(^|\s)(cc-|one-time-code|current-password|new-password)/.test(f.autocomplete ?? '') || f.signatures?.payment === true);
  /** Spec 2.3: the site's category with the owner's own change applied. The owner may lower one ask-every-step site, or allow one
   * Never-by-default site. Nothing moves a handover-only site. Read per action from the saved rule. */
  const siteCategory = (entry: Entry, origin: string, hostname: string) => {
    let setting: { rule: SiteAccess; lowered?: boolean } | undefined; try { setting = options.siteSetting?.({ ...entry.context }, origin); } catch { setting = undefined; }
    let category = categoryFor(hostname);
    if (category === 'askEveryStep' && setting?.rule === 'ask' && setting.lowered === true) category = 'normal';
    // EXT-RESTART 4.1 (ruling 3): nothing loosens from disk. Only this process's per-binding Allow, or the Settings raise for this running task, lifts it.
    else if (category === 'neverDefault' && (entry.sites[origin] === 'allow' || (entry.taskL1.has(origin) && entry.task?.lifted?.has(origin) === true))) category = 'normal';
    return { category, setting };
  };
  /** Full permissive (spec 2.2): a new site of a normal category is allowed for this task without a card. Never for a routine, for a
   * site set to Never, or for a category that still asks or refuses. The mode is read here, once, and nothing else reads it. */
  const fullAllowsNewSite = (entry: Entry, origin: string, mode: ApprovalMode): boolean => {
    if (routineOf(entry) || mode !== 'full') return false;
    // SABLE-LIVE-B: attended Full no longer needs an action check for a new normal site; decide() keeps Full the same way.
    let hostname = ''; try { hostname = new URL(origin).hostname; } catch { return false; }
    const { category, setting } = siteCategory(entry, origin, hostname);
    return category === 'normal' && entry.sites[origin] !== 'never' && setting?.rule !== 'never';
  };
  /** The one decision for an action about to be admitted (T23W): floor, level, I-rules, checker, mode and grants. */
  const decideFor = async (entry: Entry, action: ExtensionAction, inputs: StepInputs, snap: Fence, opts: { predict?: boolean; alive?: () => boolean } = {}): Promise<Decision & { mode: ApprovalMode; recipientUnknown: boolean }> => {
    // SABLE-B 4: instruction, mode and the probe flag come from the call's snapshot; ownerRequested, disclosed and conversationApproved from
    // the step's inputs (the prediction and the decision read the same object). Predicting runs no checker, so it writes no tally.
    const { operation, disclosed, ownerRequested } = inputs;
    const task = taskOf(entry);
    const name = action.name.replace(/^agent_browser_/, '');
    const origin = action.document.origin;
    const { visibility: observedVisibility, ...collected } = (action.facts ?? {}) as FloorFacts & { visibility?: Visibility };
    // Dialog facts describe the modal question, not an element on the page.
    const dialogAnswer = name === 'dialog_accept' || name === 'dialog_dismiss';
    const visibility = dialogAnswer ? undefined : observedVisibility;
    const facts = (action.facts ? { ...collected, operation: name } : { operation: name, ...(operation !== 'mutation' ? { navigationCarriesNovelData: disclosed } : {}) }) as LevelFacts;
    const floor = classifyFloor(facts);
    const instruction = snap.instruction;
    const modeNow: ApprovalMode = snap.mode;
    const sites = new Set<string>([origin, ...Object.entries(entry.sites).filter(([, access]) => access === 'allow').map(([site]) => site), ...[...entry.taskL1].filter(site => !(modeNow === 'full' && entry.autoL1?.has(site))), ...(modeNow === 'full' ? inputs.admitted : [])]);
    // The owner's own words and a link or form the page presented from a task page name a site; Full's automatic grant does not.
    if (typeof action.arguments.url === 'string' && (ownerRequested || action.presentedLink)) { try { sites.add(new URL(action.arguments.url).origin); } catch { /* not a URL: not named */ } }
    const typed = typeof action.arguments.text === 'string' ? action.arguments.text : undefined;
    const destination = typeof action.arguments.url === 'string' ? action.arguments.url : undefined;
    const wiring = opts.predict ? undefined : options.checker?.({ ...entry.context });
    let hostname = ''; try { hostname = new URL(origin).hostname; } catch { /* unsure: the category asks at every step */ }
    const { category, setting } = siteCategory(entry, origin, hostname);
    const mode: ApprovalMode = snap.mode;
    // A completed native inventory or a positive composer classification can bind an owner-approved conversation; a routine never has one.
    const convo = (facts.recipientNoField || facts.recipientComposer) && !routineOf(entry) ? conversationOf(action.document) : undefined;
    const chatFacts = (facts.recipientNoField || facts.recipientComposer) ? { recipientNoField: facts.recipientNoField, recipientComposer: facts.recipientComposer, ...(convo ? { conversationEligible: true } : {}), ...(convo && inputs.conversationApproved ? { conversationApproved: true } : {}) } : {};
    return Object.assign(await decide({
      bindingActive: active(entry), ownerAudience: entry.authorize?.() ?? true, siteAccess: entry.sites[origin] === 'never' || setting?.rule === 'never' ? 'never' : 'allow', category,
      clipboard: false, floor: floor.floor ? floor : null, operation: name, ...(typeof facts.key === 'string' ? { key: facts.key } : {}), facts,
      ...(typed !== undefined ? { textHasNewline: /[\r\n]/.test(typed) } : {}),
      mode, routine: routineOf(entry), grants: { l1: origin === 'null' || entry.sites[origin] === 'allow' || entry.taskL1.has(origin), l2: entry.taskL2.has(origin) }, siteAllowedAlways: entry.sites[origin] === 'allow',
      probeFlagged: snap.probeFlagged, ...(opts.alive ? { alive: opts.alive } : {}),
      intent: {
        ownerWords: instruction ? [instruction.text] : [], taskSites: sites, readOrigins: task.readOrigins, counters: task.counters, typedHistory: task.typedHistory,
        ...(visibility ? { visibility } : {}),
        action: { operation: operation === 'navigate' ? 'navigate' : name, sendCapable: facts.sendCapable, origin, ...(destination ? { destination } : {}), ...(typed !== undefined ? { typedText: typed } : {}), ...(withoutSecretValues(facts.recipients).length ? { recipients: withoutSecretValues(facts.recipients) } : {}), ...(facts.recipientScanFailed ? { recipientScanFailed: true } : {}), ...chatFacts, hasTarget: !dialogAnswer && action.facts !== undefined,
          ...(ownerRequested ? { ownerRequested } : {}), ...(entry.pageRead ? { pageDataRead: true } : {}), ...(action.presentedLink ? { presentedLink: true } : {}), currentUrl: action.document.url },
      },
      ...(wiring ? { checker: { deps: wiring.deps, tally: task.tally, input: { ownerInstruction: instruction?.text ?? '', siteGrant: entry.sites[origin] === 'allow' ? 'allowed always for this bot' : 'allowed for this browser task',
        action: { operation: name, site: origin, ...(collected.role || collected.tag ? { targetRole: String(collected.role || collected.tag) } : {}), ...(action.target ? { targetName: action.target } : {}),
          ...(typed !== undefined ? { typedTextLength: typed.length, typedTextExcerpt: typed.slice(0, 200), isSend: true } : {}), ...(sensitiveField(collected) ? { sensitiveField: true } : {}), ...(destination ? { destinationUrl: destination } : {}) } } } } : {}),
    }), { mode, recipientUnknown: recipientUnknown({ ...facts, ...chatFacts, operation: name }) });
  };
  /** SABLE-B 4: the step's inputs, pure, computed once per step. The prediction and the decision read this same object. */
  const stepInputs = (entry: Entry, action: ExtensionAction, snap: Fence, admitted: Set<string>): StepInputs => {
    const destination = typeof action.arguments.url === 'string' ? action.arguments.url : undefined;
    const operation = NAVIGATE_NAMES.includes(action.name) ? 'navigate' as const : action.mutation ? 'mutation' as const : 'read' as const;
    const instruction = destination && !action.mutation && (operation === 'navigate' || action.name === 'agent_browser_read') ? snap.instruction : undefined;
    const ownerRequested = !!instruction && snap.freeNavigation !== instruction.id && (instructionNames(instruction.text, destination!) || (action.presentedLink === true && searchPage(action.document.url)));
    const disclosed = operation !== 'mutation' && !!destination && navigationCarriesData({ operation, level: 'L1', origin: action.document.origin, destination, currentUrl: action.document.url, ...(ownerRequested ? { ownerRequested: true } : {}), ...(entry.pageRead ? { pageDataRead: true } : {}), ...(action.presentedLink === true ? { presentedLink: true } : {}) });
    const convo = conversationOf(action.document);
    const conversationApproved = operation === 'mutation' && !!convo && entry.task?.chats.get(convo.origin)?.has(convo.path) === true && keepsConversation(entry, action) !== 'no';
    return { ...(destination ? { destination } : {}), operation, ...(instruction ? { instruction } : {}), ownerRequested, disclosed, conversationApproved, admitted };
  };
  /** SABLE-B 4.1: wouldCard false => under the same live scope the admission's decision is pass, a refusal, the floor or a pause, never a card. */
  const wouldCard = async (entry: Entry, action: ExtensionAction, inputs: StepInputs, scope: Scope) => (await decideFor(entry, action, inputs, scope.fence, { predict: true })).outcome !== 'pass';
  const makeExecutor = (entry: Entry) => {
    const transport={document:(tabId?:number)=>documentFor(entry,tabId),send:(method:string,params:Record<string,unknown>,document:ExtensionDocument)=>send(entry,method,params,document)};
    const site=(document:ExtensionDocument)=>{try{return new URL(document.url).host||document.origin;}catch{return document.origin;}};
    const record=(action:{name:string;document:ExtensionDocument;mutation:boolean;target?:string;fromPage?:boolean;textLength?:number},decision:BrowserActivityDecision,decidedBy:BrowserActivityDecider,outcome:BrowserActivityOutcome,level?:1|2|3)=>{
      recordBrowserActivity({botId:entry.context.botId,bindingId:entry.context.bindingId,taskId:entry.context.threadId,site:site(action.document),action:action.name.replace(/^agent_browser_/,''),...(action.target?{target:action.target,fromPage:action.fromPage===true}:{}),level:level??(action.mutation?2:1),decision,decidedBy,outcome,...(action.textLength!==undefined?{textLength:action.textLength}:{})});
    };
    /** SABLE-B 5.5 R4: a Your-turn pause retry runs only while the call still owns the scope and the first attempt's pause still stands. */
    const retryOk=(scope:Scope|undefined,rev:number)=>owned(entry,scope)&&entry.state==='paused'&&entry.pausedReason==='handoff'&&entry.revision===rev;
    const admitAction=async(action:ExtensionAction,scope:Scope|undefined,token?:Step):Promise<boolean>=>{
        // SABLE-B 7.2/5.4: a dead scope admits nothing. The caller took the step lock and passes its token; only a dialog answered during
        // this call's own read comes without one (5.4 r6) and uses its own local step.
        if(!live(entry,scope))fail('binding_inactive');
        const snap=scope!.fence;
        let step:Step;
        if(token){if(token.action!==action)fail('binding_busy');step=token;}
        else{if(heldBy(entry)&&!['agent_browser_dialog_accept','agent_browser_dialog_dismiss'].includes(action.name))fail('binding_busy');step={scope:scope!,action};}
        const destination=typeof action.arguments.url==='string'?action.arguments.url:undefined;
        if(action.document.url==='about:blank'&&['agent_browser_tab_list','agent_browser_tab_close','agent_browser_close','agent_browser_tab_switch','agent_browser_tab_new'].includes(action.name)&&!destination)return live(entry,scope);
        // SABLE-B 4: the inputs the prediction computed (the same object), or computed once here when no prediction ran.
        const inputs=step.inputs??=stepInputs(entry,action,snap,scope!.admitted);
        const operation=inputs.operation;
        // Level 1: the first navigation the owner's task asked for (the address in the owner's instruction, or a
        // result a search page shows) needs no card. One per instruction; everything else keeps its card.
        const instruction=inputs.instruction,ownerRequested=inputs.ownerRequested;
        let policyAction:BrowserAction={operation,document:policyDocument(action.document),targetDigest:action.digest,params:action.arguments,...(destination?{destination}:{}),...(entry.pageRead?{pageDataRead:true}:{}),...(action.presentedLink?{presentedLink:true}:{}),...(ownerRequested?{ownerRequested:true}:{})};const context={...entry.context};let checked=policy.check(context,policyAction);let approvalId:string|undefined;
        // T23W: one decision. The policy's own rule and the decision can each ask for a card; neither can remove the other's.
        // An approved conversation covers typing in the composer and the send, and nothing else the bot does on the tab. Any other click,
        // select, press or open may have moved the page to another conversation without its URL changing (a Gmail Chat pop-up, Teams'
        // client state), so it ends the approval before this step is decided; the next send cards again.
        if(operation==='navigate')taskOf(entry).chats.clear();
        let keep:'yes'|'maybe'|'no'='no',coveredBefore=false;
        if(operation==='mutation'){
          keep=keepsConversation(entry,action);
          const convoNow=conversationOf(action.document);coveredBefore=!!convoNow&&entry.task?.chats.get(convoNow.origin)?.has(convoNow.path)===true;
          if(keep==='no')taskOf(entry).chats.delete(action.document.origin);
        }
        const checkerBefore=options.checker?.({...entry.context});
        const decision=await decideFor(entry,action,inputs,snap,{alive:()=>live(entry,scope)});
        // SEC-03: the owner may change the mode or the action check while the checker is thinking. An answer reached under the old settings never
        // carries its authority across the change: the step is refused and asked again under the new ones.
        {const nowMode:ApprovalMode=options.approvalMode?.({...entry.context})??'step',checkerNow=options.checker?.({...entry.context});
          if(!active(entry)||!live(entry,scope)||nowMode!==decision.mode||!!checkerNow!==!!checkerBefore||(checkerNow?.key!==undefined||checkerBefore?.key!==undefined?checkerNow?.key!==checkerBefore?.key:checkerNow?.deps.transport!==checkerBefore?.deps.transport))throw refusal("NOT DONE: The owner changed this browser's approval settings while the step was being checked. Try the step again.",true);}
        // A click or a press keeps the approval only when it was the send itself: classed Level 3 and covered by the approved conversation.
        if(keep==='maybe'&&!(decision.level==='L3'&&coveredBefore))taskOf(entry).chats.delete(action.document.origin);
        // T20: a Level 2 step on a site that holds an L2 grant (or is Allow always) needs no approval token. The decision above
        // has already said whether a card is still due; this only stops the policy asking for a second one it cannot justify.
        if(decision.level==='L2'&&checked.mutation&&(decision.outcome==='pass'||decision.outcome==='card')){alwaysL2(entry,action.document.origin);policyAction={...policyAction,level:'L2'};checked=policy.check(context,policyAction);}
        const levelNumber=decision.level==='L1'?1:decision.level==='L3'?3:decision.level==='L2'?2:undefined;
        if(decision.outcome==='floor'){
          const text='YOUR TURN: this step needs the owner. Murage has asked them. End your turn now and wait. Do not try another way to do this step.';
          record(action,'your turn','policy','handed over',levelNumber);entry.handoffText=text;
          const host=site(action.document),bot=options.botName?.({...entry.context})??'Your bot';entry.handoffNote=yourTurnNote(bot,host,null);
          let released=true;const first=pauseEntry(entry,'handoff'),rev=entry.revision;
          // SABLE-B 5.5 R4: the retry runs only if the first attempt's pause still stands and nothing changed since (no Continue in between).
          try{await first;}catch{if(!retryOk(scope,rev))throw refusal(text,true);try{await pauseEntry(entry,'handoff');}catch{released=false;}}
          if(!released){try{options.onHandoffFailed?.({context:{...entry.context},site:host,text:HANDOFF_FAILED_TEXT});}catch{/* telling the owner is best effort */}throw refusal(text,true);}/* the binding is marked paused and the refusal stands, but the owner is never told to type into a tab Murage could not let go of: they are told to press Stop */
          try{options.onHandoff?.({context:{...entry.context},site:host,category:null,unsure:true,text:yourTurnNote(bot,host,null),phrase:''});}catch{/* telling the owner is best effort */}
          throw refusal(text,true);
        }
        if(decision.outcome==='refuse'||decision.outcome==='skip'){
          if(decision.decidedBy==='intent'&&decision.recipientUnknown === true)taskOf(entry).counters.hits++;
          record(action,'not done',decision.decidedBy==='checker'?'checker':'policy','denied',levelNumber);
          throw refusal(`NOT DONE: ${decision.line??decision.reason}${decision.outcome==='skip'?' Tell the owner and continue without it.':''}`,true);
        }
        if(decision.outcome==='pause'){
          // The action check stopped this task (three steps in a row, or twenty). The task is paused for the owner as a Your turn
          // with a Continue: they look at what it was doing, then press Continue or Stop. The note is a durable message, not a toast.
          const text=`YOUR TURN: ${DECIDE_LINES.blocked} Murage has asked the owner. End your turn now and wait. Do not try another way to do this step.`;
          record(action,'your turn','checker','handed over',levelNumber);entry.handoffText=text;
          const host=site(action.document),bot=options.botName?.({...entry.context})??'Your bot';entry.handoffNote=checkerYourTurnNote(bot,host);
          try{await pauseEntry(entry,'handoff');}catch{/* the binding is already marked paused; the refusal still stands */}
          try{options.onHandoff?.({context:{...entry.context},site:host,category:null,unsure:true,text:checkerYourTurnNote(bot,host),phrase:'',reason:'checker'});}catch{/* telling the owner is best effort */}
          throw refusal(text,true);
        }
        // T21: Full permissive. The decision has passed the floor, the intent check and (for Level 3) the checker's allow, and said
        // no card. The step still needs its one-use approval for the policy's lease, so the service issues it here, in place of a
        // card, for an attended mutation only (a navigation that carries data and a routine keep their own card paths).
        let fullPass=false;
        if(decision.mode==='full'&&decision.outcome==='pass'&&(operation==='mutation'||operation==='navigate')&&!routineOf(entry)&&checked.requiresApproval&&(decision.level==='L2'||decision.level==='L3'||(operation==='navigate'&&decision.level==='L1'))){approvalId=policy.issueApproval(context,policyAction);fullPass=true;}
        const carded=decision.outcome==='card'||decision.outcome==='site-card';
        if(decision.decidedBy==='intent'&&carded&&decision.recipientUnknown === true)taskOf(entry).counters.hits++;
        if((checked.requiresApproval&&!fullPass)||carded){
          const lead=[decision.line,decision.checkerNote].filter(Boolean).join('\n');
          // D1: deleting, and sending to a recipient the owner never named, are asked every time in every mode; the card says so.
          const cardKind:'delete'|'newRecipient'|undefined=decision.rule==='owner-confirmation'?'delete':decision.line?.includes(INTENT_LINES.I2('').split(':')[0])&&action.facts?.recipients?.length?'newRecipient':undefined;
          const shown={...action,...(cardKind?{cardKind}:{}),...(lead?{summary:`${lead}\n${action.summary}`}:{})};
          // T22: an Allow the owner gave after the wait is used once, here. This is the only place it can act, after the floor, the intent
          // check and the checker have all had their say, so it can never lift any of them.
          // M1: the owner's Allow answers the card as they read it. What this attempt shows (the rule, the lines and the checker's note) is
          // part of what the approval is bound to, so a late Allow never covers a checker answer or intent line that was not on the card.
          const base=actionBinding(entry,action);
          const binding:ApprovalBinding={...base,submissionDigest:digestOf(['card',base.submissionDigest,decision.outcome,decision.decidedBy,decision.rule??null,decision.line??null,decision.checkerNote??null])};
          if(options.consumeApproval?.(context,{kind:'action',binding})!==true){
            const answer=options.askAction?await options.askAction(context,shown,binding):false;
            if(!live(entry,scope))fail('stale_binding');
            if(answer==='waiting'){record(action,'not done','owner','waiting',levelNumber);throw refusal(WAITING_TEXT,true);}
            if(!answer){record(action,'you denied','owner','denied',levelNumber);return false;}
          }
          // Only the owner's own Allow on a card that said "could not check who this goes to" for a chat composer approves the conversation.
          if(decision.decidedBy==='intent'&&carded&&(action.facts?.recipientNoField===true||action.facts?.recipientComposer===true)&&!routineOf(entry)&&decision.line?.includes(INTENT_LINES.I2_UNKNOWN)){
            const convo=conversationOf(action.document);
            if(convo){const task=taskOf(entry);const paths=task.chats.get(convo.origin)??task.chats.set(convo.origin,new Set()).get(convo.origin)!;if(paths.size<64)paths.add(convo.path);
              // Murage's own record of the composer: the element the bot last typed into on this origin (or the key press itself), if it is one.
              const sendName=action.name.replace(/^agent_browser_/,'');const typedInto=task.lastTyped.get(convo.origin);
              const sendKey=nodeKey(action);const pressed=sendName==='press'&&composerLike(action);
              const composer=sendName==='press'?(pressed?targetId(action):null):(typedInto?.composer?typedInto.id:null);
              const composerNode=sendName==='press'?(pressed?sendKey:null):(typedInto?.composer?typedInto.node:null);
              task.chatIds.set(convo.origin,{composer,send:targetId(action),composerNode,sendNode:sendKey});}
          }
          if(decision.decidedBy==='intent'&&destination){try{entry.autoL1?.delete(new URL(destination).origin);}catch{/* not a URL */}}
          if(!active(entry)||entry.context.generation!==context.generation)fail('stale_binding');await refresh(entry);if(!live(entry,scope))fail('stale_binding');
          if(decision.level==='L2'&&(decision.rule==='l2-first'||decision.rule==='tightened')&&options.approvalMode?.({...entry.context})==='task'){mintL2(entry,action.document.origin);checked=policy.check(context,policyAction);}
          if(checked.requiresApproval)approvalId=policy.issueApproval(context,policyAction);
        }
        if(!live(entry,scope))fail('binding_inactive');
        if(entry.mutationLease&&checked.mutation){if(checked.requiresApproval){if(!approvalId)return fail('action_approval_required');policy.consumeApproval(context,policyAction,approvalId);}}
        else{const release=policy.authorizeDispatch(context,policyAction,approvalId);const previous=entry.release;entry.release=()=>{release();previous?.();};if(checked.mutation)entry.mutationLease=true;}
        if(ownerRequested&&instruction){entry.freeNavigation=instruction.id;snap.freeNavigation=instruction.id;}
        if(destination)entry.navigation={tabId:action.document.tabId,url:destination};
        {const asked=(checked.requiresApproval&&!fullPass)||carded;const typed=typeof action.arguments.text==='string'?action.arguments.text:undefined;
          if(typed!==undefined){const task=taskOf(entry);{const kind=action.name.replace(/^agent_browser_/,'');if(kind==='fill'||kind==='type')task.lastTyped.set(action.document.origin,{id:targetId(action),composer:composerLike(action),node:nodeKey(action)});}let to=action.document.origin;try{if(destination)to=new URL(destination).origin;}catch{/* the document's origin stands */}task.typedHistory.set(to,nextTypedHistory(task.typedHistory.get(to),typed));}
          record(action,asked?(decision.decidedBy==='intent'?'intent card':'you allowed'):fullPass?'Full permissive':'free',asked?'owner':fullPass?'full-permissive':'policy','done',levelNumber);}
        // SABLE-B 4.3/7.2: what this call admitted (canonical origin and exact URL).
        if(destination){try{scope!.admitted.add(new URL(destination).origin);scope!.admittedUrls.add(destination);}catch{/* not a web URL: nothing to cover */}}
        return true;
    };
    return new BrowserExtensionExecutor({
      authorize:()=>active(entry),authorizationError:()=>authorizationError(entry),transport,
      ...(options.collectFacts?{collectFacts:options.collectFacts}:{}),
      activity:event=>record({name:event.operation,document:event.document,mutation:true,target:event.target,fromPage:event.fromPage,textLength:event.textLength},event.decision,event.decision==='your turn'?'policy':'owner',event.outcome),
      onFloor:async (info,callScope)=>{const scope=callScope as Scope|undefined;
        // SABLE-B 5.2 (fixer r1): the floor helper carries the scope of the call that looked; a dead one (the read ended while a dialog's floor
        // facts were collected) writes no hand-off and sends no Pause.
        if(!live(entry,scope))return;
        // D1: an account or security change is its own category for the owner, though the floor files it under consent.
        const category:FloorKind|'account'|null=info.result.unsure?null:info.result.rule==='owner-account-change'?'account':info.result.floor;entry.handoffText=info.text;
        const host=site(info.document),bot=options.botName?.({...entry.context})??'Your bot';entry.handoffNote=yourTurnNote(bot,host,category);
        // The runtime lets go of the tab first (the pause); only then is the owner told, so the page is theirs when they read it.
        let released=true;const first=pauseEntry(entry,'handoff'),rev=entry.revision;
        try{await first;}catch{if(!retryOk(scope,rev))return;try{await pauseEntry(entry,'handoff');}catch{released=false;}}
        if(!released){/* the binding is marked paused and the refusal stands, but the owner is never told to type into a tab Murage could not let go of: they are told to press Stop */
          try{options.onHandoffFailed?.({context:{...entry.context},site:host,text:HANDOFF_FAILED_TEXT});}catch{/* telling the owner is best effort */}
          return;}
        try{options.onHandoff?.({context:{...entry.context},site:host,category,unsure:info.result.unsure===true,text:yourTurnNote(bot,host,category),phrase:category==='account'?ACCOUNT_OWNER_PHRASE:category?FLOOR_OWNER_PHRASE[category]:''});}catch{/* telling the owner is best effort */}
      },
      createEngine:hooks=>(options.createEngine??(engineOptions=>new BrowserExtensionEngine(engineOptions)))({
        dataDir:path.dirname(parent),realmId:workspaceId,bindingId:entry.context.bindingId,authorize:()=>active(entry),authorizationError:()=>authorizationError(entry),...hooks,
        transport:{
          selected:()=>documentFor(entry),
          documents:async()=>{await refresh(entry);if(!active(entry))throw authorizationError(entry);return [...entry.documents.values()].map(doc=>structuredClone(doc));},
          send:transport.send,
          newTab:async raw=>{
            // SABLE-B 7.5/5.5 R2: no consent here. The hook's scope is read once; live after every await; a tab navigates only to a URL this call admitted.
            const scope=entry.executor?.scope as Scope|undefined;const check=()=>{if(!live(entry,scope))throw active(entry)?Object.assign(Error('binding_inactive'),{code:'binding_inactive'}):authorizationError(entry);};
            const url=raw==='about:blank'?raw:canonicalUrl(raw);
            check();await ownedTransition(entry,'tab_new',{});check();let document=await documentFor(entry);check();
            if(url!=='about:blank'){if(!scope!.admittedUrls.has(url))fail('site_consent_required');await send(entry,'Page.navigate',{url},document,scope);document=await documentFor(entry);}
            return document;},
          closeTab:async tabId=>{if(!entry.documents.has(tabId))fail('tab_not_shared');await ownedTransition(entry,'tab_close',{tabId});},
          selectTab:async tabId=>{if(!entry.documents.has(tabId))fail('tab_not_shared');await ownedTransition(entry,'tab_switch',{tabId});return documentFor(entry,tabId);},
        },
      }),
      live:scope=>live(entry,scope as Scope|undefined),
      beginStep:(scope,action)=>beginStep(entry,scope as Scope|undefined,action),
      endStep:step=>endStep(entry,step as Step),
      // SABLE-B 7.1/7.3: the page (scope, no action) and the step's destination (scope and the step's action).
      access:async(document,destination,action,scope)=>{const own=scope as Scope|undefined;await consent(entry,document.origin,own,undefined,{stepAction:action});if(destination)await consent(entry,new URL(destination).origin,own,action);return live(entry,own);},
      admit:async (action,scope,step)=>{
        try{return await admitAction(action,scope as Scope|undefined,step as Step|undefined);}
        catch(error){if(!(error as {recorded?:boolean}).recorded)record(action,'not done','policy','denied');throw error;}
      },
    });
  };
  await persist();
  return {
    async ensureBinding(input: { botId: string; threadId: string; profileId: string; clientId?: string }) {
      const profile = broker.profiles().find(profile => profile.profileId === input.profileId) ?? fail('host_offline');
      if (!['scoped_cdp', 'durable_stop', 'explicit_share', 'manual_pause', 'engine_cdp_v1', 'unexpected_input_pause','ordered_requests_v1'].every(capability => profile.capabilities.includes(capability))) fail('incompatible_capabilities');
      const clientId = input.clientId ?? 'owner';
      // The newest matching binding: a stopped one stays stopped, and the one the owner started after it is the one the bot finds (RES-003).
      let entry = [...entries.values()].reverse().find(item => item.context.botId === input.botId && item.context.threadId === input.threadId && item.context.profileId === input.profileId && item.context.clientId === clientId);
      if (!entry) {
        const context = policy.bind({ workspaceId, bindingId: randomUUID(), botId: input.botId, threadId: input.threadId, profileId: input.profileId, clientId });
        entry = { context, state: 'active', sites: {}, siteEpoch: 0, taskL1: new Set(), taskL2: new Set(), notices: [], pageRead: false, documents: new Map(), busy: false, revision: 0 }; seedNever(entry); entries.set(context.bindingId, entry); await persist(); await bind(entry);
      } else {
        // A paused or stopped task found after a restart cannot be reconciled until the owner acts (the runtime state is the same generation); its saved state is the truth the bot is told.
        try { await refresh(entry); } catch (error) { if (entry.state === 'active') throw error; }
        if (entry.state === 'active') await bind(entry);
      }
      return { ...entry.context };
    },
    /** RES-003: the owner presses Start a new browser task after Stop. The old binding stays stopped for good; this issues a new binding id (and with it
     * a new generation domain) with no grants. Only owner-authenticated code calls it: a bot call reaches ensureBinding, which never revives a stopped one. */
    async startNewTask(bindingId: string) {
      const old = entryFor(bindingId);
      if (old.state !== 'stopped') fail('not_stopped');
      const profile = broker.profiles().find(item => item.profileId === old.context.profileId) ?? fail('host_offline');
      if (!['scoped_cdp', 'durable_stop', 'explicit_share', 'manual_pause', 'engine_cdp_v1', 'unexpected_input_pause', 'ordered_requests_v1'].every(capability => profile.capabilities.includes(capability))) fail('incompatible_capabilities');
      const { botId, threadId, profileId, clientId } = old.context;
      const context = policy.bind({ workspaceId, bindingId: randomUUID(), botId, threadId, profileId, clientId });
      const entry: Entry = { context, state: 'active', sites: {}, siteEpoch: 0, taskL1: new Set(), taskL2: new Set(), notices: [], pageRead: false, documents: new Map(), busy: false, revision: 0 };
      seedNever(entry); entries.set(context.bindingId, entry); await persist(); await bind(entry);
      return { ...entry.context };
    },
    /** SABLE-B 5.7: the broker accepted a hello for this profile. Every entry of that profile runs each registered hello step, in order,
     * none awaited; this returns at once. */
    /** SABLE-B 5.6: the number of the failed grant still owed to the browser, if any (read only; for tests and diagnostics). */
    siteOwed(bindingId: string): number | undefined { return entryFor(bindingId).setOwed; },
    /** EXT-RESTART 4.2: the sites Full granted on its own for the current task (read only; for tests and diagnostics). */
    autoGranted(bindingId: string): string[] { return [...(entryFor(bindingId).autoL1 ?? [])].sort(); },
    onHello(profileId: string) {
      for (const entry of entries.values()) {
        if (entry.context.profileId !== profileId) continue;
        for (const { step } of helloSteps) { try { void step(entry).catch(() => {}); } catch { /* a step never breaks the hello */ } }
      }
    },
    /** The owner's Continue in the app after a hand-over. The page was theirs; only the runtime can take the tab back (it answers the owner's own
     * action and reports 'resumed', which starts the continuation turn). A binding that is not waiting for the owner is refused with a code. */
    async continueHandoff(bindingId: string) {
      const entry = entryFor(bindingId);
      if (entry.state !== 'paused' || entry.pausedReason !== 'handoff') fail('not_handoff');
      // SABLE-B 5.6: the browser may still hold a site taken back (setOwed), or a previous Continue's resume activated it and then failed
      // its save (no 'resumed'). Look at the extension first: paused gets the handoff Pause and the server's set before the resume;
      // active is itself the owner resume (its steps run here, no Pause); stopped is final.
      const lookFirst = async () => {
        const raw = await request(entry, 'status') as Summary;
        if (raw?.state === 'stopped') fail('binding_stopped');
        // Not observed first: the policy takes an owner resume only above the generation it knows.
        if (raw?.state === 'active') { await ownerResumeSteps(entry, raw); return { ...entry.context }; }
        await reconcile(entry, raw);
        // SABLE-B (fixer r1, as resend): the reconcile's persist await lets a panel Resume land meanwhile. The Pause goes out only at the
        // generation just read, server still paused; otherwise the newer owner action stands and this Continue sends nothing.
        if (entry.context.generation !== raw?.generation || entry.state !== 'paused') return { ...entry.context };
        await reconcile(entry, await request(entry, 'pause', handoffParams(entry)), false, 'handoff');
        await bind(entry);
        return request(entry, 'resume', { reason: 'continue' });
      };
      if (entry.setOwed !== undefined) return lookFirst();
      try { return await request(entry, 'resume', { reason: 'continue' }); }
      catch (error) {
        // The resume was refused because the extension is no longer handoff-paused at this generation (its own resume activated it).
        if (!['owner_action_required', 'stale_generation'].includes((error as { code?: string }).code ?? '')) throw error;
        const raw = await request(entry, 'status') as Summary;
        if (raw?.state !== 'active') throw error;
        await ownerResumeSteps(entry, raw); return { ...entry.context };
      }
    },
    tools(bindingId: string, authorize: () => boolean) {
      const entry = entryFor(bindingId);
      if (!authorize()) fail('binding_unauthorized');
      entry.executor ??= makeExecutor(entry);
      return { tools: entry.executor.tools() };
    },
    async dispatch(bindingId: string, method: unknown, params: unknown, authorize: () => boolean) {
      const entry = entryFor(bindingId);
      // Spec 2.5.1 step 6: until the owner continues, every attempt gets the same Your turn text and no card.
      if (entry.state === 'paused' && entry.pausedReason === 'handoff' && entry.handoffText) throw Object.assign(new Error(entry.handoffText), { code: 'browser_extension_refused', status: 409 });
      if (entry.busy) fail('binding_busy');
      entry.busy=true;
      const cancel = new AbortController();
      try {
        // A task that sat idle for 30 minutes, or ran for 8 hours, is over before this call: its grants do not carry over.
        await expireDue(entry).catch(() => {});
        // SABLE-B 4.2/5.1: the call's snapshot (a new object per dispatch). The instruction is read once here.
        const instructionNow=options.ownerInstruction?.({...entry.context});
        const fence:Fence={generation:entry.context.generation,revision:entry.revision,...(instructionNow?{instruction:{id:instructionNow.id,text:instructionNow.text}}:{}),mode:'step',probeFlagged:false};
        entry.fence=fence;
        entry.authorize=()=>authorize()&&entry.context.generation===entry.fence?.generation&&entry.revision===entry.fence?.revision;
        if (!active(entry)) fail('binding_inactive');
        // M3: an ended task stays ended until the owner writes again.
        if (!entry.task && entry.endedFor) { if (fence.instruction?.id === entry.endedFor.id) throw refusal(`NOT DONE: ${entry.endedFor.reason === 'idle' ? 'This browser task ended after 30 minutes without activity.' : entry.endedFor.reason === 'limit' ? 'This browser task ended after 8 hours.' : 'The owner ended this browser task.'} Wait for their next message.`, true); entry.endedFor = undefined; }
        // The first browser call after an owner message starts the task.
        taskOf(entry).lastAt = now();
        // Only after taskOf has handled a new owner message: the mode, the free navigation and the probe flag.
        fence.mode = options.approvalMode?.({ ...entry.context }) ?? 'step'; fence.freeNavigation = entry.freeNavigation; fence.probeFlagged = probe.isFlagged(entry.context.bindingId);
        entry.executor ??= makeExecutor(entry);
        try {
          const output = await entry.executor.call(method, params, { fence, signal: cancel.signal, admitted: new Set(), admittedUrls: new Set() });
          if (['snapshot', 'read', 'screenshot', 'get_text', 'get_title', 'get_url', 'wait_for_text', 'wait_for_selector'].includes(String(method).replace(/^agent_browser_/, ''))) entry.pageRead = true;
          return deliver(entry, method, output, true);
        }
        catch (error) { const moved = await navigatedAfterEffect(entry, method); if (moved) return deliver(entry, method, moved, false); throw error; }
      } finally { cancel.abort(); if (entry.task) { entry.task.lastAt = now(); if (entry.task.lastAt - lastSaveAt >= 60_000) { lastSaveAt = entry.task.lastAt; savedSoon(true); } } entry.release?.(); entry.release = undefined; entry.authorize = undefined; entry.fence=undefined;entry.navigation=undefined;entry.mutationLease=false;entry.effect=undefined; entry.busy = false; }
    },
    status() { return { profiles: broker.profiles(), bindings: [...entries.values()].map(entry => ({ ...entry.context, state: online(entry) ? entry.state : entry.state === 'stopped' ? 'stopped' : 'offline', ...(entry.pausedReason && entry.state === 'paused' ? { pausedReason: entry.pausedReason, ...(entry.pausedReason === 'handoff' ? { handoff: true } : {}) } : {}), ...(entry.lowered?.length ? { sitesLowered: true } : {}), ...(entry.outcomeUnknown && entry.state !== 'stopped' ? { outcomeUnknown: true } : {}), ...(entry.state === 'stopped' || entry.retired || (entry.taskEnded && !entry.task) ? { taskEnded: true, ...(entry.taskEndReason ? { taskEndReason: entry.taskEndReason } : {}) } : {}), sites: { ...entry.sites } })) }; },
    setSiteAccess,
    /** The owner changed the approval mode, the action check or (with `change`) a saved site rule for this bot. Everything the old setting
     * granted ends before this returns to the caller's next line: in-flight authority is fenced, pending answers die with the revision, and a
     * restrictive site change takes the matching task grants and the Allow always back. The extension is told afterwards (a failed bind pauses). */
    settingsChanged(botId: string, change?: { origin: string; rule: SiteAccess }): Promise<void> {
      const touched: Entry[] = [];
      for (const entry of entries.values()) {
        if (entry.context.botId !== botId) continue;
        entry.revision++; entry.siteEpoch++; entry.task?.chats.clear(); touched.push(entry);
        if (change && change.rule !== 'allow') {
          dropGrants(entry, change.origin);
          if (change.rule === 'never') entry.sites[change.origin] = 'never';
          else if (entry.sites[change.origin] === 'allow') entry.sites[change.origin] = 'ask';
          try { policy.setSiteAccess(entry.context, change.origin, change.rule === 'never' ? 'never' : (entry.sites[change.origin] ?? 'ask')); } catch { /* none held */ }
        }
      }
      // Round 10 (R9-09): the extension is fenced FIRST, for every touched binding, so an input already delivered to it cannot finish under the old settings
      // while the state file is being written. Only then is the new state persisted (a failed write pauses, as before).
      return (async () => {
        // EXT-RESTART 3.3: an entry still to be adopted after a hello is paused on both sides and not ready; the owner's Resume binds the current set.
        for (const entry of touched) { if (entry.adoptDue) continue; try { if (online(entry)) await bind(entry); } catch { await failClosedPause(entry); } }
        try { await persist(); } catch { for (const entry of touched) await failClosedPause(entry); }
      })();
    },
    /** EXT-RESTART 4.2 (rulings 2, 5): the owner saved Allow always in Settings. It reaches only the tasks of this bot and profile running at
     * save (active, online, a task, not retired, no owed grant, not a routine), exactly as the owner's Allow on that task's site card plus its
     * Level 2 grant. It ends with the task. A failed bind pauses the binding (base rebind); nothing is restored. */
    settingsAllowed(botId: string, change: { origin: string; profileId: string }): Promise<void> {
      const o = change.origin, raised: Entry[] = [];
      for (const entry of entries.values()) {
        if (entry.context.botId !== botId || entry.context.profileId !== change.profileId) continue;
        if (entry.state !== 'active' || !entry.task || !online(entry) || entry.retired || entry.setOwed !== undefined || routineOf(entry)) continue;
        if (entry.sites[o] === 'never') continue;
        const hadL1 = entry.taskL1.has(o);
        if (hadL1 && entry.taskL2.has(o)) continue;
        if (!hadL1 && entry.taskL1.size >= MAX_STORED_GRANTS) continue;
        try { policy.setSiteAccess(entry.context, o, 'allow'); }
        catch { try { (options.log ?? ((line: string) => console.warn(line)))(`Murage for Chrome: Allow always for ${o} was not applied to a running task because that site cannot be allowed.`); } catch { /* logging is best effort */ } continue; }
        entry.revision++; entry.siteEpoch++;
        if (!hadL1) entry.taskL1.add(o);
        entry.autoL1?.delete(o);
        entry.taskL2.add(o); try { policy.grantL2(entry.context, o); } catch { entry.taskL2.delete(o); }
        let hostname = ''; try { hostname = new URL(o).hostname; } catch { /* not a URL: no lift */ }
        if (hostname && categoryFor(hostname) === 'neverDefault') (entry.task.lifted ??= new Set()).add(o);
        raised.push(entry);
      }
      return (async () => { for (const entry of raised) { try { await rebind(entry); } catch { /* base rebind paused it */ } await persist().catch(() => {}); } })();
    },
    /** The owner pressed End task: the task, every grant it held and any pending answer end now. The binding itself stays. */
    async endTask(bindingId: string, reason: TaskEndReason = 'owner') { await endTask(entryFor(bindingId), reason); },
    /** The owner pressed Revoke for one site: its task grants end, an Allow always on it drops to Ask each time, and the next
     * action cards again. In-flight authority and any pending site answer are fenced. A failed bind pauses the binding (L12). */
    async revoke(bindingId: string, origin: string) { await revokeOrigin(entryFor(bindingId), origin); },
    /** What the task holds right now (for the owner's panel and tests): the task id and the sites granted, with their levels. */
    taskInfo(bindingId: string) {
      const entry = entryFor(bindingId); const task = entry.task; if (!task) return undefined;
      const origins = [...new Set([...entry.taskL1, ...entry.taskL2])].sort();
      return { taskId: task.taskId, startedAt: task.startedAt, lastAt: task.lastAt, sites: origins.map(origin => ({ origin, l1: entry.taskL1.has(origin), l2: entry.taskL2.has(origin) })) };
    },
    /** End every task that has been idle 30 minutes or running 8 hours. Called on a timer by the integration and before every call. */
    /** The Allow always sites a failed write turned back into Ask for this bot. Returned once: the owner is told, and the note is cleared. */
    async takeLowered(botId: string): Promise<string[]> {
      const taken: string[] = [];
      for (const entry of entries.values()) if (entry.context.botId === botId && entry.lowered?.length) { taken.push(...entry.lowered); entry.lowered = undefined; }
      if (taken.length) await persist().catch(() => {});
      return [...new Set(taken)];
    },
    async expireTasks() { for (const entry of entries.values()) await expireDue(entry).catch(() => {}); },
    async stop(bindingId: string) {
      const entry = entryFor(bindingId); const already = entry.state === 'stopped' && entry.runtimeState === 'stopped';
      // Round 10 (R10-03): the extension is fenced FIRST, before any file is written. Stop is never delayed by a disk write.
      entry.state = 'stopped'; entry.revision++; const rev = entry.revision;
      // Stopping what is already stopped asks the extension for nothing: each stop advances its generation.
      // EXT-RESTART 3.3: the server Stop is final at once and never throws for an extension failure. A stale refusal is answered by
      // reading (observe only, the local stop wins) and the owner's own Stop once more, only if no later owner action moved the binding.
      let summary: unknown;
      if (online(entry) && !already) {
        try { summary = await request(entry, 'stop'); }
        catch (error) {
          if (errorCode(error) === 'stale_generation' && entry.revision === rev) {
            try { await reconcile(entry, await request(entry, 'status')); } catch { /* observe only */ }
            if (entry.revision === rev) { try { summary = await request(entry, 'stop'); } catch { /* the extension holds paused, not ready */ } }
          }
        }
      }
      await endTask(entry, 'stop').catch(() => {});
      entry.state = 'stopped';
      // A task found stopped after a restart has tabs this process never shared: Stop is already true, so that is not an error.
      if (summary) { try { await reconcile(entry, summary); } catch { /* the server stays stopped */ } }
      await persist().catch(() => {});
    },
    async pause(bindingId: string) { await pauseEntry(entryFor(bindingId)); },
    /** EXT-RESTART 3.6 (ER3-06): a restart report that overflowed integration's queue. 3.5's body on every binding of the profile that is
     * not stopped and not retired. Returns their contexts so the caller sends the "may not have finished" line once each. */
    async markUncertain(profileId: string) {
      const marked: BindingContext[] = [];
      for (const lost of entries.values()) {
        if (lost.context.profileId !== profileId || lost.state === 'stopped' || lost.retired) continue;
        lost.outcomeUnknown = true; lost.revision++;
        if (lost.state === 'active') await pauseEntry(lost, 'uncertain').catch(() => {});
        else if (lost.pausedReason !== 'handoff') lost.pausedReason = 'uncertain';
        marked.push({ ...lost.context });
      }
      await persist().catch(() => {});
      return marked;
    },
    /** EXT-RESTART 3.6 (ER3-07): the connection_lost line for each restored live task, once, unless a replayed report marked it since. */
    flushRestoreLines() {
      for (const bindingId of restoreLines.splice(0)) {
        const entry = entries.get(bindingId);
        if (!entry || entry.outcomeUnknown || entry.state === 'stopped') continue;
        try { options.onConnectionLost?.({ context: { ...entry.context } }); } catch { /* telling the owner is best effort */ }
      }
    },
    async cancelThread(threadId:string){for(const entry of entries.values())if(entry.context.threadId===threadId){entry.revision++;await entry.executor?.close();entry.executor=undefined;}},
    async close(){for(const entry of entries.values()){entry.revision++;await entry.executor?.close();entry.executor=undefined;}
    // Saves started without a waiter must land before the caller removes the state folder.
    while(pendingSaves.size)await Promise.all([...pendingSaves]);await saving;},
    async handleMessage(profileId: string, message: BrowserExtensionMessage) {
      // The restarted extension says the last action may have run: pause the task so the owner decides.
      if (message.type === 'response') {
        const lost = entries.get(message.bindingId);
        if (message.error?.code === 'uncertain' && lost && lost.context.profileId === profileId && lost.state !== 'stopped') {
          // RES-002: the owner is told the last step may have run. The mark stays until they resume or stop.
          lost.outcomeUnknown = true; lost.revision++;
          if (lost.state === 'active') await pauseEntry(lost, 'uncertain').catch(() => {});
          else if (lost.pausedReason !== 'handoff') lost.pausedReason = 'uncertain';
          await persist().catch(() => {});   // EXT-RESTART 3.5: ALWAYS (ruling 4); base skipped this for an already-paused entry
        }
        return;
      }
      if (message.type !== 'event') return;
      const entry = entries.get(message.bindingId);
      if (!entry || entry.context.profileId !== profileId || message.generation < entry.context.generation) return;
      // EXT-RESTART 3.3b (r6): the explicit owner-Resume signal, from data.resumedAt only, in the synchronous prefix before the chain.
      if (message.event === 'resumed') { const ra = resumedAtOf(message); if (ra !== undefined) entry.resumeHeard = Math.max(entry.resumeHeard ?? -1, ra); }
      if(message.event==='cdp'){
        if(message.generation!==entry.context.generation||!active(entry))return;
        const {tabId,navigationEpoch,method,params}=message.data;
        if(typeof tabId==='number'&&typeof navigationEpoch==='number'&&typeof method==='string'&&params&&typeof params==='object'&&!Array.isArray(params))entry.executor?.event(tabId,navigationEpoch,method,params as Record<string,unknown>);
        return;
      }
      // The extension reporting a stop of a task that is already stopped on both sides needs no answer.
      if(message.event==='stopped'&&entry.state==='stopped'&&entry.runtimeState==='stopped')return;
      if(message.event==='notice'&&message.data.kind==='share_requested'){
        // The owner pressed Share on a tab whose site is not allowed: raise the site card now (Never is respected).
        const origin=typeof message.data.origin==='string'?message.data.origin:'';
        if(origin&&entry.sites[origin]!=='never'&&entry.sites[origin]!=='allow'&&entry.state==='active')void consent(entry,origin,undefined,undefined,{ownerShare:true}).catch(()=>{});
        return;
      }
      if(message.event==='notice'&&message.data.kind==='owner_revoked'){
        // The owner pressed Revoke in the browser's own panel. The extension already dropped the site; the app drops it too, before any rebind lists it again.
        let origin='';try{const url=new URL(String(message.data.origin??''));if(['http:','https:'].includes(url.protocol)&&url.origin===message.data.origin)origin=url.origin;}catch{/* not an origin: nothing to take back */}
        if(origin&&entry.state!=='stopped')await revokeOrigin(entry,origin).catch(()=>{});
        return;
      }
      if(message.event==='notice'){
        const text=noticeText(message.data as Record<string,unknown>);if(text){entry.notices.push(text);while(entry.notices.length>NOTICE_LIMIT)entry.notices.shift();}
        // A new shared tab changes the picture but not the authority of the action in flight.
        if(message.data.kind==='tab_opened'&&message.data.adopted===true)await refresh(entry);
        return;
      }
      // The tab an action is working on moved within an approved site (a redirect, replaceState, a trailing
      // slash): refresh the picture. The document epoch and approval digest still stop any stale input.
      // After a page-changing input was delivered, a navigation still ends the action and is reported as it happened.
      if(message.event==='navigation'&&entry.busy&&!entry.effect&&typeof message.data.tabId==='number'){
        const document=entry.documents.get(message.data.tabId),origin=typeof message.data.origin==='string'?message.data.origin:'';
        if(document&&origin&&(origin===document.origin||entry.sites[origin]==='allow'||entry.taskL1.has(origin))){await refresh(entry);return;}
      }
      // Unrelated page/human/control events fence before persistence awaits.
      // A generation change the server did not make itself (takeover, disconnect, a stop in the browser) ends the task and its grants.
      // A plain owner pause and resume of the same task keeps them.
      // EXT-RESTART 3.1/3.4: on the profile chain. A taken-in Resume runs ownerResumeSteps (the base resumed body: owner-resume
      // reconcile, outcome and tally reset, bind with SB 5.6's fail-closed, the Continue line once).
      await onProfile(profileId, () => lifecycle(entry, message));
    },
  };
}
