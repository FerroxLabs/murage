import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { setPlatformProcessHooks } from "../platform-process-hooks.ts";
import { baselineFromListing, descendantBaseline, descendantIdentities, descendantPids, isBrowserPath, parseEtime, settleArgsProbe, untrackedDescendants, untrackedIdentified, walk, type ExemptLayout } from "./process-tree.ts";

// A stand-in CLI: starts a long-lived "server" child at once, then on a line
// of stdin the server starts its own child (an npx wrapper's real server) and
// the CLI starts a new child of its own (a tool's leftover shell).
const SCRIPT = `
const { spawn } = require("node:child_process");
const keep = (args) => spawn(process.execPath, args, { stdio: ["pipe", "ignore", "ignore"] });
const server = spawn(process.execPath, ["-e", "process.stdin.once('data', () => { require('node:child_process').spawn(process.env.GRAND_BIN, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); process.stdout.write('ok\\\\n'); }); setTimeout(() => {}, 60000);"], { stdio: ["pipe", "pipe", "ignore"] });
process.stdin.once("data", () => {
  server.stdout.once("data", () => { keep(["-e", "setTimeout(() => {}, 60000)"]); process.stdout.write("grown\\n"); });
  server.stdin.write("go\\n");
});
process.stdout.write("ready\\n");
setTimeout(() => {}, 60000);
`;

let cli: ChildProcess | null = null;
let scratch: string | null = null;
afterEach(async () => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
  if (!cli?.pid) return;
  const all = (await descendantPids(cli.pid)) ?? new Set<number>();
  for (const pid of all) try { process.kill(pid, "SIGKILL"); } catch {}
  cli.kill("SIGKILL");
  cli = null;
});

const line = (child: ChildProcess, text: string) => new Promise<void>((resolve) => {
  let buffer = "";
  child.stdout!.on("data", (chunk) => { buffer += chunk; if (buffer.includes(text)) resolve(); });
});

/** A node binary under another executable name, so `ps` reports that name. */
const namedNode = (name: string) => {
  scratch = mkdtempSync(join(tmpdir(), "murage-ptree-"));
  const path = join(scratch, name);
  symlinkSync(process.execPath, path);
  return path;
};

const start = async (grandBin: string) => {
  cli = spawn(process.execPath, ["-e", SCRIPT], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, GRAND_BIN: grandBin } });
  await line(cli, "ready");
  const baseline = (await descendantPids(cli.pid!))!;
  expect(baseline.size).toBe(1);
  expect(await untrackedDescendants(cli.pid!, baseline)).toEqual(new Set());
  const grown = line(cli, "grown");
  cli.stdin!.write("go\n");
  await grown;
  return baseline;
};

describe.skipIf(process.platform === "win32")("untrackedDescendants", () => {
  it("reports a node renamed or symlinked as chrome outside every browser root", async () => {
    const baseline = await start(namedNode("chrome"));
    const fresh = (await untrackedDescendants(cli!.pid!, baseline))!;
    // the CLI's own new child AND the worker named like a browser
    expect(fresh.size).toBe(2);
    for (const pid of fresh) expect(baseline.has(pid)).toBe(false);
  }, 20_000);

  it("reports a non-browser grandchild under a baseline process as leftover work", async () => {
    const baseline = await start(process.execPath);
    const fresh = (await untrackedDescendants(cli!.pid!, baseline))!;
    // the CLI's own new child AND the worker the baseline server left running
    expect(fresh.size).toBe(2);
    for (const pid of fresh) expect(baseline.has(pid)).toBe(false);
  }, 20_000);

  it("descendantBaseline (real ps) sees the same tree as the async probe when init is later", async () => {
    await start(process.execPath);
    const baseline = await descendantBaseline(cli!.pid!, Date.now() + 2_000);
    expect(baseline).toEqual(await descendantPids(cli!.pid!));
  }, 60_000);

  it("descendantBaseline (real ps) leaves out processes started after init", async () => {
    await start(process.execPath);
    // init long ago: nothing the stand-in started can be in the baseline
    expect(await descendantBaseline(cli!.pid!, Date.now() - 3_600_000)).toEqual(new Set());
  }, 60_000);
});

