// The Tailscale account on the computer's own pairing screen.
//
// The phone has to sign in to the same Tailscale account as the computer, and
// the only place that can say which account that is, is the computer. The
// sidecar reads it from `tailscale status --json` (see listener.test.ts) and
// hands it to the desktop panel in its state. Absent, not empty, when unknown.
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

let stdout = "";
vi.mock("node:child_process", () => ({
  execFile: (
    _cli: string,
    _args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    if (stdout) callback(null, stdout, "");
    else callback(new Error("not running"), "", "");
  },
}));

const { companionState } = await import("../src/control.ts");
const { refreshTailnetName } = await import("../src/listener.ts");
const { DeviceRegistry } = await import("../src/devices.ts");
const { DATA_DIR } = await import("../src/state.ts");

const options = () =>
  ({
    devices: new DeviceRegistry(),
    companionPort: 8810,
    discovery: () => ({ advertising: false, name: "Test computer" }),
  }) as Parameters<typeof companionState>[0];

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("the computer's Tailscale account in the panel's state", () => {
  it("carries the login when Tailscale names one", async () => {
    stdout = JSON.stringify({
      Self: { DNSName: "macbook.tail1234.ts.net.", TailscaleIPs: ["100.64.0.10"], UserID: 12345 },
      User: { "12345": { LoginName: "sean@example.com" } },
    });
    await refreshTailnetName();
    expect(companionState(options()).tailnetLogin).toBe("sean@example.com");
  });

  it("leaves the field out when the login cannot be read", async () => {
    stdout = "";
    await refreshTailnetName();
    expect(companionState(options())).not.toHaveProperty("tailnetLogin");
  });
});
