// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// publish_site / take_down_site: the owner-approved path from a bot's site
// folder to a public Netlify address. This is a Murage tool, so every engine
// reaches it the same way (the agents server), and the gate lives here:
//
//   * Every publish and every take-down raises a card of kind "publish" and
//     WAITS for the owner's Allow. There is no auto-approval hook, no access
//     mode that skips it (Full access and No limits included), no "always
//     allow", and a card nobody answers closes after the wait and sends nothing.
//   * The owner approves the exact file list this module built; the zip is
//     built from a second listing that must match it.
//   * The bearer token is fetched when needed and handed to the Netlify
//     adapter only. It is not stored here, logged, put in a card, a message
//     or a result.
import { randomUUID } from "node:crypto";
import type { Message, Store } from "../store.ts";
import { publishFailureOf, type PublishCardData, type PublishProgress } from "../../shared/publish-card.ts";
import { readPublishedSites, type PublishedSite } from "../../shared/published-sites.ts";
import { PublishError } from "./errors.ts";
import { createSite, deleteDeploy, deleteSite, deployZip, findSiteByAddress, getDeploy, getSite, isPublicHttpsUrl, liveCheck } from "./netlify.ts";
import { listSite, resolveSiteFolder } from "./site-files.ts";
import { zipStore } from "./zip.ts";

export const PUBLISH_APPROVAL_TIMEOUT_MS = 15 * 60_000;
const ID = /^[A-Za-z0-9-]{1,64}$/;
/** readPublishedSites keeps this many records, so a new site is refused before it is made once the list is full. */
const MAX_SITES_PER_BOT = 200;

export interface PublishActor { botId: string; threadId: string; generation: string; signal: AbortSignal; assertActive: () => void }
export interface PublishResult {
  status: "live" | "taken-down";
  url: string; siteId: string; deployId?: string; fileCount?: number; totalBytes?: number; skipped?: string[];
  /** The progress the owner saw, in order. */
  phases: string[];
  summary: string;
}
type Answer = "allow" | "deny" | "unanswered" | "gone";

/** A Netlify address label: lowercase letters, digits and hyphens. */
export function siteSlug(name: string): string {
  return String(name ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50).replace(/-+$/g, "");
}

/** Something the live page must contain: the <title>, else the start of the file. */
export function expectedFingerprint(index: Buffer): string {
  const html = index.toString("utf8");
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  if (title) return title.slice(0, 120);
  return html.trim().slice(0, 64);
}

