import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  Check,
  Globe,
  Loader2,
  Mail,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Wifi,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import {
  companionPairingLink,
  companionPairingRoute,
  companionPairingRoutePin,
  companionPairingRoutePinAvailable,
  type CompanionEndpoint,
  type CompanionPairingRoutePin,
  type CompanionPairingRouteMode,
} from "../lib/companion-pairing";
import {
  PHONE_SETUP_PROVISIONING_TIMEOUT_MS,
  claimPhonePairingAttempt,
  closePhonePairingIfOwned,
  completePhonePairingAttempt,
  companionPairingMode,
  companionPairingOpenFailure,
  companionStartFailure,
  derivePhoneSetupPhase,
  initialPhoneSetupFlowState,
  keepPhonePairingIfCurrent,
  invalidatePhonePairingAttempt,
  newlyPairedDeviceForFlow,
  normalizePhoneSetupActionError,
  phonePairingGate,
  phoneSetupBaseline,
  phoneSetupReducer,
  queuePhonePairingAttempt,
  releasePhonePairingAttempt,
  shouldArmPhoneSetupProvisioningTimeout,
  startNonOverlappingPhoneSetupPoll,
  type PhoneSetupPhase,
  type PhonePairingAttemptLock,
  type PhonePairingAttemptQueue,
} from "../lib/phone-setup";
import { useDesktopSurface } from "../lib/use-surface";
import type { CompanionAccountState } from "../types/muragebox";
import { ConnectionDetail } from "./ConnectionDetail";

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
  connectedDeviceIds?: string[];
  pairing: { code: string; token: string; expiresAt: number } | null;
  addresses?: string[];
  tailscale?: string;
  tailnetName?: string;
  lan?: string | null;
  hosts?: string[];
  endpoints?: CompanionEndpoint[];
  discovery?: { advertising: boolean; name: string };
  /** Where the browser door is answering, or null when it is not listening.
   *
   * Reported by the sidecar (`companion/src/control.ts`) rather than derived
   * here, and that is not fussiness. The door's port is an env override, its
   * scheme decides a cookie attribute rather than describing one, and its
   * dialable host is not its bind host — under `tailscale serve` it binds
   * loopback and answers on the MagicDNS name. Three decisions taken in
   * another process; a renderer that reassembled them would be wrong the
   * first time any one of them changed.
   *
   * Optional because an older sidecar predates the field. Null because a
   * newer one distinguishes "not listening" from "did not say". */
  browser?: CompanionBrowserDoor | null;
  /** Whether `tailscale serve` is in front of the browser door, and what it
   * cost if it is not.
   *
   * `on` is the only field that says the secure address is live — it is true
   * only when serve is running AND the sidecar was told about it, because a
   * proxy the door does not know about produces the exact bug this feature
   * was built to fix: a link advertising the door's own socket behind a
   * certificate that does not cover it. `desired` is what the user asked for,
   * and it differs from `on` while a toggle is failing. */
  remoteAccess?: CompanionRemoteAccess;
  error?: string;
}

/** The state of the secure address in front of the door. */
export interface CompanionRemoteAccess {
  on: boolean;
  desired: boolean;
  /** `https://<name>` when serve is fronting the door, else null. */
  url: string | null;
  /** Whether the Tailscale CLI could be found at all. Null until asked. */
  available: boolean | null;
  reason: "missing" | "logged-out" | "no-certificates" | "conflict" | "unsupported" | "failed" | null;
  /** The honest sentence, when there is one. */
  problem: string | null;
}

/** Where a phone points its browser to reach this computer. */
export interface CompanionBrowserDoor {
  scheme: "http" | "https";
  host: string;
  port: number;
}

/** The default port for a scheme, which a URL does not spell out. */
const DEFAULT_PORT: Record<CompanionBrowserDoor["scheme"], number> = { http: 80, https: 443 };

/**
 * The link a phone actually follows: `<scheme>://<host>:<port>/enter#<token>`.
 *
 * This is the other half of `companionPairingLink`, and it exists because
 * that one hands out a `murage://` URL for an app this repository no longer
 * contains. Scanning it on a phone opens nothing. The browser door's
 * first-contact page is a real destination that a real camera app can open,
 * and this is its address.
 *
 * The credential rides in the **fragment**, which is the entire security
 * design of `/enter` and not a formatting choice. A fragment is never sent to
 * a server, so it cannot reach an access log, a proxy, or a `Referer` header —
 * and the page's first act, before any network call, is to strip it out of
 * the address bar and the session history. Putting the same token in a query
 * string would undo all of that silently.
 *
 * Everything is validated before a URL is built, on the same principle
 * `companionPairingLink` uses: a malformed link is a QR code someone points a
 * phone at and gets a blank page from, with no way to tell what went wrong.
 * `null` is a state the caller can render — "the door is not ready" — and a
 * broken string is not.
 */