describe("walk with exact exempt layouts", () => {
  const layout: ExemptLayout = { applications: "/Applications", home: "/Users/x", murageBundle: "/Applications/Murage.app", realpath: (p) => p };
  // pid 1 is the CLI, pid 2 a baseline MCP server, 3 its child under test
  const found = (comm: string, l: ExemptLayout = layout) =>
    walk(`1 0 cli\n2 1 mcp\n3 2 ${comm}\n`, 1, new Set([2]), l)!.found;
  const MURAGE = "/Applications/Murage.app/Contents/Frameworks";

  it.each([
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/130.0.1/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)",
    "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/130.0.1/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper",
    "/Applications/Firefox.app/Contents/MacOS/firefox",
    "/Users/x/Library/Caches/ms-playwright/chromium-1140/chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    "/Users/x/Library/Caches/ms-playwright/chromium-1140/chrome-mac-arm64/Chromium.app/Contents/Frameworks/Chromium Framework.framework/Versions/130.0.1/Helpers/Chromium Helper (GPU).app/Contents/MacOS/Chromium Helper (GPU)",
    "/Users/x/Library/Caches/ms-playwright/chromium_headless_shell-1140/chrome-mac/chrome-headless-shell",
    // Playwright 1.57+: Chrome for Testing in chromium-<rev>, headless shell per arch
    "/Users/x/Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Users/x/Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/143.0.1/Helpers/Google Chrome for Testing Helper (Renderer).app/Contents/MacOS/Google Chrome for Testing Helper (Renderer)",
    "/Users/x/Library/Caches/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-mac-arm64/chrome-headless-shell",
    "/Users/x/Library/Caches/ms-playwright/firefox-1465/firefox/Nightly.app/Contents/MacOS/firefox",
    "/Users/x/.cache/puppeteer/chrome/mac_arm-130.0.1/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Users/x/.cache/chrome-devtools-mcp/chrome/mac_arm-130.0.1/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    `${MURAGE}/Murage Helper.app/Contents/MacOS/Murage Helper`,
    `${MURAGE}/Murage Helper (Renderer).app/Contents/MacOS/Murage Helper (Renderer)`,
    `${MURAGE}/Murage Helper (GPU).app/Contents/MacOS/Murage Helper (GPU)`,
  ])("exempts the exact executable %s", (comm) => expect(found(comm)).toEqual(new Set()));

  it.each([
    `${MURAGE}/Murage Helper-evil`,
    `${MURAGE}/Murage Helper (Renderer).app/Contents/MacOS/Murage Helper (GPU)`,
    "/tmp/x/Murage.app/Contents/Frameworks/Murage Helper.app/Contents/MacOS/Murage Helper",
    "/Users/x/Library/Caches/ms-playwright/evil/payload",
    "/Users/x/Library/Caches/ms-playwright/chromium-1140/chrome-mac/payload",
    "/Users/x/Library/Caches/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-mac-payload/chrome-headless-shell",
    "/Users/x/Library/Caches/ms-playwright/chromium-1200/chrome-mac-evil/Chromium.app/Contents/MacOS/Chromium",
    "/Users/x/Library/Caches/ms-playwright/chromium-1140/chrome-mac/Chromium.app/Contents/MacOS/payload",
    "/Users/x/.cache/puppeteer/anything",
    "/Applications/Google Chrome.app/Contents/MacOS/payload",
    "/Applications/Google Chrome.app/Contents/Resources/helper",
    "/Applications/Firefox.app/Contents/MacOS/evil",
  ])("reports %s", (comm) => expect(found(comm)).toEqual(new Set([3])));

  it("exempts no Murage helper when not running from an app bundle", () => {
    expect(found(`${MURAGE}/Murage Helper.app/Contents/MacOS/Murage Helper`, { ...layout, murageBundle: null })).toEqual(new Set([3]));
  });

  it("reports a candidate whose realpath fails", () => {
    expect(found("/Users/x/Library/Caches/ms-playwright/chromium-1140/chrome-mac/Chromium.app/Contents/MacOS/Chromium", { ...layout, realpath: undefined })).toEqual(new Set([3]));
  });

  it("matches the exact layouts under test-injected roots on disk", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "murage-layout-")));
    try {
      const exe = join(root, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
      mkdirSync(dirname(exe), { recursive: true });
      writeFileSync(exe, "");
      const injected: ExemptLayout = { applications: join(root, "Applications"), home: join(root, "home"), murageBundle: null };
      expect(found(exe, injected)).toEqual(new Set());
      expect(found(join(root, "Applications/Google Chrome.app/Contents/MacOS/other"), injected)).toEqual(new Set([3]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("parseEtime", () => {
  it.each([
    ["00:05", 5], ["12:34", 754], ["01:02:03", 3723], ["1-00:00:00", 86400], ["2-03:04:05", 183845], ["  7:09", 429],
  ])("parses %s", (text, seconds) => expect(parseEtime(text)).toBe(seconds));
  it.each(["", "abc", "5", "1-2", "1:2:3:4"])("rejects %j", (text) => expect(parseEtime(text)).toBeNull());
});

describe("baselineFromListing", () => {
  const INIT_AT = 1_000_000_000_000;
  it("keeps what started by init and drops what started after it", () => {
    const listing = [
      "    1     0       02:00 cli",
      "    2     1       01:40 mcp server",
      "    3     2       01:40 worker",
      "    4     1       00:00 sleep",
      "garbage line",
    ].join("\n");
    // probe 5 s after init: pid 4 (etime 0) started after init, the rest before
    expect(baselineFromListing(listing, 1, INIT_AT + 5_000, INIT_AT)).toEqual(new Set([2, 3]));
  });

  it("a late probe cannot admit a late process: the listing's etimes place it after init", () => {
    // probe 10 minutes after init; mcp up 10:05 (before init), sleep up 00:30 (after)
    const late = baselineFromListing("1 0 12:00 cli\n2 1 10:05 mcp\n4 1 00:30 sleep\n", 1, INIT_AT + 600_000, INIT_AT);
    expect(late).toEqual(new Set([2]));
  });

  it("compares in whole seconds and leaves out init's own second (recycle, never admit)", () => {
    const at = INIT_AT + 3_000;
    expect(baselineFromListing("1 0 01:00 cli\n2 1 00:03 same-second\n3 1 00:02 later\n4 1 00:04 before\n", 1, at, INIT_AT)).toEqual(new Set([4]));
  });

  it("re-review repro: a child started 1.5 s after init, listed at 2.5 s, stays out of the baseline", () => {
    // ps reports etime 00:01 (floored); the probe time is taken after ps answered (2.6 s)
    expect(baselineFromListing("1 0 01:00 cli\n2 1 00:30 mcp\n5 1 00:01 tool-child\n", 1, INIT_AT + 2_600, INIT_AT)).toEqual(new Set([2]));
  });

  it("reads hh:mm:ss and dd-hh:mm:ss etimes and keeps spaces in comm", () => {
    const out = baselineFromListing("1 0 1-00:00:00 cli\n2 1 01:00:00 a b c\n3 2 00:00:00 child\n", 1, INIT_AT + 1_000, INIT_AT);
    expect(out).toEqual(new Set([2]));
  });
});

describe("isBrowserPath", () => {
  const layout: ExemptLayout = { applications: "/Applications", home: "/Users/x", murageBundle: null, realpath: (p) => p };
  it.each([
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Users/x/Library/Caches/ms-playwright/chromium-1/chrome-mac/Chromium.app/Contents/MacOS/Chromium",
  ])("accepts %s", (path) => expect(isBrowserPath(path, layout)).toBe(true));
  it.each([
    "chrome", "Chromium", "/tmp/evil/chrome", "/usr/local/bin/node", "/Applications/Google Chrome.app/../../tmp/x", "/Applications/Google Chrome.application/x", "",
  ])("rejects %s", (path) => expect(isBrowserPath(path, layout)).toBe(false));
  it.skipIf(process.platform !== "darwin")("accepts nothing by default when the path does not exist, and no Murage helper outside a bundle", () => {
    expect(isBrowserPath("/Applications/Murage.app/Contents/Frameworks/Murage Helper (GPU).app/Contents/MacOS/Murage Helper (GPU)")).toBe(false);
    expect(isBrowserPath("/tmp/Evil/chrome")).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("descendantBaseline under a platform listTree hook", () => {
  afterEach(() => setPlatformProcessHooks({}));

  it("applies the started-after-init rule to the hook's pids; a pid whose start cannot be read is not baseline", async () => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      await new Promise((resolve) => child.once("spawn", resolve));
      const root = 4242;
      // a pid in range that no process holds (ps refuses an out-of-range one outright)
      let dead = 90_000;
      while (dead > 1_000) { try { process.kill(dead, 0); dead -= 1; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") break; dead -= 1; } }
      setPlatformProcessHooks({ listTree: async () => [root, child.pid!, dead] });
      // init long ago: the child started after it, however late the hook answered
      expect(await descendantBaseline(root, Date.now() - 3_600_000)).toEqual(new Set());
      // init later: the live child is baseline; the pid that does not exist is not
      expect(await descendantBaseline(root, Date.now() + 2_000)).toEqual(new Set([child.pid]));
    } finally {
      child.kill("SIGKILL");
    }
  }, 20_000);
});

describe("settleArgsProbe", () => {
  const LINE = "123 1 Wed Oct  7 10:00:00 2026 sleep 300\n";

  it("a probe that timed out or was killed is unknown, whatever it printed first", () => {
    expect(settleArgsProbe({ killed: true, signal: "SIGKILL", code: null }, LINE, [123, 456], () => true)).toBeNull();
    expect(settleArgsProbe({ code: 2 }, LINE, [123, 456], () => true)).toBeNull();
    expect(settleArgsProbe({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, LINE, [123], () => true)).toBeNull();
  });

  it("on a clean some-pids-gone answer, each missing pid must be confirmed gone", () => {
    const done = settleArgsProbe({ code: 1 }, LINE, [123, 456], (pid) => pid === 456)!;
    expect([...done.keys()]).toEqual([123]);
    expect(done.get(123)).toEqual({ ppid: 1, start: "Wed Oct 7 10:00:00 2026", args: "sleep 300" });
    // still there although ps left it out: unknown, never "exited"
    expect(settleArgsProbe({ code: 1 }, LINE, [123, 456], () => false)).toBeNull();
    expect(settleArgsProbe(null, LINE, [123], () => false)?.has(123)).toBe(true);
    // macOS ps exits 0 with pids missing: the same rule applies
    expect(settleArgsProbe(null, LINE, [123, 456], () => false)).toBeNull();
    expect(settleArgsProbe(null, LINE, [123, 456], () => true)?.has(456)).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("untrackedIdentified", () => {
  it("an exempt entry must match pid AND start time: a recycled pid is new work, and a dead entry is not kept", async () => {
    cli = spawn("sh", ["-c", "sleep 30 & echo $!; wait"], { stdio: ["ignore", "pipe", "ignore"] });
    const sleeper = await new Promise<number>((resolve) => cli!.stdout!.once("data", (chunk) => resolve(Number(String(chunk).trim()))));
    const ids = (await descendantIdentities(cli.pid!))!;
    expect(ids.has(sleeper)).toBe(true);
    // the real identities: nothing new, the live entry confirmed
    const same = (await untrackedIdentified(cli.pid!, ids))!;
    expect(same.fresh.size).toBe(0);
    expect(same.alive).toEqual(ids);
    // the same pid recorded with another start time (a recycled pid) and a
    // pid that has exited: the live process is reported, nothing is kept
    const LONG_AGO = "Mon Jan 1 00:00:00 2001";
    const forged = (await untrackedIdentified(cli.pid!, new Map([[sleeper, LONG_AGO], [999_999, LONG_AGO]])))!;
    expect(forged.fresh.has(sleeper)).toBe(true);
    expect(forged.alive.size).toBe(0);
  }, 20_000);
});
