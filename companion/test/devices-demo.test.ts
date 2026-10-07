// Demo pairing mode: a fixed reusable code, honoured only on a host that was
// deliberately marked as a demo host. Everything else must behave as before.
import { chmodSync, statSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../src/state.ts";
import {
  DEMO_BUDGET_FILE,
  DEMO_DAY_FAILURES,
  DEMO_HOUR_FAILURES,
  DEMO_HOST_MARKER,
  DEMO_IP_ATTEMPTS,
  DEMO_PAIRING_LOG,
  DeviceRegistry,
  MAX_DEMO_DEVICES,
  MAX_PAIRING_ATTEMPTS,
  demoCodeProblem,
} from "../src/devices.ts";

const CODE = "483920";

// Lets a test script the next random window codes; otherwise real randomness.
const forced = vi.hoisted(() => ({ ints: [] as number[] }));
vi.mock("node:crypto", async (orig) => {
  const real = await orig<typeof import("node:crypto")>();
  return { ...real, randomInt: ((...a: unknown[]) => (forced.ints.length ? forced.ints.shift() : (real.randomInt as (...x: unknown[]) => number)(...a))) as typeof real.randomInt };
});

function mark() {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, DEMO_HOST_MARKER), "demo\n", { mode: 0o600 });
}
function demoEnv(code: string | undefined = CODE, flag: string | undefined = "1") {
  if (code === undefined) vi.stubEnv("MURAGE_DEMO_PAIRING_CODE", undefined as unknown as string);
  else vi.stubEnv("MURAGE_DEMO_PAIRING_CODE", code);
  if (flag === undefined) vi.stubEnv("MURAGE_DEMO_HOST", undefined as unknown as string);
  else vi.stubEnv("MURAGE_DEMO_HOST", flag);
}
const redeem = (r: DeviceRegistry, code: string, ip = "10.0.0.1", name = "Reviewer iPhone") =>
  r.redeem(code, name, undefined, undefined, undefined, undefined, ip);

