// SPDX-License-Identifier: AGPL-3.0-or-later
import { NATIVE_DOM_SOURCE } from '../../server/browser-native-dom.ts';
import { TAKEOVER_WORLD, takeoverSource } from './takeover.mjs';
import { PRESENCE_WORLD, PRESENCE_REMOVE_EXPRESSION, presenceSource } from './presence.mjs';
import { scopedCdpEvent } from './cdp-events.mjs';
import { parseBrowserExtensionMessage, parseOrderedBrowserRequestId, browserCommandDeadlineMs, nativeWireBytes, MAX_RESULT_BYTES } from '../../shared/browser-extension-protocol.ts';
import { categoryFor } from '../../shared/browser-site-categories.ts';
import { isClipboardInput } from '../../shared/browser-clipboard.ts';
import { groupTitle, GROUP_COLOR } from './tab-group.mjs';
import { SECRET_CLASSIFIER_SOURCE } from '../../shared/browser-secret-classifier-source.ts';

const STORAGE_KEY = 'murageBrowserState';
// A copy of state that could not be trusted, kept for repair; and the layout version of the live record.
const QUARANTINE_KEY = 'murageBrowserStateQuarantine';
const STATE_SCHEMA = 1;
// The side panel's status contract (sidepanel/PANEL-CONTRACT.md).
export const PANEL_CONTRACT_VERSION = 1;
export const PANEL_PUSH_TYPE = 'murage.panel.status';
// Must match server/browser-document-guard.ts WORLD.
const GUARD_WORLD = 'murage-protected-document-v1';
// Startup cleanup of a worker that ended without detach: bounded per tab and
// overall, so a hung page never holds up reconnect.
export const RELEASE_LIMITS = Object.freeze({ tabMs: 3000, totalMs: 8000 });
// Every Murage group is orange, the palette colour closest to the Murage accent (spec 4.1).
const METHODS = new Set([
  'Target.setAutoAttach', 'Runtime.enable', 'Runtime.disable', 'Runtime.evaluate', 'Runtime.callFunctionOn', 'Runtime.getProperties', 'Runtime.releaseObject', 'Runtime.releaseObjectGroup', 'Runtime.runIfWaitingForDebugger',
  'Page.enable', 'Page.disable', 'Page.getFrameTree', 'Page.createIsolatedWorld', 'Page.addScriptToEvaluateOnNewDocument', 'Page.removeScriptToEvaluateOnNewDocument', 'Page.navigate', 'Page.getNavigationHistory', 'Page.navigateToHistoryEntry', 'Page.reload', 'Page.captureScreenshot', 'Page.getLayoutMetrics', 'Page.bringToFront', 'Page.setLifecycleEventsEnabled', 'Page.handleJavaScriptDialog',
  'DOM.enable', 'DOM.disable', 'DOM.getDocument', 'DOM.querySelector', 'DOM.querySelectorAll', 'DOM.describeNode', 'DOM.resolveNode', 'DOM.getBoxModel', 'DOM.scrollIntoViewIfNeeded',
  'Accessibility.enable', 'Accessibility.disable', 'Accessibility.getFullAXTree', 'Accessibility.getPartialAXTree',
  'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText',
  'Emulation.setDeviceMetricsOverride', 'Emulation.clearDeviceMetricsOverride', 'Emulation.setEmulatedMedia', 'Network.enable', 'Network.disable',
]);
const EVENT_DOMAINS = new Set(['Page', 'Runtime', 'DOM', 'Accessibility', 'Network']);
const BOOTSTRAP_METHODS = new Set(['Target.setAutoAttach', 'Page.navigate', 'Page.enable', 'Page.disable', 'Runtime.enable', 'Runtime.disable', 'DOM.enable', 'DOM.disable', 'Accessibility.enable', 'Accessibility.disable', 'Page.getFrameTree', 'Page.createIsolatedWorld', 'Page.addScriptToEvaluateOnNewDocument', 'Page.setLifecycleEventsEnabled', 'Network.enable', 'Network.disable', 'Runtime.runIfWaitingForDebugger']);
// An accessibility tree deeper than this is cut; a screenshot is JPEG at this quality, then smaller.
const AX_MAX_DEPTH = 48, SHOT_QUALITY = [70, 40, 35];
const MAX_BINDINGS = 32, MAX_RETIRED = 2048, MAX_OPENER_CANDIDATES = 16;
const fail = (code, message = code) => { throw Object.assign(new Error(message), { code }); };
function originOf(raw, noLimits = false) {
  let url; try { url = new URL(raw); } catch { fail('site_denied'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('site_denied');
  // Only the handover-only category is closed here; the server decides every other category per action (spec 2.3).
  if (!noLimits && categoryFor(url.hostname) === 'handover') fail('human_handover');
  return url.origin;
}

// Name sources only repeat what the name already says; dropping them keeps a big page in one frame.
function stripSources(field) {
  if (!field || typeof field !== 'object' || !('sources' in field)) return field;
  const { sources, ...rest } = field; void sources; return rest;
}
/** A page's accessibility tree, smaller: no name sources, and cut to a prefix that still fits one frame. */
export function boundAxTree(result, budget) {
  if (!result || !Array.isArray(result.nodes)) return result;
  const nodes = result.nodes.map(node => ({ ...node, ...(node.name ? { name: stripSources(node.name) } : {}), ...(node.description ? { description: stripSources(node.description) } : {}), ...(node.value ? { value: stripSources(node.value) } : {}) }));
  if (nativeWireBytes({ ...result, nodes }) <= budget) return { ...result, nodes };
  let used = 2, count = 0;
  for (const node of nodes) { used += nativeWireBytes(node) + 1; if (used > budget - 4096) break; count++; }
  const kept = nodes.slice(0, count), ids = new Set(kept.map(node => node.nodeId));
  return { ...result, nodes: kept.map(node => Array.isArray(node.childIds) ? { ...node, childIds: node.childIds.filter(id => ids.has(id)) } : node) };
}
// The closed-root inspector needs topology and editable markers, never text, URLs or arbitrary attributes.
// Keep each node small even when a single attribute or text node exceeds the native response limit.
function inspectionDomPiece(root) {
  if (!root) return root;
  const output = {}, pending = [[root, output, false]];
  const editableTags = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'IFRAME', 'FRAME', 'OBJECT', 'EMBED']);
  const keep = node => node.nodeName || node.attributes.length || node.shadowRootType || node.shadowRoots?.length || node.contentDocument || node.childNodeCount > 0 || node.children?.length;
  while (pending.length) {
    const [node, out, finished] = pending.pop();
    if (finished) {
      // Fully inspected plain branches cannot hide a root. Omit them instead of sending every table cell.
      if (out.children) {
        const before = out.children.length;
        out.children = out.children.filter(keep);
        out.childNodeCount = Math.max(out.children.length, (out.childNodeCount ?? before) - before + out.children.length);
      }
      continue;
    }
    for (const key of ['nodeType', 'backendNodeId', 'childNodeCount', 'shadowRootType']) if (node[key] !== undefined) out[key] = node[key];
    out.nodeName = editableTags.has(node.nodeName) ? node.nodeName : '';
    out.localName = node.localName === 'murage-presence' ? node.localName : '';
    const attributes = Array.isArray(node.attributes) ? node.attributes : [];
    out.attributes = [];
    for (let i = 0; i + 1 < attributes.length; i += 2) {
      const name = String(attributes[i]).toLowerCase(), value = String(attributes[i + 1]);
      if (name === 'contenteditable') out.attributes.push(name, value.toLowerCase() === 'false' ? 'false' : 'true');
      if (name === 'role' && /textbox|searchbox|combobox/i.test(value)) out.attributes.push(name, 'textbox');
      if (name === 'data-murage-presence') out.attributes.push(name, '');
    }
    pending.push([node, out, true]);
    for (const key of ['children', 'shadowRoots']) if (Array.isArray(node[key])) out[key] = node[key].map(child => { const next = {}; pending.push([child, next, false]); return next; });
    if (node.contentDocument) { out.contentDocument = {}; pending.push([node.contentDocument, out.contentDocument, false]); }
  }
  return output;
}
// Opaque boxes over every secret field, and everything else hidden, for the moment of a capture. Round 8: the SAME classifier the server uses
// decides what a secret is (SECRET_CLASSIFIER_SOURCE): a field is judged by its type, its name in the common languages (its own and its
// ancestors', for an editable region too) and by the value it holds (a PIN, a code, an SSN, a card or half of one in any digit script). The walk
// goes through open shadow roots; a custom element with nothing in the light DOM is a closed root or a widget this world cannot read, so its box
// is covered. A walk or field location that cannot be completed refuses capture.
export const SENSITIVE_RECTS = String.raw`(async()=>{
  const c=globalThis.__muragePresence;if(!c)return false;
  try{
    const dom=(${NATIVE_DOM_SOURCE})();
    const {value:rect}=Object.getOwnPropertyDescriptor(Element.prototype,'getBoundingClientRect');
    const SC=${SECRET_CLASSIFIER_SOURCE},r=[],seen=new Set();
    const push=e=>{
      const b=rect.call(e);
      if(![b.x,b.y,b.width,b.height].every(Number.isFinite)||b.width<=0||b.height<=0)throw Error('Private field has no mask location');
      const k=[b.x,b.y,b.width,b.height].join();
      if(!seen.has(k)){seen.add(k);r.push({x:b.x,y:b.y,width:b.width,height:b.height});}
    };
    const names=e=>{
      const out=[];let a=e,i=0;
      for(;a&&i<400;a=dom.parent(a),i++)if(dom.kind(a)===1){
        for(const k of ['type','name','id','autocomplete','aria-label','placeholder','title','data-testid','data-name'])out.push(dom.attr(a,k));
        for(const l of dom.labels(a))out.push(dom.text(l));
        const root=dom.root(a);
        for(const id of (dom.attr(a,'aria-labelledby')||'').split(/\s+/).filter(Boolean)){
          const label=dom.byId(root,id);if(!label)throw Error('Missing private field label');out.push(dom.text(label));
        }
        if(dom.tag(a)==='label')out.push(dom.text(a));
      }
      if(a)throw Error('Private field ancestors exceed bound');return out.join(' ');
    };
    const inventory=dom.fieldPresence(document);
    for(const e of inventory.fields){
      const mask=getComputedStyle(e).webkitTextSecurity;
      // Include credential autocomplete, including cc- and one-time-code.
      if(dom.controlType(e)==='password'||mask&&mask!=='none'||SC.secretName(names(e))||SC.looksLikeSecretValue(String(dom.value(e)||'').trim()))push(e);
    }
    // A generic widget rectangle cannot account for a guard-detected field.
    if(/*GUARD*/false&&!r.length)return false;
    const overlay=c.hostElement?.();
    for(const e of inventory.all){
      if(e!==overlay&&dom.tag(e).includes('-')&&!dom.shadow(e)&&!dom.children(e).length&&!dom.text(e).trim())push(e);
    }
    dom.assertComplete();
    return await c.capture(true,r,true);
  }catch{return false;}
})()`;
// The pill's strings come from the extension's own catalogue: [label name, message key, placeholder is the bot's name].
export const PRESENCE_LABEL_KEYS = [['working', 'overlayWorking', true], ['waiting', 'overlayYourTurn', true], ['pause', 'overlayPause'], ['stop', 'overlayStop'], ['stopTask', 'overlayStopTask'], ['full', 'overlayFull'], ['continue', 'btnContinue']];
// Frames whose document this world cannot open (another site's, a plugin's), through open shadow roots and
// readable frames. The attribute keeps the frame's own inline visibility so it can be put back exactly.
export const FRAME_MASK = String.raw`(()=>{const A='data-murage-frame-mask';let n=0;
  const walk=(root,depth)=>{if(depth>8)return;for(const e of root.querySelectorAll('*')){
    if(e.shadowRoot)walk(e.shadowRoot,depth+1);
    if(!/^(IFRAME|FRAME|OBJECT|EMBED)$/.test(e.tagName))continue;
    // Round 9 (R8-06): every frame is hidden, readable or not. A readable frame's contents are never classified here, so a code in one would show.
    if(!e.hasAttribute(A))e.setAttribute(A,JSON.stringify([e.style.getPropertyValue('visibility'),e.style.getPropertyPriority('visibility')]));
    e.style.setProperty('visibility','hidden','important');n++;}};
  walk(document,0);return n;})()`;
const FRAME_UNMASK = String.raw`(()=>{const A='data-murage-frame-mask';const restore=(root,depth)=>{if(depth>8)return;for(const e of root.querySelectorAll('*')){
    if(e.shadowRoot)restore(e.shadowRoot,depth+1);
    if(e.tagName==='IFRAME'||e.tagName==='FRAME'){let inner=null;try{inner=e.contentDocument;}catch{}if(inner)restore(inner,depth+1);}
    if(!e.hasAttribute(A))continue;let v=['',''];try{v=JSON.parse(e.getAttribute(A));}catch{}
    if(v[0])e.style.setProperty('visibility',String(v[0]),String(v[1]||''));else e.style.removeProperty('visibility');e.removeAttribute(A);}};
  restore(document,0);return true;})()`;
const clip = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);

