// ACP-EFFORT-PER-MODEL-1023 X9 (r9 I5): every place that hands a durable resume cursor to a driver also hands it the touch record.
// The one non-durable cursor source (a group-room member turn, an in-memory room session) is named here, not skipped silently.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const ALLOWED_NON_DURABLE = [
  { file: "server/index.ts", needle: "resumeCursor: roomContinuedSession", why: "group-room member turn: in-process retained room memory, per-process touch map (X6a)" },
];

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "testing" || entry === "drivers") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

it("X9 every driver input that carries a resume cursor carries effortTouch, or is the named non-durable source", () => {
  const sites: Array<{ file: string; line: number; text: string; window: string }> = [];
  for (const file of sources("server")) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, index) => {
      if (/^\s*resumeCursor,\s*$/.test(text) || /\{ resumeCursor: [A-Za-z]+ \}/.test(text)) {
        sites.push({ file, line: index + 1, text: text.trim(), window: lines.slice(Math.max(0, index - 40), index + 40).join("\n") });
      }
    });
  }
  // the enumeration itself must not shrink silently: one durable site and the one named non-durable site
  expect(sites.map(site => site.file)).toEqual(["server/index.ts", "server/index.ts"]);
  for (const site of sites) {
    const allowed = ALLOWED_NON_DURABLE.find(entry => entry.file === site.file && site.text.includes(entry.needle));
    if (allowed) continue;
    expect(site.window, `${site.file}:${site.line} hands a resume cursor to a driver without effortTouch`).toContain("effortTouch");
  }
});
