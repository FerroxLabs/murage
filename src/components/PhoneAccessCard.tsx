// 1.0.9 phone tools S21: the "Phone" card in bot settings. Owner and desktop only. Hidden when the host does not offer phone tools;
// on a Cloud home it says so. One row per capability (Off by default); the device list says what each paired phone needs next.
// The words come from shared/phone-copy.ts, the same file the server reads. Activity rows are written by the server and never hold contents.
import { useEffect, useState } from "react";
import { api, useStore, type Bot } from "@/state/store";
import { isCloudOrigin } from "@/lib/cloud-workspace";
import { useDesktopSurface } from "@/lib/use-surface";
import { PHONE_CAPABILITIES, type PhoneCapability } from "../../shared/phone-jobs-contract";
import { PHONE_APP_VALUES, type PhoneApps, type PhoneReport } from "../../shared/phone-apps";
import { PHONE_CARD_COPY, PHONE_COPY } from "../../shared/phone-copy";
import { driverMountsPhoneJobs } from "../../server/phone-jobs-engines";

export interface PairedPhone { id: string; name: string; phoneJobsReady?: boolean }
export interface PhoneRegistrationView { deviceId: string; name: string; capabilities: PhoneReport }

export type PhoneDeviceRow =
  | { id: string; name: string; state: "registered"; reports: string[] }
  | { id: string; name: string; state: "passcode" }
  | { id: string; name: string; state: "update-app" };

const label = (c: PhoneCapability): string => PHONE_CARD_COPY.capabilities[c];

/** The capabilities a registration reports, by name, in catalog order. */
export function reportedNames(report: PhoneReport): string[] {
  return PHONE_CAPABILITIES.filter((c) => report[c] !== undefined && report[c] !== false).map(label);
}

/**
 * One row per phone. A registration wins (the phone has told the computer what it can do). A paired phone without one is either
 * missing its passcode-backed key (F26) or ready but running an app that does not register yet (F20, D19).
 */
export function mergePhones(paired: PairedPhone[], registrations: PhoneRegistrationView[]): PhoneDeviceRow[] {
  const rows: PhoneDeviceRow[] = [];
  const seen = new Set<string>();
  for (const reg of registrations) {
    seen.add(reg.deviceId);
    rows.push({ id: reg.deviceId, name: reg.name, state: "registered", reports: reportedNames(reg.capabilities) });
  }
  for (const phone of paired) {
    if (seen.has(phone.id)) continue;
    rows.push({ id: phone.id, name: phone.name, state: phone.phoneJobsReady === true ? "update-app" : "passcode" });
  }
  return rows;
}

/** The grant after one row changes. "off" removes the key: an absent key is off. */
export function nextGrant(current: PhoneApps, capability: PhoneCapability, value: string): PhoneApps {
  const next: Record<string, string> = { ...(current as Record<string, string>) };
  if (value === "off") delete next[capability];
  else next[capability] = value;
  return next as PhoneApps;
}

/** The one request a toggle sends: exactly `{ phoneApps }` to the bot PATCH. */
export async function savePhoneApps(send: (path: string, init: RequestInit) => Promise<unknown>, botId: string, phoneApps: PhoneApps): Promise<void> {
  await send(`/api/bots/${encodeURIComponent(botId)}`, { method: "PATCH", body: JSON.stringify({ phoneApps }) });
}

export type PhoneCardMode = "hidden" | "cloud" | "engine" | "ready";
/** What the card shows. Cloud first (only while the Cloud host has the phoneTools flag on), then host offer, then the bot's engine. */
export function phoneCardMode(input: { cloud: boolean; desktop: boolean | undefined; offered: boolean | null; engineMounts: boolean; flag?: boolean | null }): PhoneCardMode {
  if (input.cloud) return input.flag === true ? "cloud" : "hidden";
  if (input.desktop !== true || input.offered !== true) return "hidden";
  return input.engineMounts ? "ready" : "engine";
}

const DEVICE_LINE = {
  passcode: PHONE_COPY.passcode,
  "update-app": PHONE_COPY.oldApp,
} as const;