const kb = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
const plural = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
const NOT_YOURS = "That site is not one this bot published or was given, so I did not change it. Only the sites I put online can be updated or taken down from here.";
/** Errors the owner should see on a card even when no approval card was raised. */
const SHOWN_ON_CARD = new Set(["rate-limited", "host-down", "too-large", "too-many-files", "name-taken", "not-live"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NETLIFY_LABEL = /^[a-z0-9][a-z0-9-]{0,62}$/;
const BAD_SITE = "Paste the site's Netlify address (such as my-shop.netlify.app) or just its name.";
const CONNECT_TEXT = "Netlify is not connected yet. Murage is showing the owner a Connect Netlify card in this chat. Tell them to press it, and try again once they say Netlify is connected.";

/** What an owner pasted to name a site they already have on Netlify: its id, its
 * address (any page of it) or just its name. Nothing else is looked up. */
export function parseSiteReference(input: unknown): { id: string } | { address: string } {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw || raw.length > 300) throw new PublishError("bad-name", BAD_SITE);
  if (UUID.test(raw)) return { id: raw.toLowerCase() };
  let host = raw.toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:/.test(host) && !/^https?:\/\//.test(host)) throw new PublishError("bad-name", BAD_SITE);
  if (/^https?:\/\//.test(host) || host.includes(".") || host.includes("/")) {
    try { host = new URL(/^https?:\/\//.test(host) ? host : `https://${host}`).hostname; } catch { throw new PublishError("bad-name", BAD_SITE); }
    const match = /^([a-z0-9][a-z0-9-]{0,62})\.netlify\.app$/.exec(host);
    if (!match) throw new PublishError("bad-name", BAD_SITE);
    return { address: host };
  }
  if (!NETLIFY_LABEL.test(host)) throw new PublishError("bad-name", BAD_SITE);
  return { address: `${host}.netlify.app` };
}

/** Only the computer running Murage can say yes to putting something public. Any door may say no. */
export function publishAnswerAllowed(requestId: string, behavior: string, surface: "desktop" | "elsewhere"): boolean {
  return !requestId.startsWith("publish-") || behavior !== "allow" || surface === "desktop";
}

interface Pending { threadId: string; messageId: string; settle: (allow: boolean, source?: "user" | "system") => void; active: () => void }

export class PublishOperations {
  private readonly pending = new Map<string, Pending>();
  private readonly busy = new Set<string>();
  private readonly options: {
    store: Store; waiting: (threadId: string, waiting: boolean, requestId: string, messageId?: string, botId?: string) => void;
    /** The current Netlify bearer, or nothing when the owner has not connected. */
    token: () => string | undefined;
    /** The bot's own files folder (a site folder must be inside it). */
    workspaceFor: (botId: string, threadId: string) => string | undefined;
    speaker?: (threadId: string, botId: string) => Message["from"] | undefined;
    fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; approvalTimeoutMs?: number;
  };
  constructor(options: PublishOperations["options"]) { this.options = options; }

  private token(): string {
    const token = this.options.token();
    if (!token) throw new PublishError("reconnect", CONNECT_TEXT);
    return token;
  }

  // ---- site records: bot -> the sites it may change ----
  /** The sites this bot may update or take down. */
  sitesFor(botId: string): PublishedSite[] { return readPublishedSites(this.options.store.bot(botId)?.publishedSites); }
  private saveSite(botId: string, site: PublishedSite) {
    this.options.store.patchBot(botId, { publishedSites: [...this.sitesFor(botId).filter(item => item.siteId !== site.siteId), site] });
  }
  private forgetSite(botId: string, siteId: string) {
    this.options.store.patchBot(botId, { publishedSites: this.sitesFor(botId).filter(item => item.siteId !== siteId) });
  }
  private owned(botId: string, siteId: string): PublishedSite {
    const site = this.sitesFor(botId).find(item => item.siteId === siteId);
    if (!site) throw new PublishError("not-yours", NOT_YOURS);
    return site;
  }

  /** The owner hands an existing Netlify site to a bot, so it can update it. They name it by its
   * address or its name; Murage looks it up with their own Netlify connection. */
  async assignSite(botId: string, reference: string): Promise<PublishedSite> {
    const target = parseSiteReference(reference);
    if (!this.options.store.bot(botId)) throw new PublishError("not-found", "There is no such bot.");
    const token = this.token(), fetchImpl = this.options.fetchImpl;
    const found = "id" in target ? await getSite({ token, siteId: target.id, fetchImpl }) : await findSiteByAddress({ token, address: target.address, fetchImpl });
    const label = new URL(found.url).hostname.split(".")[0] || "site";
    const previous = this.sitesFor(botId).find(item => item.siteId === found.siteId);
    if (!previous && this.sitesFor(botId).length >= MAX_SITES_PER_BOT) throw new PublishError("bad-name", "This bot already keeps as many sites as it can. Take one down first, then try again.");
    const site: PublishedSite = { siteId: found.siteId, name: previous?.name ?? label, url: found.url, lastPublishedAt: previous?.lastPublishedAt ?? 0, lastFileCount: previous?.lastFileCount ?? 0, origin: previous?.origin ?? "assigned" };
    this.saveSite(botId, site);
    return site;
  }

  /** The owner takes one of this bot's sites down from its settings. The owner's own click is the approval. */
  async ownerTakeDown(botId: string, siteId: string): Promise<void> {
    if (this.busy.has(botId)) throw new PublishError("cancelled", "This bot is publishing right now. Try again when it finishes.");
    const site = this.owned(botId, siteId);
    await deleteSite({ token: this.token(), siteId: site.siteId, fetchImpl: this.options.fetchImpl });
    this.forgetSite(botId, site.siteId);
  }

  async publish(actor: PublishActor, input: { folder?: string; name?: string; siteId?: string }): Promise<PublishResult> {
    return this.exclusive(actor, () => this.shownFailures(actor, { action: input.siteId ? "update" : "publish", url: this.guessUrl(actor.botId, input) }, async (mark) => {
      const token = this.token(), fetchImpl = this.options.fetchImpl;
      const workspace = this.options.workspaceFor(actor.botId, actor.threadId);
      if (!workspace) throw new PublishError("no-folder", "This bot has no files folder to publish from.");
      const slug = siteSlug(input.name ?? "");
      const mine = this.sitesFor(actor.botId);
      // "Update my site": the same name, or no name at all when the bot has one site, goes to that site.
      let siteId = input.siteId !== undefined && input.siteId !== "" ? input.siteId : undefined;
      if (siteId === undefined) siteId = (slug ? mine.find(item => siteSlug(item.name) === slug) : mine.length === 1 ? mine[0] : undefined)?.siteId;
      if (siteId === undefined && !slug) throw new PublishError("bad-name", mine.length > 1 ? `Which site? This bot has ${mine.map(item => item.name).join(", ")}. Pass the site name.` : "Give the site a name made of letters or numbers, such as \"my-shop\".");
      const update = siteId !== undefined;
      if (!update && mine.length >= MAX_SITES_PER_BOT) throw new PublishError("bad-name", "This bot already keeps as many sites as it can. Take one down first, then try again.");
      if (update && !ID.test(siteId!)) throw new PublishError("bad-id", "That site id does not look right. Use the id I gave you when the site was published.");
      const record = update ? this.owned(actor.botId, siteId!) : undefined;
      const dir = resolveSiteFolder(workspace, input.folder ?? "site");
      const listing = listSite(dir);
      const target = update ? await getSite({ token, siteId: siteId!, fetchImpl }) : { siteId: undefined, url: `https://${slug}.netlify.app` };
      mark.url = target.url;
      const data: PublishCardData = { action: update ? "update" : "publish", host: "netlify", url: target.url, ...(update ? { siteId: target.siteId } : { siteName: slug }),
        files: listing.files.map(file => ({ path: file.rel, size: file.size })), totalBytes: listing.bytes, ...(listing.skipped.length ? { skipped: listing.skipped } : {}) };
      const lines = listing.files.map(file => `${file.rel}  (${kb(file.size)})`);
      const { answer, messageId } = await this.approve(actor, {
        title: update ? "Update your live site?" : "Publish this site?",
        subtitle: `${plural(listing.files.length)}, ${kb(listing.bytes)}. ${update ? "It replaces the live site at" : "It will be live at"} ${target.url}. Anyone with the link can see this.`,
        held: lines.join("\n") + (listing.skipped.length ? `\n\nLeft out (private): ${listing.skipped.join(", ")}` : ""),
        data, pushBody: "Publish this site?",
      });
      mark.messageId = messageId; mark.shown = true;
      this.settled(answer, "publish");
      mark.approved = true;
      actor.assertActive();
      // What goes up is exactly what was approved: the snapshot taken when the list was built.
      const fresh = listing;
      const phases: string[] = [];
      const phase = (name: string, progress: PublishProgress, url?: string) => { phases.push(name); this.progress(actor, messageId, progress, url); };
      const zip = zipStore(fresh.files);
      const index = fresh.files.find(file => file.rel === "index.html")!;
      const marker = expectedFingerprint(index.data);
      const live = this.token();
      phase(`Uploading ${plural(fresh.files.length)}`, { step: "uploading", fileCount: fresh.files.length });
      let url = target.url, created = false, currentSite = target.siteId;
      // A site made for this publish is removed if the publish fails. If Netlify will not remove it,
      // it goes in the bot's list marked as needing attention, with a Take down button there.
      let orphaned = false;
      const rollback = async () => {
        if (!created || !currentSite) return;
        try { await deleteSite({ token: this.options.token() ?? live, siteId: currentSite, fetchImpl }); }
        catch {
          orphaned = true;
          try { this.saveSite(actor.botId, { siteId: currentSite, name: slug, url, lastPublishedAt: 0, lastFileCount: 0, origin: "created", needsAttention: true }); } catch { /* the error below still names the address */ }
        }
      };
      const stillWanted = () => { if (actor.signal.aborted) throw new PublishError("cancelled", "This turn ended before the site finished going up. Nothing is left online from this attempt."); actor.assertActive(); };
      let deployId: string;
      try {
        stillWanted();
        if (!currentSite) { const site = await createSite({ token: live, name: slug, fetchImpl }); currentSite = site.siteId; url = site.url; created = true; }
        stillWanted();
        const deploy = await deployZip({ token: live, siteId: currentSite, zip, fetchImpl });
        deployId = deploy.deployId; url = deploy.url; currentSite = deploy.siteId;
        stillWanted();
        if (!isPublicHttpsUrl(url)) throw new PublishError("not-live", "Netlify gave an address I will not open. Nothing was published.");
        phase("Checking it loads", { step: "checking", fileCount: fresh.files.length });
        const check = await liveCheck({ url, expect: marker, fetchImpl, signal: actor.signal, ...(this.options.sleep ? { sleep: this.options.sleep } : {}) });
        stillWanted();
        if (!check.live) throw new PublishError("not-live", created
          ? `It did not go live: ${check.reason}. Nothing was published.`
          : `The new version was uploaded, but ${check.reason} when I checked ${url}. Open the address to see, and ask me to try again.`);
      } catch (error) {
        await rollback();
        if (orphaned && error instanceof PublishError) throw new PublishError(error.code, `${error.message} The new site ${url} was made on Netlify and could not be removed yet. It is listed under Sites this bot published in the bot's settings, where the owner can take it down.`);
        throw error;
      }
      // A site the owner removed while this ran is not brought back.
      if (record && !this.sitesFor(actor.botId).some(item => item.siteId === record.siteId)) throw new PublishError("not-yours", NOT_YOURS);
      try { this.saveSite(actor.botId, { siteId: currentSite!, name: record?.name ?? slug, url, lastPublishedAt: Date.now(), lastFileCount: fresh.files.length, origin: record?.origin ?? "created" }); }
      catch (error) { await rollback(); throw error; }
      phase(`Live at ${url}`, { step: "live", fileCount: fresh.files.length }, url);
      return { status: "live", url, siteId: currentSite!, deployId, fileCount: fresh.files.length, totalBytes: fresh.bytes, ...(fresh.skipped.length ? { skipped: fresh.skipped } : {}), phases,
        summary: `Your site is live at ${url}. Anyone with the link can see it.` } satisfies PublishResult;
    }));
  }

  async takeDown(actor: PublishActor, input: { siteId: string; deployId?: string }): Promise<PublishResult> {
    return this.exclusive(actor, () => this.shownFailures(actor, { action: "take-down", url: this.sitesFor(actor.botId).find(item => item.siteId === input.siteId)?.url }, async (mark) => {
      const token = this.token(), fetchImpl = this.options.fetchImpl;
      if (typeof input.siteId !== "string" || !ID.test(input.siteId)) throw new PublishError("bad-id", "That site id does not look right. Use the id I gave you when the site was published.");
      if (input.deployId !== undefined && !ID.test(input.deployId)) throw new PublishError("bad-id", "That deploy id does not look right.");
      this.owned(actor.botId, input.siteId);
      const site = await getSite({ token, siteId: input.siteId, fetchImpl });
      mark.url = site.url;
      // A saved version is removed only if it belongs to the site the card names.
      if (input.deployId && (await getDeploy({ token, deployId: input.deployId, fetchImpl })).siteId !== site.siteId) throw new PublishError("bad-id", "That version does not belong to this site, so I did not remove anything.");
      const data: PublishCardData = { action: "take-down", host: "netlify", url: site.url, siteId: site.siteId, ...(input.deployId ? { deployId: input.deployId } : {}) };
      const { answer, messageId } = await this.approve(actor, {
        title: "Take this site down?",
        subtitle: input.deployId ? `This removes one saved version of ${site.url}. Your files stay here.` : `This removes ${site.url} for everyone. Your files stay here.`,
        held: `${site.url}\nSite id: ${site.siteId}${input.deployId ? `\nVersion id: ${input.deployId}` : ""}`,
        data, pushBody: "Take this site down?",
      });
      mark.messageId = messageId; mark.shown = true;
      this.settled(answer, "take-down");
      mark.approved = true;
      actor.assertActive();
      const live = this.token();
      if (input.deployId) await deleteDeploy({ token: live, deployId: input.deployId, fetchImpl });
      else { await deleteSite({ token: live, siteId: site.siteId, fetchImpl }); this.forgetSite(actor.botId, site.siteId); }
      const name = input.deployId ? "Removed that version" : "Site taken down";
      this.progress(actor, messageId, { step: "taken-down" });
      return { status: "taken-down", url: site.url, siteId: site.siteId, ...(input.deployId ? { deployId: input.deployId } : {}), phases: [name],
        summary: input.deployId ? `That version of ${site.url} is removed.` : `${site.url} is taken down. The files are still here.` } satisfies PublishResult;
    }));
  }

  /** Run one operation. A failure the owner should know about lands on the card:
   * the approval card itself when one was raised, else a closed notice card. */
  private async shownFailures<T>(actor: PublishActor, shape: { action: PublishCardData["action"]; url?: string }, run: (mark: { messageId?: string; shown?: boolean; approved?: boolean; url?: string }) => Promise<T>): Promise<T> {
    const mark: { messageId?: string; shown?: boolean; approved?: boolean; url?: string } = { url: shape.url };
    try { return await run(mark); } catch (error) {
      const code = error instanceof PublishError ? error.code : "cancelled";
      const progress: PublishProgress = { step: "failed", failure: publishFailureOf(code) };
      if (code === "reconnect") this.connectNotice(actor);
      if (mark.approved && mark.messageId) this.progress(actor, mark.messageId, progress);
      else if (!mark.shown && error instanceof PublishError && SHOWN_ON_CARD.has(code)) this.failureNotice(actor, shape.action, mark.url ?? shape.url, progress);
      throw error;
    }
  }

  private guessUrl(botId: string, input: { name?: string; siteId?: string }): string | undefined {
    const slug = siteSlug(input.name ?? "");
    return this.sitesFor(botId).find(item => item.siteId === input.siteId || (slug && siteSlug(item.name) === slug))?.url ?? (slug ? `https://${slug}.netlify.app` : undefined);
  }

  /** Patch the card the owner is looking at with how far along it is. */
  private progress(actor: PublishActor, messageId: string, progress: PublishProgress, url?: string) {
    const { store } = this.options;
    const current = store.messagesFor(actor.threadId).find(item => item.id === messageId);
    if (!current?.card?.publish) return;
    store.patchMessage(actor.threadId, messageId, { card: { ...current.card, publish: { ...current.card.publish, ...(url ? { url } : {}), progress } } });
  }

  /** The "Connect Netlify" card: one per chat until it is used. */
  private connectNotice(actor: PublishActor) {
    const { store } = this.options;
    if (store.messagesFor(actor.threadId).some(item => item.card?.publish?.action === "connect" && item.card.publish.connect?.state === "needed")) return;
    const from = this.options.speaker?.(actor.threadId, actor.botId);
    store.appendMessage(actor.threadId, { role: "bot", kind: "options", ...(from ? { from } : {}), card: {
      title: "Connect Netlify", subtitle: "", options: [], kind: "publish",
      publish: { action: "connect", host: "netlify", url: "https://app.netlify.com", connect: { state: "needed", botId: actor.botId } },
    } });
  }

  /** The bot a connect card was raised for. */
  connectBot(threadId: string, messageId: string): string | undefined {
    return this.options.store.messagesFor(threadId).find(item => item.id === messageId)?.card?.publish?.connect?.botId;
  }

  /** Netlify is connected and working: the card says so. False when there is no such card. */
  markConnected(threadId: string, messageId: string): boolean {
    const { store } = this.options;
    const current = store.messagesFor(threadId).find(item => item.id === messageId);
    const publish = current?.card?.publish;
    if (!current?.card || publish?.action !== "connect" || publish.connect?.state === "connected") return false;
    store.patchMessage(threadId, messageId, { card: { ...current.card, publish: { ...publish, connect: { ...publish.connect, state: "connected" } } } });
    return true;
  }

  /** A closed card for a problem found before any approval was asked for: nothing waits on the owner. */
  private failureNotice(actor: PublishActor, action: PublishCardData["action"], url: string | undefined, progress: PublishProgress) {
    const from = this.options.speaker?.(actor.threadId, actor.botId);
    const title = action === "take-down" ? "Take this site down?" : action === "update" ? "Update your live site?" : "Publish this site?";
    this.options.store.appendMessage(actor.threadId, { role: "bot", kind: "options", ...(from ? { from } : {}), card: {
      title, subtitle: "", options: [], kind: "publish", answered: "failed", publish: { action, host: "netlify", url: url ?? "https://www.netlify.com", progress },
    } });
  }

  private async exclusive<T>(actor: PublishActor, run: () => Promise<T>): Promise<T> {
    if (this.busy.has(actor.botId)) throw new PublishError("cancelled", "A publish for this bot is already in progress. Wait for it to finish.");
    this.busy.add(actor.botId);
    try { return await run(); } finally { this.busy.delete(actor.botId); }
  }

  private settled(answer: Answer, what: "publish" | "take-down") {
    if (answer === "allow") return;
    if (answer === "deny") throw new PublishError("declined", `The owner chose not to ${what === "publish" ? "publish" : "take it down"}. Nothing was changed.`);
    if (answer === "unanswered") throw new PublishError("unanswered", `Nobody answered the approval card within ${PUBLISH_APPROVAL_TIMEOUT_MS / 60_000} minutes, so it was closed and nothing was changed. Ask again if the owner still wants this.`);
    throw new PublishError("cancelled", "This turn ended before the owner answered. Nothing was changed.");
  }

  private approve(actor: PublishActor, card: { title: string; subtitle: string; held: string; data: PublishCardData; pushBody: string }): Promise<{ answer: Answer; messageId: string }> {
    const { store } = this.options, requestId = `publish-${randomUUID()}`;
    const from = this.options.speaker?.(actor.threadId, actor.botId);
    // No allowKey, taskAllowKey or routineAllowKey: nothing can be remembered.
    const message = store.appendMessage(actor.threadId, { role: "bot", kind: "options", ...(from ? { from } : {}), card: {
      title: card.title, subtitle: card.subtitle, held: card.held, options: ["Allow", "Deny"], requestId, tool: "publish_site",
      kind: "publish", publish: card.data, pushBody: card.pushBody,
    } });
    this.options.waiting(actor.threadId, true, requestId, message.id, actor.botId);
    return new Promise<{ answer: Answer; messageId: string }>(resolve => {
      let done = false, expired = false;
      const finish = (allow: boolean, source: "user" | "system" = "system") => {
        if (done) return; done = true; clearTimeout(timer); actor.signal.removeEventListener("abort", abort); this.pending.delete(requestId);
        const current = store.messagesFor(actor.threadId).find(m => m.id === message.id);
        if (current?.card && !current.card.answered) store.patchMessage(actor.threadId, message.id, { card: { ...current.card, answered: source === "user" ? (allow ? "allow" : "deny") : "unavailable", dismissed: source !== "user" } });
        this.options.waiting(actor.threadId, false, requestId, undefined, actor.botId);
        resolve({ answer: source === "user" ? (allow ? "allow" : "deny") : expired ? "unanswered" : "gone", messageId: message.id });
      };
      const abort = () => finish(false);
      const timer = setTimeout(() => { expired = true; finish(false); }, this.options.approvalTimeoutMs ?? PUBLISH_APPROVAL_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(requestId, { threadId: actor.threadId, messageId: message.id, settle: finish, active: actor.assertActive });
      actor.signal.addEventListener("abort", abort, { once: true });
      if (actor.signal.aborted) abort();
    });
  }

  /** The owner's answer on a publish card. Null when the id is not a publish card's. */
  resolve(threadId: string, requestId: string, behavior: "allow" | "deny" | "answer"): "allowed-once" | "rejected" | "unavailable" | null {
    if (!requestId.startsWith("publish-")) return null;
    const entry = this.pending.get(requestId);
    if (!entry || entry.threadId !== threadId || behavior === "answer") return "unavailable";
    try { entry.active(); } catch { entry.settle(false); return "unavailable"; }
    entry.settle(behavior === "allow", "user");
    return behavior === "allow" ? "allowed-once" : "rejected";
  }
  cancelThread(threadId: string) { for (const entry of [...this.pending.values()]) if (entry.threadId === threadId) entry.settle(false); }
}
