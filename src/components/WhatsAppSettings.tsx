// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { t } from "@/lib/i18n";
import { api } from "@/state/store";

export type WhatsAppLinkState = "idle" | "linking" | "restarting" | "connected" | "retry" | "logged-out" | "conflict" | "blocked";
export interface WhatsAppGroupEntry { jid: string; name?: string; activation: "mention" | "always" }
export interface WhatsAppSettingsValue {
  mode: "self-chat" | "contacts"; allowFrom: string[];
  groups: { policy: "disabled" | "allowlist"; allow: WhatsAppGroupEntry[]; senders: "members" | "allowlist" };
  readReceipts: boolean; quoteReplies: "off" | "groups" | "all";
}
export interface WhatsAppPairingRequest { id: string; name: string | null; number: string; expiresAt: number }
export interface WhatsAppStatus {
  state: WhatsAppLinkState; linked: boolean; enabled: boolean; busy: boolean; error: string | null; blockedReason: string | null;
  nextRetryAt: number | null; pending: number; uncertain: number; rejected: number; needsReview: number;
  ingressWriteFailed: boolean; catchUpTruncated: boolean; number: string | null; targetBotId?: string;
  qr?: { text: string; version: number }; pairingCode?: { code: string; phone: string };
  pairing: WhatsAppPairingRequest[]; settings: WhatsAppSettingsValue;
}
const STATES = new Set<string>(["idle", "linking", "restarting", "connected", "retry", "logged-out", "conflict", "blocked"]);
const bad = () => new Error("WhatsApp status unavailable");
const count = (v: unknown) => { if (!Number.isSafeInteger(v) || Number(v) < 0) throw bad(); return Number(v); };
const short = (v: unknown, max: number) => { if (typeof v !== "string" || v.length > max) throw bad(); return v; };
const flag = (v: unknown) => { if (typeof v !== "boolean") throw bad(); return v; };

export function whatsappStatusFrom(value: unknown): WhatsAppStatus {
  if (!value || typeof value !== "object") throw bad();
  const v = value as Record<string, unknown>;
  if (!STATES.has(String(v.state))) throw bad();
  const s = v.settings as Record<string, unknown> | undefined, g = s?.groups as Record<string, unknown> | undefined;
  if (!s || !g || !Array.isArray(s.allowFrom) || !Array.isArray(g.allow) || !Array.isArray(v.pairing)) throw bad();
  if (s.mode !== "self-chat" && s.mode !== "contacts") throw bad();
  if (g.policy !== "disabled" && g.policy !== "allowlist") throw bad();
  if (g.senders !== "members" && g.senders !== "allowlist") throw bad();
  if (s.quoteReplies !== "off" && s.quoteReplies !== "groups" && s.quoteReplies !== "all") throw bad();
  if (v.nextRetryAt !== null && v.nextRetryAt !== undefined && (typeof v.nextRetryAt !== "number" || !Number.isFinite(v.nextRetryAt))) throw bad();
  const result: WhatsAppStatus = {
    state: v.state as WhatsAppLinkState, linked: flag(v.linked), enabled: flag(v.enabled), busy: flag(v.busy),
    error: v.error === null || v.error === undefined ? null : short(v.error, 120),
    blockedReason: v.blockedReason === null || v.blockedReason === undefined ? null : short(v.blockedReason, 60),
    nextRetryAt: typeof v.nextRetryAt === "number" ? v.nextRetryAt : null,
    pending: count(v.pending), uncertain: count(v.uncertain), rejected: count(v.rejected), needsReview: count(v.needsReview),
    ingressWriteFailed: v.ingressWriteFailed === true, catchUpTruncated: v.catchUpTruncated === true,
    number: v.number === null || v.number === undefined ? null : short(v.number, 40),
    pairing: v.pairing.map(p => {
      const r = p as Record<string, unknown>;
      if (!Number.isFinite(r.expiresAt)) throw bad();
      return { id: short(r.id, 40), name: r.name === null || r.name === undefined ? null : short(r.name, 80), number: short(r.number, 40), expiresAt: Number(r.expiresAt) };
    }),
    settings: {
      mode: s.mode, allowFrom: s.allowFrom.map(x => short(x, 200)), readReceipts: s.readReceipts === true, quoteReplies: s.quoteReplies,
      groups: { policy: g.policy, senders: g.senders, allow: g.allow.map(x => {
        const r = x as Record<string, unknown>;
        if (r.activation !== "mention" && r.activation !== "always") throw bad();
        return { jid: short(r.jid, 200), ...(typeof r.name === "string" ? { name: r.name.slice(0, 120) } : {}), activation: r.activation };
      }) },
    },
  };
  if (v.targetBotId !== undefined) result.targetBotId = short(v.targetBotId, 180);
  const qr = v.qr as Record<string, unknown> | undefined;
  if (qr && typeof qr.text === "string" && qr.text.length <= 4096) result.qr = { text: qr.text, version: Number(qr.version) || 0 };
  const code = v.pairingCode as Record<string, unknown> | undefined;
  if (code && typeof code.code === "string" && /^[A-Za-z0-9]{4,16}$/.test(code.code)) result.pairingCode = { code: code.code, phone: typeof code.phone === "string" ? code.phone.slice(0, 20) : "" };
  return result;
}

