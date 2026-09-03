import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  Loader2,
  Monitor,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Trash2,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import {
  WEB_UI_TITLE,
  companionAccountActionError,
  companionBridge,
  doorAddressLabel,
  loadCompanionBridgeState,
  shouldHydrateCompanionEmail,
  type CompanionRemoteAccess,
  type CompanionState,
  type PhoneSetupController,
  usePhoneSetupController,
} from "./PhoneSetupFlow";
import { companionPairingMode } from "../lib/phone-setup";
import { useDesktopSurface } from "../lib/use-surface";
import { Card, Switch } from "./SettingsPrimitives";

export {
  companionAccountActionError,
  companionPairingMode,
  loadCompanionBridgeState,
  shouldHydrateCompanionEmail,
};

export interface CompanionPanelStatus {
  label: string;
  good: boolean;
}

export function deriveCompanionPanelStatus(
  state: Pick<CompanionState, "enabled" | "devices" | "error">,
): CompanionPanelStatus | null {
  if (state.error) return { label: "Phone access needs attention", good: false };
  if (!state.enabled) return { label: "Phone access off", good: false };
  const pairedCount = state.devices.length;
  if (!pairedCount) return null;
  return {
    label: `${pairedCount} ${pairedCount === 1 ? "device" : "devices"} paired`,
    good: true,
  };
}

const relative = (at: number) => {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
};

const clockTime = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

// ── the three steps ────────────────────────────────────────────────────
// Setup is three decisions and they have an order: nothing listens until the
// door is open, there is no address until it is listening, and the secure
// address is a choice you make about an address that already exists. Naming
// them is what turns "why is the button disabled" into "you are on step one".

export type WebUiStepState = "done" | "current" | "waiting";

export interface WebUiStep {
  label: string;
  state: WebUiStepState;
  detail: string;
}

/** The strip, derived rather than tracked.
 *
 * There is no wizard cursor here on purpose. Every one of these can go
 * backwards without the app being told — the sidecar exits, Tailscale signs
 * out, somebody runs `tailscale serve off` in a terminal — and a remembered
 * step number would keep claiming progress that stopped being true. */
export function webUiSteps(source: {
  state: CompanionState | null;
  remoteAccess: CompanionRemoteAccess;
  doorAddress: string | null;
}): WebUiStep[] {
  const enabled = Boolean(source.state?.enabled) && !source.state?.error;
  const addressed = enabled && Boolean(source.doorAddress);
  const remote = source.remoteAccess.on;
  return [
    {
      label: "Open the browser door",
      state: enabled ? "done" : "current",
      detail: enabled ? "Running on this computer." : "Not running yet.",
    },
    {
      label: "Get the address",
      state: addressed ? "done" : enabled ? "current" : "waiting",
      detail: source.doorAddress ?? (enabled ? "Waiting for an address." : "Turn the door on first."),
    },
    {
      label: "Reach it from anywhere",
      state: remote ? "done" : addressed ? "current" : "waiting",
      detail: remote
        ? "Secure address, over your tailnet."
        : addressed
          ? "Optional — plain HTTP inside your tailnet works now."
          : "Needs an address first.",
    },
  ];
}

/** What the second toggle should say about itself right now.
 *
 * Three different sentences for three different truths, and the failure one
 * is the reason this is a function: "could not turn it on" is not a state
 * anybody can act on, and the reason always exists — Tailscale missing,
 * signed out, no certificates on the tailnet, or somebody else already on
 * 443. */
