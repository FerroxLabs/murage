// Phone mode's wiring in the store (spec §6). The rules themselves are unit
// tested in lib/phone-client.test.ts and lib/scrollback.test.ts; this pins that
// the store actually asks them, at the two places the spec names.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const store = readFileSync(fileURLToPath(new URL("./store.tsx", import.meta.url)), "utf8");

describe("phone mode in the store", () => {
  it("hydrates with the phone's page size, not a fixed one", () => {
    expect(store).toContain("api(`/api/bots?messages=${hydratePageSize(phone)}`)");
    expect(store).not.toContain("api(`/api/bots?messages=${MESSAGE_PAGE_SIZE}`).then(({ bots, groups, computerControl })");
  });

  it("opens the event stream without live screen frames on a phone", () => {
    expect(store).toMatch(/openLiveEvents\(\{\s*screens: phone \? false : undefined,/);
  });

  it("asks the answer once, at the top of the boot effect", () => {
    expect(store.match(/const phone = isPhoneClient\(\);/g)).toHaveLength(1);
  });

  it("tops up the conversation on screen through the scrollback path", () => {
    expect(store).toMatch(/needsNewestPage\(onScreen\)/);
    expect(store).toMatch(/dispatch\(\{ type: "loadOlderMessages", threadId: topUpThread \}\)/);
  });

  // Without a capture, windowAfterPrepend treats the top-up like a jump's
  // page and leaves it unmounted behind "Show earlier": the phone would open
  // a thread on its one booted row.
  it("mounts the top-up in both transcript views, holding the viewport still", () => {
    for (const [file, owner] of [["ChatView.tsx", "bot"], ["GroupView.tsx", "group"]]) {
      const view = readFileSync(fileURLToPath(new URL(`../components/${file}`, import.meta.url)), "utf8");
      expect(view).toContain(`if (olderPending && !preExpandHeight.current && needsNewestPage(${owner})) captureHeight();`);
    }
  });
});