export function whatsappMessage(status: WhatsAppStatus | null): string {
  if (!status) return t("whatsapp.health.checking");
  switch (status.state) {
    case "idle": return t("whatsapp.health.idle");
    case "linking": return status.pairingCode ? t("whatsapp.state.linkingCode") : t("whatsapp.state.linking");
    case "restarting": return t("whatsapp.state.restarting");
    case "connected": return status.number ? t("whatsapp.state.connected", { number: status.number, device: t("whatsapp.device") }) : t("whatsapp.state.connectedNoNumber", { device: t("whatsapp.device") });
    case "retry": return t("whatsapp.state.retry");
    case "logged-out": return t("whatsapp.state.loggedOut");
    case "conflict": return t("whatsapp.state.conflict");
    case "blocked":
      if (status.error === "cloud-api-not-available") return t("whatsapp.state.blocked.cloud");
      switch (status.blockedReason) {
        case "forbidden": return t("whatsapp.state.blocked.forbidden");
        case "multidevice-mismatch": return t("whatsapp.state.blocked.update");
        case "retry-limit": return t("whatsapp.state.blocked.retryLimit");
        case "credential-store": return t("whatsapp.state.blocked.credentialStore");
        case "key-missing": case "auth-unreadable": case "auth-dir": return t("whatsapp.state.blocked.unreadable");
        default: return t("whatsapp.state.blocked.other");
      }
  }
}
/** Digits only, with a country code: what the allowlist stores. */
export function normalizeWhatsAppNumber(value: string): string | null {
  const digits = value.replace(/[\s().+-]/g, "");
  return /^[1-9]\d{6,14}$/.test(digits) ? digits : null;
}

const inputClass = "mt-1 min-h-11 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus-visible:ring-2 focus-visible:ring-accent-border disabled:opacity-50";
const buttonClass = "min-h-11 rounded-lg border border-hairline/40 px-3 py-2 text-[12px] text-ink hover:bg-control disabled:opacity-50";
const primaryClass = "min-h-11 rounded-lg bg-accent px-3 py-2 text-[12px] text-accent-ink hover:brightness-110 disabled:opacity-50";
const checkClass = "flex min-h-11 items-center gap-2 text-[12px] text-ink";
interface PersonChoice { personId: string; label: string }
interface Groups { jid: string; name: string }

