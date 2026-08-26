import { describe, expect, it } from "vitest";
import type { CompanionAccountState } from "../types/ogb";
import {
  derivePhoneSetupPhase,
  initialPhoneSetupFlowState,
  newlyPairedDevice,
  phonePairingGate,
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
});
