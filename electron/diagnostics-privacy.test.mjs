import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDiagnosticsReport, readSafeLogTail } from "./diagnostics.mjs";

describe("A8: an owner-saved realistic diagnostics export", () => {
  it("keeps counts, ids and timing, abbreviates home paths, and omits every message body", () => {
    const dir = mkdtempSync(join(tmpdir(), "diagnostics-privacy-"));
    try {
      const id = "c680022b-d2ea-4c58-bf83-f6c0fe338526";
      const stamp = "2026-11-12T04:30:00.000Z";
      writeFileSync(join(dir, "server.log"), [
        `[${stamp}] [out] [turn] botId=${id} messageId=${id} count=3 durationMs=240 cwd="/Users/ada/Secret Project/x"`,
        `[${stamp}] [out] [turn] messageId=${id} text="BODY_ALPHA private conversation"`,
        `[${stamp}] [out] [engine] prompt: BODY_BRAVO`,
        "BODY_CHARLIE multiline continuation without a label",
        "BODY_PRIVATE_DIARY_TOKEN=opaque-placeholder",
        `[${stamp}] [out] ${JSON.stringify({ messageId: id, count: 4, elapsedMs: 12, message: "BODY_DELTA", content: [{ text: "BODY_ECHO" }], path: "/home/ada/notes/a.md" })}`,
        `[${stamp}] [err] Error: BODY_FOXTROT provider echoed the prompt`,
        `[${stamp}] [out] response=BODY_GOLF`,
        `[${stamp}] [out] body=BODY_HOTEL count=999`,
        `[${stamp}] [out] content={"text":"BODY_INDIA"}`,
        `[${stamp}] [out] ${JSON.stringify({ count: 5, path: "/tmp/file\nBODY_KILO" })}`,
      ].join("\n"));
      const log = readSafeLogTail(join(dir, "server.log"));
      const report = buildDiagnosticsReport({
        now: stamp, appInfo: { version: "1.0.19", platform: "darwin", uptimeSeconds: 60 },
        configSummary: { bots: 2, telegram: { configured: true } }, logTail: log.tail,
        desktopLogTail: `[${stamp}] event=render-process-gone surface=main-window reason=crashed exitCode=5 message="BODY_JULIET"`,
      });
      writeFileSync(join(dir, "report.txt"), report);
      const exported = readFileSync(join(dir, "report.txt"), "utf8");
      expect(exported).not.toMatch(/BODY_|\/Users\/ada|\/home\/ada/);
      expect(exported).toContain("~/Secret Project/x");
      expect(exported).toContain("~/notes/a.md");
      for (const metadata of [`messageId=${id}`, "count=3", "durationMs=240", "count=4", "elapsedMs=12", "exitCode=5"]) expect(exported).toContain(metadata);
      expect(exported).not.toContain("count=999"); // inside a body, never metadata
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("redacts Windows and non-default home paths throughout the report", () => {
    const report = buildDiagnosticsReport({ homeDir: "D:\\Profiles\\ada", logTail: [
      'path="C:\\Users\\ada\\Private Project\\x.md" count=1',
      'path="D:\\Profiles\\ada\\notes\\x.md" count=2',
      'path="/root/project/file.md" count=3',
      'path="C:\\Users\\Ada Lovelace\\notes\\x.md" count=4',
      'path="/Users/Zoë Smith/notes/x.md" count=5',
      'path="c:/Users/Ada Lovelace/forward/x.md" count=6',
      'path="d:/profiles/ADA/custom/x.md" count=7',
    ].join("\n") });
    expect(report).not.toMatch(/Users\\ada|Profiles\\ada|\/root\/|Lovelace|Smith/);
    expect(report).toContain("~\\Private Project\\x.md");
    expect(report).toContain("~\\notes\\x.md");
    expect(report).toContain("~/project/file.md");
    expect(report).toContain("~/forward/x.md");
    expect(report).toContain("~/custom/x.md");
  });
});
