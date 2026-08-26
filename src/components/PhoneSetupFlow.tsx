import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  Check,
  Loader2,
  Mail,
  QrCode,
  ShieldCheck,
  Smartphone,
  Wifi,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { companionPairingLink, type CompanionEndpoint } from "../lib/companion-pairing";
import {
  companionPairingMode,
  derivePhoneSetupPhase,
  initialPhoneSetupFlowState,
  newlyPairedDevice,
  phonePairingGate,
  phoneSetupReducer,
  type PhoneSetupPhase,
} from "../lib/phone-setup";
import type { CompanionAccountState } from "../types/ogb";

export interface PhoneDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  cloudDesktopAccess: boolean;
}

export interface CompanionState {
  enabled: boolean;
  keepAwake: boolean;
  port: number;
  devices: PhoneDevice[];
  pairing: { code: string; token: string; expiresAt: number } | null;
  addresses?: string[];
  tailscale?: string;
  tailnetName?: string;
  lan?: string | null;
  hosts?: string[];
  endpoints?: CompanionEndpoint[];
  discovery?: { advertising: boolean; name: string };
  error?: string;
}

export type CompanionBridge = {
  state: () => Promise<CompanionState>;
  start: () => Promise<CompanionState>;
  stop: () => Promise<CompanionState>;
  keepAwake: (enabled: boolean) => Promise<CompanionState>;
  pairing: (open: boolean) => Promise<CompanionState>;
  cloudDesktop: (deviceId: string, allowed: boolean) => Promise<CompanionState>;
  revoke: (deviceId: string) => Promise<CompanionState>;
};

type AccountBridge = NonNullable<NonNullable<Window["ogb"]>["companionAccount"]>;
type StateBridge<T> = { state: () => Promise<T> };

export const companionBridge = (): CompanionBridge | null =>
  // SAFETY: the preload owns this narrow bridge; browser builds are guarded by the optional lookup.
  (globalThis as { ogb?: { companion?: CompanionBridge } }).ogb?.companion ?? null;

export const companionAccountBridge = (): AccountBridge | null =>
  // SAFETY: Electron exposes only these account operations and never sends credentials to the renderer.
  (globalThis as { ogb?: { companionAccount?: AccountBridge } }).ogb?.companionAccount ?? null;

export const loadCompanionBridgeState = async (
  companion: StateBridge<CompanionState> | null,
  remote: StateBridge<CompanionAccountState> | null,
): Promise<{ companion: CompanionState | null; account: CompanionAccountState | null }> => {
  const [companionResult, accountResult] = await Promise.allSettled([
    companion ? Promise.resolve().then(() => companion.state()) : Promise.resolve(null),
    remote ? Promise.resolve().then(() => remote.state()) : Promise.resolve(null),
  ]);
  return {
    companion: companionResult.status === "fulfilled" ? companionResult.value : null,
    account: accountResult.status === "fulfilled" ? accountResult.value : null,
  };
};

export const shouldHydrateCompanionEmail = (
  userEdited: boolean,
  account: CompanionAccountState,
): boolean => !userEdited && Boolean(account.email);

export const companionAccountActionError = (
  account: CompanionAccountState | null,
  actionError: string | null,
): string | null => {
  if (actionError) return actionError;
  return account?.status === "signed-out" ? account.message ?? null : null;
};

export interface PhoneSetupController {
  state: CompanionState | null;
  account: CompanionAccountState | null;
  phase: PhoneSetupPhase;
  email: string;
  code: string;
  codeSent: boolean;
  busy: boolean;
  accountBusy: boolean;
  error: string | null;
  accountError: string | null;
  pairingLink: string | null;
  secondsLeft: number;
  address: string | undefined;
  hostedReady: boolean;
  localFallback: boolean;
  pairingExpired: boolean;
  setEmail: (email: string) => void;
  setCode: (code: string) => void;
  changeEmail: () => void;
  start: () => void;
  useLocal: () => void;
  requestCode: () => void;
  verifyCode: () => void;
  retryAccount: () => void;
  cancel: () => void;
  refreshCode: () => void;
  finish: () => void;
  skip: () => void;
  act: (call: (companion: CompanionBridge) => Promise<CompanionState>) => Promise<void>;
  accountAct: (call: (remote: AccountBridge) => Promise<CompanionAccountState>) => Promise<void>;
}

