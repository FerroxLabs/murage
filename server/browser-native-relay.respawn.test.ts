// MACMOUNTS-1020: the server's own browser engine client (createNativeBrowser -> startHeadlessEngine)
// cached its engine process for the life of the app. Once that process ended (idle exit, crash, a failed
// initialize), every later tools/list was refused at once, the route answered an uncoded 500, and the
// mount proxy sealed the whole turn about a second after dispatch with nothing in the server log.
// These witnesses drive the real relay against a real child process that behaves like the engine.
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeBrowser } from "./browser-native-relay.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A stdio MCP engine. Launch N (1-based, counted in a file) follows `plan[N-1]`:
 * "ok" answers everything; "exit-after-list" answers tools/list then exits; "die-on-list" / "die-on-call" exit on
 * that method without answering; "die-at-start" exits before answering initialize. */
function engine(plan: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "macmounts-engine-")); dirs.push(dir);
  const counter = join(dir, "launches"), script = join(dir, "engine.mjs");
  writeFileSync(script, `
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const counter = ${JSON.stringify(counter)};
const n = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;
writeFileSync(counter, String(n));
const mode = ${JSON.stringify(plan)}[n - 1] ?? "ok";
if (mode === "die-at-start") process.exit(3);
let buf = "";
process.stdin.on("data", chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (msg.id === undefined) continue;
    if (msg.method === "tools/list" && mode === "die-on-list") process.exit(4);
    if (msg.method === "tools/call" && mode === "die-on-call") process.exit(5);
    const result = msg.method === "tools/list" ? { tools: [{ name: "agent_browser_snapshot", inputSchema: { type: "object" } }] } : {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n", () => {
      if (msg.method === "tools/list" && mode === "exit-after-list") process.exit(0);
    });
  }
});
`);
  const native = createNativeBrowser({ command: process.execPath, args: [script], env: { PATH: process.env.PATH ?? "", AGENT_BROWSER_SOCKET_DIR: dir, AGENT_BROWSER_SESSION: "witness" } });
  const launches = () => existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  return { native, launches };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 300));
const listed = (reply: unknown) => (reply as { tools?: Array<{ name: string }> }).tools?.map(t => t.name);

it("MACMOUNTS-RESPAWN: an engine process that ended after a turn is replaced on the next tools/list", async () => {
  const { native, launches } = engine(["exit-after-list", "ok"]);
  expect(listed(await native.request("tools/list"))).toEqual(["agent_browser_snapshot"]);
  await settle(); // the first engine has exited
  expect(listed(await native.request("tools/list"))).toEqual(["agent_browser_snapshot"]);
  expect(launches()).toBe(2);
}, 20_000);

it("MACMOUNTS-RESPAWN: a tool call after the engine process ended starts a fresh engine instead of refusing at once", async () => {
  const { native, launches } = engine(["exit-after-list", "ok"]);
  expect(listed(await native.request("tools/list"))).toEqual(["agent_browser_snapshot"]);
  await settle(); // the first engine has exited between two steps of a turn
  await expect(native.request("tools/call", { name: "agent_browser_snapshot", arguments: {} })).resolves.toEqual({});
  expect(launches()).toBe(2);
}, 20_000);

it("MACMOUNTS-RESPAWN: an engine that dies under tools/list is replaced once and asked again", async () => {
  const { native, launches } = engine(["die-on-list", "ok"]);
  expect(listed(await native.request("tools/list"))).toEqual(["agent_browser_snapshot"]);
  expect(launches()).toBe(2);
}, 20_000);

it("MACMOUNTS-RESPAWN: a failed engine start is not cached for the life of the app", async () => {
  const { native, launches } = engine(["die-at-start", "ok"]);
  await expect(native.request("tools/list")).rejects.toThrow();
  await settle();
  expect(listed(await native.request("tools/list"))).toEqual(["agent_browser_snapshot"]);
  expect(launches()).toBe(2);
}, 20_000);

it("MACMOUNTS-RESPAWN: a tool call whose engine died is never replayed on a fresh engine (only the read-only listing is)", async () => {
  const { native, launches } = engine(["die-on-call", "ok"]);
  expect(listed(await native.request("tools/list"))).toEqual(["agent_browser_snapshot"]);
  await expect(native.request("tools/call", { name: "agent_browser_snapshot", arguments: {} })).rejects.toThrow();
  expect(launches()).toBe(1);
}, 20_000);
