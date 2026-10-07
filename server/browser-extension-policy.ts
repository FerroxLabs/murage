// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomUUID } from "node:crypto";
import { PROTECTED_DOMAINS, PROTECTED_DOMAINS_VERSION } from "../shared/browser-protected-domains.ts";
import { categoryFor } from "../shared/browser-site-categories.ts";
import { navigationCarriesData } from "./browser-intent.ts";
export { PROTECTED_DOMAINS, PROTECTED_DOMAINS_VERSION };
export type BindingIdentity = { bindingId: string; workspaceId: string; botId: string; threadId: string; clientId: string; profileId: string };
export type BindingContext = BindingIdentity & { generation: number };
export type BrowserDocument = { profileId: string; tabId: number; frameId: number; navigationEpoch: number; origin: string };
export type BrowserAction = { operation: string; document: BrowserDocument; targetDigest: string; params?: unknown; destination?: string; protectedDocument?: boolean;
  /** The bot has read page content in this binding, so a destination it picks may carry some of it. */
  pageDataRead?: boolean;
  /** The destination is a link the current page itself presents (an anchor in the document). */
  presentedLink?: boolean;
  /** The owner's task asked for this navigation (the address in the owner's own instruction, or a search-result
   * open), and it is the first such free one for that instruction. Decided by the service, never by tool input. */
  ownerRequested?: boolean;
  /** T20: the level the service's decision gave this step. Only "L2" can use an L2 grant, and the grant is held here, never read from the action. */
  level?: "L2" };