export function usePhoneSetupController(profileEmail = ""): PhoneSetupController {
  const [state, setState] = useState<CompanionState | null>(null);
  const [account, setAccount] = useState<CompanionAccountState | null>(null);
  const [email, setEmailState] = useState(profileEmail);
  const [code, setCodeState] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [flow, dispatchFlow] = useReducer(phoneSetupReducer, initialPhoneSetupFlowState);
  const emailEdited = useRef(false);
  const openingPairing = useRef(false);

  const load = useCallback(async () => {
    const next = await loadCompanionBridgeState(companionBridge(), companionAccountBridge());
    if (next.companion) setState(next.companion);
    if (next.account) {
      setAccount(next.account);
      if (shouldHydrateCompanionEmail(emailEdited.current, next.account)) {
        setEmailState(next.account.email ?? "");
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!emailEdited.current && profileEmail) setEmailState(profileEmail);
  }, [profileEmail]);

  const act = useCallback(async (call: (companion: CompanionBridge) => Promise<CompanionState>) => {
    const companion = companionBridge();
    if (!companion) return;
    setBusy(true);
    setError(null);
    try {
      setState(await call(companion));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  const accountAct = useCallback(
    async (call: (remote: AccountBridge) => Promise<CompanionAccountState>) => {
      const remote = companionAccountBridge();
      if (!remote) return;
      setAccountBusy(true);
      setAccountError(null);
      try {
        const next = await call(remote);
        setAccount(next);
        await load();
      } catch (cause) {
        setAccountError(
          cause instanceof Error ? cause.message : "Secure phone access could not be updated",
        );
      } finally {
        setAccountBusy(false);
      }
    },
    [load],
  );

  const openPairing = useCallback(
    async (localFallback: boolean, accountOverride?: CompanionAccountState | null) => {
      const companion = companionBridge();
      if (!companion || openingPairing.current) {
        if (!companion) setError("Phone setup is only available in the desktop app.");
        return;
      }
      openingPairing.current = true;
      setBusy(true);
      setError(null);
      try {
        const started = state?.enabled ? state : await companion.start();
        setState(started);
        if (!started.enabled || started.error) return;
        const gate = phonePairingGate(accountOverride ?? account, started, localFallback);
        if (gate !== "open") {
          setProvisioning(gate === "wait" || gate === "start");
          return;
        }
        const paired = await companion.pairing(true);
        setState(paired);
        setProvisioning(false);
        dispatchFlow({ type: "pairing-opened" });
      } catch (cause) {
        setProvisioning(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
        openingPairing.current = false;
      }
    },
    [account, state],
  );

  const start = useCallback(() => {
    dispatchFlow({ type: "start", deviceIds: state?.devices.map((device) => device.id) ?? [] });
    setError(null);
    setAccountError(null);
    if (account?.available && (account.status === "ready" || account.status === "connecting")) {
      setProvisioning(true);
      void openPairing(false, account);
    }
  }, [account, openPairing, state?.devices]);

  const useLocal = useCallback(() => {
    if (!flow.active) {
      dispatchFlow({ type: "start", deviceIds: state?.devices.map((device) => device.id) ?? [] });
    }
    dispatchFlow({ type: "use-local" });
    setProvisioning(true);
    void openPairing(true);
  }, [flow.active, openPairing, state?.devices]);

  const requestCode = useCallback(() => {
    const remote = companionAccountBridge();
    const normalized = email.trim().toLowerCase();
    if (!remote || !normalized) return;
    setAccountBusy(true);
    setAccountError(null);
    void remote
      .requestCode(normalized)
      .then((next) => {
        setAccount(next);
        setCodeSent(true);
      })
      .catch((cause: unknown) => {
        setAccountError(cause instanceof Error ? cause.message : "We could not send the code.");
      })
      .finally(() => setAccountBusy(false));
  }, [email]);

  const verifyCode = useCallback(() => {
    const remote = companionAccountBridge();
    const normalized = email.trim().toLowerCase();
    if (!remote || code.length !== 8) return;
    setAccountBusy(true);
    setProvisioning(true);
    setAccountError(null);
    void remote
      .verifyCode(normalized, code)
      .then(async (next) => {
        setAccount(next);
        setCodeState("");
        setCodeSent(false);
        await openPairing(false, next);
      })
      .catch((cause: unknown) => {
        setProvisioning(false);
        setAccountError(cause instanceof Error ? cause.message : "That code could not be verified.");
      })
      .finally(() => setAccountBusy(false));
  }, [code, email, openPairing]);

  const retryAccount = useCallback(() => {
    const remote = companionAccountBridge();
    if (!remote) return;
    setAccountBusy(true);
    setProvisioning(true);
    setAccountError(null);
    void remote
      .retry()
      .then(async (next) => {
        setAccount(next);
        await openPairing(false, next);
      })
      .catch((cause: unknown) => {
        setProvisioning(false);
        setAccountError(cause instanceof Error ? cause.message : "Secure access could not be restored.");
      })
      .finally(() => setAccountBusy(false));
  }, [openPairing]);

  const phase = derivePhoneSetupPhase(flow, {
    accountStatus: account?.available ? account.status : "unavailable",
    accountBusy,
    provisioning,
    pairingOpen: Boolean(state?.pairing),
  });

  useEffect(() => {
    if (!flow.active || flow.pairedDeviceName || !state) return;
    const device = newlyPairedDevice(flow.baselineDeviceIds, state.devices);
    if (device) dispatchFlow({ type: "paired", deviceName: device.name });
  }, [flow.active, flow.baselineDeviceIds, flow.pairedDeviceName, state]);

  useEffect(() => {
    if (
      !flow.active ||
      flow.localFallback ||
      flow.pairingAttempted ||
      !state ||
      phonePairingGate(account, state, false) !== "open"
    ) {
      return;
    }
    void openPairing(false);
  }, [account, flow.active, flow.localFallback, flow.pairingAttempted, openPairing, state]);

  const shouldPoll = flow.active || Boolean(state?.pairing);
  useEffect(() => {
    const timer = window.setInterval(
      () => {
        setNow(Date.now());
        void load();
      },
      shouldPoll ? 1_000 : 10_000,
    );
    return () => window.clearInterval(timer);
  }, [load, shouldPoll]);

  const address =
    state?.tailnetName ??
    state?.lan ??
    state?.addresses?.find((candidate) => candidate !== state.tailscale) ??
    state?.hosts?.[0];
  const pairingLink = useMemo(() => {
    if (!state?.pairing || !address) return null;
    return companionPairingLink({
      address,
      port: state.port,
      code: state.pairing.code,
      token: state.pairing.token,
      name: state.discovery?.name,
      hosts: state.hosts,
      endpoints: state.endpoints,
    });
  }, [address, state]);

  const cancel = useCallback(() => {
    const companion = companionBridge();
    if (companion && state?.pairing) void act((current) => current.pairing(false));
    setProvisioning(false);
    setCodeSent(false);
    setCodeState("");
    dispatchFlow({ type: "reset" });
  }, [act, state?.pairing]);

  return {
    state,
    account,
    phase,
    email,
    code,
    codeSent,
    busy,
    accountBusy,
    error,
    accountError,
    pairingLink,
    secondsLeft: state?.pairing
      ? Math.max(0, Math.round((state.pairing.expiresAt - now) / 1000))
      : 0,
    address,
    hostedReady: Boolean(state?.endpoints?.some((endpoint) => endpoint.kind === "hosted")),
    localFallback: flow.localFallback,
    pairingExpired: flow.pairingAttempted && !state?.pairing,
    setEmail: (next) => {
      emailEdited.current = true;
      setEmailState(next);
    },
    setCode: (next) => setCodeState(next.replaceAll(/\D/g, "").slice(0, 8)),
    changeEmail: () => {
      setCodeState("");
      setCodeSent(false);
      setAccountError(null);
    },
    start,
    useLocal,
    requestCode,
    verifyCode,
    retryAccount,
    cancel,
    refreshCode: () => void openPairing(flow.localFallback),
    finish: () => dispatchFlow({ type: "reset" }),
    skip: () => dispatchFlow({ type: "skip" }),
    act,
    accountAct,
  };
}

function ValuePoints() {
  const points: Array<{ Icon: typeof Smartphone; title: string; detail: string }> = [
    { Icon: Smartphone, title: "Your chats", detail: "Read and reply from your phone." },
    { Icon: Check, title: "Quick approvals", detail: "Keep work moving when you step away." },
    { Icon: ShieldCheck, title: "Private by default", detail: "Only phones you approve can connect." },
  ];
  return (
    <div className="mt-5 grid w-full gap-2 sm:grid-cols-3">
      {points.map(({ Icon, title, detail }) => (
        <div key={title} className="rounded-xl bg-inset px-3 py-3 text-left">
          <Icon size={16} className="text-accent" />
          <div className="mt-2 text-[13px] font-medium text-ink">{title}</div>
          <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">{detail}</div>
        </div>
      ))}
    </div>
  );
}

export function PhoneSetupFlowView({
  controller,
  variant,
  onSkip,
  onComplete,
}: {
  controller: PhoneSetupController;
  variant: "settings" | "onboarding";
  onSkip?: () => void;
  onComplete?: () => void;
}) {
  const c = controller;
  const actionError = companionAccountActionError(c.account, c.accountError);
  const canSubmitEmail = /^\S+@\S+\.\S+$/.test(c.email.trim());

  if (c.phase === "intro") {
    return (
      <div className="flex flex-col items-center text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-accent/12 text-accent">
          <Smartphone size={26} />
        </div>
        <h2 className="mt-4 text-[19px] font-semibold text-ink">Use OpenMausBot from your phone</h2>
        <p className="mt-1.5 max-w-[460px] text-[13.5px] leading-relaxed text-ink-secondary">
          Check chats, answer approvals, and send new work without staying at your computer.
        </p>
        <ValuePoints />
        <button
          onClick={c.start}
          className="mt-5 w-full max-w-[320px] rounded-lg bg-accent py-2.5 text-[14px] font-medium text-white hover:opacity-90"
        >
          {variant === "settings"
            ? c.state?.devices.length
              ? "Pair another phone"
              : "Pair a phone"
            : "Set up my phone"}
        </button>
        {variant === "onboarding" && (
          <>
            <button
              onClick={() => {
                c.skip();
                onSkip?.();
              }}
              className="mt-2.5 text-[12.5px] text-ink-secondary hover:text-ink"
            >
              Not now
            </button>
            <p className="mt-2 text-[11.5px] text-ink-secondary">
              You can resume anytime from Settings → Phone.
            </p>
          </>
        )}
      </div>
    );
  }

  if (c.phase === "sign-in") {
    const unavailable = !c.account?.available;
    const failed = c.account?.status === "error";
    return (
      <div className="mx-auto flex w-full max-w-[430px] flex-col">
        <button onClick={c.cancel} className="mb-4 flex w-fit items-center gap-1.5 text-[12px] text-ink-secondary hover:text-ink">
          <ArrowLeft size={13} /> Back
        </button>
        <div className="flex size-11 items-center justify-center rounded-xl bg-accent/12 text-accent">
          <Mail size={20} />
        </div>
        <h2 className="mt-3 text-[18px] font-semibold text-ink">
          {unavailable || failed ? "Secure access needs attention" : "Sign in to pair securely"}
        </h2>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
          {unavailable
            ? "Online phone access is not available right now. You can still pair directly on the same Wi-Fi."
            : failed
              ? c.account?.message ?? "We could not finish creating your private connection."
              : "We’ll email you a one-time code. No password needed."}
        </p>

        {!unavailable && !failed && (
          <div className="mt-5 flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-ink-secondary">Email</span>
              <input
                autoFocus
                autoComplete="email"
                inputMode="email"
                value={c.email}
                disabled={c.accountBusy || c.codeSent}
                onChange={(event) => c.setEmail(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !c.codeSent && canSubmitEmail) c.requestCode();
                }}
                placeholder="you@example.com"
                className="rounded-lg border border-hairline/50 bg-inset px-3 py-2.5 text-[14px] text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent disabled:opacity-50"
              />
            </label>
            {c.codeSent && (
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] font-medium text-ink-secondary">8-digit code</span>
                <input
                  autoFocus
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  value={c.code}
                  disabled={c.accountBusy}
                  onChange={(event) => c.setCode(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && c.code.length === 8) c.verifyCode();
                  }}
                  placeholder="12345678"
                  className="rounded-lg border border-hairline/50 bg-inset px-3 py-2.5 font-mono text-[16px] tracking-[0.18em] text-ink outline-none placeholder:tracking-normal placeholder:text-ink-secondary/60 focus:border-accent disabled:opacity-50"
                />
              </label>
            )}
            <button
              disabled={c.accountBusy || (!c.codeSent && !canSubmitEmail) || (c.codeSent && c.code.length !== 8)}
              onClick={c.codeSent ? c.verifyCode : c.requestCode}
              className="rounded-lg bg-accent py-2.5 text-[14px] font-medium text-white hover:opacity-90 disabled:opacity-40"
            >
              {c.accountBusy ? "Working…" : c.codeSent ? "Verify and continue" : "Email me a code"}
            </button>
            {c.codeSent && (
              <button
                disabled={c.accountBusy}
                onClick={c.changeEmail}
                className="text-[12px] text-ink-secondary hover:text-ink disabled:opacity-40"
              >
                Use another email
              </button>
            )}
            {c.codeSent && !actionError && (
              <p className="text-[11.5px] text-ink-secondary">The code expires in 10 minutes.</p>
            )}
          </div>
        )}

        {failed && (
          <button
            disabled={c.accountBusy}
            onClick={c.retryAccount}
            className="mt-5 rounded-lg bg-accent py-2.5 text-[14px] font-medium text-white disabled:opacity-40"
          >
            {c.accountBusy ? "Trying again…" : "Try secure access again"}
          </button>
        )}
        {actionError && <p role="alert" className="mt-3 text-[12.5px] text-danger">{actionError}</p>}
        <div className="my-4 flex items-center gap-3 text-[11px] text-ink-secondary">
          <span className="h-px flex-1 bg-hairline/40" /> or <span className="h-px flex-1 bg-hairline/40" />
        </div>
        <button
          disabled={c.busy}
          onClick={c.useLocal}
          className="flex items-center justify-center gap-2 rounded-lg border border-hairline/50 py-2.5 text-[13px] text-ink hover:bg-control disabled:opacity-40"
        >
          <Wifi size={15} /> Pair on this Wi-Fi instead
        </button>
        <p className="mt-2 text-center text-[11px] leading-relaxed text-ink-secondary">
          Both devices must be on a network that lets them see each other.
        </p>
      </div>
    );
  }

  if (c.phase === "verifying") {
    return (
      <div className="flex flex-col items-center py-8 text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-accent/12 text-accent">
          <Loader2 size={25} className="animate-spin" />
        </div>
        <h2 className="mt-4 text-[18px] font-semibold text-ink">
          {c.localFallback ? "Preparing your pairing code" : "Creating secure phone access"}
        </h2>
        <p className="mt-1.5 max-w-[360px] text-[13px] leading-relaxed text-ink-secondary">
          {c.localFallback
            ? "This should only take a moment."
            : "We’re giving this computer a private connection that works even when your phone is away from this Wi-Fi."}
        </p>
        {(c.error || c.accountError) && (
          <p role="alert" className="mt-3 max-w-[380px] text-[12.5px] text-danger">{c.error ?? c.accountError}</p>
        )}
        <button onClick={c.cancel} className="mt-5 text-[12px] text-ink-secondary hover:text-ink">Cancel</button>
      </div>
    );
  }

  if (c.phase === "success") {
    return (
      <div className="flex flex-col items-center py-6 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-success/15 text-success">
          <Check size={28} />
        </div>
        <h2 className="mt-4 text-[19px] font-semibold text-ink">Your phone is ready</h2>
        <p className="mt-1.5 text-[13px] text-ink-secondary">
          It can now open chats, answer approvals, and send new work.
        </p>
        <button
          onClick={() => {
            c.finish();
            onComplete?.();
          }}
          className="mt-5 w-full max-w-[280px] rounded-lg bg-accent py-2.5 text-[14px] font-medium text-white"
        >
          {variant === "onboarding" ? "Start using OpenMausBot" : "Done"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center text-center">
      <div className="flex size-12 items-center justify-center rounded-xl bg-white text-black">
        <QrCode size={23} />
      </div>
      <h2 className="mt-3 text-[18px] font-semibold text-ink">
        {c.pairingExpired ? "That code expired" : "Scan with your iPhone"}
      </h2>
      <p className="mt-1 text-[13px] text-ink-secondary">
        {c.pairingExpired ? "Create a fresh code when your phone is ready." : "Open Camera, scan the code, then tap Connect."}
      </p>
      {!c.pairingExpired && c.pairingLink && (
        <div className="mt-4 rounded-2xl bg-white p-3.5" aria-label="Phone pairing QR code">
          <QRCodeSVG value={c.pairingLink} size={180} level="M" bgColor="#ffffff" fgColor="#111111" />
        </div>
      )}
      {!c.pairingExpired && !c.pairingLink && (
        <div className="mt-4 rounded-xl bg-inset px-4 py-3 text-[12.5px] text-ink-secondary">
          Open OpenMausMobile and enter the code below.
        </div>
      )}
      {!c.pairingExpired && c.state?.pairing && (
        <p className="mt-3 text-[11.5px] text-ink-secondary">Code expires in {c.secondsLeft}s</p>
      )}
      {c.pairingExpired && (
        <button onClick={c.refreshCode} className="mt-5 rounded-lg bg-accent px-5 py-2.5 text-[14px] font-medium text-white">
          Create a new code
        </button>
      )}
      {!c.pairingExpired && c.state?.pairing && (
        <details className="mt-4 w-full max-w-[390px] rounded-lg border border-hairline/40 px-3 py-2 text-left">
          <summary className="cursor-pointer text-[12px] text-ink-secondary">Having trouble?</summary>
          <div className="mt-3 text-[12px] text-ink-secondary">
            Manual code
            <div className="mt-1 font-mono text-[22px] tracking-[0.25em] text-ink">{c.state.pairing.code}</div>
            {c.address && <div className="mt-2 break-all">Address: {c.address}:{c.state.port}</div>}
          </div>
        </details>
      )}
      <button onClick={c.cancel} className="mt-4 text-[12px] text-ink-secondary hover:text-ink">Cancel</button>
    </div>
  );
}

export function PhoneSetupFlow({
  profileEmail,
  variant,
  onSkip,
  onComplete,
}: {
  profileEmail?: string;
  variant: "settings" | "onboarding";
  onSkip?: () => void;
  onComplete?: () => void;
}) {
  const controller = usePhoneSetupController(profileEmail);
  return (
    <PhoneSetupFlowView
      controller={controller}
      variant={variant}
      onSkip={onSkip}
      onComplete={onComplete}
    />
  );
}

export { companionPairingMode };
