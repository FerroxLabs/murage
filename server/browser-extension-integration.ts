import { homedir } from "node:os";
import { connectOwnerBrowser, removeOwnerBrowser } from "../electron/browser-extension-registration.mjs";
import { runningAppImage } from "../electron/desktop-relaunch.mjs";
// SPDX-License-Identifier: AGPL-3.0-or-later
// App-owned lifecycle. This module never registers a native host in a user's browser.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { startBrowserExtensionBroker } from "./browser-extension-broker.ts";
import { browserExtensionResourcesPath } from "./browser-extension-listing.ts";
import { createBrowserExtensionService, type YourTurnInfo } from "./browser-extension-service.ts";
import { BrowserExtensionApprovals, browserActionCardTitle, type ContinuationInfo } from "./browser-extension-approvals.ts";
import { HUMAN_DECISION_MS } from "../shared/browser-extension-protocol.ts";
import type { ApprovalBus } from "./peer-approval.ts";
import type { BotRecord } from "./store.ts";
import type { ProviderInstance } from "./contracts.ts";
import type { BindingContext } from "./browser-extension-policy.ts";
import { browserActivityStore } from "./browser-extension-activity.ts";
import { botColorHex } from "../shared/ember-colors.ts";
import { resolveCheckerConnection } from "./browser-action-checker-connection.ts";

const HUMAN_WAIT_MS = HUMAN_DECISION_MS;
/** The name the extension shows for a bot: the bot's own name. The side panel adds the conversation's title itself. */
export function extensionBindName(bot: { name: string } | undefined, botId: string): string { return bot?.name ?? botId; }
/** One activity line for the side panel, in the same words the app's settings use for the access levels. */
export function extensionActivityText(line: { action: string; target?: string; site: string; decision: string }): string {
  return `${line.action}${line.target ? ` ${line.target}` : ""} on ${line.site}: ${line.decision === "Full permissive" ? "Full access" : line.decision}`;
}
type Broker = Awaited<ReturnType<typeof startBrowserExtensionBroker>>;
type Service = Awaited<ReturnType<typeof createBrowserExtensionService>>;
/** The folder the service keeps its state in. On Windows the native helper creates it (and sets its private ACL)
 * and refuses a folder that already exists, so only the other platforms create it here. */
