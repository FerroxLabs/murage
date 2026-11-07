import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { kimiSignedIn } from "./kimi.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) };
});
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.lstat).mockReset();
  vi.mocked(fs.open).mockReset();
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.lstat).mockImplementation(actual.lstat);
  vi.mocked(fs.open).mockImplementation(actual.open);
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "kimi-f30-"));
  roots.push(root);
  const dir = join(root, "credentials");
  await fs.mkdir(dir);
  const path = join(dir, "kimi-code.json");
  await fs.writeFile(path, '{"access_token":"fixture"}');
  return { root, dir, path };
}
it.each(["lstat", "open", "stat", "recheck", "read"])("F30-M1: candidate %s EIO is uncertain", async (site) => {
  const { root, dir, path } = await fixture();
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  const eio = () => { throw Object.assign(new Error("fixture EIO"), { code: "EIO" }); };
  let opened = false;
  let hit = false;
  vi.mocked(fs.lstat).mockImplementation(async (...args) => {
    if ((site === "lstat" && args[0] === path) || (site === "recheck" && opened && args[0] === dir)) { hit = true; return eio(); }
    return actual.lstat(...args);
  });
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    if (args[0] === path && site === "open") { hit = true; return eio(); }
    const handle = await actual.open(...args);
    if (args[0] === path) {
      opened = true;
      if (site === "stat" || site === "read") vi.spyOn(handle, site).mockImplementation(async () => { hit = true; return eio(); });
    }
    return handle;
  });
  expect(await kimiSignedIn({ KIMI_CODE_HOME: root })).toBeUndefined();
  expect(hit).toBe(true);
});
it("F30-M2: deadline after candidate open closes every opened handle", async () => {
  const { root, path } = await fixture();
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  let opens = 0, closes = 0, candidate = false;
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    opens++;
    if (args[0] === path) candidate = true;
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => { closes++; await close(); });
    return handle;
  });
  let settled!: () => void;
  const done = new Promise<void>(resolve => { settled = resolve; });
  let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  let reached!: () => void;
  const opened = new Promise<void>(resolve => { reached = resolve; });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const answer = kimiSignedIn({ KIMI_CODE_HOME: root }, { deadlineMs: 2000, settled, pause: async () => {
      if (candidate) { reached(); await paused; }
    } });
    expect(kimiSignedIn({ KIMI_CODE_HOME: root })).toBe(answer);
    await opened;
    await vi.advanceTimersByTimeAsync(2000);
    expect(await answer).toBeUndefined();
    release();
    await done;
    expect(opens).toBeGreaterThan(0);
    expect(closes).toBe(opens);
    expect(await kimiSignedIn({ KIMI_CODE_HOME: root })).toBe(true);
  } finally { release(); vi.useRealTimers(); }
});
it("F30-L2: a throwing settled observer cannot reject the scan", async () => {
  const { root } = await fixture();
  const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
  expect(await kimiSignedIn({ KIMI_CODE_HOME: root }, { settled: () => { throw new Error("private observer detail"); } })).toBe(true);
  await new Promise(resolve => setImmediate(resolve));
  expect(debug).toHaveBeenCalledWith("[kimi] sign-in scan settled callback failed");
});
it("an operational failure after a held candidate still makes the scan uncertain", async () => {
  const { root, dir } = await fixture();
  const later = join(dir, "kimi-code-env-0123456789abcdef.json");
  await fs.writeFile(later, '{}');
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    if (args[0] === later) throw Object.assign(new Error("fixture EIO"), { code: "EIO" });
    return actual.open(...args);
  });
  expect(await kimiSignedIn({ KIMI_CODE_HOME: root })).toBeUndefined();
});