/** The native port is a trusted broker channel, never a model-facing raw CDP tool. */
// Lifecycle (T44). Planned capabilities (levels_v1, presence_v1, handoff_v1, upload_token_v1) are declared only once their code ships here.
export const LIFECYCLE_CAPABILITY = 'lifecycle_v1';
export const MIN_APP_PROTOCOL = 1;
const isAvatar = v => typeof v === 'string' && v.length <= 16384 && /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(v);
const MUTATING = new Set(['cdp', 'navigate', 'click', 'fill', 'type', 'press', 'scroll', 'hover', 'drag', 'select', 'back', 'forward', 'reload', 'tab_new', 'tab_close', 'tab_switch']);
// Only a command that may have acted is journaled (so a restart can report it uncertain). Reads and setup calls write nothing.
const ACTING_CDP = new Set(['Runtime.callFunctionOn', 'Page.navigate', 'Page.reload', 'Page.navigateToHistoryEntry', 'Page.handleJavaScriptDialog', 'Page.addScriptToEvaluateOnNewDocument', 'Page.removeScriptToEvaluateOnNewDocument', 'Emulation.setDeviceMetricsOverride', 'Emulation.clearDeviceMetricsOverride', 'Emulation.setEmulatedMedia']);
// The pinned engine (agent-browser 0.36.0) moves the page through Runtime.evaluate in exactly these shapes: a page scroll
// (interaction.rs scroll without a selector) and history steps (actions.rs back/forward). Every other engine evaluate reads.
const ACTING_EVALUATE = /^(?:window\.scrollBy\(\s*-?[\d.eE+-]+\s*,\s*-?[\d.eE+-]+\s*\)|history\.(?:back|forward|go)\([^)]*\))$/;
const actingEvaluate = params => params?.method === 'Runtime.evaluate' && typeof params.params?.expression === 'string' && ACTING_EVALUATE.test(params.params.expression.trim());
const journaled = req => MUTATING.has(req.operation) && (req.operation !== 'cdp' || typeof req.params?.method !== 'string' || req.params.method.startsWith('Input.') || ACTING_CDP.has(req.params.method) || !METHODS.has(req.params.method) || actingEvaluate(req.params));
const DOWNLOAD_TTL_MS = 30000;
// Decisions use only raw evidence and the supplied clock. Binding identity and
// policy are snapshots at dispatch, so a later downgrade cannot revoke an exemption.
export function decide(download, events, now, since = now - DOWNLOAD_TTL_MS) {
  const fresh = [...events].filter(e => e.at <= now && e.at >= since);
  const observations = [download, ...fresh.filter(e => e.kind === 'observation' && e.id === download.id)];
  const keys = new Set(observations.flatMap(e => [e.url, e.finalUrl, e.referrer]).filter(Boolean));
  const tabs = new Set(observations.map(e => e.tabId).filter(Number.isSafeInteger));
  const matches = e => keys.has(e.url) || keys.has(e.referrer);
  if (fresh.some(e => e.binding?.noLimits && (e.kind === 'click' || e.kind === 'announce') && matches(e))) return 'keep';
  // Chrome's anonymous filename event cannot distinguish a simultaneous No limits
  // action on this site from an Ask URL arm. Keep that ambiguity; a concrete tab
  // or referrer still requires the exact evidence above. This uses raw dispatch
  // events, rather than a cached current actor or a URL ownership decision.
  if (!tabs.size && !observations.some(e => e.referrer)) {
    const origins = new Set([...keys].flatMap(key => { try { return [new URL(key).origin]; } catch { return []; } }));
    if (fresh.some(e => e.kind === 'click' && e.binding?.noLimits && now - e.at <= 1500 &&
      [e.url, e.referrer].some(key => { try { return origins.has(new URL(key).origin); } catch { return false; } }))) return 'keep';
  }

  const candidates = new Set(fresh.filter(e => e.binding && (tabs.has(e.tabId) || matches(e))).map(e => e.binding.id));
  if (candidates.size !== 1) return 'keep';
  const [binding] = candidates;
  return fresh.some(e => e.binding?.id === binding && !e.binding.noLimits && e.kind === 'arm') ? `cancel:${binding}` : 'keep';
}
const MODES = new Set(['step', 'task', 'full']), SITE_CATEGORIES = new Set(['always', 'never', 'asks']);
const RECOVERY_MESSAGES = Object.freeze({
  reshare_required: 'Murage for Chrome started fresh and kept a copy of the old data. Share your tabs again to continue.',
  update_required: 'This profile was saved by a newer Murage for Chrome. Update the extension to continue; nothing was changed.',
  storage_unavailable: 'Chrome storage could not be read. Murage for Chrome started fresh and is not saving until it can.',
});
export function createBrowserExtensionRuntime(api, options = {}) {
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  const emit = options.emit ?? (() => {});
  const bindings = new Map(), retired = new Set(), candidates = new Map(), popupUrls = new Map();
  let requestNonce, lastRequestSequence = 0;
  let profileId, connected = false, writeBusy = false, connectionEpoch = 0;
  let saving = Promise.resolve(), disconnecting = Promise.resolve();
  // Persistence health: a rejected save raises the marker (shown in status); the next save that lands clears it. `readOnly` keeps
  // the stored record untouched when it was written by a newer extension or could not be read.
  let persistenceFailed = false, readOnly = false, recovery, updateWaiting = false;
  // The last mutating request still running. It is stored so a worker that dies mid-action can report it uncertain, never replay it.
  let inFlight, restartReport;
  const save = () => {
    // Protected origins admitted for this live No limits session are not durable
    // approvals: restart validation and ordinary bindings must still reject them.
    const state = { profileId, retired: [...retired], ...(inFlight ? { inFlight } : {}), bindings: [...bindings.values()].map(b => ({ ...b, approvedOrigins: b.approvedOrigins.filter(o => { try { return originOf(o) === o; } catch { return false; } }), tabs: [...b.tabs.values()].map(({tabId, navigationEpoch, origin, url, bootstrap}) => ({tabId, navigationEpoch, origin, url, bootstrap})), attached: undefined, ready: undefined, noLimits: undefined, botAvatar: undefined, botAvatarId: undefined })) };
    if (readOnly) return Promise.reject(Object.assign(new Error('persistence_unavailable'), { code: 'persistence_failed' }));
    // Each save starts from a settled tail, so one rejection never poisons the saves after it.
    const run = async () => { try { await api.storage.local.set({ [STORAGE_KEY]: { schema: STATE_SCHEMA, ...state } }); persistenceFailed = false; } catch (error) { persistenceFailed = true; throw error; } };
    const attempt = saving.then(run);
    saving = attempt.catch(() => {});
    return attempt;
  };
  // Cleanup never waits on storage: the save is started, cleanup runs, and the save is awaited last with a bound.
  const saveSoon = () => { const attempt = save(); attempt.catch(() => {}); return attempt; };
  const settled = (attempt, ms = options.releaseTabMs ?? RELEASE_LIMITS.tabMs) => { let timer; return Promise.race([attempt.catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, ms); timer.unref?.(); })]).finally(() => clearTimeout(timer)); };
  const summary = b => {
    const tabs = [...b.tabs.values()].map(t => ({ tabId: t.tabId, navigationEpoch: t.navigationEpoch, origin: t.origin, url: t.url }));
    const selected = tabs.find(t => t.tabId === b.selectedTabId) ?? tabs[0];
    return { ...(selected ?? {}), bindingId: b.id, generation: b.generation, botName: b.botName, state: b.state, ready: b.ready,
      ...(b.state === 'paused' && b.pausedReason ? { pausedReason: b.pausedReason } : {}), ...(persistenceFailed ? { persistenceFailed: true } : {}),
      ...(selected ? { selectedTabId: selected.tabId } : {}), tabs, approvedOrigins: b.approvedOrigins, avatarId: b.botAvatar && b.botAvatarId ? b.botAvatarId : '' };
  };
  // ---- The side panel's view of one binding (PANEL-CONTRACT.md). Only what the runtime knows; nothing is invented. ----
  const handoffWaiting = b => b.state === 'paused' && b.pausedReason === 'handoff';
  function panelBinding(b) {
    const base = summary(b), tabs = base.tabs;
    const waiting = handoffWaiting(b), live = b.state !== 'stopped';
    const mode = b.mode ?? (b.full ? 'full' : 'step');
    // The owner's panel buttons: each is listed only where it applies. Setting a mode only tightens, Turn off leaves Full, and a new task starts only from a stopped one.
    const actions = [...(waiting && connected ? ['continue'] : []), ...(live ? ['revoke', 'endtask'] : []), ...(live && connected && mode !== 'step' ? ['setMode'] : []), ...(live && connected && mode === 'full' ? ['turnoff'] : []), ...(!live && connected ? ['newtask'] : [])];
    // What an active bot is doing, from what the runtime knows: a read in flight, a binding not yet ready (first time: starting; after that: connecting), or the app saying a card waits for the owner.
    const phase = b.state !== 'active' ? undefined : b.appPhase === 'waiting' ? 'waiting' : b.reading > 0 ? 'reading' : !b.ready ? (b.everReady ? 'connecting' : 'starting') : undefined;
    // The older summary fields (selected tab, epoch, approved sites) stay, so every earlier reader of the status keeps working.
    return { ...base, bindingId: b.id, generation: b.generation, botName: b.botName, ...(b.botColor ? { botColor: b.botColor } : {}), ...(b.botAvatar ? { botAvatarId: b.botAvatarId } : {}), ...(b.conversation ? { conversation: b.conversation } : {}),
      state: b.state, ...(waiting ? { pausedReason: 'handoff', ...(b.handoff ? { handoff: b.handoff } : {}), canContinue: connected } : {}),
      ready: !!b.ready && connected, ...(phase ? { phase } : {}), mode, tabs,
      grants: (b.grants ?? b.approvedOrigins.map(origin => ({ origin }))).filter(g => !b.revoked?.includes(g.origin)), activity: b.panelActivity ?? [], sites: b.sites ?? [],
      updateWaiting, panelActions: actions };
  }
  const statusSnapshot = () => ({ version: PANEL_CONTRACT_VERSION, connected, profileId, persistenceFailed, ...(recovery ? { recovery } : {}), bindings: [...bindings.values()].map(panelBinding) });
  // Every state change is pushed whole, so the panel can draw from any single message. A closed panel is no error.
  function pushStatus() {
    try { const sent = (options.panelPush ?? (status => api.runtime?.sendMessage?.({ type: PANEL_PUSH_TYPE, version: PANEL_CONTRACT_VERSION, status })))(statusSnapshot()); Promise.resolve(sent).catch(() => {}); } catch { /* no panel is listening */ }
  }
  // What the app tells the panel about a binding (mode, task access, activity, site decisions). Bounded text; never trusted as markup.
  function applyPanel(b, panel) {
    if (!panel || typeof panel !== 'object' || Array.isArray(panel)) return;
    if (MODES.has(panel.mode)) b.mode = panel.mode;
    if (typeof panel.full === 'boolean') b.full = panel.full;
    // Only one phase comes from the app: a card is waiting for the owner. Any status without it clears it.
    if (panel.phase === 'waiting') b.appPhase = 'waiting'; else delete b.appPhase;
    if (typeof panel.conversation === 'string') b.conversation = clip(panel.conversation, 80);
    if (typeof panel.botColor === 'string' && /^#[0-9a-f]{6}$/i.test(panel.botColor)) b.botColor = panel.botColor;
    if (typeof panel.handoff === 'string' && handoffWaiting(b)) b.handoff = clip(panel.handoff, 200);
    const list = (value, max, map) => Array.isArray(value) ? value.slice(0, max).map(map).filter(Boolean) : undefined;
    const origin = value => { try { return typeof value === 'string' ? originOf(value) : undefined; } catch { return undefined; } };
    const grants = list(panel.grants, 128, g => { const o = origin(g?.origin); return o ? { origin: o, ...(typeof g.label === 'string' && g.label ? { label: clip(g.label, 60) } : {}) } : undefined; });
    if (grants) b.grants = grants;
    const activity = list(panel.activity, 20, a => typeof a?.text === 'string' ? { ...(typeof a.time === 'string' ? { time: clip(a.time, 16) } : {}), text: clip(a.text, 200) } : undefined);
    if (activity) b.panelActivity = activity;
    const sites = list(panel.sites, 128, x => { const o = origin(x?.origin); return o && SITE_CATEGORIES.has(x.category) ? { origin: o, category: x.category } : undefined; });
    if (sites) b.sites = sites;
  }
  const event = (b, name, data = {}) => { if (connected) emit({ version: 1, type: 'event', bindingId: b.id, generation: b.generation, event: name, data }); };
  async function indicator(b) {
    const text = b.state === 'stopped' ? 'STOP' : b.state === 'paused' ? 'II' : 'ON';
    try {
      for (const t of b.tabs.values()) await api.action.setBadgeText({ tabId: t.tabId, text });
      // A group is renamed, never collapsed or moved. A sibling group in the same window is refreshed too,
      // because the bot name appears once two bindings share a window.
      await groupUpdate(b);
      for (const other of bindings.values()) if (other !== b && other.groupId !== undefined && other.windowId === b.windowId) await groupUpdate(other);
    } finally { pushStatus(); }
  }
  async function groupUpdate(b) {
    if (b.groupId === undefined) return;
    const showBot = [...bindings.values()].filter(o => o.groupId !== undefined && o.windowId === b.windowId).length >= 2;
    const title = groupTitle({ botName: b.botName, showBot, state: b.state, yourTurn: b.yourTurn, full: b.full, activity: b.activity }, api.i18n);
    await api.tabGroups.update(b.groupId, { title, color: GROUP_COLOR }).catch(() => {});
  }
  // A finished (stopped) task gives its slot back. The tombstone is durable, so its id can never return.
  function retire(id) {
    bindings.delete(id); retired.add(id);
    while (retired.size > MAX_RETIRED) retired.delete(retired.values().next().value);
  }
  function retireOldestStopped() {
    for (const b of bindings.values()) if (b.state === 'stopped' && !b.attached.size) { retire(b.id); return true; }
    return false;
  }
  // Downloads use raw dispatch, arm and Chrome observation events. A unique Ask
  // attribution pauses the item, then waits for three quiet seconds, bounded by
  // the arm's lifetime. Related owner evidence resumes it immediately. No cancel,
  // file removal or history erasure may run before that final decision.
  // The address maps below support notifications and disk checks, never attribution.
  const recentDownloads = new Map(), blockedUrls = new Map(), downloadWaiters = new Set(), pendingRemovals = new Map(), passedIds = new Map(), stoppedIds = new Map(), addressIds = new Map();
  let lastCommandAt = 0, actor;
  // Immutable raw dispatch/announcement/arm events; never cache an ownership
  // decision. Expire a time-ordered prefix, including retired bindings, once.
  const downloadEvents = new Set(), downloadItems = new Map(), loggedKeeps = new Map(), downloadHolds = new Map();
  const expireDownloadEvents = now => {
    for (const entry of downloadEvents) {
      if (now - entry.at <= DOWNLOAD_TTL_MS || [...downloadHolds.values()].some(h => !h.keeping && entry.at >= h.since)) break;
      downloadEvents.delete(entry);
    }
  };
  // The longest arm lives 30 seconds. Lookups may refresh a history, but must
  // never refresh the age of its individual observations.
  const expireObservations = (history, now) => {
    let count = 0;
    while (count < history.events.length && now - history.events[count].at > DOWNLOAD_TTL_MS + 5000) count++;
    if (count) history.events.splice(0, count);
  };
  const recordDownloadEvent = (b, kind, url, referrer, tabId) => {
    const at = Date.now();
    expireDownloadEvents(at);
    const entry = Object.freeze({ binding: Object.freeze({ id: b.id, noLimits: b.noLimits === true }), kind, url, referrer, tabId, at });
    downloadEvents.add(entry);
    for (const hold of downloadHolds.values()) reconsiderHold(hold, entry);
    return entry;
  };
  const recordAction = (b, t, params) => recordDownloadEvent(b, 'click', params.url || t.url, t.url, t.tabId);
  const announceAction = (b, t, url) => recordDownloadEvent(b, 'announce', url, t.url, t.tabId);
  // These are Chrome's observations, not inferred URL/referrer attribution.
  const observeDownload = (item, source = 'callback') => {
    const event = Object.freeze({ ...item, kind: 'observation', source, at: Date.now() });
    let history = downloadItems.get(item.id);
    if (!history) { history = { events: [], value: event, at: event.at }; downloadItems.set(item.id, history); }
    history.events.push(event);
    expireObservations(history, event.at);
    history.value = event;
    history.at = event.at; downloadItems.delete(item.id); downloadItems.set(item.id, history);
    // Expire only the ordered prefix. Fresh histories and held items are never evicted.
    for (const [id, old] of downloadItems) {
      if (event.at - old.at <= DOWNLOAD_TTL_MS) break;
      if (downloadHolds.has(id)) { expireObservations(old, event.at); continue; }
      downloadItems.delete(id);
    }
    const hold = downloadHolds.get(item.id);
    if (hold) reconsiderHold(hold, event);
    return event;
  };
  const decision = (item, now = Date.now()) => {
    expireDownloadEvents(now);
    const history = downloadItems.get(item.id);
    if (history) expireObservations(history, Date.now());
    const result = decide(item, [...downloadEvents, ...(downloadItems.get(item.id)?.events ?? [])], Math.max(now, Date.now()), now - DOWNLOAD_TTL_MS);
    if (result === 'keep' && !recall(loggedKeeps, item.id)) {
      rememberFresh(loggedKeeps, item.id, true);
      console.warn(`Murage kept download ${item.id}: attribution does not permit cancellation.`);
    }
    return result;
  };
  const permits = (item, binding) => {
    const hold = downloadHolds.get(item.id);
    return !hold?.keeping && (!hold || hold.finalAt !== undefined) && decision(item, hold?.finalAt ?? Date.now()) === `cancel:${binding}`;
  };
  const relatedToDownload = (event, history) => history.some(e =>
    [e.url, e.finalUrl, e.referrer].filter(Boolean).some(key => key === event.url || key === event.referrer) ||
    Number.isSafeInteger(e.tabId) && e.tabId === event.tabId);
  function holdArms(binding, history, now) {
    const active = [...downloadEvents].filter(e => e.kind === 'arm' && e.binding.id === binding && e.at <= now && now - e.at <= DOWNLOAD_TTL_MS);
    const matching = active.filter(arm => relatedToDownload(arm, history));
    // Redirects can lack a matching address. Only the newest active arm may
    // supply the fallback lifetime; an unrelated old arm must not shorten it.
    return matching.length ? matching : active.slice(-1);
  }
  function resumeHold(hold) {
    if (hold.resuming) return hold.resuming;
    hold.keeping = true;
    clearTimeout(hold.timer);
    // Chain after pause: a slow pause must not land after resume. A failed
    // resume retains the hold so the next observation can retry the decision.
    hold.resuming = (async () => {
      await hold.pausing;
      let resumed = false;
      for (let attempt = 0; attempt < 2 && !resumed; attempt++) {
        try { await api.downloads.resume?.(hold.id); resumed = true; } catch { /* retry once */ }
      }
      if (resumed) downloadHolds.delete(hold.id);
      else if (!hold.resumeLogged) {
        hold.resumeLogged = true;
        console.warn(`Murage could not resume download ${hold.id}; it remains paused and will be retried.`);
      }
      hold.resolve(false);
    })().finally(() => { hold.resuming = undefined; hold.resolveSettled(); });
    return hold.resuming;
  }
  function reconsiderHold(hold, event) {
    if (hold.keeping) { resumeHold(hold); return; }
    if (hold.finalAt !== undefined) return;
    const item = downloadItems.get(hold.id)?.value ?? { id: hold.id };
    if (decision(item) === 'keep') {
      resumeHold(hold);
      return;
    }
    const history = downloadItems.get(hold.id)?.events ?? [];
    const related = event && (event.id === hold.id || relatedToDownload(event, history));
    const arms = holdArms(hold.binding, history, Date.now());
    if (arms.length) {
      hold.since = Math.min(...arms.map(arm => arm.at));
      hold.deadline = Math.max(...arms.map(arm => {
        const lastRelatedAt = Math.max(hold.relatedAt.get(arm) ?? hold.startedAt, arm.at, related ? event.at : -Infinity);
        hold.relatedAt.set(arm, lastRelatedAt);
        return Math.min(arm.at + DOWNLOAD_TTL_MS, lastRelatedAt + 3000);
      }));
    }
    clearTimeout(hold.timer);
    hold.timer = setTimeout(async () => {
      // Clamp to the deadline so scheduler drift at the lifetime boundary cannot expire the arm.
      hold.finalAt = hold.deadline;
      await hold.pausing;
      if (decision(item, hold.finalAt) === 'keep') {
        await resumeHold(hold);
      } else {
        const stopped = await settle(hold.id, hold.notify, hold.binding);
        if (decision(downloadItems.get(hold.id)?.value ?? item, hold.finalAt) === 'keep') await resumeHold(hold);
        else {
          downloadHolds.delete(hold.id);
          hold.resolve(stopped);
          hold.resolveSettled();
        }
      }
    }, Math.max(0, hold.deadline - Date.now()));
    hold.timer.unref?.();
  }
  function holdDownload(item, notify = () => {}) {
    const existing = downloadHolds.get(item.id);
    if (existing) return existing;
    const result = decision(item);
    if (!result.startsWith('cancel:')) return undefined;
    const binding = result.slice(7);
    const now = Date.now();
    const arms = holdArms(binding, downloadItems.get(item.id)?.events ?? [item], now);
    if (!arms.length) return undefined;
    let resolve, resolveSettled;
    const done = new Promise(r => { resolve = r; });
    const settled = new Promise(r => { resolveSettled = r; });
    const hold = { id: item.id, binding, since: Math.min(...arms.map(arm => arm.at)), notify, resolve, done, settled, resolveSettled,
      startedAt: now, relatedAt: new Map(),
      pausing: Promise.resolve().then(() => api.downloads.pause?.(item.id)).catch(() => {}) };
    downloadHolds.set(item.id, hold);
    rememberFresh(stoppedIds, item.id, true);
    reconsiderHold(hold);
    return hold;
  }
  const DOWNLOAD_KEYS = 64, PENDING_REMOVALS = 32, PASSED_KEYS = 1024;
  const remember = (map, key, value) => {
    map.delete(key); map.set(key, { value, at: Date.now() });
    while (map.size > DOWNLOAD_KEYS) map.delete(map.keys().next().value);
  };
  const recall = (map, key) => { const entry = map.get(key); if (!entry) return undefined; if (Date.now() - entry.at > DOWNLOAD_TTL_MS) { map.delete(key); return undefined; } return entry; };
  // stoppedIds (and passedIds) never drop an entry inside its 30 s window: past PASSED_KEYS they shed only expired ones.
  const rememberFresh = (map, key, value) => {
    map.delete(key); map.set(key, { value, at: Date.now() });
    if (map.size > PASSED_KEYS) for (const [old, entry] of map) { if (Date.now() - entry.at <= DOWNLOAD_TTL_MS) break; map.delete(old); }
  };
  // An address whose seen ids were dropped from addressIds (cap) is remembered in lostAddresses: a fresh look that finds nothing there is
  // not proof of "nothing on disk" (a dropped item's history row may be gone while its file stays), so it is said as unknown. Past
  // LOST_KEYS addresses every empty look is unknown (lostAll): losing memory only ever makes Murage say less.
  const lostAddresses = new Set(), LOST_KEYS = 8192;
  let lostAll = false;
  const lose = url => { if (lostAll) return; lostAddresses.add(url); if (lostAddresses.size > LOST_KEYS) { lostAll = true; lostAddresses.clear(); } };
  const sawItem = item => {
    for (const url of new Set([item.url, item.finalUrl].filter(Boolean))) {
      const ids = addressIds.get(url) ?? new Set(); addressIds.delete(url); ids.delete(item.id); ids.add(item.id); addressIds.set(url, ids);
      if (ids.size > 32) { lose(url); while (ids.size > 32) ids.delete(ids.values().next().value); }
    }
    while (addressIds.size > PASSED_KEYS) { const old = addressIds.keys().next().value; if (addressIds.get(old).size) lose(old); addressIds.delete(old); }
  };
  const forgetItem = id => { for (const [key, entry] of recentDownloads) if (entry.value.id === id) recentDownloads.delete(key); };
  // Murage confirmed this item's file gone and erased its entry: it is no longer asked about (an erased item is not in the list).
  const forgetRemoved = id => { forgetItem(id); passedIds.delete(id); for (const ids of addressIds.values()) ids.delete(id); };
  const attempt = thunk => Promise.resolve().then(thunk);
  async function downloadItem(id) {
    if (typeof api.downloads.search !== 'function') return undefined;
    try {
      const item = (await api.downloads.search({ id }))?.[0];
      if (item) observeDownload({ ...item, id }, 'lookup');
      return item;
    } catch { return undefined; }
  }
  // One look at the downloads list: 'unknown' when it cannot answer, never "no item".
  async function lookup(query) {
    if (typeof api.downloads.search !== 'function') return 'unknown';
    try {
      const items = await api.downloads.search(query);
      if (!Array.isArray(items)) return [];
      for (const item of items) if (Number.isSafeInteger(item?.id)) observeDownload(item, 'lookup');
      return items;
    } catch { return 'unknown'; }
  }
  const anchored = url => `^${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
  // The items whose file may still be on disk under any of these addresses, asked fresh and with no time cutoff. Each address is looked
  // up as an item's address and as its redirect address (finalUrl), both as the exact address and as an anchored pattern, and only an
  // item whose own address is exactly one of these counts; every item Murage saw under these addresses is also looked up by id. An item
  // counts unless the browser reports its file missing; an item Murage saw that the list no longer has (its entry erased, so the browser
  // can no longer say) counts too, unless Murage itself removed it (forgetRemoved). `except` is the item whose removal was just
  // confirmed. 'unknown' when any look cannot answer.
  async function onDisk(urls, except) {
    const found = new Map();
    for (const url of urls) {
      for (const query of [{ url }, { finalUrl: url }, { urlRegex: anchored(url) }, { finalUrlRegex: anchored(url) }]) {
        const items = await lookup(query);
        if (items === 'unknown') return 'unknown';
        for (const item of items) if (Number.isSafeInteger(item?.id) && (urls.includes(item.url) || urls.includes(item.finalUrl))) found.set(item.id, item);
      }
    }
    const seen = new Set();
    for (const url of urls) { const hit = recentDownloads.get(url); if (hit) seen.add(hit.value.id); for (const id of addressIds.get(url) ?? []) seen.add(id); }
    for (const [id, passed] of passedIds) if (passed.urls.some(url => urls.includes(url))) seen.add(id);
    for (const id of seen) {
      if (found.has(id)) continue;
      const items = await lookup({ id });
      if (items === 'unknown') return 'unknown';
      found.set(id, items[0] ?? { id });
    }
    const present = [...found.values()].filter(item => item.id !== except && item.exists !== false).map(item => item.id);
    if (!present.length && (lostAll || urls.some(url => lostAddresses.has(url)))) return 'unknown';
    return present;
  }
  // What one bot is told about an address. 'download_blocked' only when the browser shows no file with it left on disk (said once per
  // announcement). Otherwise 'download_kept' only for a file this bot's own action let through and it was not told of yet; any other
  // file (the owner's, another bot's, one that cannot be looked up) is never mentioned, and nothing is said when the list cannot answer.
  async function tell(urls, except, entry) {
    const present = await onDisk(urls, except);
    if (present === 'unknown') return;
    if (!present.length) { if (!entry.saidBlocked) entry.saidBlocked = entry.notify('download_blocked') !== false; return; }
    const mine = present.map(id => passedIds.get(id)).filter(passed => passed && entry.binding !== undefined && passed.binding === entry.binding && !passed.told);
    if (!mine.length) return;
    for (const passed of mine) passed.told = true;
    entry.notify('download_kept');
  }
  // Stop a download and remove what it saved. 'removed': nothing of it is left and its entry is erased. 'pending': it is still being
  // written (a cancel that did not take); the removal runs once it completes. 'kept': its file could not be removed, and its entry
  // stays on the downloads shelf so the owner can see it.
  async function cancelDownload(id, binding, observed) {
    const cancelled = await attempt(() => {
      if (!permits(downloadItems.get(id)?.value ?? observed, binding)) return false;
      return Promise.resolve(api.downloads.cancel(id)).then(() => true, () => true);
    }).catch(() => true);
    if (!cancelled) return 'kept';
    const item = await downloadItem(id) ?? { id };
    if (item.state === 'in_progress') return 'pending';
    if (!await fileGone(id, item, binding)) return 'kept';
    const erased = await attempt(() => {
      if (!permits(downloadItems.get(id)?.value ?? item, binding)) return false;
      return Promise.resolve(api.downloads.erase({ id })).then(() => true, () => false);
    }).catch(() => false);
    if (!erased) return 'kept';
    forgetRemoved(id);
    return 'removed';
  }
  // Every asynchronous gap may admit new evidence, including an owner exemption.
  async function fileGone(id, item, binding) {
    if (!permits(item, binding)) return false;
    if (item?.exists === false) return true;
    const removed = await attempt(() => {
      if (!permits(downloadItems.get(id)?.value ?? item, binding)) return false;
      return Promise.resolve(api.downloads.removeFile(id)).then(() => true, () => false);
    }).catch(() => false);
    const after = await downloadItem(id);
    return removed ? !!after && after.exists !== true : after?.exists === false;
  }
  async function settle(id, notify, binding) {
    const item = downloadItems.get(id)?.value ?? { id };
    if (!permits(item, binding)) return false;
    const result = await cancelDownload(id, binding, item);
    if (result === 'pending') { await holdRemoval(id, notify, binding); return true; }
    await notify(result === 'removed' ? 'download_blocked' : 'download_kept');
    return true;
  }
  async function holdRemoval(id, notify, binding) {
    pendingRemovals.set(id, { notify, binding, at: Date.now() });
    while (pendingRemovals.size > PENDING_REMOVALS) { const [oldest, entry] = pendingRemovals.entries().next().value; pendingRemovals.delete(oldest); await entry.notify('download_kept'); }
    // it may have finished between the cancel and this registration, before any change event could find it here
    const item = await downloadItem(id);
    if (item && item.state !== 'in_progress') await downloadChanged({ id, state: { current: item.state } });
  }
  async function downloadChanged(delta) {
    if (!connected || !Number.isSafeInteger(delta?.id)) return;
    const pending = pendingRemovals.get(delta.id), state = delta.state?.current;
    const finished = state === 'complete' || state === 'interrupted';
    // Claim the pending removal before the lookup await: duplicate terminal
    // events must not remove or report the same file twice.
    if (pending && finished) pendingRemovals.delete(delta.id);
    const fields = Object.fromEntries(Object.entries(delta).filter(([key, value]) => key !== 'id' && value && 'current' in Object(value)).map(([key, value]) => [key, value.current]));
    observeDownload({ ...fields, id: delta.id }, 'changed');
    await downloadItem(delta.id);
    const item = downloadItems.get(delta.id)?.value ?? { id: delta.id };
    if (!pending || !finished) return;
    if (!permits(item, pending.binding)) return;
    const removed = await fileGone(delta.id, item, pending.binding);
    if (removed) {
      const erased = await attempt(() => {
        if (!permits(downloadItems.get(delta.id)?.value ?? item, pending.binding)) return false;
        return Promise.resolve(api.downloads.erase({ id: delta.id })).then(() => true, () => false);
      }).catch(() => false);
      if (!erased) { await pending.notify('download_kept'); return; }
      forgetRemoved(delta.id);
    }
    await pending.notify(removed ? 'download_blocked' : 'download_kept');
  }
  // An armed announcement met its item `id`: a file Murage could not remove is said as kept; a removal is said through tell.
  const armedNotify = (urls, entry, id) => async kind => { if (kind === 'download_kept') entry.notify(kind); else await tell(urls, id, entry); };
  async function downloadCreated(item) {
    if (!connected || !item || !Number.isSafeInteger(item.id)) return;
    sawItem(item);
    item = observeDownload(item);
    const urls = [...new Set([item.url, item.finalUrl].filter(Boolean))];
    const result = decision(item);
    if (result.startsWith('cancel:')) {
      const entry = urls.map(url => recall(blockedUrls, url)?.value).find(e => e?.binding === result.slice(7));
      holdDownload(item, entry ? armedNotify(urls, entry, item.id) : () => {});
      return;
    }
    for (const url of urls) remember(recentDownloads, url, { id: item.id, urls });
  }
  // Chrome also holds a filename callback until it is answered. An Ask item waits
  // through grace here even when pause is unavailable; unrelated items pass at once.
  async function downloadDetermining(item) {
    if (Number.isSafeInteger(item?.id)) item = observeDownload(item);
    const result = item ? decision(item) : 'keep';
    const by = result.startsWith('cancel:') ? result.slice(7) : (botActive() ? actor : undefined);
    if (connected && Number.isSafeInteger(item?.id)) sawItem(item);
    const stop = await decideFilename(item);
    if (!stop && by !== undefined && Number.isSafeInteger(item?.id) && !recall(stoppedIds, item.id) && !pendingRemovals.has(item.id)) {
      passedIds.delete(item.id); passedIds.set(item.id, { binding: by, urls: [...new Set([item.url, item.finalUrl].filter(Boolean))], told: false, at: Date.now() });
      // like stoppedIds, never drops an entry inside its 30 s window: past PASSED_KEYS it sheds only older ones
      if (passedIds.size > PASSED_KEYS) for (const [old, passed] of passedIds) if (Date.now() - passed.at > DOWNLOAD_TTL_MS) passedIds.delete(old);
    }
    return stop;
  }
  async function decideFilename(item) {
    if (!connected || !item || !Number.isSafeInteger(item.id)) return false;
    item = observeDownload(item);
    const result = decision(item);
    const urls = [item.url, item.finalUrl].filter(Boolean);
    const proven = () => decision(item).startsWith('cancel:');
    const cancelProven = async () => {
      if (downloadHolds.has(item.id)) return downloadHolds.get(item.id).done;
      if (recall(stoppedIds, item.id)) return false;
      const binding = decision(item).slice(7);
      const entry = urls.map(url => recall(blockedUrls, url)?.value).find(e => e?.binding === binding);
      forgetItem(item.id);
      return holdDownload(item, entry ? armedNotify(urls, entry, item.id) : () => {})?.done ?? false;
    };
    if (result === 'keep' && [...downloadEvents].some(e => e.kind === 'arm' && Date.now() - e.at <= DOWNLOAD_TTL_MS && urls.includes(e.url))) return false;
    const first = proven();
    if (first) return cancelProven();
    // Not while a bot action runs or has only just ended: nothing the bot did can explain this download.
    if (!botActive()) return false;
    const sites = new Set(); for (const u of [item.url, item.finalUrl, item.referrer]) { try { if (u) sites.add(new URL(u).origin); } catch { /* not an address */ } }
    const owned = [...bindings.values()].some(b => b.state === 'active' && [...b.tabs.values()].some(t => sites.has(t.origin)));
    if (!owned) return false;
    const url = await new Promise(resolve => {
      const done = value => { clearTimeout(timer); downloadWaiters.delete(check); resolve(value); };
      const check = () => { const hit = proven(); if (hit) done(hit); };
      const timer = setTimeout(() => done(undefined), options.downloadWaitMs ?? 500);
      timer.unref?.(); downloadWaiters.add(check);
    });
    return url ? cancelProven() : false;
  }
  const botActive = () => writeBusy || Date.now() - lastCommandAt <= (options.downloadAfterMs ?? 1500);
  // Announcements arm Ask downloads and report only what a fresh disk lookup
  // establishes. Items already let through remain untouched by a later arm alone.
  async function blockDownload(url, notify = () => {}, binding, referrer, tabId) {
    const b = bindings.get(binding);
    if (!url || !b || b.noLimits) return;
    recordDownloadEvent(b, 'arm', url, referrer, tabId);
    const entry = { notify, binding, saidBlocked: false };
    remember(blockedUrls, url, entry);
    for (const check of [...downloadWaiters]) check();
    await tell([url], undefined, entry);
  }
  async function disarmGuard(tabId, t) {
    const source = { tabId }, limit = options.releaseTabMs ?? RELEASE_LIMITS.tabMs;
    let timer;
    const work = (async () => {
      let frameId = t?.frameId;
      if (!frameId) frameId = (await api.debugger.sendCommand(source, 'Page.getFrameTree', {})).frameTree?.frame?.id;
      if (!frameId) return;
      const world = await api.debugger.sendCommand(source, 'Page.createIsolatedWorld', { frameId, worldName: GUARD_WORLD });
      await api.debugger.sendCommand(source, 'Runtime.evaluate', { expression: 'globalThis.__murageGuard?.enable(false)', contextId: world.executionContextId, returnByValue: true });
    })().catch(() => {});
    await Promise.race([work, new Promise(resolve => { timer = setTimeout(resolve, limit); })]).finally(() => clearTimeout(timer));
  }
  // Runs in the guard's isolated world. Each call may get a fresh world, so what was hidden is marked in the
  // page itself (the frame's previous inline visibility), and the second expression puts it back.
  async function frameMask(t, undo) {
    const source = { tabId: t.tabId };
    let timer;
    const work = (async () => {
      let frameId = t.frameId;
      if (!frameId) frameId = (await api.debugger.sendCommand(source, 'Page.getFrameTree', {})).frameTree?.frame?.id;
      if (!frameId) return false;
      const world = await api.debugger.sendCommand(source, 'Page.createIsolatedWorld', { frameId, worldName: GUARD_WORLD });
      const response = await api.debugger.sendCommand(source, 'Runtime.evaluate', { expression: undo ? FRAME_UNMASK : FRAME_MASK, contextId: world.executionContextId, returnByValue: true });
      return !response?.exceptionDetails;
    })().catch(() => false);
    const ok = await Promise.race([work, new Promise(resolve => { timer = setTimeout(() => resolve(false), options.frameMaskMs ?? 5000); })]).finally(() => clearTimeout(timer));
    if (!ok) fail('frame_mask_unavailable');
  }
  async function removeObserver(t) {
    await removePresence(t);
    const observer = t?.takeover; if (!observer) return;
    const source = {tabId:t.tabId};
    if (observer.contextId !== undefined) await observerSend(source, 'Runtime.evaluate', {expression:'globalThis.__murageTakeover?.remove()',contextId:observer.contextId,returnByValue:true}).catch(() => {});
    await observerSend(source, 'Runtime.removeBinding', {name:observer.name}).catch(() => {});
    if (observer.script) await observerSend(source, 'Page.removeScriptToEvaluateOnNewDocument', {identifier:observer.script}).catch(() => {});
    delete t.takeover;
  }
  async function detach(b) {
    const ids = [...b.attached]; b.attached.clear();
    await Promise.all(ids.map(async tabId => {
      // A hung page never holds up the detach: the page-side clean-up is bounded, then the debugger is let go regardless.
      const cleanup = (async () => {
        await removeObserver(b.tabs.get(tabId));
        const contextId = b.tabs.get(tabId)?.contextId;
        if (contextId !== undefined) await api.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: 'globalThis.__murageGuard?.enable(false)', contextId, returnByValue: true }).catch(() => {});
        for (const identifier of b.tabs.get(tabId)?.scripts ?? []) await api.debugger.sendCommand({ tabId }, 'Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => {});
      })().catch(() => {});
      await settled(cleanup);
      const tab = b.tabs.get(tabId); if (tab) delete tab.scripts;
      await api.debugger.detach({ tabId }).catch(() => {});
    }));
  }
  // A worker that ended without detach (extension reload, crash, update) could
  // not disarm its page guard. Chrome 151+ keeps a named isolated world across
  // debugger sessions, so the guard would keep blocking the owner's private
  // input. Release only that guard and observer, only in the tab this profile
  // had, only while it still shows the same site. No authority is restored.
  async function releaseAbandonedTabs(tabs) {
    const tabMs = options.releaseTabMs ?? RELEASE_LIMITS.tabMs, deadline = Date.now() + (options.releaseTotalMs ?? RELEASE_LIMITS.totalMs);
    for (const t of tabs) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      let timer;
      const limit = new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), Math.min(tabMs, left)); });
      const outcome = await Promise.race([releaseAbandoned(t).then(() => 'done', () => 'done'), limit]).finally(() => clearTimeout(timer));
      // A hung page: let it go (best effort detach) and move on.
      if (outcome === 'timeout') void Promise.resolve(api.debugger.detach({ tabId: t.tabId })).catch(() => {});
    }
  }
  async function releaseAbandoned({ tabId, origin }) {
    let tab; try { tab = await api.tabs.get(tabId); } catch { return; }
    let current; try { current = originOf(tab.url); } catch { return; }
    if (!origin || current !== origin) return;
    const source = { tabId };
    try { await api.debugger.attach(source, '1.3'); } catch { return; }
    try {
      const tree = await observerSend(source, 'Page.getFrameTree', {});
      const frameId = tree.frameTree?.frame?.id;
      if (!frameId) return;
      for (const [worldName, expression] of [[GUARD_WORLD, 'globalThis.__murageGuard?.enable(false)'], [TAKEOVER_WORLD, 'globalThis.__murageTakeover?.remove()'], [PRESENCE_WORLD, PRESENCE_REMOVE_EXPRESSION]]) {
        try {
          const world = await observerSend(source, 'Page.createIsolatedWorld', { frameId, worldName });
          await observerSend(source, 'Runtime.evaluate', { expression, contextId: world.executionContextId, returnByValue: true });
        } catch { /* Nothing armed in this document. */ }
      }
    } catch { /* The tab changed or closed: nothing left to release. */ }
    finally { await api.debugger.detach(source).catch(() => {}); }
  }
  async function fence(b, state, name, handoff) {
    // Stop is final: nothing (a pause, a takeover, a restart) turns a stopped task back into a resumable one.
    if (b.state === 'stopped' && state !== 'stopped') return summary(b);
    // Authority ends here, synchronously. What follows is clean-up, and it never waits on storage: the save is started, the page is
    // released, and only then is the save awaited (bounded). A failed save leaves the marker, never a held debugger.
    b.generation++; b.state = state; b.ready = false;
    if (state === 'paused' && handoff) { b.pausedReason = 'handoff'; b.yourTurn = true; b.handoff = clip(handoff.text, 200) || undefined; }
    else if (state !== 'paused' || !handoffWaiting(b)) { delete b.pausedReason; delete b.handoff; if (state !== 'paused') delete b.yourTurn; }
    const saved = saveSoon();
    try { await detach(b); }
    finally {
      await settled(saved);
      try { await indicator(b); } catch { /* the badge is a cue */ }
      event(b, name);
    }
    if (state === 'paused' && handoff) { const id = b.selectedTabId; if (id !== undefined) await Promise.resolve(api.tabs.update?.(id, { active: true })).catch(() => {}); }
    return summary(b);
  }
  // SABLE-B r8: `generation` (given by page-popup adoption only) is the generation the caller checked; the tab is inserted only if the binding is
  // still connected, active, ready and at that generation after the tabs.get await, so an adoption that began before a Pause, a disconnect or a
  // bind that took a site back cannot land after it.
  async function addTab(b, tabId, bootstrap = false, generation) {
    if ([...bindings.values()].some(other => other.id !== b.id && other.tabs.has(tabId))) fail('tab_owned');
    const tab = await api.tabs.get(tabId);
    // A private window is never shared, and nothing about it is stored: refused before the binding records the tab.
    if (tab.incognito) fail('incognito_denied');
    if (tab.url === 'about:blank' && !bootstrap) fail('site_denied');
    const origin = tab.url === 'about:blank' ? 'null' : originOf(tab.url, b.noLimits);
    if (!b.noLimits && origin !== 'null' && !b.approvedOrigins.includes(origin)) fail('site_denied');
    if (generation !== undefined && !(connected && b.state === 'active' && b.ready && b.generation === generation)) fail('binding_inactive');
    b.tabs.set(tabId, { tabId, navigationEpoch: 1, origin, url: tab.url, bootstrap });
    const groupId = await api.tabs.group({ tabIds: [tabId], ...(b.groupId === undefined ? {} : { groupId: b.groupId }) });
    b.groupId = groupId; b.windowId = tab.windowId; b.selectedTabId ??= tabId; await save(); await indicator(b);
    return b.tabs.get(tabId);
  }
  async function createOwnedTab(b, generation) {
    // Register before creation: Chromium can complete about:blank before create resolves.
    const completed = new Set();
    let tabId, resolveCompleted;
    const done = new Promise(resolve => { resolveCompleted = resolve; });
    const listener = details => {
      if (details.frameId !== 0 || details.url !== 'about:blank') return;
      if (completed.size < 128) completed.add(details.tabId);
      if (details.tabId === tabId) resolveCompleted();
    };
    api.webNavigation.onCompleted.addListener(listener);
    let timer;
    try {
      const tab = await api.tabs.create({ url: 'about:blank', active: false });
      tabId = tab.id;
      if (completed.has(tabId)) resolveCompleted();
      await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Tab creation did not complete'), { code: 'bootstrap_timeout' })), options.bootstrapTimeoutMs ?? 5000); })]);
      active(b, generation);
      const created = await api.tabs.get(tabId);
      if (created.incognito) { await api.tabs.remove(tabId).catch(() => {}); fail('incognito_denied'); }
      if (created.url !== 'about:blank') fail('bootstrap_changed');
      return await addTab(b, tabId, true);
    } finally { clearTimeout(timer); api.webNavigation.onCompleted.removeListener(listener); }
  }
  async function checkedTab(b, params, allowBlank = false) {
    const t = b.tabs.get(params.tabId);
    if (!t || t.navigationEpoch !== params.navigationEpoch) fail('stale_document');
    const tab = await api.tabs.get(t.tabId);
    if (tab.incognito) fail('incognito_denied');
    if (!tab.url && tab.pendingUrl === 'about:blank') tab.url = 'about:blank';
    if (!(allowBlank && t.bootstrap && tab.url === 'about:blank')) {
      const origin = originOf(tab.url, b.noLimits);
      if (origin !== t.origin || (!b.noLimits && !b.approvedOrigins.includes(origin))) fail('site_denied');
    }
    return t;
  }
  function active(b, generation) {
    if (!connected || !b.ready || b.state !== 'active' || b.generation !== generation) fail('binding_inactive');
  }
  async function observerSend(source, method, params) {
    let timer;
    return Promise.race([api.debugger.sendCommand(source, method, params), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('Takeover observer unavailable'), {code:'takeover_unavailable'})), options.commandTimeoutMs ?? 15000);
    })]).finally(() => clearTimeout(timer));
  }
  async function observerCall(t, expression) {
    if (t.takeover?.contextId === undefined) fail('takeover_unavailable');
    const result = await observerSend({tabId:t.tabId}, 'Runtime.evaluate', {expression,contextId:t.takeover.contextId,returnByValue:true});
    if (result.exceptionDetails || result.result?.type !== 'boolean') fail('takeover_unavailable');
    return result.result.value;
  }
  async function ensureObserver(t) {
    if (t.takeover?.contextId !== undefined) return;
    const source = {tabId:t.tabId};
    const tree = await observerSend(source, 'Page.getFrameTree', {});
    if (!tree.frameTree?.frame?.id) fail('takeover_unavailable');
    t.frameId = tree.frameTree.frame.id;
    t.takeover ??= {name:`murage_takeover_${uuid().replaceAll('-', '')}`};
    await observerSend(source, 'Runtime.addBinding', {name:t.takeover.name,executionContextName:TAKEOVER_WORLD});
    if (!t.takeover.script) {
      const script = await observerSend(source, 'Page.addScriptToEvaluateOnNewDocument', {source:takeoverSource(t.takeover.name),worldName:TAKEOVER_WORLD,runImmediately:true});
      t.takeover.script = script.identifier;
    }
    const world = await observerSend(source, 'Page.createIsolatedWorld', {frameId:t.frameId,worldName:TAKEOVER_WORLD});
    t.takeover.contextId = world.executionContextId;
    await observerSend(source, 'Runtime.evaluate', {expression:takeoverSource(t.takeover.name),contextId:world.executionContextId,returnByValue:true});
  }
  // ---- Presence (spec section 4): the overlay is a cue, never a gate. Every call here is best effort and
  // bounded; a hung or broken overlay can delay an action by the cap at most and never fails or authorises it.
  const presenceCap = () => options.presenceCapMs ?? 1500;
  async function presenceSend(t, method, params, capMs = presenceCap()) {
    let timer;
    try {
      return await Promise.race([api.debugger.sendCommand({ tabId: t.tabId }, method, params), new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Presence unavailable'), { code: 'presence_unavailable' })), capMs); })]);
    } finally { clearTimeout(timer); }
  }
  async function presenceEval(t, expression, capMs, awaitPromise = false) {
    const response = await presenceSend(t, 'Runtime.evaluate', { expression, contextId: t.presence.contextId, returnByValue: true, ...(awaitPromise ? { awaitPromise: true } : {}) }, capMs);
    if (response?.exceptionDetails) throw Object.assign(new Error('Presence script failed'), { code: 'presence_unavailable' });
    return response?.result?.value;
  }
  function presenceLabels(botName) {
    const get = (key, sub) => { try { const text = api.i18n?.getMessage?.(key, sub === undefined ? undefined : [sub]); return typeof text === 'string' && text.trim() ? text : undefined; } catch { return undefined; } };
    const labels = {};
    for (const [name, key, withBot] of PRESENCE_LABEL_KEYS) { const text = get(key, withBot ? botName : undefined); if (text) labels[name] = text; }
    return labels;
  }
  async function installPresence(b, t) {
    const p = t.presence;
    if (!p.bound) { await presenceSend(t, 'Runtime.addBinding', { name: p.name, executionContextName: PRESENCE_WORLD }); p.bound = true; }
    const source = presenceSource({ botName: b.botName, bindingName: p.name, labels: presenceLabels(b.botName) });
    if (!p.script) p.script = (await presenceSend(t, 'Page.addScriptToEvaluateOnNewDocument', { source, worldName: PRESENCE_WORLD, runImmediately: true })).identifier;
    if (!t.frameId) t.frameId = (await presenceSend(t, 'Page.getFrameTree', {})).frameTree?.frame?.id;
    const world = await presenceSend(t, 'Page.createIsolatedWorld', { frameId: t.frameId, worldName: PRESENCE_WORLD });
    p.contextId = world.executionContextId; p.key = undefined;
    await presenceEval(t, source);
  }
  async function pushPresenceState(b, t) {
    const p = t.presence, state = b.yourTurn ? 'waiting' : 'driving', full = !!b.full, key = `${state}:${full}`;
    if (p.key === key) return;
    await presenceEval(t, `globalThis.__muragePresence?.state(${JSON.stringify(state)},{full:${full}})`);
    p.key = key;
  }
  // Install (or re-install after a navigation, a lapsed lease or a removed control) and push the state. `touch`
  // marks real activity from a dispatch; the keepalive timer renews without counting as activity.
  async function ensurePresence(b, t, touch) {
    if (options.presence === false) return;
    const gone = () => !connected || b.state !== 'active' || b.tabs.get(t.tabId) !== t || !b.attached.has(t.tabId);
    if (gone()) return;
    try {
      const p = t.presence ??= { name: `murage_presence_${uuid().replaceAll('-', '')}` };
      if (touch) p.lastActive = Date.now();
      let alive = false;
      if (p.contextId !== undefined) { try { alive = await presenceEval(t, 'globalThis.__muragePresence?.renew()') === true; } catch { alive = false; } }
      if (!alive) await installPresence(b, t);
      await pushPresenceState(b, t);
      // A fence or detach that ran while this was in flight has already removed the overlay: do not bring it back.
      if (gone()) { await removePresence(t); return; }
      startPresenceTimer(b, t);
    } catch { /* the overlay is a cue, never a gate */ }
  }
  function startPresenceTimer(b, t) {
    const p = t.presence; if (!p || p.timer) return;
    let running = false;
    p.timer = setInterval(async () => {
      if (!connected || b.state !== 'active' || b.tabs.get(t.tabId) !== t || !b.attached.has(t.tabId)) { clearInterval(p.timer); p.timer = undefined; return; }
      if (running) return;
      running = true;
      try {
        if (!writeBusy && Date.now() - (p.lastActive ?? 0) >= (options.idleDetachMs ?? 30000)) await idleDetach(b, t);
        else await ensurePresence(b, t, false);
      } finally { running = false; }
    }, options.presenceRenewMs ?? 2000);
    p.timer.unref?.();
  }
  // Chrome's debugging bar shows only while the bot is driving: after the idle window (a turn that ended, a wait
  // for the owner, a handoff) the tab is released, and the next dispatch attaches again. Authority is unchanged.
  function forgetChildSessions(b, t) {
    for (const sessionId of t.childSessions?.keys() ?? []) event(b, 'cdp', { tabId: t.tabId, navigationEpoch: t.navigationEpoch, method: 'Target.detachedFromTarget', params: { sessionId } });
    delete t.childSessions;
  }
  async function idleDetach(b, t) {
    if (!b.attached.has(t.tabId)) return;
    b.attached.delete(t.tabId);
    await removeObserver(t);
    if (t.contextId !== undefined) await api.debugger.sendCommand({ tabId: t.tabId }, 'Runtime.evaluate', { expression: 'globalThis.__murageGuard?.enable(false)', contextId: t.contextId, returnByValue: true }).catch(() => {});
    for (const identifier of t.scripts ?? []) await api.debugger.sendCommand({ tabId: t.tabId }, 'Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => {});
    delete t.scripts; delete t.contextId; delete t.contextIds; forgetChildSessions(b, t);
    await api.debugger.detach({ tabId: t.tabId }).catch(() => {});
  }
  async function removePresence(t) {
    const p = t?.presence; if (!p) return;
    delete t.presence;
    if (p.timer) clearInterval(p.timer);
    const send = (method, params) => api.debugger.sendCommand({ tabId: t.tabId }, method, params).catch(() => {});
    const bounded = work => Promise.race([work, new Promise(resolve => { const timer = setTimeout(resolve, presenceCap()); timer.unref?.(); })]);
    if (p.contextId !== undefined) await bounded(send('Runtime.evaluate', { expression: PRESENCE_REMOVE_EXPRESSION, contextId: p.contextId, returnByValue: true }));
    if (p.fallback) await bounded(send('Overlay.hideHighlight', {}));
    await bounded(send('Runtime.removeBinding', { name: p.name }));
    if (p.script) await bounded(send('Page.removeScriptToEvaluateOnNewDocument', { identifier: p.script }));
  }
  async function presenceCapture(t, on, noLimits = false) {
    const p = t?.presence;
    // No limits does not depend on the overlay or its masking support.
    if (noLimits) {
      if (!p || p.contextId === undefined) return;
      p.capturing = true;
      if (p.fallback) await presenceSend(t, 'Overlay.hideHighlight', {}).catch(() => {});
      await presenceEval(t, 'globalThis.__muragePresence?.capture(true, [], true)', options.presenceCaptureMs ?? 500, true).catch(() => {});
      return;
    }
    // Below No limits, a screenshot requires a verified mask.
    if (!p || p.contextId === undefined) { if (on) fail('masking_unavailable'); return; }
    try {
      if (on) {
        p.capturing = true;
        if (p.fallback) await presenceSend(t, 'Overlay.hideHighlight', {}).catch(() => {});
        let privateDocument = false;
        if (t.contextId !== undefined) {
          const verdict = await presenceSend(t, 'Runtime.evaluate', { expression: 'globalThis.__murageGuard?.() ?? false', contextId: t.contextId, returnByValue: true });
          if (verdict?.exceptionDetails || typeof verdict?.result?.value !== 'boolean') fail('masking_unavailable');
          privateDocument = verdict.result.value;
        }
        const masked = await presenceEval(t, SENSITIVE_RECTS.replace('/*GUARD*/false', String(privateDocument)), options.presenceCaptureMs ?? 500, true);
        if (masked !== true) fail('masking_unavailable');
      } else if (p.capturing) {
        p.capturing = false;
        await presenceEval(t, 'globalThis.__muragePresence?.capture(false)', options.presenceCaptureMs ?? 500, true);
        if (p.fallback) await drawFallback(t);
      }
    } catch (error) { if (on) throw Object.assign(new Error('masking_unavailable'), { code: 'masking_unavailable' }); /* best effort: the control also clears capture mode when its lease lapses */ }
  }
  // The page took our host away three times: draw a CDP outline instead (no fill, so nothing to hide under).
  async function drawFallback(t) {
    const p = t.presence; if (!p) return;
    p.fallback = true;
    try {
      const metrics = await presenceSend(t, 'Page.getLayoutMetrics', {});
      const vp = metrics.cssVisualViewport ?? metrics.visualViewport ?? {};
      await presenceSend(t, 'Overlay.enable', {});
      await presenceSend(t, 'Overlay.highlightRect', { x: 0, y: 0, width: Math.round(vp.clientWidth ?? 0), height: Math.round(vp.clientHeight ?? 0), color: { r: 0, g: 0, b: 0, a: 0 }, outlineColor: { r: 255, g: 107, b: 53, a: 1 } });
    } catch { /* ignore */ }
  }
  // The pointer arrives before the click and the typing marker before the text. The wait is capped (halved in
  // Full permissive) and the epoch and generation checks that follow it are unchanged, so the animation never
  // extends authority.
  async function presencePointer(b, t, method, params) {
    if (!t.presence || t.presence.contextId === undefined) return;
    let expression;
    const num = v => typeof v === 'number' && Number.isFinite(v);
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed' && num(params.x) && num(params.y)) {
      expression = `(async()=>{const c=globalThis.__muragePresence;if(!c)return false;c.avoid({x:${params.x - 24},y:${params.y - 24},width:48,height:48});return await c.move(${params.x},${params.y});})()`;
    } else if (method === 'Input.insertText' || (method === 'Input.dispatchKeyEvent' && (params.type === 'keyDown' || params.type === 'char'))) {
      expression = `(async()=>{const c=globalThis.__muragePresence;const e=document.activeElement;if(!c||!e||e===document.body)return false;const r=e.getBoundingClientRect();return await c.type({x:r.x,y:r.y,width:r.width,height:r.height});})()`;
    } else return;
    const cap = (options.presenceMoveCapMs ?? 400) / (b.full ? 2 : 1);
    await presenceEval(t, expression, cap, true).catch(() => {});
  }
  async function checkObserver(b,t) {
    if (await observerCall(t, 'globalThis.__murageTakeover?.state()')) { await fence(b,'paused','takeover'); fail('binding_inactive'); }
  }
  async function execute(req) {
    if (!connected) fail('host_offline');
    const ordered = parseOrderedBrowserRequestId(req.id);
    if (!ordered) fail('invalid_request_sequence');
    if (requestNonce !== undefined && requestNonce !== ordered.nonce) fail('request_sequence_mismatch');
    if (ordered.sequence <= lastRequestSequence) fail('replayed_request');
    if (ordered.sequence !== lastRequestSequence + 1) fail('request_sequence_gap');
    // Consume before the first await, including commands subsequently refused.
    requestNonce = ordered.nonce; lastRequestSequence = ordered.sequence;
    // Only a command that may have acted is journaled, and the intent is durable before it runs: with no record, a restart could not
    // report the action uncertain, so an unrecorded action is refused. Reads and setup calls write nothing.
    // One acting command at a time: a second one that arrives while the first is being recorded is busy, never run unrecorded.
    // (Answering a page dialog is the one exception: it has to pass while the click that opened it is still in flight.)
    if (journaled(req) && inFlight && req.operation === 'cdp' && req.params?.method !== 'Page.handleJavaScriptDialog') fail('busy');
    if (journaled(req) && !inFlight) {
      inFlight = { id: req.id, bindingId: req.bindingId, generation: req.generation };
      try { await save(); } catch { throw Object.assign(new Error('persistence_failed'), { code: 'persistence_failed' }); }
    }
    let b = bindings.get(req.bindingId);
    if (req.operation === 'bind') {
      if (!connected) fail('host_offline');
      // A profile this extension cannot read or must not overwrite grants nothing until that is resolved.
      if (readOnly) fail(recovery?.code ?? 'persistence_failed');
      if (req.params.profileId !== profileId) fail('wrong_profile');
      // An older app than this extension supports: refuse plainly so the owner updates Murage.
      if (Number.isInteger(req.params.appProtocol) && req.params.appProtocol < MIN_APP_PROTOCOL) fail('update_murage');
      const approvedOrigins = req.params.approvedOrigins;
      if (!Array.isArray(approvedOrigins) || approvedOrigins.length > 128 || approvedOrigins.some(o => typeof o !== 'string' || originOf(o, req.params.noLimits === true) !== o)) fail('site_denied');
      if (!b) {
        // A retired id is never bound again: an old, captured bind cannot revive a finished task.
        if (retired.has(req.bindingId)) fail('binding_retired');
        if (req.generation !== 1) fail('stale_generation');
        if (bindings.size >= MAX_BINDINGS && !retireOldestStopped()) fail('binding_capacity');
        b = { id: req.bindingId, botName: String(req.params.botName ?? 'Bot').slice(0, 80), color: GROUP_COLOR, generation: 1, state: 'active', approvedOrigins, tabs: new Map(), attached: new Set(), ready: true };
        bindings.set(b.id, b); recovery = undefined;
      } else {
        if (b.generation !== req.generation) fail('stale_generation');
        // An origin the owner revoked in the panel stays revoked while the app still lists it (the app has not caught up). Once the
        // app's list drops it, the revoke is settled, and a later listing is a fresh approval.
        if (b.revoked?.length) { b.revoked = b.revoked.filter(o => approvedOrigins.includes(o)); if (!b.revoked.length) delete b.revoked; }
        b.approvedOrigins = approvedOrigins.filter(o => !b.revoked?.includes(o)); b.bindEpoch = (b.bindEpoch ?? 0) + 1; b.ready = b.state === 'active'; if (b.ready) b.everReady = true;
      }
      b.noLimits = req.params.noLimits === true;
      applyPanel(b, req.params.panel);
      await save();
      if (!b.tabs.size && b.state === 'active') {
        await createOwnedTab(b, req.generation);
      }
      await indicator(b); return summary(b);
    }
    if (!b) fail('unknown_binding');
    if (req.operation === 'status') { if (req.params.panel) { applyPanel(b, req.params.panel); pushStatus(); } return summary(b); }
    if (b.generation !== req.generation) fail('stale_generation');
    if (req.operation === 'avatar') {
      const id = req.params?.avatarId;
      if (id === '') { delete b.botAvatar; delete b.botAvatarId; }
      else if (typeof id === 'string' && /^[0-9a-f]{16}$/.test(id) && isAvatar(req.params.data)) { b.botAvatar = req.params.data; b.botAvatarId = id; }
      else fail('invalid_params');
      pushStatus(); return { avatarId: b.botAvatarId ?? '' };
    }

    if (req.operation === 'retire') {
      if (b.state !== 'stopped') fail('not_stopped');
      retire(b.id); await save(); return { retired: true };
    }
    // A pause that names a handoff is the Your turn state: the page is released and the owner presses Continue (T25).
    if (req.operation === 'stop' || req.operation === 'pause') return fence(b, req.operation === 'stop' ? 'stopped' : 'paused', req.operation === 'stop' ? 'stopped' : 'paused', req.operation === 'pause' && req.params.reason === 'handoff' ? { text: req.params.handoff } : undefined);
    // The app's own Continue (the owner at the desktop) answers a hand-over; every other resume stays the owner's action in the browser.
    if (req.operation === 'resume') { if (req.params?.reason === 'continue' && handoffWaiting(b)) return ownerResume(b, req.params.noLimits === true); fail('owner_action_required'); }
    active(b, req.generation);
    if (req.operation === 'share') fail('owner_action_required');
    if (req.operation === 'unshare') return unshare(b, req.params.tabId);
    if (req.operation === 'tab_list') return summary(b).tabs;
    if (req.operation === 'tab_new') { const tab = await createOwnedTab(b, req.generation); b.selectedTabId = tab.tabId; await save(); return summary(b); }
    if (req.operation === 'tab_switch') {
      if (!b.tabs.has(req.params.tabId)) fail('tab_not_shared');
      b.selectedTabId = req.params.tabId; await save(); return summary(b);
    }
    if (req.operation === 'tab_close') {
      const tabId = req.params.tabId ?? b.selectedTabId;
      if (!b.tabs.has(tabId)) fail('tab_not_shared');
      await unshare(b, tabId, false); await api.tabs.remove(tabId); return summary(b);
    }
    if (req.operation !== 'cdp') fail('unsupported_operation');
    const { method, params = {} } = req.params;
    if (method === 'Target.getTargets') return { targetInfos: summary(b).tabs.map(t => ({ targetId: String(t.tabId), type: 'page', attached: b.attached.has(t.tabId), url: t.url })) };
    // BRLOCK19: Page.getFrameTree cannot see a frame that lives in another process, so the page lock asks the browser for every frame
    // of the tab. Read-only, scoped to a shared and approved tab, and any failure is an error the lock treats as "locked".
    if (method === 'Murage.getAllFrames') {
      active(b, req.generation);
      const t = await checkedTab(b, req.params);
      const frames = await api.webNavigation.getAllFrames({ tabId: t.tabId });
      active(b, req.generation);
      if (!Array.isArray(frames)) fail('frames_unavailable');
      await checkedTab(b, req.params);
      // Only live documents: a back/forward-cached or prerendered one is not on the page. An unreadable url goes through as missing, so the lock reads it as doubt.
      const live = frames.filter(f => f.documentLifecycle === undefined || f.documentLifecycle === 'active');
      return { result: { frames: live.map(f => ({ frameId: f.frameId, parentFrameId: f.parentFrameId, ...(typeof f.url === 'string' ? { url: f.url } : {}) })) }, tabId: t.tabId, navigationEpoch: t.navigationEpoch, origin: t.origin, url: t.url };
    }
    if ((method === 'Target.setAutoAttach' && (req.params.noLimits !== true || params.flatten !== true)) || !METHODS.has(method) || params.sessionId || params.targetId || params.uniqueContextId) fail('method_denied');
    if (req.params.noLimits !== true && isClipboardInput(method, params)) fail('clipboard_denied');
    const t = await checkedTab(b, req.params, BOOTSTRAP_METHODS.has(method));
    // A page showing a dialog is blocked: answering it must not evaluate anything in that page.
    const dialog = method === 'Page.handleJavaScriptDialog', isInput = method.startsWith('Input.');
    const childSession = req.params.sessionId;
    const child = childSession && t.childSessions?.get(childSession);
    if (childSession && (req.params.noLimits !== true || !child)) fail('context_denied');
    const contexts = child ? child.contextIds : t.contextIds;
    const contextId = params.executionContextId ?? params.contextId;
    if (contextId !== undefined && contextId !== t.contextId && !contexts?.has(contextId)) fail('context_denied');
    if (method === 'Page.navigate' && req.params.noLimits !== true && (!b.approvedOrigins.includes(originOf(params.url)) || params.frameId)) fail('site_denied');
    // One in-flight trusted command per profile: includes reads to avoid hidden writes in engine scripts.
    // The one exception is the answer to a dialog: a click that made the page open an alert blocks its own command until the
    // dialog is answered, so the answer has to pass while that command is in flight. It never takes or clears the busy flag then.
    if (writeBusy && !dialog) fail('busy');
    const ownsBusy = !writeBusy;
    writeBusy = true; if (ownsBusy) actor = b.id; // a dialog answer inside another command never takes its downloads
    let shotHidden;
    try {
      if (!b.attached.has(t.tabId)) {
        await api.debugger.attach({ tabId: t.tabId }, '1.3');
        b.attached.add(t.tabId);
        // Detach clears Chrome's event subscriptions, but the engine session survives Continue and idle release.
        // Restore only successful domain subscriptions, never an input, navigation or page script.
        try {
          for (const [subscription, args] of t.subscriptions ?? []) {
            if (subscription === 'Target.setAutoAttach' && req.params.noLimits !== true) continue;
            active(b, req.generation);
            await api.debugger.sendCommand({ tabId: t.tabId }, subscription, args);
          }
        } catch (error) {
          b.attached.delete(t.tabId);
          await api.debugger.detach({ tabId: t.tabId }).catch(() => {});
          throw error;
        }
      }
      const bindEpoch = b.bindEpoch ?? 0;
      active(b, req.generation);
      await checkedTab(b, req.params, BOOTSTRAP_METHODS.has(method));
      if (!dialog) {
        try { await ensureObserver(t); await checkObserver(b,t); }
        catch (error) { if (b.state === 'active') await fence(b,'paused','takeover'); throw error; }
      }
      active(b, req.generation);
      if (!dialog) await ensurePresence(b, t, true);
      if (isInput && !dialog) { await presencePointer(b, t, method, params); active(b, req.generation); }
      if (isInput && !await observerCall(t, `globalThis.__murageTakeover?.arm(${JSON.stringify(method)},${JSON.stringify(params)})`)) { await fence(b,'paused','takeover'); fail('binding_inactive'); }
      // The arm was asynchronous: the document can have been replaced meanwhile. Check the
      // epoch synchronously, with no await before the dispatch, so no input reaches a new document.
      if (isInput) {
        active(b, req.generation); if (b.tabs.get(t.tabId) !== t || t.navigationEpoch !== req.params.navigationEpoch) fail('stale_document');
        // Round 9 (R8-10): the owner changed the approved sites or settings while this input waited: it does not dispatch, and the site is looked at again, synchronously.
        if (req.params.noLimits !== true && ((b.bindEpoch ?? 0) !== bindEpoch || !b.approvedOrigins.includes(t.origin))) fail('site_denied');
      }
      // Each operation has its own deadline. Only a command that may have acted (input, a function
      // call on a node) is "uncertain" and pauses; a read that is simply slow fails that call alone.
      const deadline = options.commandTimeoutMs ?? browserCommandDeadlineMs(method, params), mayAct = isInput || method === 'Runtime.callFunctionOn';
      const sendOnce = sendParams => {
        let timer;
        if (journaled(req) && ownsBusy) recordAction(b, t, sendParams);
        return Promise.race([api.debugger.sendCommand({ tabId: t.tabId, ...(childSession ? { sessionId: childSession } : {}) }, method, sendParams), new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(mayAct ? 'Command outcome uncertain' : 'Command timed out'), { code: mayAct ? 'uncertain' : 'command_timeout' })), deadline); })]).finally(() => clearTimeout(timer));
      };
      const inspection = ['DOM.getDocument', 'DOM.describeNode'].includes(method) && params.murageInspection === true;
      let sendParams = params;
      if (inspection) {
        const { murageInspection, ...cdpParams } = params;
        sendParams = { ...cdpParams, depth: Number.isInteger(params.depth) && params.depth >= 0 ? Math.min(params.depth, 4) : 4, pierce: true };
      }
      if (method === 'Accessibility.getFullAXTree') sendParams = { ...params, depth: Number.isSafeInteger(params.depth) && params.depth >= 0 ? Math.min(params.depth, AX_MAX_DEPTH) : AX_MAX_DEPTH };
      if (method === 'Page.captureScreenshot' && (params.format === undefined || params.format === 'png')) sendParams = { ...params, format: 'jpeg', quality: SHOT_QUALITY[0] };
      // A frame another site draws (a card form, a sign-in box) cannot be checked for private input from
      // here, so a screenshot hides it for the moment of the capture; if it cannot be hidden, no capture.
      const shot = method === 'Page.captureScreenshot';
      if (shot) { shotHidden = t; await presenceCapture(t, true, req.params.noLimits === true); }
      if (shot && req.params.noLimits !== true) await frameMask(t, false);
      let result;
      try {
        result = await sendOnce(sendParams);
        if (shot && sendParams.format === 'jpeg') {
          for (const quality of SHOT_QUALITY.filter(q => !(sendParams.quality <= q))) {
            if (nativeWireBytes(result) <= MAX_RESULT_BYTES) break;
            active(b, req.generation); result = await sendOnce({ ...sendParams, quality });
          }
        }
      } finally { if (shot && req.params.noLimits !== true) await frameMask(t, true).catch(() => {}); if (shot) await presenceCapture(t, false); }
      // A click or key that navigates replaces the document and its observer: there is nothing left to clear
      // or check, and that is not the owner taking over. The input was delivered; the result carries the new
      // document identity so the server can say truthfully that the page then navigated.
      const navigating = ['Page.navigate','Page.reload','Page.navigateToHistoryEntry'].includes(method);
      const moved = !navigating && (b.tabs.get(t.tabId) !== t || t.navigationEpoch !== req.params.navigationEpoch);
      // Only an input was an action that may have landed; anything read from the old document is stale.
      if (moved && !isInput) fail('stale_document');
      if (isInput && !moved) {
        if (await observerCall(t,'globalThis.__murageTakeover?.clear()')) { await fence(b,'paused','takeover'); fail('binding_inactive'); }
      }
      active(b, req.generation);
      if (!moved && !dialog && !['Page.navigate','Page.reload','Page.navigateToHistoryEntry'].includes(method)) await checkObserver(b,t);
      active(b, req.generation);
      // Navigation itself changes the epoch; its result is an acknowledgement, never page data.
      if (!moved && method !== 'Page.navigate' && method !== 'Page.reload' && method !== 'Page.navigateToHistoryEntry') await checkedTab(b, req.params, BOOTSTRAP_METHODS.has(method));
      if (inspection) result = method === 'DOM.getDocument' ? { root: inspectionDomPiece(result?.root) } : { node: inspectionDomPiece(result?.node) };
      if (method === 'Accessibility.getFullAXTree') result = boundAxTree(result, MAX_RESULT_BYTES - 4096);
      if (nativeWireBytes({ result: result ?? {}, tabId: t.tabId, navigationEpoch: t.navigationEpoch, origin: t.origin, url: t.url }) > MAX_RESULT_BYTES) fail('response_too_large');
      const [domain, verb] = method.split('.');
      if (EVENT_DOMAINS.has(domain) && (verb === 'enable' || verb === 'disable')) {
        t.subscriptions ??= new Map();
        if (verb === 'enable') t.subscriptions.set(method, structuredClone(params));
        else t.subscriptions.delete(`${domain}.enable`);
      }
      if (method === 'Target.setAutoAttach' && !child) {
        t.subscriptions ??= new Map();
        if (params.autoAttach === true) t.subscriptions.set(method, structuredClone(params));
        else t.subscriptions.delete(method);
      }
      if (method === 'Page.setLifecycleEventsEnabled') {
        t.subscriptions ??= new Map();
        if (params.enabled === true) t.subscriptions.set(method, { enabled: true });
        else t.subscriptions.delete(method);
      }
      if (method === 'Page.getFrameTree') (child ?? t).frameId = result.frameTree?.frame?.id;
      // Opus gate (round 10): t.contextId is where an idle or restart release disarms the private-input guard, so only the guard's own world sets it.
      // The server also asks for the overlay's world (R9-05); that context is allowed, but must not take the guard release away from the guard.
      if (method === 'Page.createIsolatedWorld') { if (!child && params.worldName === GUARD_WORLD) t.contextId = result.executionContextId; ((child ?? t).contextIds ??= new Set()).add(result.executionContextId); }
      if (method === 'Page.addScriptToEvaluateOnNewDocument' && result.identifier) (t.scripts ??= []).push(result.identifier);
      return { result: result ?? {}, tabId: t.tabId, navigationEpoch: t.navigationEpoch, origin: t.origin, url: t.url };
    } catch (error) {
      const gone = b.tabs.get(t.tabId) !== t || t.navigationEpoch !== req.params.navigationEpoch;
      if (isInput && !gone && t.takeover?.contextId !== undefined) await observerCall(t,'globalThis.__murageTakeover?.clear()').catch(() => {});
      if (error.code === 'takeover_unavailable' && b.state === 'active' && !gone) await fence(b,'paused','takeover');
      if (error.code === 'uncertain') { active(b, req.generation); await fence(b, 'paused', 'paused'); }
      throw error;
    } finally { if (shotHidden) await presenceCapture(shotHidden, false); if (ownsBusy) { writeBusy = false; lastCommandAt = Date.now(); } }
  }
  async function unshare(b, tabId, notify = true) {
    if (!b.tabs.has(tabId)) fail('tab_not_shared');
    const removed = b.tabs.get(tabId); b.tabs.delete(tabId); if (b.selectedTabId === tabId) b.selectedTabId = b.tabs.keys().next().value; b.generation++;
    const saved = saveSoon();
    try {
      // Removing the new-document script does not remove listeners already running in this
      // document: disarm the private-input guard here, the same way Pause and Stop do.
      if (b.attached.has(tabId)) await disarmGuard(tabId, removed);
      await removeObserver(removed);
      for (const identifier of removed.scripts ?? []) await api.debugger.sendCommand({ tabId }, 'Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => {});
    } finally { b.attached.delete(tabId); await api.debugger.detach({ tabId }).catch(() => {}); await settled(saved); }
    await api.action.setBadgeText({ tabId, text: '' }).catch(() => {}); if (notify) event(b, 'unshared', { tabId }); pushStatus(); return summary(b);
  }
  // A request that only looks at the page: the panel can say "Reading this page" while one is in flight.
  const isReadRequest = req => ['snapshot', 'read', 'screenshot', 'wait'].includes(req.operation) || (req.operation === 'cdp' && /^(Accessibility\.|DOM\.getDocument|Page\.captureScreenshot|Page\.getFrameTree)/.test(String(req.params?.method ?? '')));
  async function handleRequest(input) {
    const req = parseBrowserExtensionMessage(input);
    if (req.type !== 'command') fail('invalid_command');
    const response = { version: 1, type: 'response', id: req.id, bindingId: req.bindingId, generation: req.generation };
    const epoch = connectionEpoch;
    const reader = bindings.get(req.bindingId), reads = !!reader && isReadRequest(req);
    if (reads) { reader.reading = (reader.reading ?? 0) + 1; if (reader.reading === 1) pushStatus(); }
    try {
      const result = await execute(req);
      if (!connected || epoch !== connectionEpoch) fail('host_lost_uncertain');
      return { ...response, result };
    }
    catch (error) { return { ...response, error: { code: error.code ?? 'extension_error', message: error.code ?? 'Browser command failed' } }; }
    finally { if (reads) { reader.reading = Math.max(0, (reader.reading ?? 1) - 1); if (reader.reading === 0) pushStatus(); } if (inFlight?.id === req.id) { inFlight = undefined; saveSoon(); } }
  }
  // The owner takes the task back: sites are looked at again, the generation moves on and the app is told (event 'resumed').
  async function ownerResume(b, noLimits = false) {
    if (!connected) fail('host_offline');
    const generation = b.generation, seen = [];
    for (const t of b.tabs.values()) { const tab = await api.tabs.get(t.tabId); if (tab.incognito) fail('incognito_denied'); const origin = tab.url === 'about:blank' ? 'null' : originOf(tab.url, noLimits); if (!noLimits && origin !== 'null' && !b.approvedOrigins.includes(origin)) fail('site_denied'); seen.push([t, origin, tab.url]); }
    // The page was read across awaits: a Stop, Pause or disconnect that landed meanwhile wins, and nothing here brings the task back.
    if (!connected || b.state === 'stopped' || b.generation !== generation || bindings.get(b.id) !== b) fail('binding_inactive');
    for (const [t, origin, url] of seen) { t.origin = origin; t.url = url; t.navigationEpoch++; }
    // 1.0.1: resumedAt is the generation this Resume made, recorded at the bump and never changed. The app takes a Resume in only
    // through it (the event's own generation is stamped at emit, after the awaits below, and an unshare meanwhile moves it).
    b.generation++; const resumedAt = b.generation; b.state = 'active'; b.ready = false; delete b.pausedReason; delete b.handoff; delete b.yourTurn;
    await save(); await indicator(b); if (!noLimits) event(b, 'resumed', { ...summary(b), resumedAt }); return summary(b);
  }
  async function handlePanel(action) {
    if (action.action === 'status') return statusSnapshot();
    const b = bindings.get(action.bindingId); if (!b) fail('unknown_binding');
    if (action.action === 'avatar') return b.botAvatar ? { botAvatarId: b.botAvatarId, botAvatar: b.botAvatar } : {};
    if (action.action === 'stop' || action.action === 'pause') return fence(b, action.action === 'stop' ? 'stopped' : 'paused', action.action === 'stop' ? 'stopped' : 'paused');
    if (action.action === 'unshare') return unshare(b, action.tabId);
    // Owner actions the app carries out (it holds the bot's mode and the task). The runtime checks they apply, tells the app, and the app's next status shows the result.
    if (['endtask', 'setMode', 'turnoff', 'newtask'].includes(action.action)) {
      if (!connected) fail('host_offline');
      const mode = b.mode ?? (b.full ? 'full' : 'step');
      if (action.action === 'newtask') { if (b.state !== 'stopped') fail('binding_inactive'); event(b, 'notice', { kind: 'owner_new_task' }); return panelBinding(b); }
      if (b.state === 'stopped') fail('binding_stopped');
      if (action.action === 'endtask') event(b, 'notice', { kind: 'owner_end_task' });
      else if (action.action === 'turnoff') { if (mode !== 'full') fail('not_full'); event(b, 'notice', { kind: 'owner_turn_off' }); }
      else {
        // Only tighter: step or task, and only below the current mode.
        const rank = { step: 0, task: 1, full: 2 };
        if (!['step', 'task'].includes(action.mode) || rank[action.mode] >= rank[mode]) fail('invalid_action');
        event(b, 'notice', { kind: 'owner_set_mode', mode: action.mode });
      }
      return panelBinding(b);
    }
    if (action.action === 'share') {
      if (!connected || b.state !== 'active') fail('binding_inactive');
      // A site not allowed yet: ask the owner in Murage (a site card), then Share works. Origin only, never the address.
      let origin;
      try { const tab = await api.tabs.get(action.tabId); if (tab.incognito) fail('incognito_denied'); origin = originOf(tab.url, b.noLimits); } catch (error) { if (error.code === 'incognito_denied') throw error; /* the share below reports why */ }
      if (origin && !b.approvedOrigins.includes(origin)) event(b, 'notice', { kind: 'share_requested', tabId: action.tabId, origin });
      const result = await addTab(b, action.tabId); event(b, 'status', summary(b)); return result; }
    if (action.action === 'resume') {
      // A task the owner stopped stays stopped; a new task from the owner (a new binding) is the way back.
      if (b.state === 'stopped') fail('binding_stopped');
      // A handoff is answered with Continue, never a plain Resume: the owner says they finished the step.
      if (handoffWaiting(b)) fail('handoff_use_continue');
      return ownerResume(b);
    }
    if (action.action === 'continue') {
      if (!handoffWaiting(b)) fail('not_handoff');
      return ownerResume(b);
    }
    // Revoking an origin only ever narrows what the bot may do: the grant goes, and so do the tabs shared from that site.
    if (action.action === 'revoke') {
      if (b.state === 'stopped') fail('binding_stopped');
      let origin; try { origin = originOf(String(action.origin)); } catch { fail('site_denied'); }
      b.approvedOrigins = b.approvedOrigins.filter(o => o !== origin); b.revoked = [...new Set([...(b.revoked ?? []), origin])].slice(-128); if (b.grants) b.grants = b.grants.filter(g => g.origin !== origin); b.bindEpoch = (b.bindEpoch ?? 0) + 1;
      for (const t of [...b.tabs.values()]) if (t.origin === origin) await unshare(b, t.tabId, false);
      await save(); event(b, 'notice', { kind: 'owner_revoked', origin }); pushStatus(); return summary(b);
    }
    fail('invalid_action');
  }
  // A tab an owned tab opened (a target=_blank link, an OAuth popup). It is adopted only when its
  // site is already approved for the binding; otherwise it stays private and the bot is told.
  async function tabCreated(tab) {
    if (!connected || !Number.isSafeInteger(tab?.id) || !Number.isSafeInteger(tab?.openerTabId)) return;
    if ([...bindings.values()].some(other => other.tabs.has(tab.id))) return;
    for (const b of bindings.values()) {
      if (!b.tabs.has(tab.openerTabId) || b.state !== 'active' || !b.ready) continue;
      if (candidates.size >= MAX_OPENER_CANDIDATES) candidates.delete(candidates.keys().next().value);
      candidates.set(tab.id, b.id); return;
    }
  }
  // webNavigation.onCreatedNavigationTarget names the tab a new tab really came from. tabs.onCreated's openerTabId is
  // taken from the ACTIVE tab when the clicking tab is in the background (the bot's tab always is), so it can name the
  // wrong tab either way. Where this event exists it decides: an owned source is a candidate, any other source is not.
  async function navigationTarget(details) {
    if (!connected || !Number.isSafeInteger(details?.tabId)) return;
    candidates.delete(details.tabId);
    if (!Number.isSafeInteger(details.sourceTabId)) return;
    await tabCreated({ id: details.tabId, openerTabId: details.sourceTabId });
    const sourceBinding = bindings.get(candidates.get(details.tabId));
    if (sourceBinding) recordDownloadEvent(sourceBinding, 'announce', details.url, sourceBinding.tabs.get(details.sourceTabId)?.url, details.tabId);
    // A new tab the bot's tab opened is not attached, so it announces no download. Its first address is the announcement:
    // a download from it is the bot's (a target=_blank link to a file), and is blocked like one from the bot's own tab.
    if (candidates.has(details.tabId) && typeof details.url === 'string' && details.url && details.url !== 'about:blank') { popupUrls.set(details.tabId, details.url); while (popupUrls.size > MAX_OPENER_CANDIDATES) popupUrls.delete(popupUrls.keys().next().value); await blockDownload(details.url, popupNotify(details), sourceBinding?.id, sourceBinding?.tabs.get(details.sourceTabId)?.url, details.tabId); }
  }
  // A popup's first address may still turn out to be a page, so only a kept file (an item already let through under that address during
  // bot activity, so a real download) is said from here; "blocked" waits for a real announcement.
  function popupNotify(details) {
    const b = bindings.get(candidates.get(details.tabId));
    const origin = b?.tabs.get(details.sourceTabId)?.origin ?? '';
    let name = '';
    try { name = clip(decodeURIComponent(new URL(details.url).pathname.split('/').pop() ?? ''), 80); } catch { name = ''; }
    return kind => { if (kind !== 'download_kept' || !b || b.state !== 'active') return false; event(b, 'notice', { kind, tabId: details.sourceTabId, origin, name }); return true; };
  }
  async function openerNavigation(details) {
    if (!details.url || details.url === 'about:blank') return; // still waiting for the first real page
    const b = bindings.get(candidates.get(details.tabId)); candidates.delete(details.tabId);
    // The new tab showed a page, so its first address was not a download: it no longer stands for one.
    const announced = popupUrls.get(details.tabId); popupUrls.delete(details.tabId);
    if (announced) {
      blockedUrls.delete(announced);
      // decide() reads raw events, so the announce and arm this popup's first address made go too; any other tab's stay.
      for (const e of [...downloadEvents]) if ((e.kind === 'arm' || e.kind === 'announce') && e.tabId === details.tabId && e.url === announced) downloadEvents.delete(e);
    }
    if (!b || !connected || b.state !== 'active' || !b.ready) return;
    const generation = b.generation;
    let origin = '';
    try { origin = originOf(details.url, b.noLimits); } catch { origin = ''; }
    if (origin && (b.noLimits || b.approvedOrigins.includes(origin))) {
      try { await addTab(b, details.tabId, false, generation); event(b, 'notice', { kind: 'tab_opened', tabId: details.tabId, origin, adopted: true }); return; } catch { /* reported below */ }
    }
    event(b, 'notice', { kind: 'tab_opened', tabId: details.tabId, origin, adopted: false });
  }
  async function navigation(details, sameDocument = false) {
    if (details.frameId !== 0) return;
    if (candidates.has(details.tabId)) { await openerNavigation(details); return; }
    for (const b of bindings.values()) {
      const t = b.tabs.get(details.tabId); if (!t) continue;
      // Only what is stored (the site and address) is written: the epoch is not durable, and an idle or stopped binding writes nothing.
      const stored = `${t.origin}\0${t.url}`;
      // CDP may have already committed this navigation. Keep its main frame identity for lifecycle events.
      // Page.frameNavigated replaces it when needed; the epoch still fences every old-document command.
      if (!sameDocument || !b.noLimits) { forgetChildSessions(b, t); t.navigationEpoch++; t.bootstrap = false; delete t.contextId; delete t.contextIds; if (t.takeover) delete t.takeover.contextId; }
      if (b.state !== 'active' || !b.ready) { t.origin = ''; t.url = ''; if (stored !== '\0') await save(); continue; }
      try { t.origin = originOf(details.url, b.noLimits); t.url = (b.noLimits || b.approvedOrigins.includes(t.origin)) ? details.url : ''; } catch { t.origin = ''; t.url = ''; }
      if (`${t.origin}\0${t.url}` !== stored) await save();
      if (!b.noLimits && !b.approvedOrigins.includes(t.origin)) await fence(b, 'paused', 'paused');
      // No title, frame or page contents leave on browser events. The URL, query
      // included, leaves only for an approved origin (the same URL get_url reads);
      // an unapproved origin sends no URL at all.
      else event(b, 'navigation', { tabId: t.tabId, navigationEpoch: t.navigationEpoch, origin: t.origin, url: t.url });
    }
  }
  async function debuggerEvent(source, method, params) {
    if (source.tabId === undefined) return;
    for (const b of bindings.values()) {
      const t = b.tabs.get(source.tabId);
      if (!t || !connected || !b.ready || b.state !== 'active' || !b.attached.has(t.tabId)) continue;
      if (source.sessionId && (!b.noLimits || !t.childSessions?.has(source.sessionId))) continue;
      const sessionState = source.sessionId ? t.childSessions.get(source.sessionId) : t;
      if (method === 'Target.attachedToTarget' && b.noLimits && params.targetInfo?.type === 'iframe') {
        (t.childSessions ??= new Map()).set(params.sessionId, { contextIds: new Set() });
      }
      if (method === 'Target.detachedFromTarget') t.childSessions?.delete(params.sessionId);
      if (method === 'Runtime.bindingCalled' && source.sessionId) continue;
      if (method === 'Runtime.bindingCalled') {
        if (params.name === t.takeover?.name && params.executionContextId === t.takeover?.contextId && params.payload === 'pause') await fence(b,'paused','takeover');
        // The overlay's own pill and fallback signal: only from the presence world's context, never the page's.
        else if (t.presence && params.name === t.presence.name && params.executionContextId === t.presence.contextId) {
          if (params.payload === 'pause') await fence(b, 'paused', 'paused');
          else if (params.payload === 'stop') await fence(b, 'stopped', 'stopped');
          else if (params.payload === 'continue') event(b, 'notice', { kind: 'owner_continue', tabId: t.tabId, origin: t.origin });
          else if (params.payload === 'fallback') await drawFallback(t);
        }
        continue;
      }
      // What the owner's page did that the bot cannot see otherwise: said in plain words by the server.
      if (method === 'Page.downloadWillBegin') announceAction(b, t, params.url);
      if (method === 'Page.downloadWillBegin' && b.noLimits) continue;
      if (method === 'Page.downloadWillBegin') { const name = clip(params.suggestedFilename, 80), tabId = t.tabId, origin = t.origin; await blockDownload(params.url, kind => event(b, 'notice', { kind, tabId, origin, name }), b.id, t.url, tabId); continue; }
      if (method === 'Page.javascriptDialogOpening') event(b, 'notice', { kind: 'dialog', tabId: t.tabId, origin: t.origin, dialogType: clip(params.type, 16), text: clip(params.message, 500) });
      // Setup context/lifecycle metadata may be needed before first navigation;
      // page contents, console and arbitrary CDP notifications never leave here.
      if (method === 'Page.frameNavigated' && !params.frame?.parentId) sessionState.frameId = params.frame?.id;
      if (method === 'Runtime.executionContextsCleared') sessionState.contextIds?.clear();
      const data = scopedCdpEvent(method, params, sessionState === t ? t : { ...sessionState, origin: t.origin }, b.noLimits);
      if (!data) continue;
      if (method === 'Runtime.executionContextCreated') (sessionState.contextIds ??= new Set()).add(params.context.id);
      if (method === 'Runtime.executionContextDestroyed') sessionState.contextIds?.delete(params.executionContextId);
      if (JSON.stringify(data).length > 65536) continue;
      event(b, 'cdp', { tabId: t.tabId, navigationEpoch: t.navigationEpoch, method, params: data, ...(source.sessionId ? { sessionId: source.sessionId } : {}) });
    }
  }
  // What a saved binding record may carry. Anything else is dropped, and a record that fails these checks grants nothing.
  const isId = v => typeof v === 'string' && v.length > 0 && v.length <= 128;
  function readRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined;
    if (!isId(record.id) || !Number.isSafeInteger(record.generation) || record.generation < 0 || record.generation > 2 ** 31) return undefined;
    if (typeof record.botName !== 'string' || !Array.isArray(record.approvedOrigins) || record.approvedOrigins.length > 128) return undefined;
    if (!['active', 'paused', 'stopped'].includes(record.state) || (record.tabs !== undefined && !Array.isArray(record.tabs))) return undefined;
    // A revoke that cannot be read back cannot be honoured, so the whole record is dropped rather than its grants returned.
    if (record.revoked !== undefined && (!Array.isArray(record.revoked) || record.revoked.length > 128)) return undefined;
    for (const o of [...record.approvedOrigins, ...(record.revoked ?? [])]) { try { if (typeof o !== 'string' || originOf(o) !== o) return undefined; } catch { return undefined; } }
    const keep = {};
    for (const [key, ok] of [['color', v => typeof v === 'string'], ['groupId', Number.isSafeInteger], ['windowId', Number.isSafeInteger], ['bindEpoch', Number.isSafeInteger],
      ['botColor', v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)], ['conversation', v => typeof v === 'string'], ['mode', v => MODES.has(v)], ['full', v => typeof v === 'boolean']]) if (ok(record[key])) keep[key] = record[key];
    if (record.pausedReason === 'handoff' && record.state === 'paused') { keep.pausedReason = 'handoff'; keep.yourTurn = true; if (typeof record.handoff === 'string') keep.handoff = clip(record.handoff, 200); }
    if (record.revoked?.length) keep.revoked = [...record.revoked];
    return { ...keep, id: record.id, botName: record.botName.slice(0, 80), generation: record.generation, state: record.state, approvedOrigins: record.approvedOrigins.filter(o => !keep.revoked?.includes(o)),
      tabs: (Array.isArray(record.tabs) ? record.tabs : []).filter(t => Number.isSafeInteger(t?.tabId)).slice(0, 64).map(t => ({ tabId: t.tabId, origin: typeof t.origin === 'string' ? t.origin : '' })) };
  }
  async function quarantine(raw, reason) {
    let copy; try { const text = JSON.stringify(raw); copy = text !== undefined && text.length <= 1_000_000 ? raw : { truncated: true, bytes: text?.length ?? 0 }; } catch { copy = { unreadable: true }; }
    try { await api.storage.local.set({ [QUARANTINE_KEY]: { at: Date.now(), reason, state: copy } }); } catch { /* the copy is best effort; the clean start does not depend on it */ }
  }
  async function initialize() {
    let stored, readable = true;
    try { stored = (await api.storage.local.get(STORAGE_KEY))[STORAGE_KEY]; } catch { readable = false; }
    // The store could not be read: start clean in memory, show the marker, and write nothing that could replace what is there.
    if (!readable) { readOnly = true; persistenceFailed = true; recovery = { code: 'storage_unavailable', message: RECOVERY_MESSAGES.storage_unavailable }; profileId = uuid(); return profileId; }
    const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
    const previous = [];
    let damaged = false;
    const raw = stored;
    if (stored !== undefined && !plain(stored)) { damaged = true; stored = undefined; }
    if (plain(stored) && stored.schema !== undefined && !Number.isSafeInteger(stored.schema)) damaged = true;
    // A newer layout is preserved exactly as it is: nothing here reads it as grants, and nothing writes over it.
    if (plain(stored) && Number.isSafeInteger(stored.schema) && stored.schema > STATE_SCHEMA) {
      readOnly = true; recovery = { code: 'update_required', message: RECOVERY_MESSAGES.update_required }; profileId = isId(stored.profileId) ? stored.profileId : uuid(); return profileId;
    }
    stored = plain(stored) ? stored : undefined;
    profileId = isId(stored?.profileId) ? stored.profileId : uuid();
    if (stored && !isId(stored.profileId)) damaged = true;
    const lost = stored?.inFlight;
    if (lost && typeof lost.id === 'string' && typeof lost.bindingId === 'string' && Number.isSafeInteger(lost.generation)) restartReport = lost;
    if (stored?.retired !== undefined && !Array.isArray(stored.retired)) damaged = true;
    for (const id of Array.isArray(stored?.retired) ? stored.retired.slice(-MAX_RETIRED) : []) if (isId(id)) retired.add(id);
    // Browser tab IDs are not durable authority across a worker/browser restart. Every tab a record names is released, valid record or not.
    const list = Array.isArray(stored?.bindings) ? stored.bindings : plain(stored?.bindings) ? Object.values(stored.bindings) : [];
    if (stored?.bindings !== undefined && !Array.isArray(stored.bindings)) damaged = true;
    for (const record of list) for (const t of Array.isArray(record?.tabs) ? record.tabs : []) if (Number.isSafeInteger(t?.tabId) && previous.length < 64) previous.push({ tabId: t.tabId, origin: typeof t.origin === 'string' ? t.origin : '' });
    if (Array.isArray(stored?.bindings)) for (const record of stored.bindings) {
      const read = readRecord(record);
      if (!read || bindings.has(read.id) || bindings.size >= MAX_BINDINGS) { damaged = true; continue; }
      bindings.set(read.id, { ...read, generation: read.generation + 1, state: read.state === 'stopped' ? 'stopped' : 'paused', ready: false, selectedTabId: undefined, tabs: new Map(), attached: new Set() });
    }
    // Damaged state grants nothing: the readable parts are kept, the rest is copied aside, and the owner is asked to share again.
    if (damaged) { await quarantine(raw, 'malformed'); recovery = { code: 'reshare_required', message: RECOVERY_MESSAGES.reshare_required }; }
    await save().catch(() => {});
    for (const b of bindings.values()) { await detach(b); await indicator(b); }
    await releaseAbandonedTabs(previous);
    return profileId;
  }
  async function connection(value) {
    if (value) {
      // Wait for old debugger detach before accepting any new connection work.
      await disconnecting;
      if (!connected) { connectionEpoch++; requestNonce = undefined; lastRequestSequence = 0; connected = true; }
    } else if (connected) {
      connected = false; connectionEpoch++;
      // Fence every binding synchronously, before storage or debugger awaits.
      for (const b of bindings.values()) { b.noLimits = false; b.generation++; b.state = b.state === 'stopped' ? 'stopped' : 'paused'; b.ready = false; }
      disconnecting = (async () => {
        // Release first, record second: a rejected save leaves the marker and never a held page.
        const saved = saveSoon();
        try { await Promise.all([...bindings.values()].map(async b => { try { await detach(b); } finally { await indicator(b).catch(() => {}); } })); }
        finally { await settled(saved); }
      })();
      await disconnecting;
    }
    return { version: 1, type: 'hello', profileId, browser: 'chromium', extensionVersion: api.runtime.getManifest().version, capabilities: ['panel_avatar_v1', 'scoped_cdp', 'durable_stop', 'explicit_share', 'manual_pause', 'unexpected_input_pause', 'engine_cdp_v1', 'ordered_requests_v1', LIFECYCLE_CAPABILITY] };
  }
  // The browser restarted during an action: tell the server it may have run. Never retried here.
  function restartReports() {
    const lost = restartReport; restartReport = undefined;
    if (!lost) return [];
    const generation = bindings.get(lost.bindingId)?.generation ?? lost.generation;
    return [{ version: 1, type: 'response', id: lost.id, bindingId: lost.bindingId, generation, error: { code: 'uncertain', message: 'The browser restarted during the last action.' } }];
  }
  const driving = () => [...bindings.values()].some(b => b.state === 'active');
  // An action actually in progress (a command running, or one journaled and not yet settled). An authorized idle binding is not busy,
  // so a waiting extension update can apply at the next quiet moment.
  const busy = () => writeBusy || inFlight !== undefined;
  const drivingBotName = () => [...bindings.values()].find(b => b.state === 'active')?.botName;
  async function pauseDriving() { let n = 0; for (const b of [...bindings.values()]) if (b.state === 'active') { await fence(b, 'paused', 'paused'); n++; } return n; }
  // A replaced tab id is dropped, never re-attached; its replacement is not owned until the owner shares it.
  async function replaced(_addedId, removedId) { for (const b of [...bindings.values()]) if (b.tabs.has(removedId)) { event(b, 'notice', { kind: 'tab_replaced', tabId: removedId }); await unshare(b, removedId); } }
  // A discarded tab loses its page: advance the epoch so every earlier snapshot is stale.
  async function discarded(tabId) {
    for (const b of bindings.values()) {
      const t = b.tabs.get(tabId); if (!t) continue;
      t.navigationEpoch++; t.bootstrap = false; delete t.contextId; delete t.contextIds; delete t.childSessions; delete t.frameId; if (t.takeover) delete t.takeover.contextId;
      event(b, 'notice', { kind: 'tab_discarded', tabId, navigationEpoch: t.navigationEpoch });
    }
  }
  // Supplied only by isolated tests; production callers expose no test surface.
  if (options.downloadTestHooks) Object.assign(options.downloadTestHooks, {
    settled: id => downloadHolds.get(id)?.resuming ?? downloadHolds.get(id)?.settled ?? Promise.resolve(),
    hasHold: id => downloadHolds.has(id),
    observations: id => [...(downloadItems.get(id)?.events ?? [])],
    deadline: id => downloadHolds.get(id)?.deadline,
  });
  return { restartReports, driving, busy, setUpdateWaiting: value => { updateWaiting = !!value; pushStatus(); }, status: statusSnapshot, drivingBotName, pauseDriving, replaced, discarded, initialize, connection, handleRequest, handlePanel, navigation, tabCreated, navigationTarget, downloadCreated, downloadDetermining, downloadChanged, debuggerEvent, removed: async tabId => { candidates.delete(tabId); for (const b of bindings.values()) if (b.tabs.has(tabId)) await unshare(b, tabId); }, detached: async tabId => { for (const b of bindings.values()) if (b.attached.has(tabId)) { b.attached.delete(tabId); await fence(b, 'paused', 'takeover'); } } };
}