/** Why a binding is paused beyond the owner pressing Pause: "handoff" is the hard floor asking for the owner. */
export type PausedReason = "handoff" | "uncertain";
export type SiteAccess = "allow" | "ask" | "never";
type Tab = { document: BrowserDocument; url: string };
type Binding = { context: BindingContext; state: "active" | "paused" | "stopped"; pausedReason?: PausedReason; tabs: Map<number, Tab>; sites: Map<string, SiteAccess>; l2: Set<string> };
type Grant = { context: BindingContext; digest: string; expiresAt: number };
export class BrowserExtensionPolicyError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = "BrowserExtensionPolicyError"; this.code = code; }
}
function deny(code: string): never { throw new BrowserExtensionPolicyError(code); }
const identifier = /^[A-Za-z0-9_-]{1,128}$/;
function validId(value: unknown): value is string { return typeof value === "string" && identifier.test(value); }
function positive(value: number) { if (!Number.isSafeInteger(value) || value < 1) deny("invalid_generation"); }
function sameContext(a: BindingContext, b: BindingContext) { return ["bindingId", "workspaceId", "botId", "threadId", "clientId", "profileId", "generation"].every(key => a[key as keyof BindingContext] === b[key as keyof BindingContext]); }
function canonical(value: unknown, depth = 0): string {
  if (depth > 20) deny("invalid_action");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(item => canonical(item, depth + 1)).join(",") + "]";
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key], depth + 1)).join(",") + "}";
  return deny("invalid_action");
}
export function browserActionDigest(action: BrowserAction): string {
  const text = canonical(action); if (Buffer.byteLength(text) > 65536) deny("invalid_action");
  return createHash("sha256").update(text).digest("hex");
}
export class BrowserExtensionPolicy {
  private bindings = new Map<string, Binding>();
  private owners = new Map<string, string>();
  private approvals = new Map<string, Grant>();
  private mutations = new Map<string, symbol>();
  private readonly now: () => number;
  private readonly protectedOrigins: Set<string>;
  constructor(options: { now?: () => number; protectedOrigins?: string[] } = {}) {
    this.now = options.now ?? Date.now;
    this.protectedOrigins = new Set((options.protectedOrigins ?? []).map(value => new URL(value).origin));
  }
  /** Used only by the authenticated broker after profile reconciliation. */
  bind(identity: BindingIdentity, generation = 1): BindingContext {
    if (!identity || Object.keys(identity).length !== 6 || ["bindingId", "workspaceId", "botId", "threadId", "clientId", "profileId"].some(key => !validId(identity[key as keyof BindingIdentity]))) deny("invalid_binding"); positive(generation);
    if (this.bindings.has(identity.bindingId)) deny("binding_exists");
    if (this.bindings.size >= 256) deny("binding_capacity");
    const context = { ...identity, generation };
    this.bindings.set(identity.bindingId, { context, state: "active", tabs: new Map(), sites: new Map(), l2: new Set() });
    return { ...context };
  }
  private binding(context: BindingContext, active = true): Binding {
    const binding = this.bindings.get(context.bindingId);
    if (!binding || !sameContext(binding.context, context)) deny("stale_binding");
    if (active && binding.state !== "active") deny(binding.state);
    return binding;
  }
  private url(value: string): URL {
    let url: URL; try { url = new URL(value); } catch { return deny("invalid_url"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) deny("handover_required");
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    // T21: only the handover-only category is closed here (password managers, browser and extension stores). Banks, health and
    // government sites are ask-every-step and adult/piracy sites are Never by default; those are decided per action in the service.
    if (categoryFor(host) === "handover" || this.protectedOrigins.has(url.origin)) deny("handover_required");
    return url;
  }
  /** Owner choice only; callers must never map tool input to this API. */
  setSiteAccess(context: BindingContext, origin: string, access: SiteAccess): void {
    const binding = this.binding(context, false); const url = this.url(origin);
    if (url.origin !== origin || !["allow", "ask", "never"].includes(access)) deny("invalid_site_grant");
    binding.sites.set(origin, access); if (access !== "allow") binding.l2.delete(origin); this.invalidate(context.bindingId);
  }
  /** T20: the owner's Level 2 grant for one site, held here so the check itself enforces it. Only the service calls this, after the
   * owner answered the Level 2 card (or the site is Allow always). It needs the site to be allowed, and ends with the site's access,
   * a Stop, a retire or an explicit revoke. It exempts Level 2 mutations only; Level 3, disclosure and the floor are never exempted. */
  grantL2(context: BindingContext, origin: string): void {
    const binding = this.binding(context);
    if (this.url(origin).origin !== origin || binding.sites.get(origin) !== "allow") deny("invalid_site_grant");
    binding.l2.add(origin);
  }
  revokeL2(context: BindingContext, origin?: string): void {
    const binding = this.binding(context, false);
    if (origin === undefined) binding.l2.clear(); else binding.l2.delete(origin);
    this.invalidate(context.bindingId);
  }
  /** Explicit owner share (or broker-owned bootstrap), never group-membership inference. */
  share(context: BindingContext, document: BrowserDocument, url: string): void {
    const binding = this.binding(context);
    this.validateDocument(document, context.profileId);
    if (url === "about:blank") { if (document.origin !== "null") deny("invalid_document"); }
    else if (this.url(url).origin !== document.origin) deny("invalid_document");
    const key = context.profileId + ":" + document.tabId;
    if (this.owners.has(key)) deny("tab_already_shared");
    if (binding.tabs.size >= 64) deny("tab_capacity");
    this.owners.set(key, context.bindingId); binding.tabs.set(document.tabId, { document: { ...document }, url });
  }
  unshare(context: BindingContext, tabId: number): BindingContext {
    const binding = this.binding(context, false);
    if (!binding.tabs.delete(tabId)) deny("tab_not_shared");
    this.owners.delete(context.profileId + ":" + tabId); return this.fence(binding);
  }
  /** Every committed/history/hash/BFCache transition must reach this hook before results. */
  navigate(context: BindingContext, document: BrowserDocument, url: string): void {
    const binding = this.binding(context, false); this.validateDocument(document, context.profileId);
    const tab = binding.tabs.get(document.tabId); if (!tab) deny("tab_not_shared");
    if (document.navigationEpoch <= tab.document.navigationEpoch) deny("stale_document");
    // Record even protected destinations so old document grants cannot survive a refused redirect.
    let origin: string; try { origin = new URL(url).origin; } catch { return deny("invalid_url"); }
    if (origin !== document.origin) deny("invalid_document");
    tab.document = { ...document }; tab.url = url; this.invalidate(context.bindingId);
  }
  private validateDocument(document: BrowserDocument, profileId: string) {
    if (document.profileId !== profileId || !Number.isSafeInteger(document.tabId) || document.tabId < 0 || document.frameId !== 0 || !Number.isSafeInteger(document.navigationEpoch) || document.navigationEpoch < 0 || typeof document.origin !== "string") deny("invalid_document");
  }
  private invalidate(bindingId: string) { for (const [id, grant] of this.approvals) if (grant.context.bindingId === bindingId) this.approvals.delete(id); }
  private fence(binding: Binding): BindingContext {
    if (binding.context.generation >= Number.MAX_SAFE_INTEGER) deny("generation_exhausted");
    binding.context.generation++; this.invalidate(binding.context.bindingId); return { ...binding.context };
  }
  pause(context: BindingContext, reason?: PausedReason): BindingContext { const binding = this.binding(context, false); if (binding.state === "stopped") deny("stopped"); binding.state = "paused"; binding.pausedReason = reason; return this.fence(binding); }
  /** L11b: a retired binding gives back its slot, its tab owners and its pending approvals. */
  unbind(context: BindingContext): void {
    const binding = this.binding(context, false);
    for (const tabId of binding.tabs.keys()) if (this.owners.get(context.profileId + ":" + tabId) === context.bindingId) this.owners.delete(context.profileId + ":" + tabId);
    binding.l2.clear(); this.invalidate(context.bindingId); this.bindings.delete(context.bindingId);
  }
  stop(context: BindingContext): BindingContext { const binding = this.binding(context, false); binding.state = "stopped"; binding.l2.clear(); return this.fence(binding); }
  /** Explicit owner resume after reconciling the live document. Reconnect must not call this. */
  resume(context: BindingContext, documents: BrowserDocument[]): BindingContext {
    const binding = this.binding(context, false);
    if (documents.length !== binding.tabs.size || new Set(documents.map(document => document.tabId)).size !== documents.length) deny("document_reconciliation_required");
    for (const document of documents) { const tab = binding.tabs.get(document.tabId); if (!tab || canonical(tab.document) !== canonical(document)) deny("stale_document"); this.url(tab.url); }
    binding.state = "active"; binding.pausedReason = undefined; return this.fence(binding);
  }
  /** Authenticated runtime state only. Observation cannot undo a local Stop or Pause. */
  reconcile(context: BindingContext, update: { generation: number; state: "active" | "paused" | "stopped"; documents: { document: BrowserDocument; url: string }[]; reason: "observe" | "owner-resume"; pausedReason?: PausedReason }): BindingContext {
    const binding = this.binding(context, false); positive(update.generation);
    if (update.generation < context.generation || update.generation - context.generation > 1000000 || !["active", "paused", "stopped"].includes(update.state) || !["observe", "owner-resume"].includes(update.reason)) deny("invalid_reconciliation");
    if (update.reason === "owner-resume" && (update.state !== "active" || update.generation <= context.generation)) deny("invalid_reconciliation");
    if (update.reason === "observe" && ((binding.state !== "active" && update.state === "active") || (binding.state === "stopped" && update.state !== "stopped"))) deny("owner_resume_required");
    if (update.state !== binding.state && update.generation <= context.generation) deny("stale_binding");
    if (!Array.isArray(update.documents) || update.documents.length > 64) deny("invalid_reconciliation");
    const tabs = new Map<number, Tab>();
    for (const entry of update.documents) {
      const document = entry.document; this.validateDocument(document, context.profileId);
      if (tabs.has(document.tabId)) deny("invalid_reconciliation");
      // Reconciliation reports previously granted tabs; it cannot silently share new tabs.
      const prior = binding.tabs.get(document.tabId);
      if (!prior || this.owners.get(context.profileId + ":" + document.tabId) !== context.bindingId) deny("tab_not_shared");
      if (document.navigationEpoch < prior.document.navigationEpoch) deny("stale_document");
      if (document.navigationEpoch === prior.document.navigationEpoch && (canonical(document) !== canonical(prior.document) || entry.url !== prior.url)) deny("stale_document");
      let origin: string; try { origin = new URL(entry.url).origin; } catch { return deny("invalid_url"); }
      if (origin !== document.origin) deny("invalid_document");
      if (update.state === "active" && entry.url !== "about:blank") this.url(entry.url);
      if (update.reason === "owner-resume" && entry.url === "about:blank") deny("bootstrap_only");
      tabs.set(document.tabId, { document: { ...document }, url: entry.url });
    }
    // All checks precede mutation so a hostile trailing document changes nothing.
    for (const tabId of binding.tabs.keys()) if (!tabs.has(tabId)) this.owners.delete(context.profileId + ":" + tabId);
    binding.tabs = tabs; binding.context.generation = update.generation; binding.state = update.state;
    binding.pausedReason = update.state === "paused" ? (update.pausedReason ?? binding.pausedReason) : undefined;
    this.invalidate(context.bindingId); return { ...binding.context };
  }
  status(bindingId: string) { const binding = this.bindings.get(bindingId); if (!binding) deny("unknown_binding"); return { context: { ...binding.context }, state: binding.state, ...(binding.pausedReason ? { pausedReason: binding.pausedReason } : {}), documents: [...binding.tabs.values()].map(tab => ({ ...tab.document })) }; }
  check(context: BindingContext, action: BrowserAction): { digest: string; requiresApproval: boolean; mutation: boolean } {
    const binding = this.binding(context); const document = action.document;
    this.validateDocument(document, context.profileId);
    const tab = binding.tabs.get(document.tabId);
    if (!tab || this.owners.get(context.profileId + ":" + document.tabId) !== context.bindingId) deny("tab_not_shared");
    if (canonical(tab.document) !== canonical(document)) deny("stale_document");
    if (action.protectedDocument) deny("handover_required");
    if (typeof action.targetDigest !== "string" || !/^[a-f0-9]{64}$/.test(action.targetDigest) || !validId(action.operation)) deny("invalid_action");
    const destination = action.destination === undefined ? undefined : this.url(action.destination);
    // A bootstrap document allows only navigation, never reads or scripts.
    if (tab.url === "about:blank") { if (action.operation !== "navigate" || !destination) deny("bootstrap_only"); }
    else { this.url(tab.url); this.site(binding, document.origin); }
    if (destination) this.site(binding, destination.origin);
    // Looking around changes nothing: scrolling, focusing and hovering are free on an allowed site.
    const read = ["snapshot", "read", "screenshot", "status", "tab_list", "scroll", "focus", "hover"].includes(action.operation);
    const navigation = action.operation === "navigate";
    const mutation = !read && !navigation;
    const disclosure = !!destination && this.discloses(tab, document, destination, action);
    // T20: a Level 2 action on a site holding an L2 grant needs no approval token. Everything else a mutation does keeps it.
    const exempt = mutation && !disclosure && action.level === "L2" && binding.l2.has(document.origin) && binding.sites.get(document.origin) === "allow";
    return { digest: browserActionDigest(action), requiresApproval: (mutation && !exempt) || disclosure, mutation: mutation || disclosure };
  }
  /** Whether going to `destination` could carry page-derived or conversation data out, so the owner must see it.
   * The rule is deliberately simple and does not inspect what the text looks like:
   *  - another origin: anything beyond the bare origin (a path, a query or a fragment) is data;
   *  - the same origin: a different path or query is data once the bot has read page content,
   *    unless it is a link the page itself presents. Moving within the same document is free. */
  private discloses(tab: Tab, document: BrowserDocument, destination: URL, action: BrowserAction): boolean {
    // T27's I6 is the one rule: the same decision as the intent check makes, so the two can never drift.
    // The navigation the owner's task asked for is level 1 (free); site access is still checked above.
    return navigationCarriesData({
      operation: action.operation, level: "L1", origin: document.origin, destination: destination.href, currentUrl: tab.url,
      ...(action.ownerRequested === true ? { ownerRequested: true } : {}), ...(action.pageDataRead === true ? { pageDataRead: true } : {}), ...(action.presentedLink === true ? { presentedLink: true } : {}),
    });
  }
  private site(binding: Binding, origin: string) { const access = binding.sites.get(origin) ?? "ask"; if (access !== "allow") deny(access === "never" ? "site_denied" : "site_consent_required"); }
  /** Called only after the owner resolves the matching server-built action card. */
  issueApproval(context: BindingContext, action: BrowserAction, ttlMs = 60000): string {
    const checked = this.check(context, action);
    if (!checked.requiresApproval || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300000) deny("invalid_approval");
    for (const [id, grant] of this.approvals) if (grant.expiresAt <= this.now()) this.approvals.delete(id);
    if (this.approvals.size >= 1024) deny("approval_capacity");
    const id = randomUUID(); this.approvals.set(id, { context: { ...context }, digest: checked.digest, expiresAt: this.now() + ttlMs }); return id;
  }
  consumeApproval(context: BindingContext, action: BrowserAction, approvalId: string): void {
    const checked = this.check(context, action); const grant = this.approvals.get(approvalId);
    if (!grant || !sameContext(grant.context, context) || grant.digest !== checked.digest || grant.expiresAt <= this.now()) deny("invalid_approval");
    this.approvals.delete(approvalId);
  }
  /** Immediate pre-dispatch check and bounded profile mutation admission. Always release in finally. */
  authorizeDispatch(context: BindingContext, action: BrowserAction, approvalId?: string): () => void {
    const checked = this.check(context, action);
    if (checked.mutation && this.mutations.has(context.profileId)) deny("profile_busy");
    if (checked.requiresApproval) { if (!approvalId) deny("action_approval_required"); this.consumeApproval(context, action, approvalId); }
    if (!checked.mutation) return () => {};
    const lease = Symbol(); this.mutations.set(context.profileId, lease);
    return () => { if (this.mutations.get(context.profileId) === lease) this.mutations.delete(context.profileId); };
  }
}