export function remoteAccessSummary(remote: CompanionRemoteAccess, doorAddress: string | null): string {
  if (remote.on) {
    return `On. Any device signed into your tailnet can open ${remote.url ?? doorAddress ?? "this computer"}.`;
  }
  if (remote.problem) return remote.problem;
  if (remote.available === false) {
    return "Tailscale is not installed on this computer, so there is no secure address to serve.";
  }
  return (
    "Off. Murage is reachable at a plain HTTP address inside your tailnet. Turning this on puts your "
    + "tailnet's own HTTPS certificate in front, so the link has no port to type and works on any browser."
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  return (
    <button
      onClick={() => {
        void navigator.clipboard
          .writeText(value)
          .then(() => {
            setCopied(true);
            if (timer.current !== null) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setCopied(false), 1_200);
          })
          .catch(() => {
            // Clipboard access is best effort — the value is on screen and
            // selectable either way.
          });
      }}
      aria-label={label}
      className="shrink-0 rounded p-1.5 text-ink-secondary hover:bg-control hover:text-ink"
    >
      {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
    </button>
  );
}

/** The consequence, asked as a question, before anything changes.
 *
 * The primary button repeats the action rather than saying OK: a dialog whose
 * confirm button is "OK" makes the reader reconstruct what they are agreeing
 * to from the title they have already scrolled past. */
function ConfirmRemoteAccess({
  onCancel,
  onConfirm,
  busy,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div role="dialog" aria-modal="true" aria-label="Serve Murage on your tailnet" className="w-full max-w-[440px] rounded-2xl bg-card p-5 shadow-xl">
        <h3 className="text-[16px] font-semibold text-ink">Serve Murage on your tailnet?</h3>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
          Tailscale will put your tailnet’s own HTTPS certificate in front of Murage on this computer,
          and Murage will listen only on loopback behind it. Every device signed into your tailnet — a
          phone, a laptop, a tablet — can then open it at a plain address with nothing to install.
        </p>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
          Nothing is published to the public internet: this uses <span className="text-ink">tailscale serve</span>,
          which is tailnet-only, never Funnel. Traffic stays encrypted end to end. It stays on until you
          turn it off, including after a restart.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-hairline/50 px-3.5 py-2 text-[13px] text-ink hover:bg-control disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            {busy ? "Turning on…" : "Serve on my tailnet"}
          </button>
        </div>
      </div>
    </div>
  );
}

function StepStrip({ steps }: { steps: WebUiStep[] }) {
  return (
    <ol className="flex flex-col gap-2 sm:flex-row sm:gap-3">
      {steps.map((step, index) => (
        <li
          key={step.label}
          className={`flex flex-1 items-start gap-2.5 rounded-xl px-3 py-2.5 ${
            step.state === "current" ? "bg-accent/10" : "bg-inset"
          }`}
        >
          <span
            className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium ${
              step.state === "done"
                ? "bg-success/20 text-success"
                : step.state === "current"
                  ? "bg-accent text-white"
                  : "bg-control text-ink-secondary"
            }`}
          >
            {step.state === "done" ? <Check size={12} /> : index + 1}
          </span>
          <span className="min-w-0">
            <span className="block text-[12.5px] font-medium text-ink">{step.label}</span>
            <span className="mt-0.5 block truncate text-[11.5px] text-ink-secondary" title={step.detail}>
              {step.detail}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function QrLogin({ c }: { c: PhoneSetupController }) {
  const link = c.browserLink;
  const pairing = c.state?.pairing ?? null;
  return (
    <div>
      <div className="text-[13px] text-ink">Scan to sign in</div>
      <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">
        Scan this with the camera on the device you want to use — a phone, a tablet, another laptop —
        and Murage opens signed in, in its browser. That device has to be signed into the same tailnet
        as this computer. Nothing to install.
      </p>
      {link && pairing ? (
        <div className="mt-3 flex flex-col items-start gap-3 sm:flex-row">
          <div className="rounded-2xl bg-white p-3" aria-label="Browser sign-in QR code">
            <QRCodeSVG value={link} size={148} level="M" bgColor="#ffffff" fgColor="#111111" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-medium uppercase tracking-wide text-ink-secondary">
              Or type this code
            </div>
            <div className="mt-1 font-mono text-[22px] tracking-[0.25em] text-ink">{pairing.code}</div>
            <div className="mt-3 flex items-center gap-1.5">
              <span className="text-[11.5px] text-ink-secondary">
                Expires at {clockTime(pairing.expiresAt)}
                {c.secondsLeft > 0 ? ` · ${c.secondsLeft}s` : ""}
              </span>
              <CopyButton value={link} label="Copy sign-in link" />
              <button
                onClick={c.refreshCode}
                disabled={c.busy}
                aria-label="Create a new code"
                className="shrink-0 rounded p-1.5 text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"
              >
                <RefreshCw size={13} />
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button
          // Straight to a pairing window, never through the email sign-in.
          // That flow provisions a hosted internet route, which is a
          // different product decision from "let my own devices reach this
          // machine on my own tailnet" — and this page is entirely the
          // second one. Tailscale when there is a tailnet, the local network
          // when there is not; both open a code without asking for an email.
          onClick={c.tailscaleAvailable ? c.useTailscale : c.useLocal}
          disabled={!c.state?.enabled || c.busy || c.accountBusy}
          className="mt-3 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40"
        >
          {c.state?.devices.length ? "Add another device" : "Show me the code"}
        </button>
      )}
    </div>
  );
}

export function CompanionSection({ profileEmail = "" }: { profileEmail?: string }) {
  const desktop = useDesktopSurface();
  const c = usePhoneSetupController(profileEmail);
  const state = c.state;
  const [confirming, setConfirming] = useState(false);

  // Settings → this pane, seen FROM a paired device, was a list of things to
  // do to a computer it cannot see: every switch writes over the Electron
  // bridge, which does not exist on this side of the door. The pane goes
  // rather than becoming a disabled copy of itself.
  if (desktop === false) {
    return (
      <Card
        // The exact sentence `RemoteSurface.test.ts` pins across every gated
        // component. It reads as being about phones and is not: this pane is
        // about any device, and the subtitle says so.
        title="Phone setup happens on the computer"
        subtitle="You are already using Murage in a browser. To pair another device — a phone, a tablet, another laptop — or to change how devices reach Murage, open Settings on the computer running it."
      />
    );
  }

  if (desktop !== true) return null;

  if (!companionBridge()) {
    return <Card title={WEB_UI_TITLE} subtitle="Open Settings in the Murage desktop app to set this up." />;
  }

  if (!state) {
    return (
      <Card title="WebUI" subtitle="Checking this computer…">
        <Loader2 size={15} className="animate-spin text-ink-secondary" />
      </Card>
    );
  }

  const remote = c.remoteAccess;
  const doorAddress = doorAddressLabel(c.browserDoor);
  const doorUrl = c.browserDoor
    ? `${c.browserDoor.scheme}://${doorAddress}`
    : null;
  const steps = webUiSteps({ state, remoteAccess: remote, doorAddress });
  const pairedCount = state.devices.length;
  const accountActionError = companionAccountActionError(c.account, c.accountError);
  const connected = new Set(state.connectedDeviceIds ?? []);
  const activity = [...state.devices]
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
    .slice(0, 5);

  return (
    <div className="flex flex-col gap-4">
      {confirming && (
        <ConfirmRemoteAccess
          busy={c.busy}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            c.setRemoteAccess(true);
          }}
        />
      )}

      <div>
        <h2 className="text-[19px] font-semibold text-ink">WebUI</h2>
        <p className="mt-1 max-w-[560px] text-[13px] leading-relaxed text-ink-secondary">
          Use Murage from any device you own — hand it work from a phone on the sofa, a laptop in
          another city, or a browser tab next to this one. Over your own tailnet, never the internet.
        </p>
      </div>

      <StepStrip steps={steps} />

      <Card subtitle="Turn the browser door on so a phone, a tablet or another computer can open Murage.">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[13px] text-ink">Enable WebUI</div>
            <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">
              Runs the part of Murage that answers other devices. Off, nothing listens.
            </div>
          </div>
          <Switch
            checked={state.enabled}
            aria-label="Enable WebUI"
            disabled={c.busy}
            onClick={() => void c.act((companion) => (state.enabled ? companion.stop() : companion.start()))}
          />
        </div>

        <div className="mt-4 flex items-center justify-between gap-4 border-t border-hairline/30 pt-4">
          <div className="min-w-0">
            <div className="text-[13px] text-ink">Allow remote access</div>
            <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">
              {remoteAccessSummary(remote, doorAddress)}
            </div>
            <a
              href="https://tailscale.com/kb/1312/serve"
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block text-[11.5px] text-accent hover:opacity-80"
            >
              View guide
            </a>
          </div>
          <Switch
            checked={remote.on}
            aria-label="Allow remote access"
            disabled={c.busy || !state.enabled}
            onClick={() => {
              if (remote.on) c.setRemoteAccess(false);
              else setConfirming(true);
            }}
          />
        </div>

        {state.enabled && (
          <div className="mt-4 border-t border-hairline/30 pt-4">
            <div className="text-[11px] font-medium uppercase tracking-wide text-ink-secondary">
              Access URL
            </div>
            {doorUrl ? (
              <div className="mt-1.5 flex items-center gap-2">
                <a
                  href={doorUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-warning hover:underline"
                >
                  {doorUrl}
                </a>
                <CopyButton value={doorUrl} label="Copy access URL" />
              </div>
            ) : (
              <div className="mt-1.5 text-[12px] text-ink-secondary">
                No address yet — the door is starting, or Tailscale is not up on this computer.
              </div>
            )}
          </div>
        )}

        {remote.on && (
          <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5">
            <ShieldCheck size={15} className="mt-0.5 shrink-0 text-warning" />
            <div className="text-[11.5px] leading-relaxed text-ink-secondary">
              Remote access is on. Any device signed into your tailnet can open{" "}
              <span className="font-mono text-ink">{remote.url ?? doorUrl}</span> and, with a code from
              below, sign in. Nothing is exposed to the public internet, and it stays on until you turn
              it off — including after a restart.
            </div>
          </div>
        )}

        {!remote.on && remote.problem && (
          <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-hairline/40 px-3 py-2.5">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-ink-secondary" />
            <div className="text-[11.5px] leading-relaxed text-ink-secondary">{remote.problem}</div>
          </div>
        )}

        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={c.refreshTailscale}
            disabled={c.busy}
            className="flex items-center gap-1.5 text-[12px] text-accent hover:opacity-80 disabled:opacity-40"
          >
            <RefreshCw size={12} /> Check Tailscale again
          </button>
        </div>

        {(c.error || state.error) && (
          <div className="mt-3 text-[12px] text-danger">{c.error ?? state.error}</div>
        )}
      </Card>

      <Card title="Sign in on another device">
        <QrLogin c={c} />
        {accountActionError && <div className="mt-3 text-[12px] text-danger">{accountActionError}</div>}
      </Card>

      <Card
        title="Paired devices"
        subtitle={
          pairedCount
            ? "Every device that can use this Murage. Revoking one ends its sessions immediately."
            : "No devices paired yet."
        }
      >
        {pairedCount > 0 && (
          <ul className="flex flex-col gap-2">
            {state.devices.map((device) => (
              <li key={device.id} className="rounded-xl bg-inset px-3 py-3">
                <div className="flex items-center gap-3">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-control text-ink-secondary">
                    {connected.has(device.id) ? <Monitor size={15} /> : <Smartphone size={15} />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium text-ink">{device.name}</div>
                    <div className="text-[11.5px] text-ink-secondary">
                      Added {relative(device.createdAt)} · last seen {relative(device.lastSeenAt)}
                      {connected.has(device.id) ? " · connected now" : ""}
                    </div>
                  </div>
                  <button
                    disabled={c.busy}
                    onClick={() => void c.act((companion) => companion.revoke(device.id))}
                    aria-label={`Revoke ${device.name}`}
                    className="shrink-0 rounded px-2 py-1.5 text-[11.5px] text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-40"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="mt-3 flex items-center justify-between gap-3 border-t border-hairline/30 pt-3">
                  <div>
                    <div className="text-[12px] text-ink">Allow computer view</div>
                    <div className="mt-0.5 text-[11px] text-ink-secondary">
                      Full interactive access from this device.
                    </div>
                  </div>
                  <Switch
                    checked={device.cloudDesktopAccess}
                    aria-label={`Computer view access for ${device.name}`}
                    disabled={c.busy}
                    onClick={() =>
                      void c.act((companion) => companion.cloudDesktop(device.id, !device.cloudDesktopAccess))
                    }
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Recent activity">
        <div className="-mt-2 mb-3 flex items-center justify-between gap-3">
          <span className="text-[11.5px] text-ink-secondary">
            {activity.length ? "When each device last reached this computer." : "No activity recorded yet."}
          </span>
          <button
            onClick={() => void c.act((companion) => companion.state())}
            disabled={c.busy}
            className="flex shrink-0 items-center gap-1.5 text-[12px] text-accent hover:opacity-80 disabled:opacity-40"
          >
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
        {activity.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {activity.map((device) => (
              <li key={device.id} className="flex items-baseline justify-between gap-3">
                <span className="truncate text-[12.5px] text-ink">{device.name}</span>
                <span className="shrink-0 text-[11.5px] text-ink-secondary">
                  {connected.has(device.id) ? "connected now" : relative(device.lastSeenAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
