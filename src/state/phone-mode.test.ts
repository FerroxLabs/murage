// Phone mode's wiring in the store (spec §6). The rules themselves are unit
// tested in lib/phone-client.test.ts and lib/scrollback.test.ts; this pins that
// the store actually asks them, at the two places the spec names.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const store = readFileSync(fileURLToPath(new URL("./store.tsx", import.meta.url)), "utf8");

describe("phone mode in the store", () => {
  it("boots from the sidebar roster (no rows), the same on a phone as on the desktop", () => {
    expect(store).toContain("api(`/api/bots?view=sidebar`).then(({ bots, groups, computerControl, sidebarSectionOrder, pendingSends })");
    expect(store).not.toMatch(/api\(`\/api\/bots\?messages=\$\{/);
  });

  it("opens the event stream without live screen frames on a phone", () => {
    expect(store).toMatch(/openLiveEvents\(\{\s*screens: phone \? false : undefined,/);
  });

  it("asks the answer once, at the top of the boot effect", () => {
    expect(store.match(/const phone = isPhoneClient\(\);/g)).toHaveLength(1);
  });

  it("fetches the first page of the conversation on screen through the scrollback path", () => {
    expect(store).toMatch(/needsFirstPage\(onScreen\)/);
    expect(store).toMatch(/dispatch\(\{ type: "loadFirstPage", threadId: topUpThread \}\)/);
  });

  // A resync drops an in-flight top-up as stale; a failure must not loop.
  it("asks again once per transcript generation, and never while a page is in flight", () => {
    expect(store).toContain("const key = `${topUpThread}:${topUpGeneration}`;");
    expect(store).toContain("if (!topUpThread || topUpBusy) return;");
    // rc10-preview2 (4fecfadca) adds two deliberate re-asks: opening the thread again (screenThread) and the window coming back into view
    // or online (freshRetry). Each clears the once-per-generation guard only there; nothing else resets it, so a dead link still does not loop.
    expect(store).toContain("}, [topUpThread, topUpGeneration, topUpBusy, freshRetry, screenThread, dispatch]);");
    expect(store.match(/toppedUp\.current = "";/g)).toHaveLength(2);
    expect(store).toContain("toppedUp.current = \"\";\n  }, [screenThread]);");
    expect(store).toMatch(/if \(document\.visibilityState === "hidden"\) return;\s+toppedUp\.current = "";\s+setFreshRetry/);
  });

  // Without a capture, windowAfterPrepend treats a page that replaces held rows (a rehydrated conversation's) like a jump's page and
  // leaves it unmounted behind "Show earlier".
  it("mounts the first page in both transcript views, holding the viewport still", () => {
    for (const [file, owner] of [["ChatView.tsx", "bot"], ["GroupView.tsx", "group"]]) {
      const view = readFileSync(fileURLToPath(new URL(`../components/${file}`, import.meta.url)), "utf8");
      expect(view).toContain(`const firstPagePending = ${owner}.firstPageEvents !== undefined;`);
      expect(view).toContain(`if (firstPagePending && !preExpandAnchor.current) captureAnchor("first");`);
      expect(view).toContain("}, [olderPending, firstPagePending, transcriptKey]);");
    }
  });
});
