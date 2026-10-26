import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

// A failed Copy message / Copy conversation ID banner is short-lived like the other copy failures.
it("reports a failed copy as a transient error", () => {
  for (const file of ["./ChatView.tsx", "./Sidebar.tsx"]) {
    const source = read(file);
    const reports = [...source.matchAll(/copyOrReport\([^\n]*\)\s*\}?,?/g)].map(([m]) => m);
    expect(reports.length, file).toBeGreaterThan(0);
    for (const call of reports) {
      expect(call, file).toContain("raiseTransientError(dispatch, message)");
      expect(call, file).not.toContain('type: "error"');
    }
  }
});