export function PhoneAccessView({ mode, grant, rows, busy, error, onChange }: {
  mode: PhoneCardMode; grant: PhoneApps; rows: PhoneDeviceRow[]; busy: boolean; error: string | null;
  onChange: (capability: PhoneCapability, value: string) => void;
}) {
  if (mode === "hidden") return null;
  const valueLabel = (v: string): string => (PHONE_CARD_COPY.values as Record<string, string>)[v] ?? v;
  return <div className="rounded-xl bg-card p-4" data-testid="phone-access-card">
    <div className="text-[14px] font-medium text-ink">{PHONE_CARD_COPY.title}</div>
    {mode === "cloud" && <p className="mt-1 text-[12px] text-ink-secondary">{PHONE_COPY.cloud}</p>}
    {mode === "engine" && <p className="mt-1 text-[12px] text-ink-secondary">{PHONE_CARD_COPY.engineUnsupported}</p>}
    {mode === "ready" && <div className="mt-1 space-y-3 text-[12px] text-ink-secondary">
      <p>{PHONE_CARD_COPY.intro}</p>
      {error && <div role="alert" className="text-danger">{error}</div>}
      {PHONE_CAPABILITIES.map((c) => {
        const id = `phone-access-${c}`;
        const value = (grant as Record<string, string | undefined>)[c] ?? "off";
        return <div key={c} className="flex min-h-11 items-center justify-between gap-3">
          <span id={id}>{label(c)}</span>
          <select aria-labelledby={id} value={value} disabled={busy} onChange={(event) => onChange(c, event.target.value)} className="rounded-lg bg-inset px-2 py-2 text-ink">
            <option value="off">{PHONE_CARD_COPY.off}</option>
            {PHONE_APP_VALUES[c].map((v) => <option key={v} value={v}>{valueLabel(v)}</option>)}
          </select>
        </div>;
      })}
      {rows.length === 0 ? <p>{PHONE_CARD_COPY.noPhones}</p> : <ul className="space-y-2">
        {rows.map((row) => <li key={row.id} className="rounded-lg border border-hairline/40 p-3">
          <p className="font-medium text-ink">{row.name}</p>
          <p className="mt-1">{row.state === "registered" ? `${PHONE_CARD_COPY.reports}: ${row.reports.length ? row.reports.join(", ") : PHONE_CARD_COPY.reportsNothing}` : DEVICE_LINE[row.state]}</p>
        </li>)}
      </ul>}
      <p>{PHONE_CARD_COPY.activityNote}</p>
    </div>}
  </div>;
}

type CompanionLike = { state?: () => Promise<{ devices?: PairedPhone[] }> };
const pairedPhones = async (): Promise<PairedPhone[]> => {
  try {
    const bridge = (globalThis as { muragebox?: { companion?: CompanionLike } }).muragebox?.companion;
    const state = await bridge?.state?.();
    return (state?.devices ?? []).map((d) => ({ id: d.id, name: d.name, phoneJobsReady: d.phoneJobsReady }));
  } catch { return []; }
};

export function PhoneAccessCard({ bot }: { bot: Pick<Bot, "id" | "phoneApps" | "modelSelection"> }) {
  const desktop = useDesktopSurface();
  const { state } = useStore();
  const cloud = isCloudOrigin();
  const [offered, setOffered] = useState<boolean | null>(null);
  const [flag, setFlag] = useState<boolean | null>(null);
  const [rows, setRows] = useState<PhoneDeviceRow[]>([]);
  const [grant, setGrant] = useState<PhoneApps>(bot.phoneApps ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kind = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId)?.driverKind;
  const engineMounts = kind !== undefined && driverMountsPhoneJobs(kind);
  useEffect(() => { setGrant(bot.phoneApps ?? {}); }, [bot.id, JSON.stringify(bot.phoneApps ?? {})]);
  useEffect(() => {
    if (!cloud) return;
    let active = true;
    void (async () => {
      try {
        const answer = await api("/api/phones/offered");
        if (active) setFlag(answer?.flag === true);
      } catch { if (active) setFlag(false); }
    })();
    return () => { active = false; };
  }, [cloud]);
  useEffect(() => {
    if (cloud || desktop !== true) return;
    let active = true;
    void (async () => {
      try {
        const answer = await api("/api/phones/offered");
        if (!active) return;
        setOffered(answer?.offered === true);
        if (answer?.offered !== true) return;
        const [registered, paired] = await Promise.all([api("/api/phones"), pairedPhones()]);
        if (active) setRows(mergePhones(paired, Array.isArray(registered?.phones) ? registered.phones : []));
      } catch { if (active) setOffered(false); }
    })();
    return () => { active = false; };
  }, [cloud, desktop]);
  const change = (capability: PhoneCapability, value: string) => {
    if (busy) return;
    const previous = grant;
    const next = nextGrant(grant, capability, value);
    setGrant(next); setBusy(true); setError(null);
    void savePhoneApps((path, init) => api(path, init), bot.id, next)
      .catch(() => { setGrant(previous); setError(PHONE_CARD_COPY.saveFailed); })
      .finally(() => setBusy(false));
  };
  return <PhoneAccessView mode={phoneCardMode({ cloud, desktop, offered, engineMounts, flag })} grant={grant} rows={rows} busy={busy} error={error} onChange={change} />;
}
