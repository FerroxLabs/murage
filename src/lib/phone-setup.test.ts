import { describe, expect, it } from "vitest";
import type { CompanionAccountState } from "../types/ogb";
import {
  companionStartFailure,
  derivePhoneSetupPhase,
  initialPhoneSetupFlowState,
  newlyPairedDevice,
  normalizePhoneSetupActionError,
  phonePairingGate,
  phoneSetupBaseline,
  phoneSetupReducer,
} from "./phone-setup";

const account = (status: CompanionAccountState["status"]): CompanionAccountState => ({
  available: true,
  status,
});

describe("phone setup flow", () => {
  it("moves from intro to sign-in and preserves the profile-independent resume path", () => {
    const started = phoneSetupReducer(initialPhoneSetupFlowState, {
      type: "start",
      deviceIds: ["existing"],
    });
    expect(
      derivePhoneSetupPhase(started, {
        accountStatus: "signed-out",
        accountBusy: false,
        provisioning: false,
        pairingOpen: false,
      }),
    ).toBe("sign-in");

    const skipped = phoneSetupReducer(started, { type: "skip" });
    expect(skipped.skipped).toBe(true);
    expect(skipped.active).toBe(false);
    expect(
      derivePhoneSetupPhase(skipped, {
        accountStatus: "signed-out",
        accountBusy: false,
        provisioning: false,
        pairingOpen: false,
      }),
    ).toBe("intro");

    const resumed = phoneSetupReducer(skipped, { type: "resume", deviceIds: ["existing"] });
    expect(resumed.active).toBe(true);
    expect(resumed.skipped).toBe(false);
  });

  it("never opens local pairing while hosted access is provisioning", () => {
    const companion = { enabled: true, endpoints: [] };
    expect(phonePairingGate(account("connecting"), companion, false)).toBe("wait");
    expect(phonePairingGate(account("ready"), companion, false)).toBe("wait");
    expect(phonePairingGate(account("signed-out"), companion, false)).toBe("account-required");
  });

  it("opens local pairing only after the explicit Wi-Fi fallback", () => {
    expect(
      phonePairingGate(
        { available: false, status: "signed-out" },
        { enabled: true, endpoints: [] },
        false,
      ),
    ).toBe("account-required");
    expect(
      phonePairingGate(
        { available: false, status: "signed-out" },
        { enabled: true, endpoints: [] },
        true,
      ),
    ).toBe("open");
  });

  it("opens pairing immediately when the hosted route is ready", () => {
    expect(
      phonePairingGate(
        account("ready"),
        {
          enabled: true,
          endpoints: [{ kind: "hosted", url: "https://phone.example", priority: 0 }],
        },
        false,
      ),
    ).toBe("open");
  });

  it("derives paired success from a device added after setup began", () => {
    const started = phoneSetupReducer(initialPhoneSetupFlowState, {
      type: "start",
      deviceIds: ["old"],
    });
    const device = newlyPairedDevice(started.baselineDeviceIds, [
      { id: "old", name: "Old phone" },
      { id: "new", name: "Milind’s iPhone" },
    ]);
    expect(device?.name).toBe("Milind’s iPhone");

    const success = phoneSetupReducer(started, {
      type: "paired",
      deviceName: device?.name ?? "Phone",
    });
    expect(
      derivePhoneSetupPhase(success, {
        accountStatus: "ready",
        accountBusy: false,
        provisioning: false,
        pairingOpen: false,
      }),
    ).toBe("success");
  });

  it("waits for the initial device snapshot before capturing the success baseline", () => {
    expect(phoneSetupBaseline(null)).toBeNull();

    const baseline = phoneSetupBaseline([{ id: "already-paired", name: "Existing iPhone" }]);
    expect(baseline).toEqual(["already-paired"]);
    expect(
      newlyPairedDevice(baseline ?? [], [{ id: "already-paired", name: "Existing iPhone" }]),
    ).toBeNull();
  });

  it("turns a disabled start result into a stable actionable error", () => {
    expect(companionStartFailure({ enabled: true })).toBeNull();
    expect(companionStartFailure({ enabled: false })).toContain("Advanced & troubleshooting");
    expect(companionStartFailure({ enabled: false, error: "Port 8811 is already in use" })).toBe(
      "Port 8811 is already in use",
    );
  });

  it("unwraps Electron IPC account errors without exposing channel machinery", () => {
    const requestId = "c285fe8c-f6f4-41a3-a737-7a2d1faf405a";
    const message = normalizePhoneSetupActionError(
      new Error(
        `Error invoking remote method 'companion-account:request-code': Error: The secure connection request was not allowed. Try signing in again. Reference: ${requestId}.`,
      ),
      "We could not send the code. Try again.",
    );
    expect(message).toBe(`We could not send the code. Try again. Reference: ${requestId}.`);
    expect(message).not.toContain("remote method");
    expect(message).not.toContain("companion-account");
  });

  it("replaces arbitrary IPC details with calm setup copy", () => {
    expect(
      normalizePhoneSetupActionError(
        new Error("Error invoking remote method 'companion-account:request-code': Error: /private/keychain failed"),
        "We could not send the code. Try again.",
      ),
    ).toBe("We could not send the code. Try again.");
  });
});
