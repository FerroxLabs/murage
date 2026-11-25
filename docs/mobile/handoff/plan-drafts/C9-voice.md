### Task C9: Calls from a paired phone (voice-host and call-note)

Found while drafting B3. Allowing the routes at the door has no effect, for two reasons.
The harness refuses both call routes to anything but the desktop
(`server/index.ts:16528`, `:16552`: `requestSurface(...) !== "desktop"` → 403 "calls are
available on the desktop app"). And the call-note handler never checks which bots the
caller may see. Spec §5 needs both routes to work from a paired phone, limited to the
bots that phone can see.

**Files:**
- Create: `server/voice/call-access.ts`
- Modify: `server/index.ts:16527-16561` (the two call routes)
- Modify: `companion/src/routes.ts`. Add `POST /api/bots/:id/voice-host` to
  `BROWSER_ALLOWED` next to B3's call-note entry, and extend C2's launch-proof helper.
- Modify: `companion/src/browser.ts`. Forward the launch proof wherever C2 does, now
  through `needsLaunchProof`.
- Test: `server/voice/call-access.test.ts`, `companion/test/routes.test.ts`

**Interfaces:**
- Consumes:
  - `inboxDoor`, `inboxAccessFor`, `InboxDoor` and `InboxRosterStore` from C1
    (`server/inbox-access.ts`)
  - `visibleToCompanion` from `server/sse-visibility.ts:355`
  - C2's `isInboxRoute`, and the proof-forwarding branch in `companion/src/browser.ts`
  - B3's call-note allowlist entry
- Produces:
  - `type CallAccess = "allowed" | "forbidden" | "not-found"`
  - `callAccess(store: InboxRosterStore, door: InboxDoor, botId: string): CallAccess`
  - `export function needsLaunchProof(method: string, path: string): boolean` in
    `companion/src/routes.ts`. It covers C2's two Inbox routes plus the two call routes.
    `browser.ts` calls it where it previously called `isInboxRoute`.

- [ ] **Step 1: Write the failing test**

`server/voice/call-access.test.ts`:
```ts
// Who may start a call with which bot. The desktop may call any bot, as it
// always has. A phone the companion proved it forwarded may call the bots
// its sidebar shows and no others. Nothing unproven may call at all.
import { describe, expect, it } from "vitest";

import type { InboxRosterStore } from "../inbox-access.ts";
import { callAccess } from "./call-access.ts";

function world(): InboxRosterStore {
  const bots = [
    { id: "open", name: "Open", threadId: "t-open", tasks: [] },
    { id: "secret", name: "Secret", threadId: "t-secret", hidden: true, tasks: [] },
  ];
  const groups: InboxRosterStore["groups"] = [];
  return {
    bots, groups,
    bot: id => bots.find(bot => bot.id === id) ?? null,
    botByThread: threadId => bots.find(bot => bot.threadId === threadId) ?? null,
    group: () => undefined,
    groupByThread: () => undefined,
  };
}

describe("call access", () => {
  it("lets the desktop call any bot, hidden ones included", () => {
    expect(callAccess(world(), "desktop", "open")).toBe("allowed");
    expect(callAccess(world(), "desktop", "secret")).toBe("allowed");
  });

  it("lets a proven phone call only the bots its sidebar shows", () => {
    expect(callAccess(world(), "companion", "open")).toBe("allowed");
    // A hidden bot answers exactly like a bot that does not exist, so a phone
    // cannot learn it is there by probing ids.
    expect(callAccess(world(), "companion", "secret")).toBe("not-found");
    expect(callAccess(world(), "companion", "nobody")).toBe("not-found");
  });

  it("refuses anything unproven, whatever bot it names", () => {
    expect(callAccess(world(), "unproven", "open")).toBe("forbidden");
    expect(callAccess(world(), "unproven", "nobody")).toBe("forbidden");
  });
});
```

Append to `companion/test/routes.test.ts`. Extend the import from `../src/routes.ts` to
include `needsLaunchProof`.
```ts
describe("routes that carry the sidecar's launch proof", () => {
  it("covers the Inbox and both call routes, and nothing else", () => {
    expect(needsLaunchProof("GET", "/api/inbox")).toBe(true);
    expect(needsLaunchProof("POST", "/api/inbox/state")).toBe(true);
    expect(needsLaunchProof("POST", "/api/bots/bot_1/voice-host")).toBe(true);
    expect(needsLaunchProof("POST", "/api/bots/bot_1/call-note")).toBe(true);
    expect(needsLaunchProof("GET", "/api/bots/bot_1/voice-host")).toBe(false);
    expect(needsLaunchProof("POST", "/api/bots/bot_1/messages")).toBe(false);
    expect(needsLaunchProof("POST", "/api/bots/../voice-host")).toBe(false);
  });

  it("lets a signed-in browser reach voice-host", () => {
    expect(askBrowser("POST", "/api/bots/bot_1/voice-host")).toBeNull();
    expect(askBrowser("GET", "/api/bots/bot_1/voice-host")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run server/voice/call-access.test.ts companion/test/routes.test.ts -t "call access|launch proof|voice-host"`
Expected: FAIL with "Failed to resolve import ./call-access.ts" and
"needsLaunchProof is not a function".

- [ ] **Step 3: Write minimal implementation**

`server/voice/call-access.ts`:
```ts
// Who may start a call with which bot (voice-host and call-note).
//
// Calls were desktop-only because the voice-host snapshot includes the
// Inbox. C1 made the Inbox safe to show a proven phone, scoped to the
// threads its sidebar shows, so the same scoping now decides calls. A
// hidden bot answers "not-found", never "forbidden": the phone must not be
// able to tell a hidden bot from a missing one.
import type { InboxDoor, InboxRosterStore } from "../inbox-access.ts";
import { visibleToCompanion } from "../sse-visibility.ts";

export type CallAccess = "allowed" | "forbidden" | "not-found";

export function callAccess(store: InboxRosterStore, door: InboxDoor, botId: string): CallAccess {
  if (door === "unproven") return "forbidden";
  if (door === "desktop") return "allowed";
  return visibleToCompanion(store, { scope: "bot", botId }) ? "allowed" : "not-found";
}
```

In `server/index.ts`, add next to C1's `inbox-access.ts` import:
```ts
import { callAccess } from "./voice/call-access.ts";
```

Replace the voice-host route opening (`server/index.ts:16527-16528`) with:
```ts
    if (method === "POST" && VOICE_HOST_PATH.test(path)) {
      const door = inboxDoor(req.headers, url.searchParams);
      const access = callAccess(store, door, VOICE_HOST_PATH.exec(path)![1]);
      if (access === "forbidden") return json(res, 403, { error: "calls need a paired device" });
      if (access === "not-found") return json(res, 404, { error: "no such bot" });
```
In the same route's `needsYou` callback (`:16534-16540`), replace
`{ owner: true, threads }` with the door's scoped access, so a phone's call snapshot never
lists hidden threads:
```ts
          const scoped = inboxAccessFor(store, door);
          const result = inboxRequest(database(), { method: "GET", path: "/api/inbox", query: { view: "decisions", page: 0, pageSize: 10 } },
            { ...scoped, threads: scoped.threads.filter((thread) => threads.some((own) => own.threadId === thread.threadId)) });
```
Replace the call-note route opening (`server/index.ts:16551-16552`) with:
```ts
    if (method === "POST" && CALL_NOTE_PATH.test(path)) {
      const access = callAccess(store, inboxDoor(req.headers, url.searchParams), CALL_NOTE_PATH.exec(path)![1]);
      if (access === "forbidden") return json(res, 403, { error: "calls need a paired device" });
      if (access === "not-found") return json(res, 404, { error: "no such bot" });
```

In `companion/src/routes.ts`:
- In `BROWSER_ALLOWED`, directly after B3's call-note entry, add:
  ```ts
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/voice-host$/ },
  ```
- Next to C2's `isInboxRoute`, add:
  ```ts
  const CALL_ROUTE = /^\/api\/bots\/[\w-]+\/(?:voice-host|call-note)$/;
  /** Routes the harness answers only when the sidecar proves it forwarded them:
   *  the Inbox (C2) and a call's two routes (C9). */
  export function needsLaunchProof(method: string, path: string): boolean {
    return isInboxRoute(method, path) || (method === "POST" && CALL_ROUTE.test(path));
  }
  ```

In `companion/src/browser.ts`, change C2's forwarding condition from
`isInboxRoute(method, path)` to `needsLaunchProof(method, path)`, and update its import.
C2's tests already prove that a browser-supplied `x-murage-companion-token` is replaced
by the sidecar's own proof and never passed through.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run server/voice/call-access.test.ts companion/test/routes.test.ts server/inbox-access.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add server/voice/call-access.ts server/voice/call-access.test.ts server/index.ts companion/src/routes.ts companion/src/browser.ts companion/test/routes.test.ts
git commit -m "feat(calls): a paired phone may call the bots it can see"
```