describe("demo pairing", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("does nothing with the code env var alone", () => {
    demoEnv(CODE, undefined);
    const r = new DeviceRegistry();
    expect("error" in redeem(r, CODE)).toBe(true);
  });

  it("does nothing with the env var and flag but no marker", () => {
    demoEnv();
    const r = new DeviceRegistry();
    expect("error" in redeem(r, CODE)).toBe(true);
  });

  it("does nothing with a marker that is readable by others", () => {
    demoEnv();
    mark();
    chmodSync(join(DATA_DIR, DEMO_HOST_MARKER), 0o644);
    const r = new DeviceRegistry();
    expect("error" in redeem(r, CODE)).toBe(true);
  });

  it("refuses a symlinked marker, even one pointing at a qualifying file", () => {
    demoEnv();
    mkdirSync(DATA_DIR, { recursive: true });
    const real = join(DATA_DIR, "real-marker");
    writeFileSync(real, "demo\n", { mode: 0o600 });
    symlinkSync(real, join(DATA_DIR, DEMO_HOST_MARKER));
    expect("error" in redeem(new DeviceRegistry(), CODE)).toBe(true);
  });

  it("refuses a marker whose mode is not exactly 0600", () => {
    demoEnv();
    for (const mode of [0o400, 0o700, 0o640]) {
      rmSync(join(DATA_DIR, DEMO_HOST_MARKER), { force: true });
      mark();
      chmodSync(join(DATA_DIR, DEMO_HOST_MARKER), mode);
      expect("error" in redeem(new DeviceRegistry(), CODE), mode.toString(8)).toBe(true);
    }
  });

  it("refuses a marker that is a directory", () => {
    demoEnv();
    mkdirSync(join(DATA_DIR, DEMO_HOST_MARKER), { recursive: true });
    expect("error" in redeem(new DeviceRegistry(), CODE)).toBe(true);
  });

  it("is never available on win32", () => {
    demoEnv();
    mark();
    const real = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      expect("error" in redeem(new DeviceRegistry(), CODE)).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: real });
    }
  });

  it("pairs, and can be reused, with all three in place; permissions match a normal pairing", () => {
    demoEnv();
    mark();
    const r = new DeviceRegistry();
    const a = redeem(r, CODE, "10.0.0.1", "A");
    const b = redeem(r, CODE, "10.0.0.1", "B");
    if ("error" in a || "error" in b) throw new Error("demo pairing failed");
    expect(r.authenticate(a.token)?.id).toBe(a.device.id);
    expect(r.authenticate(b.token)?.id).toBe(b.device.id);
    // no extra scope: same record shape as a normal pairing, plus the bookkeeping flag
    const normal = (() => {
      const { code } = r.openPairing();
      const n = r.redeem(code, "N");
      if ("error" in n) throw new Error(n.error);
      return n;
    })();
    const strip = (d: object) => {
      const { demo: _demo, id: _id, name: _n, createdAt: _c, lastSeenAt: _l, ...rest } = d as Record<string, unknown>;
      return rest;
    };
    expect(strip(a.device)).toEqual(strip(normal.device));
    expect(a.device.cloudDesktopAccess).toBe(false);
  });

  it("keeps the wrong-guess lockout on a live pairing window", () => {
    demoEnv();
    mark();
    const r = new DeviceRegistry();
    const { code } = r.openPairing();
    let last: unknown;
    // distinct IPs so only the window's own budget is in play
    for (let i = 0; i < MAX_PAIRING_ATTEMPTS; i++) last = redeem(r, "000001", `10.1.0.${i}`);
    expect((last as { reason: string }).reason).toBe("locked-out");
    expect("error" in redeem(r, code, "10.1.1.1")).toBe(true);
  });

  it("rate limits attempts per IP, and not other IPs", () => {
    demoEnv();
    mark();
    const r = new DeviceRegistry();
    for (let i = 0; i < DEMO_IP_ATTEMPTS; i++) expect((redeem(r, "111112", "9.9.9.9") as { reason: string }).reason).toBe("no-pairing");
    const limited = redeem(r, CODE, "9.9.9.9");
    expect((limited as { reason: string }).reason).toBe("rate-limited");
    expect("error" in redeem(r, CODE, "9.9.9.10")).toBe(false);
  });

  it("has a global failed-attempt budget across addresses, persisted, with normal pairing unaffected", () => {
    demoEnv();
    mark();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = new DeviceRegistry();
    for (let i = 0; i < DEMO_HOUR_FAILURES; i++) redeem(r, "111112", `10.5.${i}.1`);
    expect(warn.mock.calls.flat().join("\n")).toMatch(/budget exhausted/);
    expect(warn.mock.calls.flat().join("\n")).not.toContain(CODE);
    // a fresh address with the right code is refused while the budget is spent
    expect("error" in redeem(r, CODE, "10.6.0.1")).toBe(true);
    // normal pairing still works
    const { code } = r.openPairing();
    expect("error" in redeem(r, code, "10.6.0.2")).toBe(false);
    // owner-only file, and a restart does not reset it
    const file = join(DATA_DIR, DEMO_BUDGET_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const r2 = new DeviceRegistry();
    expect("error" in redeem(r2, CODE, "10.7.0.1")).toBe(true);
  });

  it("releases the hourly budget after an hour, and enforces the daily cap", () => {
    demoEnv();
    mark();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const r = new DeviceRegistry();
      let n = 0;
      // spend 20 now, then 20 each hour for two more hours: 60 in a day
      for (let h = 0; h < 3; h++) {
        for (let i = 0; i < DEMO_HOUR_FAILURES; i++) redeem(r, "111112", `10.8.${n++}.1`);
        expect("error" in redeem(r, CODE, "10.9.9.9")).toBe(true);
        vi.setSystemTime(new Date(Date.parse("2026-01-01T00:00:00Z") + (h + 1) * 61 * 60_000));
        if (h < 2) expect("error" in redeem(r, CODE, `10.9.${h}.1`)).toBe(false);
        if (h < 2) for (const d of r.list()) r.revoke(d.id);
      }
      // 60 failures inside 24h: hour window is clear but the day cap holds
      expect(DEMO_DAY_FAILURES).toBe(60);
      expect("error" in redeem(r, CODE, "10.9.9.8")).toBe(true);
      vi.setSystemTime(new Date("2026-01-02T01:00:00Z"));
      expect("error" in redeem(r, CODE, "10.9.9.7")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never opens a normal window with the demo code", () => {
    demoEnv();
    mark();
    const r = new DeviceRegistry();
    forced.ints.push(Number(CODE), Number(CODE), 777001);
    const w = r.openPairing();
    expect(w.code).toBe("777001");
    expect(forced.ints).toHaveLength(0);
  });

  it("never persists or lists a device name that contains the demo code", () => {
    demoEnv();
    mark();
    vi.spyOn(console, "info").mockImplementation(() => {});
    const r = new DeviceRegistry();
    const a = redeem(r, CODE, "10.3.0.1", `phone ${CODE}`);
    const b = redeem(r, CODE, "10.3.0.2", "phone 483-920");
    if ("error" in a || "error" in b) throw new Error("pairing failed");
    expect(a.device.name).toBe("Demo device");
    expect(b.device.name).toBe("Demo device");
    expect(JSON.stringify(r.list())).not.toContain(CODE);
    expect(readFileSync(join(DATA_DIR, "devices.json"), "utf8")).not.toContain(CODE);
  });

  it("removes every demo device at startup when demo mode is not active", () => {
    demoEnv();
    mark();
    vi.spyOn(console, "info").mockImplementation(() => {});
    const r = new DeviceRegistry();
    const keep = r.redeem(r.openPairing().code, "Normal");
    const a = redeem(r, CODE, "10.4.0.1", "A");
    const b = redeem(r, CODE, "10.4.0.2", "B");
    if ("error" in keep || "error" in a || "error" in b) throw new Error("pairing failed");
    // marker removed, restart
    rmSync(join(DATA_DIR, DEMO_HOST_MARKER));
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const removed: string[] = [];
    const r2 = new DeviceRegistry();
    r2.onDeviceRemoved((id) => removed.push(id));
    r2.announceStartupPurge();
    expect(r2.authenticate(a.token)).toBeNull();
    expect(r2.authenticate(b.token)).toBeNull();
    expect(r2.authenticate(keep.token)?.id).toBe(keep.device.id);
    expect(r2.list().some((d) => (d as { demo?: boolean }).demo)).toBe(false);
    expect(removed.sort()).toEqual([a.device.id, b.device.id].sort());
    expect(info.mock.calls.flat().join("\n")).toMatch(/removed 2 demo devices/);
    // and it is on disk, not just in memory
    expect(new DeviceRegistry().list().map((d) => d.id)).toEqual([keep.device.id]);
  });

  describe("budget state fails closed for demo only", () => {
    const budget = () => join(DATA_DIR, DEMO_BUDGET_FILE);
    const plant = (text: string) => {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(budget(), text, { mode: 0o600 });
    };
    const normalWorks = (r: DeviceRegistry) => "error" in r.redeem(r.openPairing().code, "N") === false;

    it("treats malformed state as exhausted, logs once, keeps normal pairing, and recovers on a valid file", () => {
      demoEnv();
      mark();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      plant("{not json");
      const r = new DeviceRegistry();
      expect("error" in redeem(r, CODE, "10.0.1.1")).toBe(true);
      expect("error" in redeem(r, CODE, "10.0.1.2")).toBe(true);
      expect(warn.mock.calls.filter((c) => /budget file/.test(String(c[0])))).toHaveLength(1);
      expect(normalWorks(r)).toBe(true);
      plant(JSON.stringify({ failures: [] }));
      expect("error" in redeem(r, CODE, "10.0.1.3")).toBe(false);
    });

    it("treats oversized state as exhausted", () => {
      demoEnv();
      mark();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      plant(JSON.stringify({ failures: [], pad: "x".repeat(70 * 1024) }));
      expect("error" in redeem(new DeviceRegistry(), CODE)).toBe(true);
    });

    it("treats a wrong-shaped document as exhausted", () => {
      demoEnv();
      mark();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      plant(JSON.stringify({ failures: "lots" }));
      expect("error" in redeem(new DeviceRegistry(), CODE)).toBe(true);
    });

    it("drops planted future timestamps so they cannot lock demo out", () => {
      demoEnv();
      mark();
      const far = Date.now() + 30 * 24 * 3600_000;
      plant(JSON.stringify({ failures: Array.from({ length: DEMO_DAY_FAILURES }, (_, i) => far + i) }));
      expect("error" in redeem(new DeviceRegistry(), CODE)).toBe(false);
    });

    it("drops timestamps older than a day", () => {
      demoEnv();
      mark();
      const old = Date.now() - 2 * 24 * 3600_000;
      plant(JSON.stringify({ failures: Array.from({ length: DEMO_DAY_FAILURES }, (_, i) => old + i) }));
      expect("error" in redeem(new DeviceRegistry(), CODE)).toBe(false);
    });

    it("refuses demo redemption when the budget cannot be saved", () => {
      demoEnv();
      mark();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const r = new DeviceRegistry();
      mkdirSync(budget()); // a directory where the file goes: every write fails
      redeem(r, "111112", "10.0.2.1"); // a failed attempt that cannot be recorded
      expect("error" in redeem(r, CODE, "10.0.2.2")).toBe(true);
      expect(normalWorks(r)).toBe(true);
    });
  });

  it("once the budget is spent the demo code never redeems and is judged like any wrong guess", () => {
    demoEnv();
    mark();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = new DeviceRegistry();
    for (let i = 0; i < DEMO_HOUR_FAILURES; i++) redeem(r, "111112", `10.11.${i}.1`);
    r.openPairing();
    for (let i = 0; i < MAX_PAIRING_ATTEMPTS; i++) {
      const res = redeem(r, CODE, `10.12.${i}.1`) as { reason: string };
      expect(res.reason).toBe(i === MAX_PAIRING_ATTEMPTS - 1 ? "locked-out" : "wrong");
    }
    expect(r.list()).toHaveLength(0);
  });

  it("purges and announces demo devices when the registry first loads later, after being unreadable", () => {
    demoEnv();
    mark();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = new DeviceRegistry();
    const keep = r.redeem(r.openPairing().code, "Normal");
    const demo = redeem(r, CODE, "10.14.0.1", "D");
    if ("error" in keep || "error" in demo) throw new Error("pairing failed");
    rmSync(join(DATA_DIR, DEMO_HOST_MARKER));
    const file = join(DATA_DIR, "devices.json");
    const original = readFileSync(file, "utf8");
    writeFileSync(file, "{ damaged", { mode: 0o600 });
    const r2 = new DeviceRegistry();
    expect(r2.registryStatus().available).toBe(false);
    const removed: string[] = [];
    r2.onDeviceRemoved((id) => removed.push(id));
    r2.announceStartupPurge();
    expect(removed).toEqual([]);
    writeFileSync(file, original, { mode: 0o600 });
    expect(r2.reload()).toBe(true);
    expect(r2.authenticate(demo.token)).toBeNull();
    expect(r2.authenticate(keep.token)?.id).toBe(keep.device.id);
    expect(removed).toEqual([demo.device.id]);
    expect(new DeviceRegistry().list().map((d) => d.id)).toEqual([keep.device.id]);
  });

  it("caps demo devices and frees a slot when one is removed", () => {
    demoEnv();
    mark();
    const r = new DeviceRegistry();
    const made = [];
    for (let i = 0; i < MAX_DEMO_DEVICES; i++) {
      const x = redeem(r, CODE, `10.2.0.${i}`, `D${i}`);
      if ("error" in x) throw new Error(x.error);
      made.push(x);
    }
    const over = redeem(r, CODE, "10.2.1.1");
    expect((over as { reason: string }).reason).toBe("demo-cap");
    r.revoke(made[0].device.id);
    expect("error" in redeem(r, CODE, "10.2.1.2")).toBe(false);
  });

  it("refuses trivial or malformed codes", () => {
    for (const bad of ["000000", "123456", "654321", "111111", "121212", "123123", "12345", "1234567", "abcdef", "12 456"]) {
      expect(demoCodeProblem(bad), bad).not.toBeNull();
    }
    expect(demoCodeProblem(CODE)).toBeNull();
    mark();
    demoEnv("123456");
    expect(() => new DeviceRegistry()).toThrow(/demo pairing refused/);
  });

  it("logs each redemption without the code", () => {
    demoEnv();
    mark();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const r = new DeviceRegistry();
    redeem(r, CODE, "203.0.113.7", "Reviewer iPhone");
    redeem(r, CODE, "203.0.113.7", `typed ${CODE} by mistake`);
    const file = readFileSync(join(DATA_DIR, DEMO_PAIRING_LOG), "utf8");
    const lines = file.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(file).not.toContain(CODE);
    expect(file).not.toContain("203.0.113.7");
    expect(JSON.parse(lines[0])).toMatchObject({ device: "Reviewer iPhone" });
    expect(info.mock.calls.flat().join("\n")).not.toContain(CODE);
    expect(existsSync(join(DATA_DIR, DEMO_PAIRING_LOG))).toBe(true);
  });
});
