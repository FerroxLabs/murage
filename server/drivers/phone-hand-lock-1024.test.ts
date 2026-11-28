// SPDX-License-Identifier: AGPL-3.0-or-later
// The machine-wide phone lock (phone-hand-lock.ts) with real processes: six processes take the phone one at a time; a holder killed
// while it holds the phone frees it at once; a caller leaves the phone free for the next one in its own process; a program that is not
// a proxy holding the port gets a retryable busy answer and the phone gets nothing.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { PhoneBusyError, withPhoneHand } from "./phone-hand-lock.ts";
import { freePortBlock } from "../testing/ports.ts";

const LOCK_MODULE = fileURLToPath(new URL("./phone-hand-lock.ts", import.meta.url));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function node(script: string) {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { stdio: "ignore", windowsHide: true });
  return { child, closed: new Promise<void>((resolve) => child.once("close", () => resolve())) };
}

it("six processes take the phone one at a time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hand-lock-"));
  try {
    const port = await freePortBlock([0]);
    const log = join(dir, "turns.log");
    const startAt = Date.now() + 1500;
    const workers = Array.from({ length: 6 }, () => node(`import { appendFileSync } from "node:fs"; import { withPhoneHand } from ${JSON.stringify(LOCK_MODULE)};
      while (Date.now() < ${startAt}) {}
      await withPhoneHand(async () => { appendFileSync(${JSON.stringify(log)}, "in\\n"); await new Promise((r) => setTimeout(r, 120)); appendFileSync(${JSON.stringify(log)}, "out\\n"); }, ${port});`).closed);
    await Promise.all(workers);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(Array.from({ length: 6 }, () => ["in", "out"]).flat());
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 60000);

it("a holder killed while it holds the phone frees it at once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hand-lock-"));
  try {
    const port = await freePortBlock([0]);
    const held = join(dir, "held");
    const holder = node(`import { writeFileSync } from "node:fs"; import { withPhoneHand } from ${JSON.stringify(LOCK_MODULE)};
      await withPhoneHand(async () => { writeFileSync(${JSON.stringify(held)}, "x"); await new Promise((r) => setTimeout(r, 60000)); }, ${port});`);
    for (let waited = 0; !existsSync(held) && waited < 15000; waited += 20) await wait(20);
    expect(existsSync(held)).toBe(true);
    holder.child.kill("SIGKILL");
    await holder.closed;
    const started = Date.now();
    expect(await withPhoneHand(async () => "ran", port, 10000)).toBe("ran");
    expect(Date.now() - started).toBeLessThan(2000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 60000);

it("leaves the phone free for the next call in the same process, even after a failed one", async () => {
  const port = await freePortBlock([0]);
  await expect(withPhoneHand(async () => { throw new Error("adb failed"); }, port, 600)).rejects.toThrow("adb failed");
  const started = Date.now();
  await expect(withPhoneHand(async () => "next", port, 600)).resolves.toBe("next");
  expect(Date.now() - started).toBeLessThan(300);
});

it("refuses with a retryable busy error, and does nothing, when a program that is not a proxy holds the port past the wait", async () => {
  const squatter = createServer();
  await new Promise<void>((resolve) => squatter.listen({ port: 0, host: "127.0.0.1", exclusive: true }, resolve));
  try {
    const port = (squatter.address() as { port: number }).port;
    let ran = false;
    const started = Date.now();
    await expect(withPhoneHand(async () => { ran = true; return "ran"; }, port, 400)).rejects.toBeInstanceOf(PhoneBusyError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    expect(ran).toBe(false);
  } finally { squatter.close(); }
});