export function prepareStateDirectory(directory: string, platform: NodeJS.Platform = process.platform): void {
  if (platform !== "win32") mkdirSync(directory, { recursive: true, mode: 0o700 });
}
/** The notices the browser's side panel sends for the app to carry out. Others (owner_revoked, share_requested ...) go to the service. */
const PANEL_REQUESTS = new Set(["owner_end_task", "owner_new_task", "owner_set_mode", "owner_turn_off"]);
export class BrowserExtensionIntegration {
  readonly approvals: BrowserExtensionApprovals;
  private broker?: Broker;
  private service?: Service;
  private starting?: Promise<Service>;
  private expiry?: ReturnType<typeof setInterval>;
  private registrationProblem = "";
  private registrationCode = "";
  private options: { dataDir: string; socketDir: string; workspaceId: string; approvalBus: ApprovalBus; bot: (id: string) => BotRecord | undefined; protectedOrigins: string[]; createEngine?: Parameters<typeof createBrowserExtensionService>[0]["createEngine"]; collectFacts?: Parameters<typeof createBrowserExtensionService>[0]["collectFacts"]; stopped?: (threadId: string) => void;
    /** The owner's latest proven instruction in a conversation (level-1 free navigation, coordinator ruling 0.1.62). */
    ownerInstruction?: (threadId: string) => { id: string; text: string } | undefined;
    /** The hard floor asked for the owner: post the Your turn note in the conversation and send the push (no page text). */
    yourTurn?: (info: YourTurnInfo & { bot: BotRecord }) => void;
    /** C2 / RES-002: the extension reported that the last step may have run. One plain line to the owner in the conversation. */
    outcomeUnknown?: (info: { context: BindingContext; text: string; bot: BotRecord }) => void;
    /** C2: the owner tightened the approval mode from the browser's side panel (never looser). */
    setMode?: (botId: string, mode: "step" | "task") => void;
    /** C2: the hand-over pause failed twice. The owner gets one plain line (press Stop) in the conversation. */
    handoffFailed?: (info: { context: BindingContext; site: string; text: string; bot: BotRecord }) => void;
    /** C2: the saved browser state could not be used and was set aside (or is newer than this Murage). Told once, to the owner. */
    stateRecovered?: (info: { kind: "damaged" | "newer"; text: string }) => void;
    /** C2 / T25: the owner pressed Continue after a hand-over. Start the bot's continuation turn. Return false when the bot is busy; it is tried again. */
    handoffContinue?: (info: { context: BindingContext; site: string; text: string; bot: BotRecord }) => boolean | void | Promise<boolean | void>;
    /** The provider instances the bot-engine checker may use (text-only, never the bot's agent session). */
    checkerInstances?: () => ProviderInstance[];
    /** T22: the owner answered a card after its call had returned WAITING (or after a restart). Start the continuation turn: the approved step
     * is repeated by the bot and used once, or the owner's decline is told to it. Return false when the bot is busy; it is tried again. */
    continueCard?: (info: ContinuationInfo & { bot: BotRecord }) => boolean | void | Promise<boolean | void>;
    /** T20: a task ended (End task, Stop, idle, 8 hours, routine end, takeover). T34's end-of-task offer reads the status; this is the push. */
    taskEnded?: (info: { context: BindingContext; bot: BotRecord; taskId: string; reason: string }) => void;
    /** T20/T37: this conversation is an unattended routine run. A routine never asks, so it never mints a grant. */
    routine?: (threadId: string) => boolean;
    /** The owner's saved rule for a site on this bot and browser profile (the approved-sites list). */
    siteSetting?: (botId: string, profileId: string, origin: string) => { rule: "allow" | "ask" | "never"; lowered?: boolean } | undefined };
  constructor(options: BrowserExtensionIntegration["options"]) {
    this.options = options;
    // Continuation records sit inside browser-extension/, which a backup never takes. A restart within 24 hours keeps a card answerable.
    this.approvals = new BrowserExtensionApprovals(options.approvalBus, {
      file: join(this.options.dataDir, "browser-extension", "approvals.json"),
      // Before anything runs from a late answer the binding is looked at again: the same generation, and the task still going.
      valid: record => { const binding = this.service?.status().bindings.find(item => item.bindingId === record.bindingId); return !!binding && binding.generation === record.generation && binding.state !== "stopped" && binding.taskEnded !== true; },
      onContinue: info => { const bot = this.options.bot(info.botId); return bot ? this.options.continueCard?.({ ...info, bot }) : true; },
    });
    this.approvals.dismissStale();
  }
  /** The Allow always sites a failed save turned back into Ask for this bot. Returned once; nothing when the service has not started. */
  async takeLoweredSites(botId: string): Promise<string[]> { try { return (await this.service?.takeLowered(botId)) ?? []; } catch { return []; } }
  /** The owner changed this bot's approval mode, its action check or (with `change`) a saved site rule. Pending cards for the bot's bindings die
   * and the service fences everything the old setting granted, before this returns its promise. Never throws. */
  settingsChanged(botId: string, change?: { origin: string; rule: "allow" | "ask" | "never" }): Promise<void> {
    const service = this.service;
    if (!service) return this.starting ? this.starting.then(() => this.settingsChanged(botId, change), () => {}) : Promise.resolve();
    try { for (const binding of service.status().bindings) if (binding.botId === botId) this.approvals.cancelBinding(binding.bindingId); } catch { /* the service fence below still runs */ }
    return service.settingsChanged(botId, change).catch(() => {});
  }
  /** True when this conversation is an unattended or routine run. Any throw reads as a routine: it only ever means "ask a human". */
  isRoutineThread(threadId: string): boolean { try { return this.options.routine?.(threadId) === true; } catch { return true; } }
  /** The owner answers a card. A card whose call already returned WAITING (or that survived a restart) needs the saved state loaded
   * first, so its binding can be looked at again before anything runs. */
  async answerCard(threadId: string, requestId: string, behavior: string | undefined): Promise<boolean> {
    if (!this.approvals.knows(requestId)) return false;
    if (!this.service) { try { await this.start(); } catch { /* the binding cannot be checked: the answer closes the card and runs nothing */ } }
    return this.approvals.resolve(threadId, requestId, behavior);
  }
  start(): Promise<Service> {
    if (this.service) return Promise.resolve(this.service);
    if (this.starting) return this.starting;
    this.starting = this.open().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async open(): Promise<Service> {
    const directory = join(this.options.dataDir, "browser-extension");
    prepareStateDirectory(directory);
    const broker = await startBrowserExtensionBroker({ stateDir: this.options.socketDir, configAlias: "native-host.json", onMessage: (profileId, message) => this.handleBrokerMessage(profileId, message) });
    try {
      const service = await createBrowserExtensionService({ broker, workspaceId: this.options.workspaceId, stateFile: join(directory, "state.json"), createEngine: this.options.createEngine, collectFacts: this.options.collectFacts, protectedOrigins: this.options.protectedOrigins,
        // The side panel shows the bot's name and the conversation, never the ids.
        ownerInstruction: context => this.options.ownerInstruction?.(context.threadId),
        approvalMode: context => this.options.bot(context.botId)?.browserApproval ?? "task",
        botName: context => this.options.bot(context.botId)?.name ?? "Your bot",
        siteSetting: (context, origin) => this.options.siteSetting?.(context.botId, context.profileId, origin),
        // Flux by default, the bot's own engine on the owner's switch. Not available (no key, or Flux has not shipped no-retain) means none.
        checker: context => {
          const bot = this.options.bot(context.botId); const check = bot?.browserActionCheck ?? "flux";
          const connection = resolveCheckerConnection({ switch: check, instances: this.options.checkerInstances?.() ?? [], ...(bot?.modelSelection?.instanceId ? { botInstanceId: bot.modelSelection.instanceId } : {}) });
          return connection ? { deps: { transport: connection.transport, models: connection.models }, key: JSON.stringify([connection.source, connection.fallback === true, bot?.modelSelection?.instanceId ?? null, connection.models]) } : undefined;
        },
        routine: context => this.isRoutineThread(context.threadId),
        // What only the app knows, for the browser's side panel: the conversation, the bot's colour, whether Full access is on, and the last lines of activity.
        panel: context => {
          const bot = this.options.bot(context.botId); if (!bot) return undefined;
          const title = bot.tasks?.find(task => task.threadId === context.threadId)?.title?.trim();
          const lines = browserActivityStore()?.list({ botId: context.botId, bindingId: context.bindingId }).slice(-20) ?? [];
          return { ...(title ? { conversation: title } : {}), ...(botColorHex(bot.color) ? { botColor: botColorHex(bot.color)! } : {}), full: bot.browserApproval === "full", ...(this.approvals.hasWaiting(context.bindingId) ? { phase: "waiting" as const } : {}),
            activity: lines.map(line => ({ time: new Date(line.at).toISOString().slice(11, 16), text: extensionActivityText(line) })) };
        },
        onTaskEnded: info => { this.approvals.cancelBinding(info.context.bindingId); const bot = this.options.bot(info.context.botId); if (bot) this.options.taskEnded?.({ ...info, bot }); },
        onHandoff: info => { const bot = this.options.bot(info.context.botId); if (bot) this.options.yourTurn?.({ ...info, bot }); },
        onHandoffFailed: info => { const bot = this.options.bot(info.context.botId); if (bot) this.options.handoffFailed?.({ ...info, bot }); },
        onStateRecovered: info => { this.options.stateRecovered?.(info); },
        onContinue: info => { this.continueWhenFree(info, 0); },
        // The side panel already shows the conversation under the name, so the name is the bot's alone.
        botLabel: context => extensionBindName(this.options.bot(context.botId), context.botId),
        askSite: async (context, origin, binding) => {
          const bot = this.options.bot(context.botId);
          if (!bot) return "never";
          const state = await this.approvals.ask({ bot, threadId: context.threadId, bindingId: context.bindingId, generation: context.generation,
            digest: createHash("sha256").update(JSON.stringify(["site", context, origin])).digest("hex"),
            summary: `Let ${bot.name} read and work on ${origin}? Site access is remembered for this browser task. It does not approve purchases, messages or other changes.`, scope: "site", waitMs: HUMAN_WAIT_MS, binding, kind: "site", title: `${bot.name} wants to use ${(() => { try { return new URL(origin).host || origin; } catch { return origin; } })()}` });
          return state === "allow" ? "allow" : state === "waiting" ? "waiting" : "ask";
        },
        askAction: async (context, action, binding) => {
          const bot = this.options.bot(context.botId);
          if (!bot) return false;
          const state = await this.approvals.ask({ bot, threadId: context.threadId, bindingId: context.bindingId, generation: context.generation, digest: action.digest, summary: action.summary.slice(0, 12000), ...(action.pushSummary ? { pushSummary: action.pushSummary } : {}), waitMs: HUMAN_WAIT_MS, binding, kind: "action", title: browserActionCardTitle(bot.name, action), ...(action.cardKind ? { cardKind: action.cardKind } : {}) });
          return state === "allow" ? true : state === "waiting" ? "waiting" : false;
        },
        consumeApproval: (context, query) => this.approvals.consume({ bindingId: context.bindingId, kind: query.kind, binding: query.binding }),
      });
      this.broker = broker; this.service = service;
      // A task idle for 30 minutes, or running for 8 hours, ends even if the bot never calls again.
      this.expiry = setInterval(() => { void service.expireTasks().catch(() => {}); this.approvals.sweep(); void this.approvals.drain().catch(() => {}); }, 60_000); this.expiry.unref?.();
      return service;
    } catch (error) { await broker.close(); throw error; }
  }
  /** Everything the broker passes up: events, and the one kind of response that arrives with no request waiting (the restarted extension's
   * "the last step may have run"). Public so the broker-to-service path is testable end to end. */
  handleBrokerMessage(profileId: string, message: Parameters<Service["handleMessage"]>[1]): void {
    // The extension is talking to the helper, so setup worked: a leftover registration problem is no longer true.
    this.registrationProblem = ""; this.registrationCode = "";
    if (message.type === "response") {
      // RES-002: an uncertain report is owner news. Cards for the old step die first; the service pauses the binding and keeps the outcome-unknown mark.
      if (message.error?.code === "uncertain") {
        this.approvals.cancelBinding(message.bindingId);
        const entry = this.service?.status().bindings.find(binding => binding.bindingId === message.bindingId);
        const bot = entry && entry.profileId === profileId && entry.state !== "stopped" ? this.options.bot(entry.botId) : undefined;
        if (entry && bot) { try { this.options.outcomeUnknown?.({ context: { ...entry } as never, bot, text: "The browser restarted during the last step, so it may not have finished. Check the page, then resume." }); } catch { /* telling the owner is best effort */ } }
        void this.service?.handleMessage(profileId, message).catch(() => {});
      }
      return;
    }
    if (message.type !== "event") return;
    // The owner pressed a button in the browser's own side panel that the app carries out. The extension is authenticated by the broker; each request
    // can only narrow what the bot may do, or start a new task with no grants. Anything else is ignored.
    if (message.event === "notice" && PANEL_REQUESTS.has(String(message.data?.kind))) { void this.panelRequest(profileId, message); return; }
    // Owner interruption invalidates cards before the async state reconciliation.
    if (["stopped", "paused", "takeover", "unshared", "disconnected"].includes(message.event)) this.approvals.cancelBinding(message.bindingId);
    const entry = this.service?.status().bindings.find(binding => binding.bindingId === message.bindingId);
    if (message.event === "stopped" && entry) this.options.stopped?.(entry.threadId);
    void this.service?.handleMessage(profileId, message).catch(() => this.failClosed(message.bindingId, message.event));
  }
  private async panelRequest(profileId: string, message: Extract<Parameters<Service["handleMessage"]>[1], { type: "event" }>): Promise<void> {
    try {
      const entry = this.service?.status().bindings.find(binding => binding.bindingId === message.bindingId);
      if (!entry || entry.profileId !== profileId) return;
      const kind = String(message.data.kind);
      if (kind === "owner_end_task") await this.ownerAction(entry.bindingId, "end", { surface: "panel" });
      else if (kind === "owner_new_task") await this.ownerAction(entry.bindingId, "start", { surface: "panel" });
      else if (kind === "owner_set_mode" || kind === "owner_turn_off") {
        const mode = kind === "owner_turn_off" ? "task" : message.data.mode;
        if (mode !== "step" && mode !== "task") return;
        const rank = { step: 0, task: 1, full: 2 } as const;
        const current = this.options.bot(entry.botId)?.browserApproval ?? "task";
        if (rank[mode] >= rank[current]) return; // only tighter
        this.options.setMode?.(entry.botId, mode);
        await this.settingsChanged(entry.botId);
      }
    } catch { /* the panel's next status shows what is true */ }
  }
  /** The continuation turn after Continue. A busy bot is tried again every few seconds, for half an hour or until the task is no longer running, and never run twice. */
  private continueWhenFree(info: { context: BindingContext; site: string; text: string }, attempt: number) {
    const bot = this.options.bot(info.context.botId); if (!bot) return;
    const status = this.service?.status().bindings.find(binding => binding.bindingId === info.context.bindingId);
    if (!status || status.state !== "active") return;
    let done: boolean | void | Promise<boolean | void> = true;
    try { done = this.options.handoffContinue?.({ ...info, bot }); } catch { return; }
    void Promise.resolve(done).then(result => {
      if (result === false && attempt < 360) { const timer = setTimeout(() => this.continueWhenFree(info, attempt + 1), 5_000); timer.unref?.(); }
    }, () => {});
  }
  /** A failed reconcile fails closed through one stop, never a stop for a task that is already stopped (that loops). */
  private failClosed(bindingId: string, event: string) {
    this.approvals.cancelBinding(bindingId);
    const state = this.service?.status().bindings.find(binding => binding.bindingId === bindingId)?.state;
    if (state === "stopped" || event === "stopped") return;
    void this.service?.stop(bindingId).catch(() => {});
  }
  private registrationOptions(browser: "chrome" | "edge" | "brave") {
    const configPath = this.broker?.configPath;
    if (!configPath) throw new Error("Start the browser helper before registering it.");
    // Mac and Linux: the launcher and its receipt live in the data folder, not
    // beside the broker socket in /tmp, which the system empties at restart.
    // Windows keeps its qualified per-user runtime folder.
    const registrationDirectory = process.platform === "win32" ? undefined : join(this.options.dataDir, "browser-extension", "native-host");
    if (registrationDirectory) mkdirSync(registrationDirectory, { recursive: true, mode: 0o700 });
    const appImage = runningAppImage() ?? undefined;
    return { ownerConfirmed: true, browser, configPath, registrationHome: homedir(), electronPath: process.execPath, registrationDirectory, appImage,
      resourcesPath: browserExtensionResourcesPath() };
  }
  /** Called only from explicit owner setup, not from a bot tool or connection heartbeat. */
  async connectOwner(browser: "chrome" | "edge" | "brave" = "chrome") {
    const service = await this.start();
    try { await connectOwnerBrowser(this.registrationOptions(browser)); this.registrationProblem = ""; this.registrationCode = ""; }
    catch (error) {
      this.registrationProblem = error instanceof Error ? error.message : "Browser helper registration could not finish.";
      this.registrationCode = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "";
      throw Object.assign(new Error(this.registrationProblem), { status: 409 });
    }
    return service;
  }
  async removeOwner(browser: "chrome" | "edge" | "brave" = "chrome") {
    // The broker's config path names the owned launcher; start it (it never
    // registers anything) so Remove works before any Connect this session.
    await this.start();
    if (this.service?.status().bindings.some(binding => binding.state === "active")) throw Object.assign(new Error("Stop browser tasks before removing the helper registration."), { status: 409 });
    try { return await removeOwnerBrowser(this.registrationOptions(browser)); }
    catch (error) {
      const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "";
      // Never delete what Murage cannot prove it wrote.
      throw Object.assign(new Error(code === "registration_ownership_conflict" ? "Another browser helper is registered under Murage's name, or its files were changed. Murage left them in place." : "Browser helper removal could not finish. Changed files were left in place."), { status: 409 });
    } finally { this.registrationProblem = ""; this.registrationCode = ""; }
  }
  /** A browser that is connected shows the helper works, so an earlier "needs repair" is stale: drop it. */
  private clearProblemWhenConnected() {
    if ((this.registrationProblem || this.registrationCode) && (this.service?.status().profiles.length ?? 0) > 0) { this.registrationProblem = ""; this.registrationCode = ""; }
  }
  setupProblem() { this.clearProblemWhenConnected(); return this.registrationProblem; }
  /** repair: this build needs the old owned registration removed first; foreign: another registration holds the name. */
  setupProblemKind(): "repair" | "foreign" | undefined {
    this.clearProblemWhenConnected();
    return this.registrationCode === "registration_repair_required" ? "repair" : this.registrationCode === "registration_ownership_conflict" ? "foreign" : undefined;
  }
  status() { return this.service?.status() ?? { profiles: [], bindings: [] }; }
  /** Used by owner-controlled packaging/setup only, never by a model/client endpoint. */
  hostConfigPath() { return this.broker?.configPath ?? null; }
  async bind(bot: BotRecord, threadId: string) {
    const service = await this.start();
    const profiles = service.status().profiles;
    const profileId = bot.browserExtensionProfileId ?? (profiles.length === 1 ? profiles[0].profileId : undefined);
    if (!profileId) throw Object.assign(new Error(profiles.length ? "Choose the browser profile to connect." : "Connect Murage for Chrome to use your browser. Your request stays in this conversation."), { code: "browser_extension_setup_required" });
    // The only profile online is used for this turn but never pinned here: a
    // profile is remembered only when the owner chooses it (setup Continue or
    // the Browser panel). What reaches the bot is a plain sentence, never a code.
    let binding: Awaited<ReturnType<Service["ensureBinding"]>>;
    try { binding = await service.ensureBinding({ botId: bot.id, threadId, profileId }); }
    catch (error) {
      const code = (error as { code?: unknown })?.code;
      throw Object.assign(new Error(code === "host_offline" ? "The owner's browser is not connected right now." : code === "incompatible_capabilities" ? "Update Murage for Chrome in the owner's browser to use it with this version of Murage. Ask the owner to update the extension, then try again."
        : code === "update_murage" ? "Update Murage on this computer to use this version of Murage for Chrome. Ask the owner to update the app, then try again."
        : code === "binding_capacity" ? "Murage for Chrome is holding as many browser tasks as it can. The owner can stop one in the extension side panel." : "The owner's browser could not be reached for this conversation."), { code: "browser_extension_not_ready" });
    }
    // Tools are mounted only for a binding that can act now. A paused, stopped
    // or offline one would list every browser tool and refuse every call.
    const status = service.status().bindings.find(item => item.bindingId === binding.bindingId) as { state?: string; pausedReason?: string } | undefined;
    const state = status?.state;
    if (state !== "active") throw Object.assign(new Error(state === "stopped" ? "Browser control is stopped for this conversation. The owner stopped it, so do not use the browser here unless the owner starts it again."
      : state === "paused" && status?.pausedReason === "handoff" ? "YOUR TURN: this step needs the owner. Murage has asked them. Ask the owner to press Continue in Murage for Chrome so you can carry on. Do not try another way to do the step."
      : state === "paused" && status?.pausedReason === "uncertain" ? "Browser control is paused because the owner's browser restarted during the last step, so that step may not have finished. Ask the owner to check the page and resume it in Murage for Chrome before you carry on."
      : state === "paused" ? "Browser control is paused; the owner can check the page and resume it in Murage for Chrome."
      : "The owner's browser is not connected right now."), { code: "browser_extension_not_ready" });
    return binding;
  }
  async externalBind(identity: { botId: string; threadId: string; profileId: string; clientId: string }) {
    const service = await this.start();
    return service.ensureBinding(identity);
  }
  async dispatch(bindingId: string, method: string, params: Record<string, unknown>, authorize: () => boolean) {
    const service = this.service;
    if (!service || !authorize()) throw new Error("Browser connection is unavailable.");
    if (method === "tools/list") return service.tools(bindingId, authorize);
    if (method !== "tools/call") throw new Error("Unsupported browser method.");
    return service.dispatch(bindingId, params.name, params.arguments ?? {}, authorize);
  }
  /** The owner's actions. `surface` is where the request came from: the phone and the side panel may only tighten (stop, pause,
   * end the task, revoke, set a site to Ask or Never); raising a site's access is the desktop app's alone. Unknown means tighten only. */
  async ownerAction(bindingId: string, action: string, input: { origin?: string; access?: "allow" | "ask" | "never"; surface?: "desktop" | "phone" | "panel" } = {}) {
    const service = this.service;
    if (!service) throw new Error("Browser connection is unavailable.");
    if (action === "stop" || action === "pause") { this.approvals.cancelBinding(bindingId); return service[action](bindingId); }
    // RES-003: a new task after Stop is the owner's to start. It gives no authority back (a new binding, no grants), so the desktop, the panel and the phone may all do it; a bot call never reaches here.
    if (action === "start" || action === "newtask") { this.approvals.cancelBinding(bindingId); return service.startNewTask(bindingId); }
    // T25 / D9: Continue after a hand-over is the owner at the desktop or in the browser's own panel. The phone cannot.
    if (action === "continue") {
      if (input.surface !== "desktop" && input.surface !== "panel") throw Object.assign(new Error("Continue needs the Murage app on your computer."), { status: 403, errorKey: "browserExt.owner.errorContinueDesktop" });
      try { return await service.continueHandoff(bindingId); }
      catch (error) {
        const code = (error as { code?: string }).code;
        throw Object.assign(new Error(code === "not_handoff" ? "This step is not waiting for you." : "Press Continue in the Murage for Chrome side panel."), { status: 409, code, errorKey: code === "not_handoff" ? "browserExt.owner.errorNotWaiting" : "browserExt.owner.errorContinuePanel" });
      }
    }
    // A plain Resume does not answer a hand-over: the owner says they finished the step with Continue.
    if (action === "resume") {
      const waiting = service.status().bindings.find(item => item.bindingId === bindingId) as { state?: string; pausedReason?: string } | undefined;
      if (waiting?.state === "paused" && waiting.pausedReason === "handoff") throw Object.assign(new Error("Press Continue once you have done the step."), { status: 409, code: "handoff_use_continue", errorKey: "browserExt.owner.errorUseContinue" });
    }
    // Ending a task, revoking a site and lowering a site all cancel the cards waiting on the old access before anything else.
    if (action === "end") { this.approvals.cancelBinding(bindingId); return service.endTask(bindingId); }
    if (action === "revoke" && input.origin) { this.approvals.cancelBinding(bindingId); return service.revoke(bindingId, input.origin); }
    if (action === "site" && input.origin && input.access) {
      if (input.access === "allow" && input.surface !== "desktop") throw Object.assign(new Error("Allowing a site needs the Murage app on your computer."), { status: 403 });
      // Tighten only: a Never stays a Never until the desktop app lifts it.
      if (input.access === "ask" && input.surface !== "desktop" && this.status().bindings.find(item => item.bindingId === bindingId)?.sites?.[input.origin] === "never") throw Object.assign(new Error("Lifting a Never needs the Murage app on your computer."), { status: 403 });
      if (input.access !== "allow") this.approvals.cancelBinding(bindingId);
      return service.setSiteAccess(bindingId, input.origin, input.access);
    }
    throw new Error("Use the browser extension to resume or share a tab.");
  }
  cancelThread(threadId: string) { this.approvals.cancelThread(threadId); }
  async close() {
    if (this.starting) await this.starting.catch(() => {});
    // A restart pauses what was running so the owner can Resume it; a task the owner stopped stays stopped.
    for (const binding of this.service?.status().bindings ?? []) { this.approvals.cancelBinding(binding.bindingId); if (binding.state !== "stopped") await this.service?.pause(binding.bindingId).catch(() => {}); }
    if (this.expiry) { clearInterval(this.expiry); this.expiry = undefined; }
    await this.service?.close();
    await this.broker?.close(); this.broker = undefined; this.service = undefined;
  }
}

/** Re-review H1: a routine run is not marked unattended (a scheduled or manual run comes in with an automation source), so the routine flag
 * is the unattended mark OR a live routine run in the thread (schedule, manual, webhook, channel or the card-continuation turn of a run). */
export function routineThreadSignal(deps: { isUnattended: (threadId: string) => boolean; routines: () => { isActiveThread(threadId: string): boolean } | null | undefined }): (threadId: string) => boolean {
  return threadId => deps.isUnattended(threadId) || deps.routines()?.isActiveThread(threadId) === true;
}

/** Re-review 2 H1: a turn started on another bot's behalf (ask_bot, delegation, a queued bot-to-bot ask, an inherited auto-approve) is
 * unattended when its source thread is unattended OR is a live routine run; the child thread is then marked like any unattended turn. */
export function delegatedTurnUnattended(deps: Parameters<typeof routineThreadSignal>[0], sourceThreadId?: string | null): boolean {
  return Boolean(sourceThreadId) && routineThreadSignal(deps)(sourceThreadId as string);
}
