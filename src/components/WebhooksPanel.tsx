import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronRight,
  CircleAlert,
  Cloud,
  Copy,
  ExternalLink,
  KeyRound,
  Laptop,
  Loader2,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RotateCw,
  Send,
  ShieldCheck,
  Trash2,
  Webhook,
  X,
} from "lucide-react";

import { MausAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import type { RoutineRun, RoutineRunOn } from "@/lib/routines";
import type { WebhookAttempt, WebhookCredential, WebhookTrigger, WebhookTriggerInput } from "@/lib/webhooks";
import { api, useStore, type Bot } from "@/state/store";

function relativeTime(at?: number) {
  if (!at) return "Never";
  const elapsed = Math.max(0, Date.now() - at);
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
}

function deliverySummary(run: RoutineRun) {
  const eventName = run.prompt?.match(/^Event: (.+)$/m)?.[1]?.trim() || "Webhook event";
  const eventData = run.prompt?.match(/\[UNTRUSTED WEBHOOK EVENT DATA\]\n([\s\S]*?)\n\[\/UNTRUSTED WEBHOOK EVENT DATA\]/)?.[1] ?? "";
  const payloadStart = eventData.indexOf("\n\n");
  const payload = (payloadStart >= 0 ? eventData.slice(payloadStart + 2) : eventData).replace(/\s+/g, " ").trim();
  return { eventName, preview: payload.slice(0, 240) };
}

function suggestedName(prompt: string, bot?: Bot) {
  const first = prompt.trim().split(/[.!?\n]/)[0]?.trim().slice(0, 60);
  return first || `${bot?.name ?? "MAUS"} webhook`;
}

function statusFor(webhook: WebhookTrigger) {
  if (webhook.verificationPending) return { label: "Waiting for test", tone: "text-accent", dot: "bg-accent animate-pulse" };
  if (webhook.verifiedAt && !webhook.enabled) return { label: "Ready to enable", tone: "text-warning", dot: "bg-warning" };
  if (webhook.enabled) return { label: "Active", tone: "text-success", dot: "bg-success" };
  return { label: "Paused", tone: "text-ink-secondary", dot: "bg-ink-secondary/50" };
}

function outcomeTone(outcome: WebhookAttempt["outcome"], run?: RoutineRun) {
  if (outcome === "rejected" || run?.status === "failed" || run?.status === "missed") return "text-danger";
  if (run && ["queued", "running", "waiting"].includes(run.status)) return "text-accent";
  if (run?.status === "completed" || outcome === "captured" || outcome === "accepted") return "text-success";
  return "text-ink-secondary";
}

function outcomeLabel(outcome: WebhookAttempt["outcome"], run?: RoutineRun) {
  if (run) return run.status === "waiting" ? "Needs you" : run.status[0]!.toUpperCase() + run.status.slice(1);
  if (outcome === "captured") return "Test received";
  if (outcome === "duplicate") return "Duplicate";
  if (outcome === "ignored") return "Ignored";
  if (outcome === "rejected") return "Rejected";
  return "Accepted";
}

function SetupModal({ credential, webhookId, available, onClose }: { credential: WebhookCredential; webhookId: string; available: boolean; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const webhook = state.webhooks.find((candidate) => candidate.id === webhookId);
  const [copied, setCopied] = useState<"url" | "endpoint" | "secret" | "command" | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const command = `curl -sS '${credential.url}' --json '{"task":"Summarize this event and recommend the next step"}'`;
  const headerCommand = `curl -sS '${credential.endpointUrl}' -H 'Authorization: Bearer ${credential.secret}' --json '{"task":"Summarize this event and recommend the next step"}'`;

  const copy = async (kind: typeof copied, value: string) => {
    await navigator.clipboard?.writeText(value);
    setCopied(kind);
    setTimeout(() => setCopied(null), 1_800);
  };

  const enable = async () => {
    if (!webhook) return;
    setWorking(true);
    setError("");
    try {
      const response = await api(`/api/webhooks/${webhook.id}`, { method: "PATCH", body: JSON.stringify({ enabled: true, verificationPending: false }) });
      dispatch({ type: "webhookPatched", webhook: response.webhook });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-5 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="max-h-[90vh] w-full max-w-[620px] overflow-y-auto rounded-2xl border border-hairline/60 bg-panel shadow-2xl">
        <div className="flex items-start justify-between border-b border-hairline/40 px-5 py-4">
          <div><div className="flex items-center gap-2 text-[17px] font-semibold text-ink"><Webhook size={18} className="text-accent" />Local webhook setup</div><div className="mt-1 text-[12px] text-ink-secondary">Copy one URL, send a real event, then turn it on.</div></div>
          <button onClick={onClose} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink"><X size={18} /></button>
        </div>
        <div className="space-y-4 p-5">
          <div className={cn("rounded-xl border p-3.5", available ? "border-warning/25 bg-warning/5" : "border-danger/30 bg-danger/10")}>
            <div className={cn("flex items-center gap-2 text-[12px] font-medium", available ? "text-warning" : "text-danger")}>{available ? <Laptop size={14} /> : <CircleAlert size={14} />}{available ? "Local receiver running" : "Local receiver unavailable"}</div>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-secondary">{available ? "This address only works on this Mac. OpenMausBot must stay open." : "Restart OpenMausBot or change its webhook port before testing."}</p>
          </div>
          <div>
            <div className="mb-1.5 text-[12px] font-medium text-ink">Webhook URL</div>
            <button onClick={() => void copy("url", credential.url)} className="flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3 text-[13px] font-medium text-white hover:brightness-110">{copied === "url" ? <Check size={15} /> : <Copy size={15} />}{copied === "url" ? "Copied" : "Copy local webhook URL"}</button>
            <p className="mt-2 text-[11px] leading-relaxed text-ink-secondary">The URL contains a one-time secret. Treat it like a password.</p>
          </div>
          <div className="rounded-xl border border-hairline/45 bg-inset/55 p-4">
            {webhook?.enabled ? (
              <div className="flex items-start gap-3"><ShieldCheck size={18} className="mt-0.5 text-success" /><div><div className="text-[13px] font-medium text-ink">Webhook is active</div><p className="mt-1 text-[11.5px] text-ink-secondary">New requests will start a background task for this MAUS.</p></div></div>
            ) : webhook?.verifiedAt ? (
              <div><div className="flex items-start gap-3"><Check size={18} className="mt-0.5 text-success" /><div className="min-w-0"><div className="text-[13px] font-medium text-ink">Test event received</div><p className="mt-1 break-words font-mono text-[11px] leading-relaxed text-ink-secondary">{webhook.verificationSample?.preview || "Empty payload"}</p></div></div><button disabled={working} onClick={() => void enable()} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50">{working ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}Turn on webhook</button></div>
            ) : (
              <div><div className="flex items-start gap-3"><Loader2 size={18} className="mt-0.5 animate-spin text-accent" /><div><div className="text-[13px] font-medium text-ink">Waiting for a real event</div><p className="mt-1 text-[11.5px] leading-relaxed text-ink-secondary">The first authenticated request is captured for preview and will not start the MAUS.</p></div></div><div className="relative mt-3 rounded-lg border border-hairline/40 bg-[#101010] p-3 pr-11"><code className="block overflow-x-auto whitespace-nowrap text-[10.5px] text-ink-secondary">{command}</code><button onClick={() => void copy("command", command)} className="absolute right-1.5 top-1.5 rounded-md p-2 text-ink-secondary hover:bg-raised hover:text-ink" title="Copy test command">{copied === "command" ? <Check size={13} className="text-success" /> : <Copy size={13} />}</button></div></div>
            )}
          </div>
          {error && <div className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-3 text-[12px] text-danger">{error}</div>}
          <details className="rounded-xl border border-hairline/40 bg-inset px-3.5 py-3">
            <summary className="cursor-pointer text-[12px] font-medium text-ink">Advanced authentication</summary>
            <div className="mt-3 space-y-2">
              <div className="flex items-center gap-2 rounded-lg border border-hairline/40 bg-panel p-2"><div className="min-w-0 flex-1"><div className="px-2 text-[9px] uppercase tracking-wider text-ink-secondary">Endpoint</div><code className="block overflow-x-auto px-2 pt-0.5 text-[11px] text-ink">{credential.endpointUrl}</code></div><button onClick={() => void copy("endpoint", credential.endpointUrl)} className="rounded-lg bg-raised p-2.5 text-ink-secondary hover:text-ink">{copied === "endpoint" ? <Check size={13} /> : <Copy size={13} />}</button></div>
              <div className="flex items-center gap-2 rounded-lg border border-hairline/40 bg-panel p-2"><div className="min-w-0 flex-1"><div className="px-2 text-[9px] uppercase tracking-wider text-ink-secondary">Bearer secret</div><code className="block overflow-x-auto px-2 pt-0.5 text-[11px] text-ink">{credential.secret}</code></div><button onClick={() => void copy("secret", credential.secret)} className="rounded-lg bg-raised p-2.5 text-ink-secondary hover:text-ink">{copied === "secret" ? <Check size={13} /> : <KeyRound size={13} />}</button></div>
              <div className="relative rounded-lg border border-hairline/40 bg-[#101010] p-3 pr-11"><code className="block overflow-x-auto whitespace-nowrap text-[10.5px] text-ink-secondary">{headerCommand}</code></div>
            </div>
          </details>
        </div>
        <div className="flex justify-end border-t border-hairline/40 px-5 py-4"><button onClick={onClose} className="rounded-xl bg-raised px-4 py-2 text-[13px] text-ink hover:bg-raised-hover">Done</button></div>
      </div>
    </div>
  );
}

function WebhookEditor({ webhook, bots, onClose, onCredential }: { webhook?: WebhookTrigger; bots: Bot[]; onClose: () => void; onCredential: (credential: WebhookCredential, webhookId: string) => void }) {
  const { state, dispatch } = useStore();
  const [botId, setBotId] = useState(webhook?.botId ?? bots[0]?.id ?? "");
  const [name, setName] = useState(webhook?.name ?? "");
  const [prompt, setPrompt] = useState(webhook?.prompt ?? "");
  const [runOn, setRunOn] = useState<RoutineRunOn>(webhook?.runOn ?? "maus");
  const [eventTypes, setEventTypes] = useState((webhook?.eventTypes ?? []).join(", "));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const cloudInstance = state.instances.find((instance) => instance.driverKind === "boxAgent");
  const cloudReady = Boolean(state.config?.box.configured && cloudInstance?.snapshot.state === "available");

  const save = async () => {
    const bot = bots.find((candidate) => candidate.id === botId);
    const input: WebhookTriggerInput = { name: name.trim() || suggestedName(prompt, bot), prompt: prompt.trim(), botId, runOn, enabled: webhook?.enabled ?? false, verificationPending: webhook?.verificationPending ?? !webhook, eventTypes: eventTypes.split(",").map((value) => value.trim()).filter(Boolean) };
    setSaving(true);
    setError("");
    try {
      const response = await api(webhook ? `/api/webhooks/${webhook.id}` : "/api/webhooks", { method: webhook ? "PATCH" : "POST", body: JSON.stringify(input) });
      dispatch({ type: "webhookPatched", webhook: response.webhook });
      onClose();
      if (response.credential) onCredential(response.credential, response.webhook.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-5 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="flex max-h-[90vh] w-full max-w-[590px] flex-col overflow-hidden rounded-2xl border border-hairline/60 bg-panel shadow-2xl">
        <div className="flex items-start justify-between border-b border-hairline/40 px-5 py-4"><div><div className="text-[17px] font-semibold text-ink">{webhook ? "Edit webhook" : "New local webhook"}</div><div className="mt-1 text-[12px] text-ink-secondary">Each request sends a new background task to a MAUS.</div></div><button onClick={onClose} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink"><X size={18} /></button></div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          <div><div className="mb-2 text-[12px] font-medium text-ink-secondary">Who receives the tasks?</div><div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{bots.map((bot) => <button key={bot.id} type="button" onClick={() => setBotId(bot.id)} className={cn("flex min-w-0 items-center gap-2 rounded-xl border px-3 py-2 text-left", botId === bot.id ? "border-accent/70 bg-accent/10" : "border-hairline/50 bg-inset hover:bg-raised/60")}><MausAvatar color={bot.color} state={botId === bot.id ? "happy" : "idle"} size={38} animated={false} /><span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{bot.name}</span></button>)}</div></div>
          <div className="rounded-xl border border-accent/20 bg-accent/5 px-3.5 py-3 text-[11.5px] leading-relaxed text-ink-secondary">Send the task in the request: <code className="text-ink">{`{"task":"Check the failed build"}`}</code>. The MAUS keeps its model, tools, permissions, and computer setup.</div>
          <details className="group rounded-xl border border-hairline/45 bg-inset/45 px-4 py-3" open={Boolean(webhook)}>
            <summary className="cursor-pointer text-[12.5px] font-medium text-ink">Advanced options</summary>
            <div className="mt-4 space-y-4">
              <label className="block"><span className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary">Name <span className="font-normal">· optional</span></span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={suggestedName(prompt, bots.find((bot) => bot.id === botId))} className="w-full rounded-xl border border-hairline/60 bg-panel px-3.5 py-2.5 text-[13px] text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent/70" /></label>
              <label className="block"><span className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary">Default instructions <span className="font-normal">· optional</span></span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} placeholder="For every event, summarize what happened and suggest the next step…" className="w-full resize-y rounded-xl border border-hairline/60 bg-panel px-3.5 py-3 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent/70" /><span className="mt-1.5 block text-[10.5px] leading-relaxed text-ink-secondary">Use this only when every event needs the same handling rule. Otherwise the request’s task is used.</span></label>
              <div><div className="mb-2 text-[11.5px] font-medium text-ink-secondary">Run on</div><div className="grid grid-cols-2 gap-2"><button type="button" onClick={() => setRunOn("maus")} className={cn("rounded-xl border p-3 text-left", runOn === "maus" ? "border-accent/70 bg-accent/10" : "border-hairline/50 bg-panel hover:bg-raised/60")}><div className="flex items-center gap-2 text-[12.5px] font-medium text-ink"><Laptop size={14} />This computer</div></button><button type="button" disabled={!cloudReady && runOn !== "cloud"} onClick={() => setRunOn("cloud")} className={cn("rounded-xl border p-3 text-left disabled:cursor-not-allowed disabled:opacity-45", runOn === "cloud" ? "border-accent/70 bg-accent/10" : "border-hairline/50 bg-panel hover:bg-raised/60")}><div className="flex items-center gap-2 text-[12.5px] font-medium text-ink"><Cloud size={14} />Cloud VM</div></button></div></div>
              <label className="block"><span className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary">Only accept event types <span className="font-normal">· optional</span></span><input value={eventTypes} onChange={(event) => setEventTypes(event.target.value)} placeholder="push, workflow_run" className="w-full rounded-xl border border-hairline/60 bg-panel px-3.5 py-2.5 text-[13px] text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent/70" /><span className="mt-1.5 block text-[10.5px] text-ink-secondary">Comma-separated values from the sender’s event-type header.</span></label>
            </div>
          </details>
          {error && <div className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-3 text-[12px] text-danger">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-hairline/40 px-5 py-4"><button onClick={onClose} className="rounded-xl px-4 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink">Cancel</button><button disabled={saving || !botId} onClick={() => void save()} className="flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40">{saving && <Loader2 size={14} className="animate-spin" />}{webhook ? "Save changes" : "Create local webhook"}</button></div>
      </div>
    </div>
  );
}

interface ActivityItem { id: string; at: number; outcome: WebhookAttempt["outcome"]; eventName: string; preview: string; reason?: string; run?: RoutineRun }

export function WebhooksPanel({ bots }: { bots: Bot[] }) {
  const { state, dispatch } = useStore();
  const [editor, setEditor] = useState<WebhookTrigger | "new" | null>(null);
  const [setup, setSetup] = useState<{ credential: WebhookCredential; webhookId: string } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(state.webhooks[0]?.id ?? null);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState("");
  const runById = useMemo(() => new Map(state.routineRuns.map((run) => [run.id, run])), [state.routineRuns]);

  useEffect(() => {
    if (!state.webhooks.length) setSelectedId(null);
    else if (!selectedId || !state.webhooks.some((webhook) => webhook.id === selectedId)) setSelectedId(state.webhooks[0]!.id);
  }, [selectedId, state.webhooks]);

  const selected = state.webhooks.find((webhook) => webhook.id === selectedId) ?? null;
  const selectedBot = selected ? bots.find((bot) => bot.id === selected.botId) : undefined;
  const attemptsByRun = useMemo(() => new Set(state.webhookAttempts.map((attempt) => attempt.runId).filter(Boolean)), [state.webhookAttempts]);
  const activity = useMemo<ActivityItem[]>(() => {
    if (!selected) return [];
    const attempts = state.webhookAttempts.filter((attempt) => attempt.webhookId === selected.id).map((attempt) => ({ id: attempt.id, at: attempt.receivedAt, outcome: attempt.outcome, eventName: attempt.eventName || (attempt.outcome === "rejected" ? "Rejected request" : "Webhook event"), preview: attempt.preview || "", reason: attempt.reason, run: attempt.runId ? runById.get(attempt.runId) : undefined }));
    const legacy = state.routineRuns.filter((run) => run.webhookId === selected.id && !attemptsByRun.has(run.id)).map((run) => { const summary = deliverySummary(run); return { id: run.id, at: run.scheduledFor, outcome: "accepted" as const, eventName: summary.eventName, preview: summary.preview, run }; });
    return [...attempts, ...legacy].sort((a, b) => b.at - a.at).slice(0, 30);
  }, [attemptsByRun, runById, selected, state.routineRuns, state.webhookAttempts]);

  const invoke = async (webhook: WebhookTrigger, action: "sample" | "rotate" | "toggle" | "delete") => {
    setWorking(`${webhook.id}:${action}`);
    setError("");
    try {
      if (action === "delete") {
        if (!window.confirm(`Delete “${webhook.name}”? Existing task history will stay available.`)) return;
        await api(`/api/webhooks/${webhook.id}`, { method: "DELETE" });
        dispatch({ type: "webhookDeleted", webhookId: webhook.id });
      } else if (action === "toggle") {
        const enabling = !webhook.enabled;
        if (enabling && webhook.verificationPending) throw new Error("Send a test event before turning this webhook on");
        const response = await api(`/api/webhooks/${webhook.id}`, { method: "PATCH", body: JSON.stringify({ enabled: enabling, verificationPending: false }) });
        dispatch({ type: "webhookPatched", webhook: response.webhook });
      } else if (action === "rotate") {
        if (!window.confirm("Generate a new setup URL? The previous secret will stop working immediately.")) return;
        const response = await api(`/api/webhooks/${webhook.id}/rotate`, { method: "POST" });
        dispatch({ type: "webhookPatched", webhook: response.webhook });
        setSetup({ credential: response.credential, webhookId: webhook.id });
      } else {
        if (!window.confirm(`Run a sample task with ${bots.find((bot) => bot.id === webhook.botId)?.name ?? "this MAUS"}? This can use tokens and allowed tools.`)) return;
        await api(`/api/webhooks/${webhook.id}/test`, { method: "POST", body: JSON.stringify({ task: "Summarize this sample event and recommend the next step." }) });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(null);
    }
  };

  const ingress = state.webhookIngress;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto border-t border-hairline/40 p-5 md:p-6">
      <div className="mx-auto max-w-[1100px] space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-[16px] font-semibold text-ink">Webhooks <span className="ml-1 rounded-md bg-accent/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-accent">Local beta</span></h2><p className="mt-1 text-[12px] text-ink-secondary">Send a task to a MAUS the moment an event happens.</p></div><button onClick={() => setEditor("new")} disabled={bots.length === 0} className="flex items-center gap-2 rounded-xl bg-accent px-3.5 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40"><Plus size={15} />New webhook</button></div>
        <div className={cn("flex items-center gap-2 rounded-xl border px-3.5 py-2.5 text-[11.5px]", ingress?.available ? "border-warning/20 bg-warning/5 text-ink-secondary" : "border-danger/25 bg-danger/10 text-danger")}>{ingress?.available ? <Laptop size={14} className="text-warning" /> : <CircleAlert size={14} />}<span><span className="font-medium text-ink">{ingress?.available ? "Local receiver running" : "Local receiver unavailable"}</span>{ingress?.available ? " · Only this Mac can receive events right now." : ` · ${ingress?.error ?? "Restart OpenMausBot to try again."}`}</span></div>
        {error && <div className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-3 text-[12px] text-danger">{error}</div>}
        {state.webhooks.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-hairline/60 bg-panel/50 px-6 py-12 text-center"><div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Send size={26} /></div><h3 className="text-[16px] font-semibold text-ink">Send a task from anywhere on this Mac</h3><p className="mx-auto mt-2 max-w-[450px] text-[12.5px] leading-relaxed text-ink-secondary">Create a URL for a MAUS, then send <code className="text-ink">{`{"task":"…"}`}</code> from Terminal or another local app.</p><button onClick={() => setEditor("new")} disabled={bots.length === 0} className="mt-5 inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40"><Plus size={15} />Create local webhook</button>{bots.length === 0 && <p className="mt-3 text-[12px] text-warning">Create a MAUS first, then come back here.</p>}</div>
        ) : (
          <div className="grid min-h-[480px] overflow-hidden rounded-2xl border border-hairline/45 bg-panel md:grid-cols-[310px_minmax(0,1fr)]">
            <div className="border-b border-hairline/35 bg-inset/25 md:border-b-0 md:border-r">{state.webhooks.map((webhook) => { const bot = bots.find((candidate) => candidate.id === webhook.botId); const status = statusFor(webhook); const last = state.webhookAttempts.filter((attempt) => attempt.webhookId === webhook.id).at(-1); return <button key={webhook.id} onClick={() => setSelectedId(webhook.id)} className={cn("flex w-full items-center gap-3 border-b border-hairline/25 px-3.5 py-3 text-left last:border-b-0", selectedId === webhook.id ? "bg-raised/75" : "hover:bg-raised/35")}>{bot ? <MausAvatar color={bot.color} state={webhook.enabled ? "idle" : "sleeping"} size={42} animated={false} label={bot.name} /> : <div className="flex size-[42px] items-center justify-center rounded-xl bg-raised text-ink-secondary"><Webhook size={18} /></div>}<div className="min-w-0 flex-1"><div className="truncate text-[13px] font-medium text-ink">{webhook.name}</div><div className="mt-1 flex items-center gap-1.5 text-[10.5px] text-ink-secondary"><span className={cn("size-1.5 rounded-full", status.dot)} /><span className={status.tone}>{status.label}</span>{last && <><span>·</span><span>{relativeTime(last.receivedAt)}</span></>}</div></div><ChevronRight size={14} className="shrink-0 text-ink-secondary" /></button>; })}</div>
            {selected && <div className="min-w-0 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex min-w-0 items-center gap-3">{selectedBot ? <MausAvatar color={selectedBot.color} state={selected.enabled ? "idle" : "sleeping"} size={52} animated={false} label={selectedBot.name} /> : <div className="flex size-[52px] items-center justify-center rounded-xl bg-raised text-ink-secondary"><Webhook size={22} /></div>}<div className="min-w-0"><h3 className="truncate text-[17px] font-semibold text-ink">{selected.name}</h3><div className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-secondary"><span>{selectedBot?.name ?? "Deleted MAUS"}</span><span>·</span><span>{selected.runOn === "cloud" ? "Cloud VM" : "This computer"}</span><span>·</span><span className={statusFor(selected).tone}>{statusFor(selected).label}</span></div></div></div><div className="flex items-center gap-1.5">{selected.enabled && <button disabled={Boolean(working)} onClick={() => void invoke(selected, "sample")} className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-[11.5px] text-ink hover:bg-raised-hover disabled:opacity-40"><Play size={12} />Run sample</button>}<details className="relative"><summary className="list-none rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink"><MoreHorizontal size={17} /></summary><div className="absolute right-0 top-full z-20 mt-1 w-[190px] rounded-xl border border-hairline/50 bg-card p-1.5 shadow-2xl"><button onClick={() => setEditor(selected)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[12px] text-ink hover:bg-raised">Edit</button><button onClick={() => void invoke(selected, "rotate")} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[12px] text-ink hover:bg-raised"><RotateCw size={13} />New setup URL</button>{!selected.verificationPending && <button onClick={() => void invoke(selected, "toggle")} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[12px] text-ink hover:bg-raised">{selected.enabled ? <Pause size={13} /> : <Play size={13} />}{selected.enabled ? "Pause" : "Enable"}</button>}<button onClick={() => void invoke(selected, "delete")} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[12px] text-danger hover:bg-danger/10"><Trash2 size={13} />Delete</button></div></details></div></div>
              <div className="mt-5 grid gap-3 sm:grid-cols-2"><div className="rounded-xl border border-hairline/40 bg-inset/40 p-3.5"><div className="text-[10px] uppercase tracking-wider text-ink-secondary">When an event arrives</div><div className="mt-2 text-[12px] leading-relaxed text-ink">{selected.prompt || "Use the task or message sent in each request."}</div>{selected.eventTypes?.length ? <div className="mt-2 text-[10.5px] text-ink-secondary">Only: {selected.eventTypes.join(", ")}</div> : null}</div><div className="rounded-xl border border-hairline/40 bg-inset/40 p-3.5"><div className="flex items-center justify-between"><div className="text-[10px] uppercase tracking-wider text-ink-secondary">Connection</div><span className="rounded-full bg-warning/10 px-2 py-0.5 text-[9.5px] text-warning">Local only</span></div><div className="mt-2 flex items-center gap-2 text-[12px] text-ink"><Laptop size={13} />{ingress?.available ? "Receiver running" : "Receiver unavailable"}</div><p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-secondary">OpenMausBot must stay open. Public connectivity is not configured.</p><button onClick={() => void invoke(selected, "rotate")} className="mt-3 flex items-center gap-1.5 text-[11px] font-medium text-accent hover:brightness-125"><KeyRound size={12} />Generate setup URL</button></div></div>
              {selected.verificationSample && !selected.enabled && <div className="mt-3 rounded-xl border border-success/20 bg-success/5 p-3.5"><div className="flex items-center gap-2 text-[12px] font-medium text-success"><Check size={13} />Test event received</div><p className="mt-2 break-words font-mono text-[10.5px] leading-relaxed text-ink-secondary">{selected.verificationSample.preview || "Empty payload"}</p><button disabled={Boolean(working)} onClick={() => void invoke(selected, "toggle")} className="mt-3 flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-[11.5px] font-medium text-white hover:brightness-110"><Play size={12} />Turn on webhook</button></div>}
              <div className="mt-5"><div className="mb-2 flex items-center justify-between"><h4 className="text-[12.5px] font-medium text-ink">Activity</h4><span className="text-[10.5px] text-ink-secondary">Updates automatically</span></div><div className="overflow-hidden rounded-xl border border-hairline/35 bg-inset/35">{activity.length === 0 ? <div className="px-4 py-8 text-center text-[11.5px] text-ink-secondary">No requests yet. Generate a setup URL and send a test event.</div> : activity.map((item, index) => <div key={item.id} className={cn("flex items-center gap-2.5 px-3.5 py-3", index > 0 && "border-t border-hairline/25")}><span className={cn("size-2 shrink-0 rounded-full", item.outcome === "rejected" || item.run?.status === "failed" ? "bg-danger" : item.run && ["queued", "running", "waiting"].includes(item.run.status) ? "animate-pulse bg-accent" : item.outcome === "ignored" || item.outcome === "duplicate" ? "bg-ink-secondary/50" : "bg-success")} /><div className="min-w-0 flex-1"><div className="flex items-center gap-1.5 text-[11.5px]"><span className="truncate font-medium text-ink">{item.eventName}</span><span className="shrink-0 text-ink-secondary">· {relativeTime(item.at)}</span></div><div className="mt-0.5 truncate font-mono text-[10.5px] text-ink-secondary/85">{item.reason || item.preview || "Empty payload"}</div></div><span className={cn("shrink-0 text-[10.5px] font-medium", outcomeTone(item.outcome, item.run))}>{outcomeLabel(item.outcome, item.run)}</span>{item.run?.threadId && selectedBot && <button onClick={() => { dispatch({ type: "select", id: selectedBot.id }); dispatch({ type: "switchTask", botId: selectedBot.id, threadId: item.run!.threadId! }); }} className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[10.5px] text-ink-secondary hover:bg-raised hover:text-ink" title="Open this execution in the MAUS chat"><ExternalLink size={11} />Open chat</button>}</div>)}</div></div>
            </div>}
          </div>
        )}
      </div>
      {editor && <WebhookEditor webhook={editor === "new" ? undefined : editor} bots={bots} onClose={() => setEditor(null)} onCredential={(credential, webhookId) => setSetup({ credential, webhookId })} />}
      {setup && <SetupModal credential={setup.credential} webhookId={setup.webhookId} available={Boolean(ingress?.available)} onClose={() => setSetup(null)} />}
    </div>
  );
}
