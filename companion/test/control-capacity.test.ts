// The computer's half of a full fleet. A phone told "too many devices" can
// do nothing about it; the pairing screen on the computer has to offer the
// fix, in the order that makes the right choice obvious.
import { rmSync } from "node:fs";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createControlServer } from "../src/control.ts";
import { DeviceRegistry, MAX_DEVICES } from "../src/devices.ts";
import { DATA_DIR } from "../src/state.ts";

let control: Server;
let port = 0;
let devices: DeviceRegistry;

const ask = async (method: string, path: string): Promise<{ status: number; body: any }> => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
};

beforeAll(async () => {
  control = createControlServer({
    get devices() {
      return devices;
    },
    companionPort: 8810,
    discovery: () => ({ advertising: false, name: "Test computer" }),
  } as Parameters<typeof createControlServer>[0]);
  port = await new Promise<number>((resolve) =>
    control.listen(0, "127.0.0.1", () => resolve((control.address() as { port: number }).port)),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => control.close(() => resolve()));
});

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  devices = new DeviceRegistry();
});

const fill = () => {
  const start = Date.now();
  try {
    for (let i = 0; i < MAX_DEVICES; i += 1) {
      vi.setSystemTime(start + i * 60_000);
      const result = devices.redeem(devices.openPairing().code, `Phone ${i}`);
      if ("error" in result) throw new Error(result.error);
    }
  } finally {
    vi.useRealTimers();
  }
};

describe("replacing an old device from the pairing screen", () => {
  it("reports the cap, and no candidates while there is room", async () => {
    const { body } = await ask("GET", "/state");
    expect(body.maxDevices).toBe(MAX_DEVICES);
    expect(body.replaceCandidates).toEqual([]);
  });

  it("lists every device least recently seen first once full, and replacing one lets the same code in", async () => {
    fill();
    const opened = await ask("POST", "/pairing");
    expect(opened.body.replaceCandidates.map((d: { name: string }) => d.name)).toEqual(
      Array.from({ length: MAX_DEVICES }, (_, i) => `Phone ${i}`),
    );
    expect(opened.body.replaceCandidates[0]).not.toHaveProperty("tokenHash");

    const oldest = opened.body.replaceCandidates[0].id;
    const after = await ask("DELETE", `/devices/${oldest}`);
    expect(after.status).toBe(200);
    expect(after.body.replaceCandidates).toEqual([]);
    expect(devices.redeem(opened.body.code, "New phone")).toHaveProperty("token");
  });

  it("puts the replace list on the page, wired to the same revoke", async () => {
    const page = await ask("GET", "/");
    expect(page.body).toContain("Replace an old device");
    expect(page.body).toContain("data-replace");
    expect(page.body).toContain('"/devices/" + b.dataset.replace, "DELETE"');
  });
});
