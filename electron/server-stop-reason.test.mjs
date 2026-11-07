import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createServerStopReason } from "./server-stop-reason.mjs";

const run = () => { const lines = []; return { lines, stop: createServerStopReason((line) => lines.push(line)) }; };

describe("server stop reason line", () => {
  it("says quit when nothing named another reason", () => {
    const { lines, stop } = run();
    stop.logOnce();
    expect(lines).toEqual(["server stop reason=quit"]);
  });

  it.each(["update", "backup", "system-shutdown", "restart"])("says %s, once, however often the close is entered", (reason) => {
    const { lines, stop } = run();
    stop.note(reason);
    stop.logOnce(); stop.logOnce();
    expect(lines).toEqual([`server stop reason=${reason}`]);
  });

  it("keeps the first named reason and ignores a word outside the set", () => {
    const { lines, stop } = run();
    stop.note("nonsense"); stop.note("update"); stop.note("backup");
    stop.logOnce();
    expect(lines).toEqual(["server stop reason=update"]);
  });

  it("main names the reason on every stop path and logs as the close begins", () => {
    const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
    for (const reason of ["update", "backup", "system-shutdown", "restart"]) expect(main).toContain(`serverStopReason.note("${reason}")`);
    expect(main.indexOf("serverStopReason.logOnce()")).toBeGreaterThan(main.indexOf("function cleanupDesktopForExit("));
    expect(main.slice(main.indexOf("function cleanupDesktopForExit("), main.indexOf("serverStopReason.logOnce()"))).not.toContain("return");
  });
});
