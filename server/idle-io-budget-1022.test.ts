// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.22 q1022-ordfiles (release gate 05c): a booted server with fake engines and
// real timers, left idle with no turns and no owner requests, writes under the
// idle budget once warm. The gate fails on ANY "[io-budget] writing ... (budget N)"
// line after a 5-minute warmup in a 30-minute idle window; this is that gate on
// the real server entry (server/index.ts), its real io-budget tick and meter.
//
// The child's raw write methods are traced (the counted-fs boundary takes its
// pristine methods from the shared raw-fs global), so a failing minute names the
// file and the stack that wrote it; the native meter's buckets moved each minute
// ([idle-meter]) name the database files written, by whoever.
//
// NOT a witness for the q1022-ordfiles fix (MAIN round 2): in this fixture (Linux, fake
// engines) it is GREEN on base d91ec92098 as on the fix, so it proves nothing about
// the fix. It is kept only as an opt-in diagnostic tracer for a later idle-writer hunt.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMurage } from "../scripts/control-murage.ts";

// A 30-minute gate: it runs only when asked (IDLE_IO_MINUTES=30), never inside a plain `vitest run`.
const IDLE_MINUTES = Number(process.env.IDLE_IO_MINUTES ?? 0);
const WARMUP_MINUTES = 5;

// Runs in the server's main thread before server/index.ts loads.
const TRACE = String.raw`
const __nfs = (await import("node:fs")).default, __fsp = (await import("node:fs/promises")).default;
const __raw = { ...__nfs }, __rawP = { ...__fsp }, __orig = { ...__nfs }, __open = __fsp.open;
const __agg = new Map();
const __file = fd => { try { return __nfs.fstatSync(fd).isFile(); } catch { return false; } };
const __where = fd => { try { return __nfs.readlinkSync("/proc/self/fd/" + fd).replace(process.env.MURAGE_DATA_DIR ?? "\0", "<data>"); } catch { return "fd"; } };
const __note = (where, n) => {
  if (!(n > 0)) return;
  const stack = (new Error().stack ?? "").split("\n").slice(3).map(s => s.trim().replace(/^at /, "")).filter(s => !/node:|idle-trace|counted-fs/.test(s)).slice(0, 4).join(" < ");
  const key = where.replace(/[0-9a-f]{8,}|\d{6,}/g, "#") + " | " + stack;
  __agg.set(key, (__agg.get(key) ?? 0) + n);
};
const __rec = (fd, n) => { if (n > 0 && __file(fd)) __note(__where(fd), n); };
__raw.writeSync = (...a) => { const n = __orig.writeSync(...a); __rec(a[0], n); return n; };
__raw.writevSync = (...a) => { const n = __orig.writevSync(...a); __rec(a[0], n); return n; };
__raw.write = (...a) => { const cb = a.pop(); return __orig.write(...a, (e, n, ...r) => { __rec(a[0], n); cb(e, n, ...r); }); };
__raw.writev = (...a) => { const cb = a.pop(); return __orig.writev(...a, (e, n, ...r) => { __rec(a[0], n); cb(e, n, ...r); }); };
__rawP.open = async (...a) => {
  const h = await __open(...a), path = String(a[0]).replace(process.env.MURAGE_DATA_DIR ?? "\0", "<data>");
  const write = h.write.bind(h), writev = h.writev.bind(h);
  h.write = async (...b) => { const r = await write(...b); __note(path, r.bytesWritten); return r; };
  h.writev = async (...b) => { const r = await writev(...b); __note(path, r.bytesWritten); return r; };
  return h;
};
globalThis[Symbol.for("murage.io.raw-fs")] = __raw;
globalThis[Symbol.for("murage.io.raw-fs-promises")] = __rawP;
const __meter = await import(new URL("server/io-meter.ts", "file://" + process.cwd() + "/").href);
const __prev = new Map();
setInterval(() => {
  try {
    const snap = __meter.ioMeterSnapshot(), moved = [];
    for (const [name, total] of snap?.buckets ?? []) { const d = total - (__prev.get(name) ?? 0); __prev.set(name, total); if (d > 0) moved.push([name.replace(process.env.MURAGE_DATA_DIR ?? "\0", "<data>"), d]); }
    if (moved.length) process.stderr.write("[idle-meter] " + JSON.stringify(moved) + " rusageFsWriteBytes=" + process.resourceUsage().fsWrite * 512 + "\n");
  } catch (e) { process.stderr.write("[idle-meter] unread " + e + "\n"); }
}, 60_000).unref();
setInterval(() => {
  const top = [...__agg].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const total = [...__agg.values()].reduce((s, n) => s + n, 0);
  __agg.clear();
  if (total) process.stderr.write("[idle-trace] total=" + total + " " + JSON.stringify(top) + "\n");
}, 60_000).unref();
`;

it.runIf(IDLE_MINUTES > 0)("an idle booted server writes under the idle budget after its warmup (no [io-budget] writing line)", async () => {
  const session = await launchVerificationServer(process.env, undefined, { instrumentationSource: TRACE });
  const env = { MURAGE_URL: session.info.url };
  const call = async (args: string[]) => await runControlMurage([...args, "--url", session.info.url], { env }) as any;
  // A used install, not an empty one: chats with turns (memory capture, recall views, session lineage) before the idle window.
  for (let b = 0; b < Number(process.env.IDLE_IO_BOTS ?? 4); b++) {
    const id = (await call(["new-bot", "--name", `Idle probe ${b}`])).bot.id;
    for (let t = 0; t < 3; t++) {
      await call(["send", "--bot", id, "--text", `Remember fixture fact ${b}-${t}: the blue kettle is on shelf ${t}.`]);
      expect((await call(["wait", "--bot", id, "--timeout", "60"])).status).toBe("settled");
    }
  }
  const started = Date.now();
  const seen: Array<{ at: number; line: string }> = [];
  let offset = 0;
  const scan = () => {
    const text = readFileSync(session.info.logPath, "utf8");
    for (const line of text.slice(offset).split("\n")) if (/\[io-budget\]|\[idle-trace\]|\[idle-meter\]/.test(line)) seen.push({ at: (Date.now() - started) / 60_000, line });
    offset = text.length;
  };
  try {
    for (let minute = 0; minute < IDLE_MINUTES; minute += 0.25) {
      await new Promise(resolve => setTimeout(resolve, 15_000));
      scan();
    }
  } finally {
    scan();
    for (const { at, line } of seen) console.log(`[t+${at.toFixed(2)}m] ${line.slice(0, 3000)}`);
    await session.close();
  }
  const overBudget = seen.filter(({ at, line }) => at > WARMUP_MINUTES && /\[io-budget\] writing .* MB\/min \(budget \d+/.test(line));
  expect(overBudget.map(({ at, line }) => `t+${at.toFixed(1)}m ${line.slice(0, 400)}`)).toEqual([]);
}, (IDLE_MINUTES + 8) * 60_000);
