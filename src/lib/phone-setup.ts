import type { CompanionAccountState } from "../types/ogb";
import type { CompanionEndpoint } from "./companion-pairing";

export type PhoneSetupPhase = "intro" | "sign-in" | "verifying" | "qr" | "success";

export interface PhoneSetupFlowState {
  active: boolean;
  localFallback: boolean;
  baselineDeviceIds: string[];
  pairingAttempted: boolean;
  pairedDeviceName: string | null;
  skipped: boolean;
}

export type PhoneSetupEvent =
  | { type: "start"; deviceIds: string[] }
  | { type: "resume"; deviceIds: string[] }
  | { type: "use-local" }
  | { type: "pairing-opened" }
  | { type: "paired"; deviceName: string }
  | { type: "skip" }
  | { type: "reset" };

export const initialPhoneSetupFlowState: PhoneSetupFlowState = {
  active: false,
  localFallback: false,
  baselineDeviceIds: [],
  pairingAttempted: false,
  pairedDeviceName: null,
  skipped: false,
};

/** A small explicit state machine shared by first-run onboarding and Settings.
 * Network/account state remains external input; user intent stays here so a
 * refresh cannot accidentally turn a secure setup into local-only pairing. */
export function phoneSetupReducer(
  state: PhoneSetupFlowState,
  event: PhoneSetupEvent,
): PhoneSetupFlowState {
  switch (event.type) {
    case "start":
    case "resume":
      return {
        active: true,
        localFallback: false,
        baselineDeviceIds: [...event.deviceIds],
        pairingAttempted: false,
        pairedDeviceName: null,
        skipped: false,
      };
    case "use-local":
      return { ...state, active: true, localFallback: true, pairingAttempted: false };
    case "pairing-opened":
      return { ...state, pairingAttempted: true };
    case "paired":
      return { ...state, active: true, pairedDeviceName: event.deviceName };
    case "skip":
      return { ...initialPhoneSetupFlowState, skipped: true };
    case "reset":
      return initialPhoneSetupFlowState;
  }
}

export type PhoneSetupAccountStatus = CompanionAccountState["status"] | "unavailable";

export interface PhoneSetupSnapshot {
  accountStatus: PhoneSetupAccountStatus;
  accountBusy: boolean;
  provisioning: boolean;
  pairingOpen: boolean;
}

export function derivePhoneSetupPhase(
  flow: PhoneSetupFlowState,
  snapshot: PhoneSetupSnapshot,
): PhoneSetupPhase {
  if (flow.pairedDeviceName) return "success";
  if (!flow.active) return "intro";
  if (snapshot.pairingOpen || flow.pairingAttempted) return "qr";
  if (flow.localFallback || snapshot.accountBusy || snapshot.provisioning) return "verifying";
  if (snapshot.accountStatus === "signed-out" || snapshot.accountStatus === "unavailable") {
    return "sign-in";
  }
  if (snapshot.accountStatus === "error") return "sign-in";
  return "verifying";
}

export type CompanionPairingMode =
  | "local-only"
  | "hosted-startable"
  | "hosted-connecting"
  | "hosted-ready";

export interface PhoneSetupCompanionSnapshot {
  enabled: boolean;
  endpoints?: CompanionEndpoint[];
}

/** A hosted endpoint is the only automatic route. Local pairing requires an
 * explicit user choice, which prevents provisioning races from showing a QR
 * that cannot work on an isolated Wi-Fi network. */
export const companionPairingMode = (
  account: CompanionAccountState | null,
  companion: PhoneSetupCompanionSnapshot | null,
): CompanionPairingMode => {
  if (companion?.endpoints?.some((endpoint) => endpoint.kind === "hosted")) {
    return "hosted-ready";
  }
  if (!account?.available || account.status === "signed-out" || account.status === "error") {
    return "local-only";
  }
  if (account.status === "ready" && !companion?.enabled) return "hosted-startable";
  return "hosted-connecting";
};

export type PhonePairingGate = "open" | "start" | "wait" | "account-required";

export function phonePairingGate(
  account: CompanionAccountState | null,
  companion: PhoneSetupCompanionSnapshot | null,
  localFallback: boolean,
): PhonePairingGate {
  if (localFallback) return "open";
  switch (companionPairingMode(account, companion)) {
    case "hosted-ready":
      return "open";
    case "hosted-startable":
      return "start";
    case "hosted-connecting":
      return "wait";
    case "local-only":
      return "account-required";
  }
}

export function newlyPairedDevice<T extends { id: string; name: string }>(
  baselineDeviceIds: string[],
  devices: T[],
): T | null {
  const baseline = new Set(baselineDeviceIds);
  return devices.find((device) => !baseline.has(device.id)) ?? null;
}
