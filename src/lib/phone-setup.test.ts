import { describe, expect, it, vi } from "vitest";
import type { CompanionAccountState } from "../types/ogb";
import {
  companionStartFailure,
  derivePhoneSetupPhase,
  initialPhoneSetupFlowState,
  keepPhonePairingIfCurrent,
  newlyPairedDevice,
  newlyPairedDeviceForFlow,
  normalizePhoneSetupActionError,
  phonePairingGate,
  phoneSetupBaseline,
  phoneSetupReducer,
  shouldArmPhoneSetupProvisioningTimeout,
  startNonOverlappingPhoneSetupPoll,
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

  it("stops showing provisioning when the secure account fails or times out", () => {
    const started = phoneSetupReducer(initialPhoneSetupFlowState, {
      type: "start",
      deviceIds: [],
    });
    expect(
      derivePhoneSetupPhase(started, {
        accountStatus: "error",
        accountBusy: false,
        provisioning: true,
        pairingOpen: false,
      }),
    ).toBe("sign-in");
    expect(
      derivePhoneSetupPhase(started, {
        accountStatus: "unavailable",
        accountBusy: false,
        provisioning: true,
        pairingOpen: false,
      }),
    ).toBe("sign-in");
    expect(
      derivePhoneSetupPhase(started, {
        accountStatus: "connecting",
        accountBusy: false,
        provisioning: true,
        provisioningTimedOut: true,
        pairingOpen: false,
      }),
    ).toBe("sign-in");
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

  it("opens pairing over a protected tailnet without requiring a hosted account", () => {
    const tailnet = {
      enabled: true,
      endpoints: [{
        kind: "tailnet" as const,
        url: "http://mac.tail1234.ts.net:8810",
        priority: 100,
      }],
    };
    expect(phonePairingGate(account("signed-out"), tailnet, false)).toBe("open");
    expect(
      phonePairingGate({ available: false, status: "signed-out" }, tailnet, false),
    ).toBe("open");
  });

  it("arms the timeout during account IPC and explicit local setup", () => {
    const local = phoneSetupReducer(
      phoneSetupReducer(initialPhoneSetupFlowState, { type: "start", deviceIds: [] }),
      { type: "use-local" },
    );
    expect(shouldArmPhoneSetupProvisioningTimeout(local, {
      provisioning: true,
      provisioningTimedOut: false,
    })).toBe(true);
    expect(derivePhoneSetupPhase(local, {
      accountStatus: "connecting",
      accountBusy: true,
      provisioning: true,
      provisioningTimedOut: true,
      pairingOpen: false,
    })).toBe("sign-in");
  });

  it("closes a pairing window that resolves after cancellation", async () => {
    let current = true;
    let resolveOpen!: (value: { pairing: true }) => void;
    const open = vi.fn(() => new Promise<{ pairing: true }>((resolve) => {
      resolveOpen = resolve;
    }));
    const close = vi.fn(async () => undefined);
    const result = keepPhonePairingIfCurrent(open, close, () => current);

    current = false;
    resolveOpen({ pairing: true });
    await expect(result).resolves.toBeNull();
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not overlap a slow poll with later timer ticks", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const poll = vi.fn(() => new Promise<void>((resolve) => {
        release = resolve;
      }));
      const stop = startNonOverlappingPhoneSetupPoll(poll, 1_000);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(poll).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(poll).toHaveBeenCalledTimes(1);

      release();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(poll).toHaveBeenCalledTimes(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
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

  it("rebases on historical devices when pairing opens and waits for a later device", () => {
    const preStart = phoneSetupReducer(initialPhoneSetupFlowState, {
      type: "start",
      deviceIds: [],
    });
    const historicalDevices = [
      { id: "old-1", name: "Old iPhone" },
      { id: "old-2", name: "Test iPhone" },
      { id: "old-3", name: "Previous iPhone" },
    ];

    expect(newlyPairedDeviceForFlow(preStart, historicalDevices)).toBeNull();

    const pairingOpen = phoneSetupReducer(preStart, {
      type: "pairing-opened",
      deviceIds: historicalDevices.map((device) => device.id),
    });
    expect(pairingOpen.pairingAttempted).toBe(true);
    expect(pairingOpen.baselineDeviceIds).toEqual(["old-1", "old-2", "old-3"]);
    expect(newlyPairedDeviceForFlow(pairingOpen, historicalDevices)).toBeNull();

    const newPhone = { id: "new-1", name: "Milind’s iPhone" };
    expect(newlyPairedDeviceForFlow(pairingOpen, [...historicalDevices, newPhone])).toBe(newPhone);

    const success = phoneSetupReducer(pairingOpen, {
      type: "paired",
      deviceName: newPhone.name,
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