export function WhatsAppSettings() {
  const [status, setStatus] = useState<WhatsAppStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState(false), [method, setMethod] = useState<"qr" | "code">("qr"), [phone, setPhone] = useState("");
  const [confirmUnlink, setConfirmUnlink] = useState(false), [allowInput, setAllowInput] = useState(""), [allowError, setAllowError] = useState(false);
  const [codes, setCodes] = useState<Record<string, string>>({}), [personFor, setPersonFor] = useState<Record<string, string>>({});
  const [people, setPeople] = useState<PersonChoice[]>([]), [groups, setGroups] = useState<Groups[] | null>(null);
  const gate = useRef(false), version = useRef(0), mounted = useRef(true);
  const apply = (value: unknown, expected: number) => {
    const next = whatsappStatusFrom(value);
    if (!mounted.current || version.current !== expected) return;
    setStatus(next); setRefreshError(false);
  };
  const refresh = async (expected: number) => { apply(await api("/api/whatsapp/status"), expected); };
  const run = async (action: string, work: (expected: number) => Promise<void>) => {
    if (gate.current) return; gate.current = true; const expected = ++version.current;
    setBusy(action); setError(null); setNotice(null);
    try { await work(expected); }
    catch {
      if (mounted.current && expected === version.current) {
        setError(t(`whatsapp.error.${action}` as never) || t("whatsapp.error.status"));
        if (action !== "status") try { await refresh(expected); } catch { setRefreshError(true); }
      }
    } finally { gate.current = false; if (mounted.current) setBusy(null); }
  };
  useEffect(() => { mounted.current = true; void run("status", refresh); return () => { mounted.current = false; version.current++; }; }, []);
  useEffect(() => {
    let active = true, inFlight = false;
    const timer = window.setInterval(async () => {
      if (gate.current || inFlight) return;
      inFlight = true; const expected = version.current;
      try { const next = await api("/api/whatsapp/status"); if (active) apply(next, expected); }
      catch { if (active && version.current === expected) setRefreshError(true); }
      finally { inFlight = false; }
    }, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const pendingCount = status?.pairing.length ?? 0;
  useEffect(() => {
    if (!pendingCount) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await api("/api/memory/action", { method: "POST", body: JSON.stringify({ action: "humans" }) }) as { ownerPersonId?: string; bindings?: Array<{ active?: boolean; personId?: string | null; origin?: { platform?: string; userId?: string } }> };
        const seen = new Set<string>(), list: PersonChoice[] = [];
        for (const b of res.bindings ?? []) if (b.active && b.personId && b.personId !== res.ownerPersonId && !seen.has(b.personId)) { seen.add(b.personId); list.push({ personId: b.personId, label: `${b.origin?.platform ?? ""} ${b.origin?.userId ?? ""}`.trim() }); }
        if (!cancelled) setPeople(list);
      } catch { if (!cancelled) setPeople([]); }
    })();
    return () => { cancelled = true; };
  }, [pendingCount]);

  const linkState = status?.state ?? "idle";
  const canLink = !status || ["idle", "logged-out", "conflict", "blocked"].includes(linkState);
  const canResume = linkState === "retry" || (linkState === "blocked" && status?.blockedReason === "retry-limit");
  const settings = status?.settings;
  const saveSettings = (patch: Partial<WhatsAppSettingsValue>) => run("save", async expected => {
    await api("/api/config", { method: "PATCH", body: JSON.stringify({ whatsapp: patch }) });
    await refresh(expected); if (mounted.current) setNotice(t("whatsapp.saved"));
  });
  const link = (via: "qr" | "code") => run("link", async expected => {
    if (via === "code" && !phone.replace(/\D/g, "").match(/^\d{8,15}$/)) { setError(t("whatsapp.error.phone")); return; }
    apply(await api("/api/whatsapp/link", { method: "POST", body: JSON.stringify(via === "code" ? { method: "code", phone: phone.replace(/\D/g, "") } : { method: "qr" }) }), expected);
  });
  const addAllow = () => {
    const n = normalizeWhatsAppNumber(allowInput);
    if (!n) { setAllowError(true); return; }
    setAllowError(false); setAllowInput("");
    if (settings && !settings.allowFrom.includes(n)) void saveSettings({ allowFrom: [...settings.allowFrom, n] });
  };
  const groupsFor = settings?.groups;
  const setGroups_ = (next: Partial<WhatsAppSettingsValue["groups"]>) => groupsFor && saveSettings({ groups: { ...groupsFor, ...next } });
  const toggleGroup = (g: Groups, on: boolean) => {
    if (!groupsFor) return;
    const rest = groupsFor.allow.filter(x => x.jid !== g.jid);
    void setGroups_({ allow: on ? [...rest, { jid: g.jid, name: g.name, activation: "mention" }] : rest });
  };
  const setActivation = (jid: string, activation: "mention" | "always") => groupsFor && setGroups_({ allow: groupsFor.allow.map(x => x.jid === jid ? { ...x, activation } : x) });
  const shownGroups: Array<{ jid: string; name: string; entry?: WhatsAppGroupEntry }> = [];
  for (const g of groups ?? []) shownGroups.push({ ...g, entry: groupsFor?.allow.find(x => x.jid === g.jid) });
  for (const e of groupsFor?.allow ?? []) if (!shownGroups.some(g => g.jid === e.jid)) shownGroups.push({ jid: e.jid, name: e.name ?? t("whatsapp.groups.saved"), entry: e });
  const off = Boolean(busy) || !status || status.busy;

  return <section aria-labelledby="whatsapp-settings-title" className="min-w-0 rounded-xl border border-hairline/40 bg-card p-4">
    <h3 id="whatsapp-settings-title" className="text-[15px] font-semibold text-ink">{t("whatsapp.title")}</h3>
    <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{t("whatsapp.intro")}</p>
    <div className="mt-3 rounded-lg bg-inset p-3 text-[12px] leading-relaxed text-ink-secondary">
      <h4 className="text-[13px] font-medium text-ink">{t("whatsapp.risk.title")}</h4>
      <p className="mt-1">{t("whatsapp.risk.how")}</p><p className="mt-2">{t("whatsapp.risk.unofficial")}</p><p className="mt-2">{t("whatsapp.risk.local")}</p>
      <p className="mt-2">{t("whatsapp.risk.official")}</p>
    </div>
    <p role="status" className="mt-3 text-[12px] font-medium text-ink">{whatsappMessage(status)}</p>
    {status?.state === "connected" && <p className="mt-1 text-[12px] text-ink-secondary">{t("whatsapp.status.chief")}</p>}

    {canLink && <div className="mt-3">
      {method === "code" && <label className="block text-[12px] text-ink-secondary">{t("whatsapp.link.phone")}
        <input name="whatsapp-phone" type="tel" inputMode="numeric" autoComplete="off" maxLength={24} value={phone} disabled={off} onChange={e => setPhone(e.target.value)} className={inputClass} />
        <span className="mt-1 block">{t("whatsapp.link.phoneHelp")}</span></label>}
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className={primaryClass} disabled={off} onClick={() => void link(method)}>{busy === "link" ? t("whatsapp.link.starting") : linkState === "idle" ? t("whatsapp.link.qr") : t("whatsapp.link.relink")}</button>
        <button type="button" className={buttonClass} disabled={off} onClick={() => setMethod(method === "qr" ? "code" : "qr")}>{method === "qr" ? t("whatsapp.link.code") : t("whatsapp.link.qrInstead")}</button>
      </div>
    </div>}
    {linkState === "linking" && <div className="mt-3 rounded-lg bg-inset p-3 text-[12px] text-ink">
      {status?.pairingCode ? <>
        <p className="text-ink-secondary">{t("whatsapp.link.codeSteps")}</p>
        <code className="mt-2 block text-[22px] tracking-[0.3em] select-all" aria-label={t("whatsapp.pairing.code")}>{status.pairingCode.code}</code>
        {status.pairingCode.phone && <p className="mt-1 text-ink-secondary">{t("whatsapp.link.codeFor", { number: `+${status.pairingCode.phone}` })}</p>}
      </> : status?.qr ? <>
        <p className="text-ink-secondary">{t("whatsapp.link.steps")}</p>
        <div className="mt-2 inline-block rounded-lg bg-white p-3" role="img" aria-label={t("whatsapp.link.qrAlt")}><QRCodeSVG value={status.qr.text} size={256} /></div>
        <p className="mt-2 text-ink-secondary">{t("whatsapp.link.sameDevice")}</p>
        <button type="button" className={`${buttonClass} mt-2`} disabled={off} onClick={() => setMethod("code")}>{t("whatsapp.link.code")}</button>
      </> : <p className="text-ink-secondary">{t("whatsapp.link.waiting")}</p>}
    </div>}
    {linkState === "linking" && method === "code" && !status?.pairingCode && <div className="mt-2">
      <label className="block text-[12px] text-ink-secondary">{t("whatsapp.link.phone")}
        <input name="whatsapp-phone" type="tel" inputMode="numeric" autoComplete="off" maxLength={24} value={phone} disabled={off} onChange={e => setPhone(e.target.value)} className={inputClass} /></label>
      <button type="button" className={`${primaryClass} mt-2`} disabled={off} onClick={() => void link("code")}>{t("whatsapp.link.code")}</button>
    </div>}

    <div className="mt-3 flex flex-wrap gap-2">
      {canResume && <button type="button" className={buttonClass} disabled={off} onClick={() => void run("resume", async expected => { await api("/api/whatsapp/resume", { method: "POST", body: "{}" }); await refresh(expected); })}>{busy === "resume" ? t("whatsapp.resuming") : t("whatsapp.resume")}</button>}
      <button type="button" className={buttonClass} disabled={Boolean(busy)} onClick={() => void run("status", refresh)}>{t("whatsapp.refresh")}</button>
      {linkState !== "idle" && !confirmUnlink && <button type="button" className={`${buttonClass} text-danger`} disabled={off} onClick={() => setConfirmUnlink(true)}>{t("whatsapp.unlink")}</button>}
    </div>
    {confirmUnlink && <div role="alertdialog" aria-label={t("whatsapp.unlink")} className="mt-2 rounded-lg bg-inset p-3 text-[12px] text-ink">
      <p>{t("whatsapp.unlinkConfirm")}</p>
      <div className="mt-2 flex gap-2">
        <button type="button" className={`${buttonClass} text-danger`} disabled={off} onClick={() => void run("unlink", async expected => { await api("/api/whatsapp/unlink", { method: "POST", body: "{}" }); setConfirmUnlink(false); await refresh(expected); })}>{busy === "unlink" ? t("whatsapp.unlinking") : t("whatsapp.unlinkYes")}</button>
        <button type="button" className={buttonClass} onClick={() => setConfirmUnlink(false)}>{t("whatsapp.cancel")}</button>
      </div>
    </div>}

    {status?.linked && settings && <>
      <h4 className="mt-5 text-[13px] font-medium text-ink">{t("whatsapp.mode.title")}</h4>
      <div role="radiogroup" aria-label={t("whatsapp.mode.title")}>
        {(["self-chat", "contacts"] as const).map(m => <label key={m} className={checkClass}>
          <input type="radio" name="whatsapp-mode" checked={settings.mode === m} disabled={off} onChange={() => void saveSettings({ mode: m })} />{m === "self-chat" ? t("whatsapp.mode.self") : t("whatsapp.mode.contacts")}</label>)}
      </div>
      <p className="text-[12px] text-ink-secondary">{t("whatsapp.mode.help")}</p>

      {settings.mode === "contacts" && <>
        <h4 className="mt-5 text-[13px] font-medium text-ink">{t("whatsapp.allow.title")}</h4>
        {settings.allowFrom.length === 0 ? <p className="mt-1 text-[12px] text-ink-secondary">{t("whatsapp.allow.empty")}</p> :
          <ul className="mt-1 space-y-1">{settings.allowFrom.map(n => <li key={n} className="flex items-center justify-between gap-2 text-[12px] text-ink">
            <span>+{n}</span><button type="button" className={buttonClass} disabled={off} aria-label={t("whatsapp.allow.remove", { number: `+${n}` })}
              onClick={() => void saveSettings({ allowFrom: settings.allowFrom.filter(x => x !== n) })}>×</button></li>)}</ul>}
        <label className="mt-2 block text-[12px] text-ink-secondary">{t("whatsapp.allow.label")}
          <input name="whatsapp-allow" type="tel" inputMode="numeric" autoComplete="off" maxLength={24} value={allowInput} disabled={off} onChange={e => setAllowInput(e.target.value)} className={inputClass} /></label>
        {allowError && <p role="alert" className="mt-1 text-[12px] text-warning">{t("whatsapp.allow.invalid")}</p>}
        <button type="button" className={`${buttonClass} mt-2`} disabled={off || !allowInput.trim() || settings.allowFrom.length >= 200} onClick={addAllow}>{t("whatsapp.allow.add")}</button>
        {settings.allowFrom.length >= 200 && <p className="mt-1 text-[12px] text-warning">{t("whatsapp.allow.full")}</p>}

        <h4 className="mt-5 text-[13px] font-medium text-ink">{t("whatsapp.pairing.title")}</h4>
        {status.pairing.length === 0 ? <p className="mt-1 text-[12px] text-ink-secondary">{t("whatsapp.pairing.none")}</p> : <>
          <p className="mt-1 text-[12px] text-ink-secondary">{t("whatsapp.pairing.help")}</p>
          <ul className="mt-2 space-y-3">{status.pairing.map(p => <li key={p.id} className="rounded-lg bg-inset p-3 text-[12px] text-ink">
            <p>{p.name ? t("whatsapp.pairing.from", { who: p.name, number: p.number }) : t("whatsapp.pairing.fromNoName", { number: p.number })}</p>
            <label className="mt-2 block text-ink-secondary">{t("whatsapp.pairing.codeLabel")}
              <input name={`whatsapp-code-${p.id}`} autoComplete="off" spellCheck={false} maxLength={12} value={codes[p.id] ?? ""} disabled={off} className={inputClass}
                onChange={e => setCodes(c => ({ ...c, [p.id]: e.target.value.trim().toUpperCase() }))} /></label>
            <label className="mt-2 block text-ink-secondary">{t("whatsapp.pairing.approveAs")}
              <select name={`whatsapp-person-${p.id}`} value={personFor[p.id] ?? ""} disabled={off} className={inputClass} onChange={e => setPersonFor(c => ({ ...c, [p.id]: e.target.value }))}>
                <option value="">{t("whatsapp.pairing.newPerson")}</option>{people.map(x => <option key={x.personId} value={x.personId}>{x.label}</option>)}</select></label>
            <div className="mt-2 flex gap-2">
              <button type="button" className={primaryClass} disabled={off || !codes[p.id]} onClick={() => void run("approve", async expected => {
                await api("/api/whatsapp/approve", { method: "POST", body: JSON.stringify({ code: codes[p.id], ...(personFor[p.id] ? { personId: personFor[p.id] } : {}) }) });
                setCodes(c => ({ ...c, [p.id]: "" })); await refresh(expected); if (mounted.current) setNotice(t("whatsapp.pairing.approved"));
              })}>{t("whatsapp.pairing.confirm")}</button>
              <button type="button" className={buttonClass} disabled={off || !codes[p.id]} onClick={() => void run("dismiss", async expected => {
                await api("/api/whatsapp/dismiss", { method: "POST", body: JSON.stringify({ code: codes[p.id] }) });
                setCodes(c => ({ ...c, [p.id]: "" })); await refresh(expected); if (mounted.current) setNotice(t("whatsapp.pairing.dismissed"));
              })}>{t("whatsapp.pairing.dismiss")}</button>
            </div></li>)}</ul></>}
      </>}

      <h4 className="mt-5 text-[13px] font-medium text-ink">{t("whatsapp.groups.title")}</h4>
      <p className="mt-1 text-[12px] text-ink-secondary">{t("whatsapp.groups.help")}</p>
      <label className={checkClass}><input type="checkbox" checked={settings.groups.policy === "allowlist"} disabled={off}
        onChange={e => void setGroups_({ policy: e.target.checked ? "allowlist" : "disabled" })} />{t("whatsapp.groups.enable")}</label>
      {settings.groups.policy === "allowlist" && <>
        <label className="block text-[12px] text-ink-secondary">{t("whatsapp.groups.senders")}
          <select name="whatsapp-senders" value={settings.groups.senders} disabled={off} className={inputClass} onChange={e => void setGroups_({ senders: e.target.value as "members" | "allowlist" })}>
            <option value="members">{t("whatsapp.groups.sendersMembers")}</option><option value="allowlist">{t("whatsapp.groups.sendersAllowlist")}</option></select></label>
        <button type="button" className={`${buttonClass} mt-2`} disabled={off} onClick={() => void run("groups", async () => {
          const res = await api("/api/whatsapp/groups") as { groups?: Array<{ jid?: unknown; name?: unknown }> };
          setGroups((res.groups ?? []).filter(g => typeof g.jid === "string").map(g => ({ jid: String(g.jid), name: typeof g.name === "string" && g.name ? g.name : String(g.jid) })));
        })}>{busy === "groups" ? t("whatsapp.groups.loading") : t("whatsapp.groups.load")}</button>
        {groups && groups.length === 0 && shownGroups.length === 0 && <p className="mt-2 text-[12px] text-ink-secondary">{t("whatsapp.groups.none")}</p>}
        <ul className="mt-2 space-y-2">{shownGroups.map(g => <li key={g.jid} className="rounded-lg bg-inset p-3 text-[12px] text-ink">
          <label className={checkClass}><input type="checkbox" checked={Boolean(g.entry)} disabled={off || (!g.entry && settings.groups.allow.length >= 50)} onChange={e => toggleGroup(g, e.target.checked)} />{t("whatsapp.groups.use", { name: g.name })}</label>
          {g.entry && <label className="block text-ink-secondary">{t("whatsapp.groups.activation", { name: g.name })}
            <select value={g.entry.activation} disabled={off} className={inputClass} onChange={e => void setActivation(g.jid, e.target.value as "mention" | "always")}>
              <option value="mention">{t("whatsapp.groups.mention")}</option><option value="always">{t("whatsapp.groups.always")}</option></select></label>}
        </li>)}</ul>
        {settings.groups.allow.length >= 50 && <p className="mt-1 text-[12px] text-warning">{t("whatsapp.groups.full")}</p>}
      </>}

      <h4 className="mt-5 text-[13px] font-medium text-ink">{t("whatsapp.options.title")}</h4>
      <label className={checkClass}><input type="checkbox" checked={settings.readReceipts} disabled={off} onChange={e => void saveSettings({ readReceipts: e.target.checked })} />{t("whatsapp.options.receipts")}</label>
      <label className="block text-[12px] text-ink-secondary">{t("whatsapp.options.quote")}
        <select name="whatsapp-quote" value={settings.quoteReplies} disabled={off} className={inputClass} onChange={e => void saveSettings({ quoteReplies: e.target.value as "off" | "groups" | "all" })}>
          <option value="off">{t("whatsapp.options.quoteOff")}</option><option value="groups">{t("whatsapp.options.quoteGroups")}</option><option value="all">{t("whatsapp.options.quoteAll")}</option></select></label>
    </>}

    {(status?.pending ?? 0) > 0 && <p role="status" className="mt-3 text-[12px] text-ink-secondary">{t("whatsapp.status.pending")}</p>}
    {(status?.uncertain ?? 0) > 0 && <p role="alert" className="mt-2 text-[12px] text-warning">{t("whatsapp.status.uncertain")}</p>}
    {(status?.rejected ?? 0) > 0 && <p role="alert" className="mt-2 text-[12px] text-warning">{t("whatsapp.status.rejected")}</p>}
    {(status?.needsReview ?? 0) > 0 && <p role="alert" className="mt-2 text-[12px] text-warning">{t("whatsapp.status.needsReview")}</p>}
    {status?.ingressWriteFailed && <p role="alert" className="mt-2 text-[12px] text-warning">{t("whatsapp.status.ingress")}</p>}
    {status?.catchUpTruncated && <p role="status" className="mt-2 text-[12px] text-ink-secondary">{t("whatsapp.status.catchUp")}</p>}
    {refreshError && <p role="alert" className="mt-2 text-[12px] text-warning">{t("whatsapp.error.refreshFailed")}</p>}
    {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    {notice && <p role="status" className="mt-2 text-[12px] text-ink-secondary">{notice}</p>}
  </section>;
}
