// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// A scripted `ps` for tests of the process-table probes (macOS shape): the full listing (`ps -A`) answers from a script of
// behaviours, one per call ("hang" never calls back, "timeout" fails as a killed ps does, "ok" answers from `table`), and the
// per-pid probe (`ps -p`) answers from `table`. Everything else goes to the real execFile.
import type { execFile as realExecFile } from "node:child_process";

export interface FakeRow { pid: number; ppid: number; comm: string }
export const psFake = {
  active: false,
  script: [] as Array<"hang" | "timeout" | "ok">,
  fullCalls: 0,
  table: [] as FakeRow[],
  reset(): void { this.active = false; this.script = []; this.fullCalls = 0; this.table = []; },
};
const LSTART = "Wed Oct  7 10:00:00 2026";
const render = (rows: FakeRow[]) => rows.map((row) => `${row.pid} ${row.ppid} ${LSTART} ${row.comm}`).join("\n") + "\n";

export function fakeExecFile(real: typeof realExecFile): typeof realExecFile {
  return ((file: string, args: string[], ...rest: unknown[]) => {
    if (!psFake.active || file !== "ps") return (real as (...a: unknown[]) => unknown)(file, args, ...rest);
    const callback = rest[rest.length - 1] as (error: Error | null, stdout?: string) => void;
    if (args.includes("-A")) {
      psFake.fullCalls++;
      const step = psFake.script.shift() ?? "ok";
      if (step === "hang") return undefined;
      if (step === "timeout") { queueMicrotask(() => callback(Object.assign(new Error("ps timed out"), { killed: true, signal: "SIGKILL" }))); return undefined; }
      queueMicrotask(() => callback(null, render(psFake.table)));
      return undefined;
    }
    const wanted = new Set(String(args[args.indexOf("-p") + 1]).split(",").map(Number));
    queueMicrotask(() => callback(null, render(psFake.table.filter((row) => wanted.has(row.pid)))));
    return undefined;
  }) as typeof realExecFile;
}
