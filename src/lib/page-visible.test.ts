// Every setInterval poller stops while the page is hidden (spec §3.6). A
// phone that locks with the Inbox open used to wake its radio every 5 s for
// a list nobody could see. The pattern is ComputerPanel's: the effect
// returns early when hidden and lists pageVisible in its deps, so it tears
// its interval down and builds it again on return.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(fileURLToPath(new URL(`../components/${file}`, import.meta.url)), "utf8");

/** The effect around each setInterval: from its useEffect( to its deps. */
function pollers(source: string): string[] {
  const out: string[] = [];
  for (let at = source.indexOf("setInterval("); at >= 0; at = source.indexOf("setInterval(", at + 1)) {
    const start = source.lastIndexOf("useEffect(", at);
    const end = source.indexOf("]);", at);
    expect(start, "a poller outside an effect").toBeGreaterThan(-1);
    out.push(source.slice(start, end + 3));
  }
  return out;
}

describe("pollers pause while hidden", () => {
  it.each([["Inbox.tsx", 1], ["SidebarPhoneButton.tsx", 1], ["WorkspacePane.tsx", 1], ["ComputerPanel.tsx", 3]])(
    "%s",
    (file, count) => {
      const source = read(file);
      expect(source).toContain("usePageVisible()");
      const found = pollers(source);
      expect(found).toHaveLength(count);
      for (const effect of found) {
        expect(effect).toMatch(/!pageVisible\)?\s*\)?\s*return;|\|\| !pageVisible\) return;/);
        expect(effect).toMatch(/\[[^\]]*\bpageVisible\b[^\]]*\]\);$/);
      }
    },
  );

  it("the Inbox and the file probe look again the moment the page comes back", () => {
    expect(read("Inbox.tsx")).toContain("if (wasHidden.current) { wasHidden.current = false; setRevision(current => current + 1); }");
    expect(read("WorkspacePane.tsx")).toContain("if (probeOnShow.current) { probeOnShow.current = false; void probe(); }");
  });
});