it.each([{}, { access_token: null }, { access_token: "" }, { access_token: "  " },
  { access_token: 123, refresh_token: false }])("requires a nonblank string token: %j", async (body) => {
  const { root, path } = await fixture();
  await fs.writeFile(path, JSON.stringify(body));
  expect(await kimiSignedIn({ KIMI_CODE_HOME: root })).toBeUndefined();
});
it.each([{ refresh_token: "refresh-fixture" }, { access_token: "access-fixture" }])("accepts a usable token: %j", async (body) => {
  const { root, path } = await fixture();
  await fs.writeFile(path, JSON.stringify(body));
  expect(await kimiSignedIn({ KIMI_CODE_HOME: root })).toBe(true);
});
it.each([1, 2])("folder removal or replacement at boundary %s is uncertain", async (boundary) => {
  for (const replacement of [false, true]) {
    const { root, dir } = await fixture();
    let steps = 0;
    expect(await kimiSignedIn({ KIMI_CODE_HOME: root }, { pause: async () => {
      if (++steps === boundary) {
        await fs.rm(dir, { recursive: true });
        if (replacement) await fs.writeFile(dir, "replacement");
      }
    } })).toBeUndefined();
    expect(steps).toBe(boundary);
  }
});

it("rejects parent substitution AFTER candidate lstat, restored before folder recheck", async () => {
  const { root, dir, path } = await fixture();
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  const outside = join(root, "outside");
  const saved = join(root, "credentials-saved");
  await fs.mkdir(outside);
  await fs.writeFile(join(outside, "kimi-code.json"), '{"access_token":"outside-fixture"}');
  let read: ReturnType<typeof vi.spyOn> | undefined;
  let swapped = false;
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    if (args[0] !== path) return actual.open(...args);
    await fs.rename(dir, saved);
    await fs.symlink(outside, dir, process.platform === "win32" ? "junction" : "dir");
    try {
      const handle = await actual.open(...args);
      read = vi.spyOn(handle, "read");
      swapped = true;
      return handle;
    } finally {
      await fs.unlink(dir);
      await fs.rename(saved, dir);
    }
  });
  expect(await kimiSignedIn({ KIMI_CODE_HOME: root })).toBeUndefined();
  expect(swapped).toBe(true);
  expect(read).not.toHaveBeenCalled();
});

// Characterization guard: this intentionally passes before L9. Parent reads
// are not confined; only a coarse readiness answer escapes the scanner.
it.each([false, true])("L9 B2/G1: early parent swap reads outside; malformed=%s", async (malformed) => {
  const { root, dir, path } = await fixture();
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  await fs.writeFile(path, '{"access_token":"","refresh_token":""}');
  expect(await kimiSignedIn({ KIMI_CODE_HOME: root })).toBe(false);
  const access = "L9_ACCESS_SENTINEL", refresh = "L9_REFRESH_SENTINEL";
  const body = JSON.stringify({ access_token: access, refresh_token: refresh, padding: "x".repeat(1739) }) + (malformed ? "BROKEN" : "");
  const outside = join(root, "outside"), saved = join(root, "saved");
  await fs.mkdir(outside);
  await fs.writeFile(join(outside, "kimi-code.json"), body);
  const logs = ["debug", "info", "log", "warn", "error"].map(name => vi.spyOn(console, name as "debug").mockImplementation(() => {}));
  let swapped = false, restored = false, reads = "", closes = 0;
  vi.mocked(fs.lstat).mockImplementation(async (...args) => {
    if (args[0] === path && !swapped) {
      await fs.rename(dir, saved);
      await fs.symlink(outside, dir, process.platform === "win32" ? "junction" : "dir");
      swapped = true;
    }
    return actual.lstat(...args);
  });
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    if (args[0] === path) {
      expect(swapped).toBe(true);
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation((async (...params: Parameters<typeof read>) => {
        const result = await read(...params);
        reads += Buffer.from(result.buffer.buffer, result.buffer.byteOffset, result.bytesRead).toString();
        return result;
      }) as typeof handle.read);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => { closes++; await close(); });
      await fs.unlink(dir); await fs.rename(saved, dir); restored = true;
    }
    return handle;
  });
  try {
    const answer = await kimiSignedIn({ KIMI_CODE_HOME: root });
    expect(answer).toBe(malformed ? false : true);
    expect(reads).toBe(body);
    expect(restored).toBe(true);
    expect(closes).toBe(1);
    const exposed = JSON.stringify({ answer, logs: logs.flatMap(log => log.mock.calls) });
    for (const secret of [access, refresh, body, String(Buffer.byteLength(body))]) expect(exposed).not.toContain(secret);
  } finally {
    if (swapped && !restored) { await fs.unlink(dir); await fs.rename(saved, dir); }
  }
});
