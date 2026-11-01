// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A server child that stays alive and silent to the end of the limit is doing slow work: another fork would start that work over, so it gets
// one stop and the recovery page says so. A child that exited, or a port another program owns, still moves on to the next port.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.mjs"), "utf8");
const start = text.indexOf("async function startServerPackaged()");
const source = text.slice(start, text.indexOf("function syncManagedComposioCredentials()", start));

function run(reasons) {
  const forks = [];
  const scope = {
    assertDesktopStartupActive: () => {},
    startServerOn: async (port) => { forks.push(port); return { proc: null, reason: reasons(forks.length) }; },
    superviseServerChild: () => {}, mcpServers: { resume: async () => {} }, slog: () => {},
    setTimeout: (done) => { done(); return 0; },
  };
  const body = `let memoryUpgradeBlocked=null, serverStartSlow=false, serverStartConflictOnly=false, serverProc=null, SERVER_PORT=0;
    ${source}
    return startServerPackaged().then((ready) => ({ ready, serverStartSlow, serverStartConflictOnly }));`;
  return new Function(...Object.keys(scope), body)(...Object.values(scope)).then((result) => ({ ...result, forks }));
}

describe("a server child that is slow to answer", () => {
  it("gets one fork, then the slow recovery page", async () => {
    const result = await run(() => "timeout");
    expect(result.forks).toEqual([8799]);
    expect(result).toMatchObject({ ready: false, serverStartSlow: true, serverStartConflictOnly: false });
  });
  it("after an exited child on the first port, the timeout on the next ends it there", async () => {
    const result = await run((fork) => fork === 1 ? "exited" : "timeout");
    expect(result.forks).toEqual([8799, 18799]);
    expect(result.serverStartSlow).toBe(true);
  });
  it("a child that exits still tries every port, twice", async () => {
    const result = await run(() => "exited");
    expect(result.forks).toHaveLength(6);
    expect(result).toMatchObject({ ready: false, serverStartSlow: false, serverStartConflictOnly: false });
  });
  it("ports another program owns still hop, and read as a port conflict", async () => {
    const result = await run(() => "foreign-owner");
    expect(result.forks).toHaveLength(6);
    expect(result).toMatchObject({ serverStartSlow: false, serverStartConflictOnly: true });
  });
  it("the limit is five minutes, and the page names the log", () => {
    expect(text).toMatch(/const SERVER_BOOT_SLOW_LIMIT_MS = 5 \* 60_000;/);
    expect(text).toMatch(/bootTimeoutMs: SERVER_BOOT_SLOW_LIMIT_MS/);
    expect(text).toMatch(/serverStartSlow \? "STARTUP_SLOW"/);
    expect(text).toMatch(/reasonCode === "STARTUP_SLOW"\n\s*\? `Murage is taking longer than usual to start\. Your data is kept as it is\. Choose Retry startup\. If this keeps happening, the details are in \$\{path\.join\(LOG_DIR, "server\.log"\)\}\.`/);
  });
});