export function companionBrowserLink(
  door: CompanionBrowserDoor | null | undefined,
  token: string | undefined | null,
): string | null {
  const origin = companionDoorUrl(door);
  if (!origin || !token) return null;
  // The same token the pairing window issued, and the same shape `devices.ts`
  // will accept at `POST /session`. Checked here so a phone is never sent to
  // a page that can only tell it the code is wrong.
  if (!/^murage_pair_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return `${origin}/enter#${token}`;
}

/** The address to READ OUT to somebody sitting at another computer.
 *
 * The door's own origin, with no path and no credential in it. That is not a
 * simplification of `/enter`: any HTML GET without a session answers 401 with
 * the sign-in page, and that page carries the typed-code field
 * (`signInPage` / `codeEntryMarkup` in `companion/src/browser.ts`). So the
 * origin IS the instruction — open it, type the six digits. `/enter` is for
 * the QR, whose token rides in the fragment; a keyboard sent there reaches
 * the same field by a longer road.
 *
 * Validated for the same reason `companionBrowserLink` is: the host arrives
 * over IPC from the sidecar, and one `/` or `@` in it turns an address
 * somebody is about to type into a different machine's.
 */
export function companionDoorUrl(door: CompanionBrowserDoor | null | undefined): string | null {
  if (!door) return null;
  if (door.scheme !== "http" && door.scheme !== "https") return null;
  if (!Number.isInteger(door.port) || door.port < 1 || door.port > 65_535) return null;
  const host = door.host.trim();
  if (!host || /[\s/\\?#@]/.test(host)) return null;
  // A bare IPv6 literal has colons of its own and has to be bracketed, or the
  // first one reads as the port separator.
  const dialable = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const port = door.port === DEFAULT_PORT[door.scheme] ? "" : `:${door.port}`;
  return `${door.scheme}://${dialable}${port}`;
}

/** The second way in, said in the order a person needs it: where to go, then
 * what to type.
 *
 * There are two routes through the same single-use credential and only one of
 * them was ever named on screen. A laptop cannot photograph its own screen and
 * a browser pointed at a cloud instance has no camera at all, so "scan this"
 * is not advice either of them can take. The typed field has been on the
 * door's pages since the browser door learned to accept six digits; this is
 * the desktop finally admitting it exists.
 *
 * Split into parts rather than one string so the address can be rendered as
 * an address. Joined, it is one sentence — this is a step in a flow, not
 * documentation.
 */
export function typedCodeInstruction(doorUrl: string | null): {
  lead: string;
  url: string | null;
  tail: string;
} {
  // No address to give yet — the door is still coming up, or this is the
  // local-network fallback. Still say the code can be typed, because the
  // alternative is the old dead end where the only named route was a camera.
  if (!doorUrl) return { lead: "No camera? Open Murage's address on that computer and type this code.", url: null, tail: "" };
  return { lead: "No camera? Open ", url: doorUrl, tail: " on that computer and type this code." };
}

export type CompanionBridge = {
  state: () => Promise<CompanionState>;
  start: () => Promise<CompanionState>;
  stop: () => Promise<CompanionState>;
  keepAwake: (enabled: boolean) => Promise<CompanionState>;
  pairing: (open: boolean, expectedToken?: string) => Promise<CompanionState>;
  cloudDesktop: (deviceId: string, allowed: boolean) => Promise<CompanionState>;
  revoke: (deviceId: string) => Promise<CompanionState>;
  /** Re-read Tailscale now, rather than trusting what was true at boot.
   *
   * The sidecar used to read the MagicDNS name once at startup and cache it
   * for the process lifetime, so bringing Tailscale up after Murage was
   * already running left the tailnet route reading as permanently
   * unavailable. The door back in exists as of the #669 port; this is the
   * declaration that lets the renderer actually open it. */
  refreshTailscale: () => Promise<CompanionState>;
  /** Put `tailscale serve` in front of the door — or take it away.
   *
   * The main process does both halves: the serve config AND the door's bind,
   * because they are one decision. It refuses rather than overwriting a serve
   * config somebody else set up. */
  remoteAccess: (enabled: boolean) => Promise<CompanionState>;
};

type AccountBridge = NonNullable<NonNullable<Window["muragebox"]>["companionAccount"]>;
type StateBridge<T> = { state: () => Promise<T> };
const DIRECT_PAIRING_UNAVAILABLE =
  "Direct Wi-Fi pairing isn’t available on this computer right now. Connect this computer to Wi-Fi, then try again.";
const PROTECTED_PAIRING_UNAVAILABLE =
  "The HTTPS pairing route became unavailable. Check secure access, then create a new code.";

interface OwnedCompanionPairingRoutePin extends CompanionPairingRoutePin {
  generation: number;
  token: string;
}

interface PhonePairingRequest {
  routeMode: CompanionPairingRouteMode;
  accountOverride?: CompanionAccountState | null;
  generation: number;
}

/** Before the main process has answered. Not "off": nothing has been asked
 * yet, and rendering a confident "off" for an unasked question is how the
 * readiness panel came to tell a phone that its own working tailnet did not
 * exist. */
export const REMOTE_ACCESS_UNKNOWN: CompanionRemoteAccess = {
  on: false,
  desired: false,
  url: null,
  available: null,
  reason: null,
  problem: null,
};

export const companionBridge = (): CompanionBridge | null =>
  // SAFETY: the preload owns this narrow bridge; browser builds are guarded by the optional lookup.
  (globalThis as { muragebox?: { companion?: CompanionBridge } }).muragebox?.companion ?? null;

export const companionAccountBridge = (): AccountBridge | null =>
  // SAFETY: Electron exposes only these account operations and never sends credentials to the renderer.
  (globalThis as { muragebox?: { companionAccount?: AccountBridge } }).muragebox?.companionAccount ?? null;

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

export interface CompanionStateMutationEpoch {
  current: number;
}

/** Polls capture the epoch before reading. A mutation advances it both before
 * and after the IPC call, invalidating snapshots taken before or during that
 * mutation while leaving the independently loaded account result usable. */
export const mutateCompanionBridgeState = async <State,>(
  epoch: CompanionStateMutationEpoch,
  mutate: () => Promise<State>,
): Promise<State> => {
  epoch.current += 1;
  try {
    return await mutate();
  } finally {
    epoch.current += 1;
  }
};

export const companionStateRefreshIsCurrent = (
  epoch: CompanionStateMutationEpoch,
  refreshEpoch: number,
): boolean => epoch.current === refreshEpoch;

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
  pairingPort: number;
  hostedReady: boolean;
  localFallback: boolean;
  tailscaleFallback: boolean;
  tailscaleAvailable: boolean;
  /** The `/enter#<token>` URL a phone's camera can open, or null while there
   * is no pairing window or no door to send it to. */
  browserLink: string | null;
  /** Where the door is answering, for saying so honestly before there is a
   * link to show. */
  browserDoor: CompanionBrowserDoor | null;
  /** The secure address in front of the door, as it actually is. */
  remoteAccess: CompanionRemoteAccess;
  /** Turn the secure address on or off. */
  setRemoteAccess: (enabled: boolean) => void;
  pairingExpired: boolean;
  setupTimedOut: boolean;
  setEmail: (email: string) => void;
  setCode: (code: string) => void;
  changeEmail: () => void;
  start: () => void;
  useLocal: () => void;
  useTailscale: () => void;
  requestCode: () => void;
  verifyCode: () => void;
  retryAccount: () => void;
  cancel: () => void;
  /** Ask the sidecar to look for Tailscale again, and to move the browser
   * door onto the tailnet if it has appeared since startup. */
  refreshTailscale: () => void;
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
  const [actionBusy, setActionBusy] = useState(false);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [setupTimedOut, setSetupTimedOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [flow, dispatchFlow] = useReducer(phoneSetupReducer, initialPhoneSetupFlowState);
  const emailEdited = useRef(false);
  const pairingUiOwner = useRef<PhonePairingAttemptLock>({ generation: null });
  const pairingAttemptQueue = useRef<PhonePairingAttemptQueue<PhonePairingRequest>>({
    active: null,
    pending: null,
  });
  const runPairingAttemptRef = useRef<(request: PhonePairingRequest) => Promise<void>>(
    async () => {},
  );
  const pairingRoutePinRef = useRef<OwnedCompanionPairingRoutePin | null>(null);
  const [pairingRoutePinState, setPairingRoutePinState] =
    useState<OwnedCompanionPairingRoutePin | null>(null);
  const setupGeneration = useRef(0);
  const mounted = useRef(true);
  const companionMutationEpoch = useRef(0);
  const loadInFlight = useRef<Promise<void> | null>(null);

  const publishPairingRoutePin = useCallback((pin: OwnedCompanionPairingRoutePin | null) => {
    pairingRoutePinRef.current = pin;
    setPairingRoutePinState(pin);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      setupGeneration.current += 1;
    };
  }, []);

  const load = useCallback((): Promise<void> => {
    if (loadInFlight.current) return loadInFlight.current;
    const refreshEpoch = companionMutationEpoch.current;
    const pending = (async () => {
      const next = await loadCompanionBridgeState(companionBridge(), companionAccountBridge());
      if (!mounted.current) return;
      if (
        next.companion
        && companionStateRefreshIsCurrent(companionMutationEpoch, refreshEpoch)
      ) {
        setState(next.companion);
      }
      if (next.account) {
        setAccount(next.account);
        if (shouldHydrateCompanionEmail(emailEdited.current, next.account)) {
          setEmailState(next.account.email ?? "");
        }
      }
    })().finally(() => {
      if (loadInFlight.current === pending) loadInFlight.current = null;
    });
    loadInFlight.current = pending;
    return pending;
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
    setActionBusy(true);
    setError(null);
    try {
      const next = await mutateCompanionBridgeState(
        companionMutationEpoch,
        () => call(companion),
      );
      if (mounted.current) setState(next);
    } catch (cause) {
      if (mounted.current) setError(
        normalizePhoneSetupActionError(
          cause,
          "Phone access could not be updated. Open Advanced & troubleshooting and try again.",
        ),
      );
    } finally {
      if (mounted.current) setActionBusy(false);
    }
  }, []);

  const accountAct = useCallback(
    async (call: (remote: AccountBridge) => Promise<CompanionAccountState>) => {
      const remote = companionAccountBridge();
      if (!remote) return;
      setAccountBusy(true);
      setAccountError(null);
      try {
        const next = await mutateCompanionBridgeState(
          companionMutationEpoch,
          () => call(remote),
        );
        if (!mounted.current) return;
        setAccount(next);
        await load();
      } catch (cause) {
        if (mounted.current) setAccountError(normalizePhoneSetupActionError(
          cause,
          "Secure phone access could not be updated. Try again.",
        ));
      } finally {
        if (mounted.current) setAccountBusy(false);
      }
    },
    [load],
  );

  const runPairingAttempt = useCallback(
    async ({ routeMode, accountOverride, generation }: PhonePairingRequest) => {
      const finishAttempt = () => {
        if (releasePhonePairingAttempt(pairingUiOwner.current, generation) && mounted.current) {
          setPairingBusy(false);
        }
        const next = completePhonePairingAttempt(pairingAttemptQueue.current, generation);
        if (next) void runPairingAttemptRef.current(next);
      };
      const isCurrent = () => mounted.current && setupGeneration.current === generation;
      if (!isCurrent()) {
        finishAttempt();
        return;
      }
      const companion = companionBridge();
      if (!companion) {
        if (mounted.current && setupGeneration.current === generation) {
          setError("Phone setup is only available in the desktop app.");
        }
        finishAttempt();
        return;
      }
      const staleAttemptMayClose = () => {
        const activePin = pairingRoutePinRef.current;
        return !activePin || activePin.generation === generation;
      };
      const previousPin = pairingRoutePinRef.current;
      if (previousPin && previousPin.generation !== generation) {
        publishPairingRoutePin(null);
        setState((current) => current?.pairing?.token === previousPin.token
          ? { ...current, pairing: null }
          : current);
      }
      setError(null);
      try {
        const started = state?.enabled
          ? await companion.state()
          : await mutateCompanionBridgeState(
              companionMutationEpoch,
              () => companion.start(),
            );
        if (!isCurrent()) return;
        setState(started);
        const startFailure = companionStartFailure(started);
        if (startFailure) {
          setProvisioning(false);
          setError(startFailure);
          dispatchFlow({ type: "reset" });
          return;
        }
        const explicitRoute = routeMode !== "automatic";
        const gate = phonePairingGate(accountOverride ?? account, started, explicitRoute);
        if (gate !== "open") {
          setProvisioning(gate === "wait" || gate === "start");
          return;
        }
        if (explicitRoute && !companionPairingRoute(started, routeMode)) {
          setProvisioning(false);
          setError(routeMode === "tailscale"
            ? "Tailscale pairing isn’t available right now. Make sure Tailscale is connected and MagicDNS is on."
            : DIRECT_PAIRING_UNAVAILABLE);
          dispatchFlow({ type: "reset" });
          return;
        }
        const paired = await keepPhonePairingIfCurrent(
          () => mutateCompanionBridgeState(
            companionMutationEpoch,
            () => companion.pairing(true),
          ),
          (opened) => closePhonePairingIfOwned(
            opened,
            () => companion.state(),
            () => mutateCompanionBridgeState(
              companionMutationEpoch,
              () => companion.pairing(false, opened.pairing?.token),
            ),
            staleAttemptMayClose,
          ),
          isCurrent,
        );
        if (!paired) return;

        const pairingWindow = paired.pairing;
        const pairingFailure = companionPairingOpenFailure(
          paired,
          started.pairing?.token ?? null,
        );
        const routePin = pairingFailure ? null : companionPairingRoutePin(paired, routeMode);
        if (pairingFailure || !routePin || !pairingWindow) {
          await closePhonePairingIfOwned(
            paired,
            () => companion.state(),
            () => mutateCompanionBridgeState(
              companionMutationEpoch,
              () => companion.pairing(false, paired.pairing?.token),
            ),
            isCurrent,
          );
          if (!isCurrent()) return;
          publishPairingRoutePin(null);
          setState({ ...paired, pairing: null });
          setProvisioning(false);
          setError(pairingFailure ?? (routeMode === "local"
            ? DIRECT_PAIRING_UNAVAILABLE
            : routeMode === "tailscale"
              ? "Tailscale pairing isn’t available right now. Make sure Tailscale is connected and MagicDNS is on."
              : PROTECTED_PAIRING_UNAVAILABLE));
          dispatchFlow({ type: "reset" });
          return;
        }
        publishPairingRoutePin({
          ...routePin,
          generation,
          token: pairingWindow.token,
        });
        setState(paired);
        setProvisioning(false);
        setSetupTimedOut(false);
        dispatchFlow({
          type: "pairing-opened",
          deviceIds: paired.devices.map((device) => device.id),
        });
      } catch (cause) {
        if (!isCurrent()) return;
        publishPairingRoutePin(null);
        setProvisioning(false);
        setError(normalizePhoneSetupActionError(
          cause,
          "Phone pairing could not be prepared. Open Advanced & troubleshooting and try again.",
        ));
        dispatchFlow({ type: "reset" });
      } finally {
        finishAttempt();
      }
    },
    [account, publishPairingRoutePin, state],
  );

  useLayoutEffect(() => {
    runPairingAttemptRef.current = runPairingAttempt;
  }, [runPairingAttempt]);

  const openPairing = useCallback((
    routeMode: CompanionPairingRouteMode,
    accountOverride?: CompanionAccountState | null,
    generation = setupGeneration.current,
  ) => {
    const request = { routeMode, accountOverride, generation };
    const decision = queuePhonePairingAttempt(pairingAttemptQueue.current, request);
    if (decision === "duplicate") return;
    claimPhonePairingAttempt(pairingUiOwner.current, generation);
    setPairingBusy(true);
    if (decision === "start") void runPairingAttemptRef.current(request);
  }, []);

  const start = useCallback(() => {
    const baseline = phoneSetupBaseline(state?.devices ?? null);
    if (!baseline) return;
    const generation = ++setupGeneration.current;
    dispatchFlow({ type: "start", deviceIds: baseline });
    setError(null);
    setAccountError(null);
    setSetupTimedOut(false);
    if (
      phonePairingGate(account, state, false) === "open"
      || (account?.available && (account.status === "ready" || account.status === "connecting"))
    ) {
      setProvisioning(true);
      void openPairing("automatic", account, generation);
    }
  }, [account, openPairing, state]);

  const useLocal = useCallback(() => {
    const baseline = phoneSetupBaseline(state?.devices ?? null);
    if (!baseline) return;
    if (!flow.active) {
      dispatchFlow({ type: "start", deviceIds: baseline });
    }
    const generation = ++setupGeneration.current;
    dispatchFlow({ type: "use-local" });
    setProvisioning(true);
    setSetupTimedOut(false);
    setAccountError(null);
    void openPairing("local", undefined, generation);
  }, [flow.active, openPairing, state?.devices]);

  const useTailscale = useCallback(() => {
    const baseline = phoneSetupBaseline(state?.devices ?? null);
    if (!baseline) return;
    if (!flow.active) {
      dispatchFlow({ type: "start", deviceIds: baseline });
    }
    const generation = ++setupGeneration.current;
    dispatchFlow({ type: "use-tailscale" });
    setProvisioning(true);
    setSetupTimedOut(false);
    setAccountError(null);
    void openPairing("tailscale", undefined, generation);
  }, [flow.active, openPairing, state?.devices]);

  const requestCode = useCallback(() => {
    const remote = companionAccountBridge();
    const normalized = email.trim().toLowerCase();
    if (!remote || !normalized) return;
    const generation = setupGeneration.current;
    setAccountBusy(true);
    setAccountError(null);
    void remote
      .requestCode(normalized)
      .then((next) => {
        if (!mounted.current || setupGeneration.current !== generation) return;
        setAccount(next);
        setCodeSent(true);
      })
      .catch((cause: unknown) => {
        if (!mounted.current || setupGeneration.current !== generation) return;
        setAccountError(
          normalizePhoneSetupActionError(cause, "We could not send the code. Try again."),
        );
      })
      .finally(() => {
        if (mounted.current && setupGeneration.current === generation) setAccountBusy(false);
      });
  }, [email]);

  const verifyCode = useCallback(() => {
    const remote = companionAccountBridge();
    const normalized = email.trim().toLowerCase();
    if (!remote || code.length !== 8) return;
    const generation = setupGeneration.current;
    setAccountBusy(true);
    setProvisioning(true);
    setSetupTimedOut(false);
    setAccountError(null);
    void mutateCompanionBridgeState(
      companionMutationEpoch,
      () => remote.verifyCode(normalized, code),
    )
      .then(async (next) => {
        if (!mounted.current || setupGeneration.current !== generation) return;
        setAccount(next);
        setCodeState("");
        setCodeSent(false);
        await openPairing("automatic", next, generation);
      })
      .catch((cause: unknown) => {
        if (!mounted.current || setupGeneration.current !== generation) return;
        setProvisioning(false);
        setAccountError(
          normalizePhoneSetupActionError(cause, "That code could not be verified. Try again."),
        );
      })
      .finally(() => {
        if (mounted.current && setupGeneration.current === generation) setAccountBusy(false);
      });
  }, [code, email, openPairing]);

  const retryAccount = useCallback(() => {
    const remote = companionAccountBridge();
    if (!remote) return;
    const baseline = flow.active ? phoneSetupBaseline(state?.devices ?? null) : null;
    const generation = ++setupGeneration.current;
    if (baseline) dispatchFlow({ type: "start", deviceIds: baseline });
    setAccountBusy(true);
    setProvisioning(true);
    setSetupTimedOut(false);
    setAccountError(null);
    void mutateCompanionBridgeState(
      companionMutationEpoch,
      () => remote.retry(),
    )
      .then(async (next) => {
        if (!mounted.current || setupGeneration.current !== generation) return;
        setAccount(next);
        if (flow.active) await openPairing("automatic", next, generation);
        else {
          await load();
          if (mounted.current && setupGeneration.current === generation) setProvisioning(false);
        }
      })
      .catch((cause: unknown) => {
        if (!mounted.current || setupGeneration.current !== generation) return;
        setProvisioning(false);
        setAccountError(
          normalizePhoneSetupActionError(cause, "Secure access could not be restored. Try again."),
        );
      })
      .finally(() => {
        if (mounted.current && setupGeneration.current === generation) setAccountBusy(false);
      });
  }, [flow.active, load, openPairing, state?.devices]);

  const phase = derivePhoneSetupPhase(flow, {
    accountStatus: account?.available ? account.status : "unavailable",
    accountBusy,
    provisioning,
    provisioningTimedOut: setupTimedOut,
    pairingOpen: Boolean(
      state?.pairing
      && pairingRoutePinState?.token === state.pairing.token,
    ),
  });

  useEffect(() => {
    if (
      !flow.active
      || flow.localFallback
      || flow.tailscaleFallback
      || !account
      || (account.available && account.status !== "signed-out" && account.status !== "error")
    ) {
      return;
    }
    setProvisioning(false);
  }, [account, flow.active, flow.localFallback, flow.tailscaleFallback]);

  useEffect(() => {
    if (!shouldArmPhoneSetupProvisioningTimeout(flow, {
      provisioning,
      provisioningTimedOut: setupTimedOut,
    })) return;
    const timer = window.setTimeout(() => {
      const timedOutGeneration = setupGeneration.current;
      setupGeneration.current += 1;
      invalidatePhonePairingAttempt(pairingAttemptQueue.current, timedOutGeneration);
      releasePhonePairingAttempt(pairingUiOwner.current, timedOutGeneration);
      setPairingBusy(false);
      setAccountBusy(false);
      setProvisioning(false);
      setSetupTimedOut(true);
    }, PHONE_SETUP_PROVISIONING_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [flow, provisioning, setupTimedOut]);

  useEffect(() => {
    const pin = pairingRoutePinState;
    if (!pin || !state) return;
    if (!state.pairing) {
      publishPairingRoutePin(null);
      return;
    }

    const tokenMatches = state.pairing.token === pin.token;
    const routeAvailable = companionPairingRoutePinAvailable(state, pin);
    if (tokenMatches && routeAvailable) return;

    const companion = companionBridge();
    if (setupGeneration.current === pin.generation) setupGeneration.current += 1;
    invalidatePhonePairingAttempt(pairingAttemptQueue.current, pin.generation);
    releasePhonePairingAttempt(pairingUiOwner.current, pin.generation);
    setPairingBusy(false);
    publishPairingRoutePin(null);
    setState((current) => current ? { ...current, pairing: null } : current);
    setProvisioning(false);
    setSetupTimedOut(false);
    setError(tokenMatches
      ? PROTECTED_PAIRING_UNAVAILABLE
      : "The pairing code changed before setup finished. Create a new code and try again.");
    dispatchFlow({ type: "reset" });

    if (tokenMatches && companion) {
      void closePhonePairingIfOwned(
        state,
        () => companion.state(),
        () => mutateCompanionBridgeState(
          companionMutationEpoch,
          () => companion.pairing(false, state.pairing?.token),
        ),
        () => {
          const activePin = pairingRoutePinRef.current;
          return !activePin || activePin.generation === pin.generation;
        },
      );
    }
  }, [pairingRoutePinState, publishPairingRoutePin, state]);

  useEffect(() => {
    if (!state) return;
    const device = newlyPairedDeviceForFlow(flow, state.devices);
    if (device) dispatchFlow({ type: "paired", deviceName: device.name });
  }, [flow, state]);

  useEffect(() => {
    if (
      !flow.active ||
      flow.localFallback ||
      flow.tailscaleFallback ||
      flow.pairingAttempted ||
      setupTimedOut ||
      !state ||
      phonePairingGate(account, state, false) !== "open"
    ) {
      return;
    }
    void openPairing("automatic");
  }, [account, flow.active, flow.localFallback, flow.pairingAttempted, flow.tailscaleFallback, openPairing, setupTimedOut, state]);

  const shouldPoll = flow.active || Boolean(state?.pairing);
  useEffect(() => {
    return startNonOverlappingPhoneSetupPoll(
      () => {
        setNow(Date.now());
        return load();
      },
      shouldPoll ? 1_000 : 10_000,
    );
  }, [load, shouldPoll]);

  const pairingRouteMode: CompanionPairingRouteMode = flow.localFallback
    ? "local"
    : flow.tailscaleFallback
      ? "tailscale"
      : "automatic";
  const pairingRoute = useMemo(
    () => {
      if (!state) return null;
      if (state.pairing) {
        return pairingRoutePinState?.token === state.pairing.token
          ? pairingRoutePinState.route
          : null;
      }
      return companionPairingRoute(state, pairingRouteMode);
    },
    [pairingRouteMode, pairingRoutePinState, state],
  );
  const pairingLink = useMemo(() => {
    if (!state?.pairing || !pairingRoute) return null;
    return companionPairingLink({
      ...pairingRoute,
      code: state.pairing.code,
      token: state.pairing.token,
      name: state.discovery?.name,
    });
  }, [pairingRoute, state]);

  /** The URL the QR should carry. Built from the door the sidecar reported
   * and the token the pairing window just issued — never from the route the
   * `murage://` link uses, which addresses the device port and an app that
   * is not in this repository. */
  const browserLink = useMemo(
    () => companionBrowserLink(state?.browser, state?.pairing?.token),
    [state],
  );

  /** Look for Tailscale again, now.
   *
   * The sidecar reads the MagicDNS name at boot, and installing or signing
   * into Tailscale afterwards used to leave a perfectly working tailnet
   * reading as permanently unavailable. This asks again — and the sidecar
   * moves the browser door onto the tailnet in the same call, because a
   * correctly spelled name for a door still on loopback is not the fix
   * anybody wanted. */
  const refreshTailscale = useCallback(() => {
    void act((companion) => companion.refreshTailscale());
  }, [act]);

  const cancel = useCallback(() => {
    const cancelledGeneration = setupGeneration.current;
    setupGeneration.current += 1;
    invalidatePhonePairingAttempt(pairingAttemptQueue.current, cancelledGeneration);
    releasePhonePairingAttempt(pairingUiOwner.current, cancelledGeneration);
    setPairingBusy(false);
    const snapshot = state;
    const companion = companionBridge();
    publishPairingRoutePin(null);
    setState((current) => current ? { ...current, pairing: null } : current);
    if (companion && snapshot?.pairing) {
      void closePhonePairingIfOwned(
        snapshot,
        () => companion.state(),
        () => mutateCompanionBridgeState(
          companionMutationEpoch,
          () => companion.pairing(false, snapshot.pairing?.token),
        ),
        () => pairingRoutePinRef.current === null,
      );
    }
    setProvisioning(false);
    setAccountBusy(false);
    setSetupTimedOut(false);
    setCodeSent(false);
    setCodeState("");
    dispatchFlow({ type: "reset" });
  }, [publishPairingRoutePin, state]);

  return {
    state,
    account,
    phase,
    email,
    code,
    codeSent,
    busy: actionBusy || pairingBusy,
    accountBusy,
    error,
    accountError,
    pairingLink,
    secondsLeft: state?.pairing
      ? Math.max(0, Math.round((state.pairing.expiresAt - now) / 1000))
      : 0,
    address: pairingRoute?.address,
    pairingPort: pairingRoute?.port ?? state?.port ?? 8810,
    hostedReady: Boolean(state?.endpoints?.some((endpoint) => endpoint.kind === "hosted")),
    localFallback: flow.localFallback,
    tailscaleFallback: flow.tailscaleFallback,
    tailscaleAvailable: Boolean(state && companionPairingRoute(state, "tailscale")),
    browserLink,
    browserDoor: state?.browser ?? null,
    remoteAccess: state?.remoteAccess ?? REMOTE_ACCESS_UNKNOWN,
    setRemoteAccess: (enabled: boolean) => {
      void act((companion) => companion.remoteAccess(enabled));
    },
    pairingExpired: flow.pairingAttempted && !state?.pairing,
    setupTimedOut,
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
    useTailscale,
    requestCode,
    verifyCode,
    retryAccount,
    cancel,
    refreshTailscale,
    refreshCode: () => {
      const generation = ++setupGeneration.current;
      void openPairing(pairingRouteMode, undefined, generation);
    },
    finish: () => {
      const generation = setupGeneration.current;
      setupGeneration.current += 1;
      invalidatePhonePairingAttempt(pairingAttemptQueue.current, generation);
      releasePhonePairingAttempt(pairingUiOwner.current, generation);
      setPairingBusy(false);
      publishPairingRoutePin(null);
      setSetupTimedOut(false);
      dispatchFlow({ type: "reset" });
    },
    skip: () => {
      const generation = setupGeneration.current;
      setupGeneration.current += 1;
      invalidatePhonePairingAttempt(pairingAttemptQueue.current, generation);
      releasePhonePairingAttempt(pairingUiOwner.current, generation);
      setPairingBusy(false);
      publishPairingRoutePin(null);
      dispatchFlow({ type: "skip" });
    },
    act,
    accountAct,
  };
}

/** The one sentence this screen is allowed to make.
 *
 * It used to say "Use Murage from your phone" over a phone icon and a button
 * reading "Set up my phone", which described a native app. There is no native
 * app — `ios/` was removed from this repository, and the `murage://` link the
 * old QR carried opens nothing on a phone that never installed one. What
 * exists is the browser door: the sidecar serves this same app over the
 * tailnet, and a phone reaches it with a camera and a browser.
 *
 * Exported so `CompanionSection` can say the same thing. Two screens leading
 * into one flow with two different promises is how the old copy survived a
 * rewrite of the thing underneath it. */
export const WEB_UI_TITLE = "Open Murage in your browser";
export const WEB_UI_SUBTITLE =
  "Scan a code and Murage opens in the browser on your phone, tablet, or another computer: "
  + "over your own Tailscale network. Nothing to install, and nothing exposed to the internet.";

/** What still has to be true before there is anything to scan.
 *
 * Named rather than inferred at the button, because each of these is a
 * different thing to go and do and "it didn't work" is not one of them.
 * Ordered by what a person fixes first: the app has to be able to ask at all,
 * then the sidecar has to be running, then Tailscale, then the door. */
export interface WebUiReadiness {
  ready: boolean;
  /** The single next thing to do, when there is one. */
  blocker: string | null;
  tailnetName: string | null;
  /** The address the door is answering on, as a browser would type it —
   * portless when the scheme's default port is what is in front. */
  doorAddress: string | null;
  /** Whether re-probing Tailscale could plausibly change the answer. */
  canRecheck: boolean;
}

/** The default port for a scheme, which a browser never shows. */
const DEFAULT_DOOR_PORT: Record<CompanionBrowserDoor["scheme"], number> = { http: 80, https: 443 };

/** The door as a person would read it out: `name.ts.net` behind serve,
 * `name.ts.net:8813` on the plain tailnet. Dropping the default port is the
 * whole visible difference between a working link and a broken one. */
export function doorAddressLabel(door: CompanionBrowserDoor | null): string | null {
  if (!door) return null;
  return door.port === DEFAULT_DOOR_PORT[door.scheme] ? door.host : `${door.host}:${door.port}`;
}

export function webUiReadiness(source: {
  state: CompanionState | null;
  browserDoor: CompanionBrowserDoor | null;
}): WebUiReadiness {
  const { state, browserDoor } = source;
  const tailnetName = state?.tailnetName ?? null;
  const doorAddress = doorAddressLabel(browserDoor);
  const base = { tailnetName, doorAddress, canRecheck: Boolean(state?.enabled) };
  if (!state) {
    return { ...base, ready: false, blocker: "Checking this computer…", canRecheck: false };
  }
  if (!state.enabled) {
    // Ready, deliberately. The sidecar is off, and pressing the button is
    // what turns it on — everything below is a question only a running
    // sidecar can answer, so refusing here would be refusing to let anyone
    // find out. The rows still say "not found" and "not listening yet",
    // which is true and is not a promise that they will stay that way.
    return { ...base, ready: true, blocker: null };
  }
  if (!tailnetName) {
    return {
      ...base,
      ready: false,
      blocker:
        "Tailscale isn’t signed in on this computer yet. Install it, sign in, then check again: "
        + "your phone needs to be signed into the same tailnet.",
    };
  }
  if (!browserDoor) {
    return {
      ...base,
      ready: false,
      blocker: "The browser door isn’t listening yet. Check again in a moment.",
    };
  }
  return { ...base, ready: true, blocker: null };
}

/** The preconditions, said out loud.
 *
 * A row per thing that has to be true, each either satisfied and specific —
 * the actual tailnet name, the actual address the door answers on — or
 * unsatisfied with the action next to it. This is the "say what is true and
 * leave the affordance disabled with an honest reason" rule made visible
 * rather than left to a tooltip. */
export interface WebUiReadinessRow {
  label: string;
  value: string;
  good: boolean;
}

/** What this renderer has NOT looked at, said as such.
 *
 * "not found" and "not listening yet" are findings. They are only true if
 * somebody went and looked, and the only renderer that can look is the one
 * running on the machine: the tailnet name and the door's address both arrive
 * over the Electron bridge, which does not exist on the other side of the
 * browser door. On a phone this panel reported BOTH negatives while the user
 * was reading it in a browser, over Tailscale — every word of it disproved by
 * the fact that it was on screen.
 *
 * So the negative belongs to the desktop and nobody else. The panel does not
 * render at all once the surface is known to be remote; while the surface is
 * still unknown it renders, because hiding it would flash the desktop's own
 * settings pane, and it says "checking…" — absence of evidence reported as
 * absence of evidence, not as evidence of absence. */
export function webUiReadinessRows(
  readiness: WebUiReadiness,
  desktop: boolean | undefined,
): WebUiReadinessRow[] {
  const unknown = desktop === undefined;
  return [
    {
      label: "Tailscale on this computer",
      value: readiness.tailnetName ?? (unknown ? "checking…" : "not found"),
      good: Boolean(readiness.tailnetName),
    },
    {
      label: "Murage in a browser",
      value: readiness.doorAddress ?? (unknown ? "checking…" : "not listening yet"),
      good: Boolean(readiness.doorAddress),
    },
  ];
}

function WebUiReadinessPanel({
  readiness,
  busy,
  onRecheck,
  desktop,
}: {
  readiness: WebUiReadiness;
  busy: boolean;
  onRecheck: () => void;
  desktop: boolean | undefined;
}) {
  // Confirmed remote: there is no computer here to report on. Nothing to
  // disable, nothing to caveat — the rows simply are not this device's rows.
  if (desktop === false) return null;
  const rows = webUiReadinessRows(readiness, desktop);
  return (
    <div className="mt-4 w-full max-w-[420px] rounded-xl border border-hairline/50 px-3 py-2.5 text-left">
      {rows.map((row) => (
        <div key={row.label} className="flex items-baseline justify-between gap-3 py-1">
          <span className="text-[12px] text-ink-secondary">{row.label}</span>
          <span
            className={`truncate text-[12px] ${row.good ? "text-ink" : "text-ink-secondary"}`}
            title={row.value}
          >
            {row.value}
          </span>
        </div>
      ))}
      {readiness.canRecheck && !readiness.ready && (
        // Tailscale is routinely installed or signed into after Murage has
        // already started, and the sidecar read the tailnet once, at boot. So
        // this is not a refresh button in the decorative sense: without it a
        // working tailnet reads as permanently absent until somebody restarts
        // the app, and nobody would think to.
        <button
          disabled={busy}
          onClick={onRecheck}
          className="mt-1.5 flex items-center gap-1.5 text-[12px] text-accent hover:opacity-80 disabled:opacity-40"
        >
          <RefreshCw size={12} /> Check for Tailscale again
        </button>
      )}
    </div>
  );
}

function ValuePoints() {
  const points: Array<{ Icon: typeof Smartphone; title: string; detail: string }> = [
    { Icon: Smartphone, title: "Any device", detail: "A phone, a tablet, another laptop. Just a browser." },
    { Icon: Check, title: "Nothing to install", detail: "No app store, no account. Scan and you are in." },
    { Icon: ShieldCheck, title: "Your tailnet only", detail: "Not the internet. Only devices you approve." },
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
  // THE PHONE IS THE PHONE.
  //
  // This whole flow is "how do I get Murage onto a phone" — a QR code to point
  // a camera at, a tailnet to join, a pairing to approve. It was rendered ON
  // the paired phone, which had already done all of it. Confirmed remote gets
  // nothing here rather than a disabled version of it: a greyed-out wizard for
  // a job you have already finished is still the wrong screen.
  //
  // `undefined` keeps rendering. On the desktop this component's own callers
  // (Onboarding, CompanionSection) have already established the surface, so
  // the only renderer that reaches here unknowing is the dev server's — and
  // blanking the settings pane for a fetch would be a change to the desktop.
  const desktop = useDesktopSurface();
  const actionError = companionAccountActionError(c.account, c.accountError);
  const canSubmitEmail = /^\S+@\S+\.\S+$/.test(c.email.trim());
  // Both ways in need the door's address: the QR carries it, and the person
  // typing the code has to be told it.
  const doorUrl = companionDoorUrl(c.browserDoor);
  const typed = typedCodeInstruction(doorUrl);

  if (desktop === false) return null;

  if (c.phase === "intro") {
    const readiness = webUiReadiness(c);
    return (
      <div className="flex flex-col items-center text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-accent/12 text-accent">
          <Globe size={26} />
        </div>
        <h2 className="mt-4 text-[19px] font-semibold text-ink">{WEB_UI_TITLE}</h2>
        <p className="mt-1.5 max-w-[460px] text-[13.5px] leading-relaxed text-ink-secondary">
          {WEB_UI_SUBTITLE}
        </p>
        <ValuePoints />
        <WebUiReadinessPanel
          readiness={readiness}
          busy={c.busy || c.accountBusy}
          onRecheck={c.refreshTailscale}
          desktop={desktop}
        />
        <button
          onClick={c.start}
          disabled={!c.state || c.busy || c.accountBusy || !readiness.ready}
          className="mt-4 w-full max-w-[320px] rounded-lg bg-accent py-2.5 text-[14px] font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {variant === "settings"
            ? c.state?.devices.length
              ? "Add another device"
              : "Show me the code"
            : "Show me the code"}
        </button>
        {!readiness.ready && (
          // The reason lives here rather than in a tooltip: a disabled button
          // with no explanation is the failure this screen was already making
          // in a different way.
          <p className="mt-2 max-w-[390px] text-[11.5px] leading-relaxed text-ink-secondary">
            {readiness.blocker}
          </p>
        )}
        {c.error && <p role="alert" className="mt-3 max-w-[390px] text-[12.5px] text-danger">{c.error}</p>}
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
    const failed = c.account?.status === "error" || c.setupTimedOut;
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
        <p
          role={c.setupTimedOut ? "alert" : undefined}
          className="mt-1 text-[13px] leading-relaxed text-ink-secondary"
        >
          {unavailable
            ? "Online phone access is not available right now. You can still pair directly on the same Wi-Fi."
            : c.setupTimedOut
              ? "Secure access is taking longer than expected. You can try again or pair directly on this Wi-Fi."
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

        {(unavailable || failed) && (
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
        {c.tailscaleAvailable ? (
          <>
            <button
              disabled={c.busy || c.accountBusy}
              onClick={c.useTailscale}
              className="flex items-center justify-center gap-2 rounded-lg border border-hairline/50 py-2.5 text-[13px] text-ink hover:bg-control disabled:opacity-40"
            >
              <ShieldCheck size={15} /> Pair over Tailscale
            </button>
            <p className="mt-2 text-center text-[11px] leading-relaxed text-ink-secondary">
              That device must be signed in to the same tailnet.
            </p>
          </>
        ) : (
          // The tailnet is the route this product leads with, and the sidecar
          // reads it once, at boot. Somebody who installs Tailscale while
          // this screen is open — which is exactly when they would — sees
          // "no Tailscale route" until they restart the whole app. This is
          // the way back, and it is a plain text button on purpose: it is a
          // re-probe, not a route to choose.
          <button
            disabled={c.busy || c.accountBusy}
            onClick={c.refreshTailscale}
            className="flex items-center justify-center gap-1.5 text-[12.5px] text-accent hover:opacity-80 disabled:opacity-40"
          >
            <RefreshCw size={13} /> Check for Tailscale again
          </button>
        )}
        <button
          disabled={c.busy || c.accountBusy}
          onClick={c.useLocal}
          className={`${c.tailscaleAvailable ? "mt-3" : ""} flex items-center justify-center gap-2 rounded-lg border border-hairline/50 py-2.5 text-[13px] text-ink hover:bg-control disabled:opacity-40`}
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
          {c.localFallback
            ? "Preparing your pairing code"
            : c.tailscaleFallback
              ? "Preparing Tailscale pairing"
              : "Creating secure phone access"}
        </h2>
        <p className="mt-1.5 max-w-[360px] text-[13px] leading-relaxed text-ink-secondary">
          {c.localFallback
            ? "This should only take a moment."
            : c.tailscaleFallback
              ? "Your pairing code will use your private tailnet connection."
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
        <h2 className="mt-4 text-[19px] font-semibold text-ink">That device is ready</h2>
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
          {variant === "onboarding" ? "Start using Murage" : "Done"}
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
        {c.pairingExpired ? "That code expired" : "Scan it, or type the code"}
      </h2>
      <p className="mt-1 text-[13px] text-ink-secondary">
        {c.pairingExpired
          ? "Create a fresh code when the device you are pairing is ready."
          : "Point a phone camera at it. On a computer with no camera, type the code instead."}
      </p>
      {/* The browser door first, the `murage://` link only as a fallback.
        * The fallback addresses an app this repository no longer contains, so
        * scanning it opens nothing — it stays only because a phone that
        * paired against an older build may still have one installed, and
        * "delete nothing until its replacement ships" is the rule. The
        * replacement is `c.browserLink`, which every camera app can open. */}
      {!c.pairingExpired && (c.browserLink ?? c.pairingLink) && (
        <div className="mt-4 rounded-2xl bg-white p-3.5" aria-label="Phone pairing QR code">
          <QRCodeSVG
            value={(c.browserLink ?? c.pairingLink)!}
            size={180}
            level="M"
            bgColor="#ffffff"
            fgColor="#111111"
          />
        </div>
      )}
      {!c.pairingExpired && c.browserLink && c.browserDoor && (
        <p className="mt-2.5 max-w-[390px] text-[11.5px] leading-relaxed text-ink-secondary">
          Opens <span className="text-ink">{doorAddressLabel(c.browserDoor)}</span> in the browser on
          whichever device scans it: a phone, a tablet, a laptop. That device has to be signed into
          the same tailnet.
        </p>
      )}
      {/* The digits, on screen, whenever there is a code — never again behind
        * "Having trouble?". They used to hide there whenever a QR link could
        * be built, which is exactly the case a laptop hits: a code nobody can
        * read is a code nobody can type, and the only route left on screen
        * was one a machine without a camera cannot take. */}
      {!c.pairingExpired && c.state?.pairing && (
        <div className="mt-4 w-full max-w-[390px] rounded-xl bg-inset px-4 py-3 text-left text-[12px] leading-relaxed text-ink-secondary">
          <div>
            {typed.lead}
            {typed.url && <span className="font-mono text-ink">{typed.url}</span>}
            {typed.tail}
          </div>
          <div className="mt-1.5 font-mono text-[22px] tracking-[0.25em] text-ink">
            {c.state.pairing.code}
          </div>
          <div className="mt-1.5">Signs in one device, then it is spent. Expires in {c.secondsLeft}s.</div>
        </div>
      )}
      {c.pairingExpired && (
        <button onClick={c.refreshCode} className="mt-5 rounded-lg bg-accent px-5 py-2.5 text-[14px] font-medium text-white">
          Create a new code
        </button>
      )}
      {!c.pairingExpired && c.state?.pairing && c.address && (
        <details className="mt-4 w-full max-w-[390px] rounded-lg border border-hairline/40 px-3 py-2 text-left">
          <summary className="cursor-pointer text-[12px] text-ink-secondary">Having trouble?</summary>
          <div className="mt-3 text-[12px] text-ink-secondary">
            {/* The code itself is above now. What is left here is the direct
              * pairing address, which only the local-network route uses — and
              * with nothing else in the block, an empty "Having trouble?" is
              * worse than none, so the whole disclosure waits on it. */}
            <ConnectionDetail label="Pairing address" value={`${c.address}:${c.pairingPort}`} />
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
