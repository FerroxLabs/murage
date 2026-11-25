# Group C: server, installer and desktop setup (Plan 1, host fixes)

Scope: spec §3.3 row "Remote Inbox access model", and from §3.4 the `murage pair` command, the keep-awake offer and the setup copy for tailnets without HTTPS certificates.

All line numbers are from `mobile/v1` @ `121c79fb`.

Proof model, decided after reading the code: the task brief suggested keying the remote Inbox off the `x-murage-companion` marker (`sse-visibility.ts:130` `companionMarked`). That marker is not a secret, because any local process can type it. This branch already has a real proof. `server/companion-authority.ts` checks `x-murage-companion-token` against the per-launch `MURAGE_COMPANION_TOKEN`. Both the desktop (`electron/main.mjs:152,1579`) and `murage start` (`installer/bin/murage.mjs:1142`) hand that token to the harness and to the sidecar. The browser door already forwards it for one route (`companion/src/browser.ts:1359`, cloud-desktop join). C1 and C2 therefore key the remote Inbox on that proof, not on the marker. A forged marker earns nothing.

Task order: C1 → C2 (C2's end-to-end test needs C1's semantics, but its unit tests do not). C3 → C4. C5 → C6. C7 → C8.

---

### Task C1: Remote Inbox access model (server)

**Files:**
- Create: `server/inbox-access.ts`
- Modify: `server/index.ts:64` (import), `server/index.ts:10367-10379` (inbox route), `server/index.ts:10383-10388` (tray roster)
- Test: `server/inbox-access.test.ts`

**Interfaces:**
- Consumes: `inboxRequest`, `InboxAccess` and `InboxThread` from `server/inbox.ts:17-18,403`. `requestSurface` and `visibleToCompanion` from `server/sse-visibility.ts:173,355`. `companionAuthorized` and `createCompanionAuthority` from `server/companion-authority.ts`.
- Produces:
  - `type InboxDoor = "desktop" | "companion" | "unproven"`
  - `inboxDoor(headers: IncomingHttpHeaders, query: URLSearchParams | null, proven?: (headers: IncomingHttpHeaders) => boolean): InboxDoor`
  - `inboxThreads(store: InboxRosterStore): InboxThread[]`
  - `inboxAccessFor(store: InboxRosterStore, door: InboxDoor): InboxAccess`
  - `interface InboxRosterStore extends VisibilityStore { bots; groups }`
  - HTTP contract that C2 relies on: `GET /api/inbox` and `POST /api/inbox/state` answer 200 to a request that carries a valid `x-murage-companion-token`, scoped to visible threads. Without that proof or desktop proof, both still answer 404.

- [ ] **Step 1: Write the failing test**
```ts
// The Inbox, asked for through the browser door.
//
// `inboxRequest` has always been scoped by an explicit list of threads; what
// this file pins is who gets which list. The desktop gets every thread, as it
// always has. A request the companion proved it forwarded gets the threads
// the phone's sidebar shows — the same `visibleToCompanion` answer the live
// stream and the transcript routes give — and nothing else gets anything.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { InboxPage, InboxQuery } from "../shared/inbox.ts";
import { createCompanionAuthority } from "./companion-authority.ts";
import { inboxAccessFor, inboxDoor, type InboxRosterStore } from "./inbox-access.ts";
import { inboxRequest, initializeInbox } from "./inbox.ts";
import { desktopSurfaceSecret } from "./sse-visibility.ts";

const PROOF = "c".repeat(64);
const proven = createCompanionAuthority(PROOF);

const roots: string[] = [], databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) { try { db.close(); } catch {} } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "murage-inbox-access-")); roots.push(root);
  const db = new DatabaseSync(join(root, "messages.db")); databases.push(db);
  db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
  initializeInbox(db);
  return db;
}
/** One pending approval per thread, each with its own request id. */
function seed(db: DatabaseSync) {
  ALL.forEach((thread, index) => {
    const value = { id: `m-${thread}`, at: 100 + index, role: "bot", kind: "options",
      card: { requestId: `r-${thread}`, title: "Run a command", options: ["Allow", "Deny"], tool: "Bash" } };
    db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)")
      .run(thread, value.id, value.at, value.role, value.kind, null, JSON.stringify(value));
  });
}
const ALL = ["t-open", "t-open-task", "t-secret", "t-secret-task", "t-room", "t-dm"];

/** The world in a few lines: an open bot with a task, a hidden bot with a
 *  task, a room, and the bot⇄bot channel the harness makes on its own. */
function world() {
  type Titled = { threadId: string; title: string };
  const bots: Array<{ id: string; name: string; threadId: string; hidden?: boolean; tasks: Titled[] }> = [
    { id: "open", name: "Open", threadId: "t-open", tasks: [{ threadId: "t-open-task", title: "Draft" }] },
    { id: "secret", name: "Secret", threadId: "t-secret", hidden: true, tasks: [{ threadId: "t-secret-task", title: "Payroll" }] },
  ];
  const groups: Array<{ id: string; name: string; threadId: string; dm?: boolean; tasks: Titled[] }> = [
    { id: "room", name: "Room", threadId: "t-room", tasks: [] },
    { id: "dm", name: "Open ⇄ Secret", threadId: "t-dm", dm: true, tasks: [] },
  ];
  const owns = (record: { threadId: string; tasks: Titled[] }, threadId: string) =>
    record.threadId === threadId || record.tasks.some(task => task.threadId === threadId);
  const store: InboxRosterStore = {
    bots, groups,
    bot: id => bots.find(bot => bot.id === id) ?? null,
    botByThread: threadId => bots.find(bot => owns(bot, threadId)) ?? null,
    group: id => groups.find(group => group.id === id),
    groupByThread: threadId => groups.find(group => owns(group, threadId)),
  };
  return { store, bots };
}
const list = (db: DatabaseSync, door: Parameters<typeof inboxAccessFor>[1], store: InboxRosterStore, query: InboxQuery = { view: "all" }) =>
  inboxRequest(db, { method: "GET", path: "/api/inbox", query }, inboxAccessFor(store, door));
const threadsOf = (page: InboxPage) => new Set(page.items.map(item => item.link.threadId));

describe("which door is asking", () => {
  it("names the desktop only when it proves itself", () => {
    expect(inboxDoor({ "x-murage-surface": "desktop", "x-murage-surface-secret": desktopSurfaceSecret() }, null, proven)).toBe("desktop");
    expect(inboxDoor({ "x-murage-surface": "desktop" }, null, proven)).toBe("unproven");
  });

  it("names the companion by its private launch proof, not by the marker", () => {
    expect(inboxDoor({ "x-murage-companion": "1", "x-murage-companion-token": PROOF }, null, proven)).toBe("companion");
    // The marker is typeable by any local process. It earns nothing alone.
    expect(inboxDoor({ "x-murage-companion": "1" }, null, proven)).toBe("unproven");
    expect(inboxDoor({ "x-murage-companion": "1", "x-murage-companion-token": "d".repeat(64) }, null, proven)).toBe("unproven");
  });

  it("does not let a companion-stamped request talk its way up to the desktop", () => {
    const query = new URLSearchParams({ surface: "desktop", surfaceSecret: desktopSurfaceSecret() });
    expect(inboxDoor({ "x-murage-companion": "1", "x-murage-companion-token": PROOF }, query, proven)).toBe("companion");
  });
});

describe("the remote Inbox", () => {
  it("shows the companion only the threads its sidebar shows", () => {
    const db = fixture(); seed(db);
    const result = list(db, "companion", world().store);
    expect(result.status).toBe(200);
    expect(threadsOf(result.body as InboxPage)).toEqual(new Set(["t-open", "t-open-task", "t-room"]));
    expect((result.body as InboxPage).decisions).toBe(3);
  });

  it("never lets a hidden thread in through search, a label or a count", () => {
    const db = fixture(); seed(db);
    const { store } = world();
    for (const query of ["Secret", "Payroll"]) {
      const result = list(db, "companion", store, { view: "all", query });
      expect(result.status).toBe(200);
      expect((result.body as InboxPage).total, query).toBe(0);
    }
    const page = list(db, "companion", store, { view: "approvals" }).body as InboxPage;
    expect(page.approvals).toBe(3);
    expect(JSON.stringify(page)).not.toMatch(/Secret|Payroll/);
  });

  it("follows a bot hidden after the phone last looked", () => {
    const db = fixture(); seed(db);
    const { store, bots } = world();
    bots[0].hidden = true;
    expect(threadsOf(list(db, "companion", store).body as InboxPage)).toEqual(new Set(["t-room"]));
  });

  it("refuses a state change to a hidden thread, and writes nothing", () => {
    const db = fixture(); seed(db);
    const { store } = world();
    const everything = (list(db, "desktop", store).body as InboxPage).items;
    for (const thread of ["t-secret", "t-secret-task", "t-dm"]) {
      const hidden = everything.find(item => item.link.threadId === thread)!;
      const result = inboxRequest(db, { method: "POST", path: "/api/inbox/state", body: { id: hidden.id, version: hidden.version, read: true } },
        inboxAccessFor(store, "companion"));
      expect(result.status, thread).toBe(404);
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM inbox_item_state").get()).toEqual({ n: 0 });
  });

  it("lets the companion mark a visible item read", () => {
    const db = fixture(); seed(db);
    const { store } = world();
    const visible = (list(db, "companion", store).body as InboxPage).items.find(item => item.link.threadId === "t-open")!;
    const result = inboxRequest(db, { method: "POST", path: "/api/inbox/state", body: { id: visible.id, version: visible.version, read: true } },
      inboxAccessFor(store, "companion"));
    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect((list(db, "companion", store).body as InboxPage).items.find(item => item.id === visible.id)?.read).toBe(true);
  });

  it("still answers 404 to a caller no door vouched for", () => {
    const db = fixture(); seed(db);
    const { store } = world();
    expect(list(db, "unproven", store).status).toBe(404);
    const any = (list(db, "desktop", store).body as InboxPage).items[0];
    expect(inboxRequest(db, { method: "POST", path: "/api/inbox/state", body: { id: any.id, version: any.version, read: true } },
      inboxAccessFor(store, "unproven")).status).toBe(404);
  });
});

describe("the desktop Inbox is unchanged", () => {
  it("gets every thread, labelled exactly as the route built them before", () => {
    expect(inboxAccessFor(world().store, "desktop")).toEqual({ owner: true, threads: [
      { threadId: "t-open", label: "Open", botId: "open" },
      { threadId: "t-open-task", label: "Open · Draft", botId: "open" },
      { threadId: "t-secret", label: "Secret", botId: "secret" },
      { threadId: "t-secret-task", label: "Secret · Payroll", botId: "secret" },
      { threadId: "t-room", label: "Room" },
      { threadId: "t-dm", label: "Open ⇄ Secret" },
    ] });
  });

  it("sees hidden bots and bot⇄bot rooms, as it always has", () => {
    const db = fixture(); seed(db);
    expect(threadsOf(list(db, "desktop", world().store).body as InboxPage)).toEqual(new Set(ALL));
  });
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run server/inbox-access.test.ts`
Expected: FAIL with `Failed to resolve import "./inbox-access.ts"`.
- [ ] **Step 3: Write minimal implementation**

Create `server/inbox-access.ts`:
```ts
// Who is shown which Inbox.
//
// The Inbox query has always been scoped by an explicit list of threads
// (`inbox.ts` `scope`), and the only list anyone built was the whole machine.
// So a remote door got `owner:false` and a 404: handing it the desktop's list
// would have shown a phone the hidden bots and the bot⇄bot rooms (spec §3.3,
// Astra 5).
//
// The remote list is the desktop list filtered by `visibleToCompanion`, the
// same predicate the live stream and the transcript routes use. One
// definition of "visible", asked in three places, so the Inbox can never name
// a conversation the phone's sidebar cannot open. State writes need nothing
// extra: `updateInboxState` looks the item up inside the same list, so an id
// from a hidden thread is simply not found.
//
// Who counts as the companion is decided by the private launch proof, not by
// the `x-murage-companion` marker. The marker is a request for the narrow
// answer and any local process can type it; the proof is a per-launch secret
// only the sidecar holds (`companion-authority.ts`). A request with neither
// proof gets what it always got here: nothing.
import type { IncomingHttpHeaders } from "node:http";

import { companionAuthorized } from "./companion-authority.ts";
import type { InboxAccess, InboxThread } from "./inbox.ts";
import { requestSurface, visibleToCompanion, type VisibilityStore } from "./sse-visibility.ts";

interface TitledThread { threadId: string; title?: string }

/** The slice of `Store` the roster needs. Structural, like `VisibilityStore`,
 *  so the tests can state the world without a data directory. */
export interface InboxRosterStore extends VisibilityStore {
  readonly bots: ReadonlyArray<{ id: string; name: string; threadId: string; tasks?: readonly TitledThread[] }>;
  readonly groups: ReadonlyArray<{ name: string; threadId: string; tasks?: readonly TitledThread[] }>;
}

/** Which door an Inbox request came through. `unproven` is every remote
 *  caller neither the desktop nor the companion vouched for. */
export type InboxDoor = "desktop" | "companion" | "unproven";

export function inboxDoor(
  headers: IncomingHttpHeaders,
  query: URLSearchParams | null,
  proven: (headers: IncomingHttpHeaders) => boolean = companionAuthorized,
): InboxDoor {
  if (requestSurface(headers, query) === "desktop") return "desktop";
  return proven(headers) ? "companion" : "unproven";
}

/** Every thread on the machine with its Inbox label. Moved here unchanged
 *  from the two routes in `index.ts` that each spelled it out. */
export function inboxThreads(store: InboxRosterStore): InboxThread[] {
  const label = (name: string, tasks: readonly TitledThread[] | undefined, threadId: string) =>
    [name, tasks?.find(task => task.threadId === threadId)?.title].filter(Boolean).join(" · ");
  const threadIds = (record: { threadId: string; tasks?: readonly TitledThread[] }) =>
    [...new Set([record.threadId, ...(record.tasks ?? []).map(task => task.threadId)])];
  return [
    ...store.bots.flatMap(bot => threadIds(bot).map(threadId => ({ threadId, label: label(bot.name, bot.tasks, threadId), botId: bot.id }))),
    ...store.groups.flatMap(group => threadIds(group).map(threadId => ({ threadId, label: label(group.name, group.tasks, threadId) }))),
  ];
}

export function inboxAccessFor(store: InboxRosterStore, door: InboxDoor): InboxAccess {
  if (door === "unproven") return { owner: false, threads: [] };
  const threads = inboxThreads(store);
  if (door === "desktop") return { owner: true, threads };
  return { owner: true, threads: threads.filter(thread => visibleToCompanion(store, { scope: "thread", threadId: thread.threadId })) };
}
```

In `server/index.ts`, after line 64 (`import { inboxRequest } from "./inbox.ts";`) add:
```ts
import { inboxAccessFor, inboxDoor, inboxThreads } from "./inbox-access.ts";
```

In `server/index.ts`, replace lines 10367-10379 (the `/api/inbox` block) with:
```ts
    if ((method === "GET" && path === "/api/inbox") || (method === "POST" && path === "/api/inbox/state")) {
      // A proven companion gets the Inbox of the conversations its sidebar
      // shows, and can only mark items inside that list (inbox-access.ts).
      const result = inboxRequest(database(), { method, path,
        query: { view: (url.searchParams.get("view") ?? "decisions") as InboxView, query: url.searchParams.get("query") ?? "",
          page: Number(url.searchParams.get("page") ?? 0), pageSize: Number(url.searchParams.get("pageSize") ?? 25), includeSnoozed: url.searchParams.get("includeSnoozed") === "true" },
        body: method === "POST" ? await readBody(req) : undefined,
      }, inboxAccessFor(store, inboxDoor(req.headers, url.searchParams)));
      return json(res, result.status, result.body);
    }
```

In `server/index.ts`, in the `/api/desktop/tray` block, delete the `const threads = [...]` literal (lines 10384-10387). Change line 10388's access argument from `{ owner: true, threads }` to `{ owner: true, threads: inboxThreads(store) }`. The desktop gate at line 10383 stays exactly as it is.

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run server/inbox-access.test.ts server/inbox.test.ts server/sse-visibility.test.ts`, then `pnpm typecheck`
Expected: PASS. `inbox.test.ts` is unchanged and still passes. `sse-visibility.test.ts` scans `index.ts` for `broadcast(` kinds, and this task adds none. If `tsc` rejects `store` as an `InboxRosterStore`, the cause is `ThreadId` vs `string` on `tasks[].threadId`. In that case widen `TitledThread.threadId` to `string` in the interface. Do not cast at the call site.
Then verify against an isolated instance (AGENTS.md → `docs/verification/README.md`, skill `verify-omb`). Start the fixture harness with `MURAGE_COMPANION_TOKEN=<64 hex>`. `curl` `/api/inbox` with that token in `x-murage-companion-token` → 200. The same call with only `x-murage-companion: 1` → 404.
- [ ] **Step 5: Commit**
`git add server/inbox-access.ts server/inbox-access.test.ts server/index.ts`
`git commit -m "feat(inbox): a proven companion gets the Inbox of the threads it can see"`

---

### Task C2: Inbox through the browser door (companion allowlist and launch proof)

**Files:**
- Modify: `companion/src/routes.ts:62-64` (add `isInboxRoute` next to `isCloudDesktopJoin`), `companion/src/routes.ts:325` (add two `BROWSER_ALLOWED` entries after the `/respond` line)
- Modify: `companion/src/browser.ts:1345-1347` (proof-required refusal), `companion/src/browser.ts:1359` (forward the proof)
- Test: `companion/test/routes.test.ts` (new `describe`), `companion/test/browser-inbox.test.ts` (new)

**Interfaces:**
- Consumes: C1's HTTP contract (valid `x-murage-companion-token` → scoped Inbox).
- Produces: `export function isInboxRoute(method: string, path: string): boolean`. Browser surface: `GET /api/inbox` and `POST /api/inbox/state` are allowed for a signed-in session and forwarded with the sidecar's own launch proof. The device surface (`DEVICE_ALLOWED`) is deliberately unchanged, because the new app uses the browser door (spec §2).

- [ ] **Step 1: Write the failing test**

Append to `companion/test/routes.test.ts`. Extend the import at line 13 to `import { BROWSER_DENIED, BROWSER_STATIC, denyReason, isInboxRoute, type Surface } from "../src/routes.ts";`.
```ts
describe("the Inbox reaches the browser door", () => {
  it("allows the list and the read/snooze/clear marks to a signed-in browser", () => {
    expect(askBrowser("GET", "/api/inbox")).toBeNull();
    expect(askBrowser("POST", "/api/inbox/state")).toBeNull();
  });

  it("sends a browser that has not signed in to /enter", () => {
    expect(askBrowser("GET", "/api/inbox", false)).toEqual({ status: 401, error: "sign in", signIn: "/enter" });
  });

  it("opens exactly two routes, not a family", () => {
    for (const [method, path] of [
      ["POST", "/api/inbox"],
      ["GET", "/api/inbox/state"],
      ["DELETE", "/api/inbox/state"],
      ["GET", "/api/inbox/state/extra"],
      ["GET", "/api/inboxes"],
      ["GET", "/api/inbox/../config"],
    ] as const) {
      expect(askBrowser(method, path), `${method} ${path}`).not.toBeNull();
    }
  });

  it("stays off the device door, which the new app does not use", () => {
    expect(ask("GET", "/api/inbox")).not.toBeNull();
    expect(ask("POST", "/api/inbox/state")).not.toBeNull();
  });

  it("names the routes that carry the launch proof, and only those", () => {
    expect(isInboxRoute("GET", "/api/inbox")).toBe(true);
    expect(isInboxRoute("POST", "/api/inbox/state")).toBe(true);
    expect(isInboxRoute("POST", "/api/inbox")).toBe(false);
    expect(isInboxRoute("GET", "/api/bots")).toBe(false);
  });
});
```

Create `companion/test/browser-inbox.test.ts`. It uses the helpers and fixture shape of `companion/test/companion-authority.test.ts`:
```ts
// The Inbox is scoped by the harness to the threads a companion can see, and
// the harness only believes it is talking to the companion when the private
// launch proof arrives with the request. So the door has to add that proof on
// these two routes — its own, never one a browser sent — and on no others.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { cookieName, createBrowserHandler, type BrowserDeviceStore } from "../src/browser.ts";

const PRIVATE_TOKEN = "c".repeat(64);
const listen = async (server: Server) => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};
const close = async (server: Server) => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
};
const devices: BrowserDeviceStore = {
  redeem: () => ({ error: "unused" }), openSession: () => null, closeSession: () => false, renewSession: () => null,
  resolveSession: value => value === "paired-session" ? {
    device: { id: "paired", name: "Fixture", cloudDesktopAccess: false }, session: { expiresAt: Date.now() + 60_000 },
    sessionId: "paired-session-record",
  } : null,
  sessionDeadline: id => id === "paired-session-record" ? Date.now() + 60_000 : null,
};

describe("the browser door's Inbox", () => {
  it("forwards its own launch proof on the two Inbox routes and nowhere else", async () => {
    const seen: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
    const harness = createServer((req, res) => {
      seen.push({ url: req.url ?? "", headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const harnessPort = await listen(harness);
    const door = createServer(createBrowserHandler({
      harnessPort, companionToken: PRIVATE_TOKEN,
      identity: () => ({ scheme: "http", hosts: new Set(["127.0.0.1"]) }), devices,
    }));
    const port = await listen(door);
    const headers = {
      "content-type": "application/json", origin: `http://127.0.0.1:${port}`,
      cookie: `${cookieName("http")}=paired-session`, "x-murage-companion-token": "attacker-supplied-proof",
    };
    try {
      const listed = await fetch(`http://127.0.0.1:${port}/api/inbox?view=decisions&pageSize=1`, { headers });
      expect(listed.status).toBe(200);
      expect(seen.at(-1)!.url).toBe("/api/inbox?view=decisions&pageSize=1");
      expect(seen.at(-1)!.headers["x-murage-companion-token"]).toBe(PRIVATE_TOKEN);
      expect(seen.at(-1)!.headers["x-murage-companion"]).toBe("1");
      expect(await listed.text()).not.toContain(PRIVATE_TOKEN);

      const marked = await fetch(`http://127.0.0.1:${port}/api/inbox/state`, { method: "POST", headers, body: "{}" });
      expect(marked.status).toBe(200);
      expect(seen.at(-1)!.headers["x-murage-companion-token"]).toBe(PRIVATE_TOKEN);

      const other = await fetch(`http://127.0.0.1:${port}/api/bots`, { headers });
      expect(other.status).toBe(200);
      expect(seen.at(-1)!.headers["x-murage-companion-token"]).toBeUndefined();
    } finally { await close(door); await close(harness); }
  });

  it("explains itself when the sidecar was launched without the proof", async () => {
    const door = createServer(createBrowserHandler({
      harnessPort: 1, identity: () => ({ scheme: "http", hosts: new Set(["127.0.0.1"]) }), devices,
    }));
    const port = await listen(door);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/inbox`, {
        headers: { origin: `http://127.0.0.1:${port}`, cookie: `${cookieName("http")}=paired-session` },
      });
      expect(response.status).toBe(503);
      expect(await response.text()).toContain("started together");
    } finally { await close(door); }
  });
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run companion/test/routes.test.ts companion/test/browser-inbox.test.ts`
Expected: FAIL. `isInboxRoute` is not exported. `askBrowser("GET", "/api/inbox")` returns `{ status: 404, error: "no route: GET /api/inbox" }`.
- [ ] **Step 3: Write minimal implementation**

In `companion/src/routes.ts`, after `isCloudDesktopJoin` (line 64) add:
```ts
/** The two Inbox routes. The harness scopes them to the threads a companion
 * can see, and only believes the companion is asking when the private launch
 * proof comes with the request — so the browser door adds its own proof to
 * exactly these, alongside the cloud-desktop join (`browser.ts`). */
export function isInboxRoute(method: string, path: string): boolean {
  return (method === "GET" && path === "/api/inbox") || (method === "POST" && path === "/api/inbox/state");
}
```
In `companion/src/routes.ts`, inside `BROWSER_ALLOWED`, directly after line 325 (`{ method: "POST", path: /^\/api\/threads\/[\w-]+\/respond$/ },`) add:
```ts

  // The Inbox: what is waiting on you, and read, snooze and clear marks. The
  // harness hands a proven companion only the threads its sidebar shows, and
  // a mark can only find an item inside that list (server/inbox-access.ts).
  // Answering stays on /respond above; a mark never answers anything.
  { method: "GET", path: /^\/api\/inbox$/ },
  { method: "POST", path: /^\/api\/inbox\/state$/ },
```
In `companion/src/browser.ts`, import `isInboxRoute` next to `isCloudDesktopJoin` from `./routes.ts`. Replace lines 1345-1347 (the `isCloudDesktopJoin && companionToken` 503 check) with:
```ts
    const carriesProof = isCloudDesktopJoin(method, path) || isInboxRoute(method, path);
    if (carriesProof && (options.companionToken?.length !== 64 || !/^[a-f0-9]{64}$/.test(options.companionToken))) {
      return sendJson(res, 503, {
        error: isInboxRoute(method, path)
          ? "the Inbox requires Murage and its companion to be started together by the desktop app or murage start"
          : "cloud desktop access requires Murage and its companion to be started together by the desktop app or murage start",
      });
    }
```
Replace line 1359 with:
```ts
            ...(carriesProof ? { "x-murage-companion-token": options.companionToken! } : {}),
```
(`carriesProof` is in scope. It is declared at the same block level as the join checks, before `httpRequest`.)

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run companion/test/routes.test.ts companion/test/browser-inbox.test.ts companion/test/companion-authority.test.ts companion/test/browser.test.ts`
Expected: PASS. `companion-authority.test.ts` still shows the proof absent on `/api/bots` and `/api/events`.
- [ ] **Step 5: Commit**
`git add companion/src/routes.ts companion/src/browser.ts companion/test/routes.test.ts companion/test/browser-inbox.test.ts`
`git commit -m "feat(companion): the Inbox reaches the browser door, carrying the launch proof"`

---

### Task C3: Pairing-window client for the installer (`installer/lib/pair.mjs`)

**Files:**
- Create: `installer/lib/pair.mjs`
- Test: `installer/test/pair.test.mjs`

**Interfaces:**
- Consumes: the companion control page `POST /pairing` → 201 `{ ...companionState, code, token }`, where the state carries `pairing.expiresAt`, `browser: {scheme,host,port}|null` and `devices[]` (`companion/src/control.ts:208-250,339-349`). Also `GET /state` and `DELETE /pairing?expectedToken=` (`control.ts:314,350-354`). The control page admits a request with no `Origin` (`control.ts:305-308`). The control port is `MURAGE_CONTROL_PORT`, default 8811, parsed like `companion/src/index.ts:90-98` `num()`.
- Produces:
  - `DEFAULT_CONTROL_PORT = 8811`
  - `controlPort(env): number`
  - `pairingLink(door, token): string | null`, the same rules as `src/lib/companion-pairing.ts:379-397`
  - `openPairing({ port, send? }): Promise<{ ok: true, token, code, expiresAt, link, door, origin } | { ok: false, reason }>`
  - `closePairing({ port, token, send? }): Promise<boolean>`
  - `expiryText(expiresAt, now): string`
  - `watchPairing({ port, token, expiresAt, openedAt, signal?, onTick?, now?, sleep?, send?, intervalMs? }): Promise<{ outcome: "paired", device: string } | { outcome: "expired" | "replaced" | "closed" | "unreachable" | "cancelled" }>`
  - `controlRequest(port, method, path, timeoutMs): Promise<{ status: number, body: any }>`

- [ ] **Step 1: Write the failing test**
```js
/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { closePairing, controlPort, expiryText, openPairing, pairingLink, watchPairing } from "../lib/pair.mjs";

const TOKEN = `murage_pair_${"A".repeat(43)}`;
const DOOR = { scheme: "https", host: "box.tail1234.ts.net", port: 443 };

/** A control page that answers like `companion/src/control.ts`, and records
 * what it was sent. */
async function fakeControl(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, origin: req.headers.origin, host: req.headers.host });
    const [status, body] = handler(req);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("the control port follows MURAGE_CONTROL_PORT, and falls back the way the companion does", () => {
  assert.equal(controlPort({}), 8811);
  assert.equal(controlPort({ MURAGE_CONTROL_PORT: "9911" }), 9911);
  for (const bad of ["", "0", "65536", "80.5", "eighty"]) assert.equal(controlPort({ MURAGE_CONTROL_PORT: bad }), 8811, bad);
});

test("the link is the desktop's link: /enter with the token in the fragment", () => {
  assert.equal(pairingLink(DOOR, TOKEN), `https://box.tail1234.ts.net/enter#${TOKEN}`);
  assert.equal(pairingLink({ scheme: "http", host: "box.tail1234.ts.net", port: 8813 }, TOKEN), `http://box.tail1234.ts.net:8813/enter#${TOKEN}`);
  assert.equal(pairingLink({ scheme: "http", host: "fd7a:115c::1", port: 8813 }, TOKEN), `http://[fd7a:115c::1]:8813/enter#${TOKEN}`);
});

test("no link rather than a link to somewhere else", () => {
  assert.equal(pairingLink(null, TOKEN), null);
  assert.equal(pairingLink(DOOR, "murage_pair_short"), null);
  for (const host of ["evil.example@box", "box/other", "box?x", "box#y", " "]) {
    assert.equal(pairingLink({ ...DOOR, host }, TOKEN), null, host);
  }
  assert.equal(pairingLink({ ...DOOR, scheme: "ftp" }, TOKEN), null);
  assert.equal(pairingLink({ ...DOOR, port: 0 }, TOKEN), null);
});

test("opens the window with a loopback POST that carries no Origin", async () => {
  const expiresAt = Date.now() + 600_000;
  const control = await fakeControl(() => [201, { browser: DOOR, devices: [], pairing: { code: "123456", token: TOKEN, expiresAt }, code: "123456", token: TOKEN }]);
  try {
    const opened = await openPairing({ port: control.port });
    assert.deepEqual(opened, { ok: true, token: TOKEN, code: "123456", expiresAt, door: DOOR,
      link: `https://box.tail1234.ts.net/enter#${TOKEN}`, origin: "https://box.tail1234.ts.net" });
    assert.equal(control.seen[0].method, "POST");
    assert.equal(control.seen[0].url, "/pairing");
    // The control page refuses any Origin that is not its own page's; a CLI
    // must send none at all.
    assert.equal(control.seen[0].origin, undefined);
    assert.equal(control.seen[0].host, `127.0.0.1:${control.port}`);
  } finally { await control.close(); }
});

test("passes the companion's own refusal through, word for word", async () => {
  const control = await fakeControl(() => [503, { error: "Phone pairing is paused because devices.json could not be read." }]);
  try {
    const opened = await openPairing({ port: control.port });
    assert.equal(opened.ok, false);
    assert.match(opened.reason, /Phone pairing is paused because devices\.json could not be read\./);
  } finally { await control.close(); }
});

test("says `murage start` when nothing is listening", async () => {
  const control = await fakeControl(() => [201, {}]);
  const port = control.port;
  await control.close();
  const opened = await openPairing({ port });
  assert.equal(opened.ok, false);
  assert.match(opened.reason, /murage start/);
});

test("refuses an answer that is not a pairing window, rather than printing it", async () => {
  for (const body of [
    { token: "murage_pair_short", code: "123456", pairing: { expiresAt: Date.now() + 1 }, browser: DOOR },
    { token: TOKEN, code: "12345", pairing: { expiresAt: Date.now() + 1 }, browser: DOOR },
    { token: TOKEN, code: "123456", pairing: null, browser: DOOR },
  ]) {
    const control = await fakeControl(() => [201, body]);
    try { assert.equal((await openPairing({ port: control.port })).ok, false, JSON.stringify(body)); }
    finally { await control.close(); }
  }
});

test("an open window with no door is not a link", async () => {
  const control = await fakeControl(() => [201, { browser: null, devices: [], code: "123456", token: TOKEN, pairing: { code: "123456", token: TOKEN, expiresAt: Date.now() + 600_000 } }]);
  try {
    const opened = await openPairing({ port: control.port });
    assert.equal(opened.ok, true);
    assert.equal(opened.link, null);
    assert.equal(opened.origin, null);
  } finally { await control.close(); }
});

test("closing names the window it means, so it cannot close a newer one", async () => {
  const control = await fakeControl(() => [200, {}]);
  try {
    assert.equal(await closePairing({ port: control.port, token: TOKEN }), true);
    assert.equal(control.seen[0].method, "DELETE");
    assert.equal(control.seen[0].url, `/pairing?expectedToken=${encodeURIComponent(TOKEN)}`);
  } finally { await control.close(); }
});

test("the countdown reads as minutes and seconds, and ends", () => {
  assert.equal(expiryText(600_000, 0), "Expires in 10:00.");
  assert.equal(expiryText(61_400, 0), "Expires in 1:02.");
  assert.equal(expiryText(1_000, 0), "Expires in 0:01.");
  assert.equal(expiryText(0, 0), "This code has expired.");
  assert.equal(expiryText(0, 5_000), "This code has expired.");
});

/** `watchPairing` against a scripted `/state`, a fake clock and no sleeping. */
function scripted(states, { start = 1_000 } = {}) {
  let clock = start;
  const ticks = [];
  return {
    ticks,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    onTick: (text) => ticks.push(text),
    send: async () => {
      const next = states.length > 1 ? states.shift() : states[0];
      if (next instanceof Error) throw next;
      return { status: 200, body: next };
    },
  };
}

test("reports the device that paired through this window", async () => {
  const s = scripted([
    { pairing: { token: TOKEN }, devices: [{ name: "Old", createdAt: 10 }] },
    { pairing: null, devices: [{ name: "Old", createdAt: 10 }, { name: "Sean's iPhone", createdAt: 3_500 }] },
  ]);
  const result = await watchPairing({ port: 1, token: TOKEN, expiresAt: 601_000, openedAt: 1_000, intervalMs: 2_000, ...s });
  assert.deepEqual(result, { outcome: "paired", device: "Sean's iPhone" });
  assert.equal(s.ticks[0], "Expires in 10:00.");
});

test("expires on the clock even if the companion still shows the window", async () => {
  const s = scripted([{ pairing: { token: TOKEN }, devices: [] }]);
  const result = await watchPairing({ port: 1, token: TOKEN, expiresAt: 7_000, openedAt: 1_000, intervalMs: 2_000, ...s });
  assert.deepEqual(result, { outcome: "expired" });
});

test("tells a replaced window apart from a closed one", async () => {
  const replaced = scripted([{ pairing: { token: `murage_pair_${"B".repeat(43)}` }, devices: [] }]);
  assert.deepEqual(await watchPairing({ port: 1, token: TOKEN, expiresAt: 601_000, openedAt: 1_000, ...replaced }), { outcome: "replaced" });
  const closed = scripted([{ pairing: null, devices: [] }]);
  assert.deepEqual(await watchPairing({ port: 1, token: TOKEN, expiresAt: 601_000, openedAt: 1_000, ...closed }), { outcome: "closed" });
});

test("gives up after three unanswered polls, not one", async () => {
  const s = scripted([new Error("ECONNREFUSED"), new Error("ECONNREFUSED"), { pairing: { token: TOKEN }, devices: [] }, new Error("x")]);
  // One recovered miss does not end the wait; the clock ends it instead.
  const result = await watchPairing({ port: 1, token: TOKEN, expiresAt: 9_000, openedAt: 1_000, intervalMs: 2_000, ...s });
  assert.deepEqual(result, { outcome: "expired" });
  const dead = scripted([new Error("ECONNREFUSED")]);
  assert.deepEqual(await watchPairing({ port: 1, token: TOKEN, expiresAt: 601_000, openedAt: 1_000, ...dead }), { outcome: "unreachable" });
});

test("stops when asked to", async () => {
  const controller = new AbortController();
  controller.abort();
  const s = scripted([{ pairing: { token: TOKEN }, devices: [] }]);
  assert.deepEqual(await watchPairing({ port: 1, token: TOKEN, expiresAt: 601_000, openedAt: 1_000, signal: controller.signal, ...s }), { outcome: "cancelled" });
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `node --test installer/test/pair.test.mjs`
Expected: FAIL with `Cannot find module '.../installer/lib/pair.mjs'`.
- [ ] **Step 3: Write minimal implementation**

Create `installer/lib/pair.mjs`:
```js
/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * `murage pair`: open a pairing window on this box's own companion, and hand
 * back what a phone needs: the `/enter#<token>` link for the QR, and the six
 * digits for a phone that types instead.
 *
 * The window is opened through the companion's loopback control page
 * (`companion/src/control.ts`, `POST /pairing`), the same call the desktop app
 * makes over IPC. That page refuses any request whose Origin is not its own
 * page's, so this client uses `node:http` and sends no Origin at all — the
 * case the page already admits for clients that are not browsers. `fetch` is
 * not used for the write: whether it adds an Origin is the runtime's
 * business, and a runtime that sent `Origin: null` would be refused.
 */

import { request } from "node:http";

export const DEFAULT_CONTROL_PORT = 8811;
const TOKEN = /^murage_pair_[A-Za-z0-9_-]{43}$/;
const CODE = /^\d{6}$/;
const DEFAULT_PORT = { http: 80, https: 443 };

/**
 * The control page's port, parsed the way `companion/src/index.ts` `num()`
 * parses it: anything that is not a usable port is the default.
 * @param {Record<string, string | undefined>} env
 */
export function controlPort(env = process.env) {
  const parsed = Number(env.MURAGE_CONTROL_PORT);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_CONTROL_PORT;
}

/**
 * The QR link, by the desktop's rules (`src/lib/companion-pairing.ts`
 * `companionBrowserLink`). Null rather than a link that opens somewhere else:
 * the host comes from another process, and one `@` or `/` in it turns the
 * address a phone opens into a different machine's.
 * @param {{ scheme: string, host: string, port: number } | null | undefined} door
 * @param {string | null | undefined} token
 */
export function pairingLink(door, token) {
  const origin = doorOrigin(door);
  if (!origin || !token || !TOKEN.test(token)) return null;
  return `${origin}/enter#${token}`;
}

/** @param {{ scheme: string, host: string, port: number } | null | undefined} door */
function doorOrigin(door) {
  if (!door || (door.scheme !== "http" && door.scheme !== "https")) return null;
  if (!Number.isInteger(door.port) || door.port < 1 || door.port > 65_535) return null;
  const host = String(door.host ?? "").trim();
  if (!host || /[\s/\\?#@]/.test(host)) return null;
  const dialable = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const port = door.port === DEFAULT_PORT[door.scheme] ? "" : `:${door.port}`;
  return `${door.scheme}://${dialable}${port}`;
}

/**
 * One request to the control page, JSON back. Bounded in time and size: a
 * squatter on the port must not be able to hang or flood the CLI.
 * @param {number} port @param {string} method @param {string} path @param {number} timeoutMs
 * @returns {Promise<{ status: number, body: any }>}
 */
export function controlRequest(port, method, path, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, timeout: timeoutMs, headers: { accept: "application/json" } }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > 1_000_000) req.destroy(new Error("the control page's answer was too large"));
        else chunks.push(chunk);
      });
      res.on("end", () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; }
        resolve({ status: res.statusCode ?? 0, body });
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Open a pairing window. Replaces any window already open, exactly as the
 * desktop's "Create a new code" does (`devices.ts` `openPairing`).
 * @param {{ port: number, send?: typeof controlRequest }} opts
 */
export async function openPairing({ port, send = controlRequest }) {
  let answer;
  try {
    answer = await send(port, "POST", "/pairing", 5_000);
  } catch {
    return { ok: false, reason: `nothing answered on the companion's control page, 127.0.0.1:${port}. Is \`murage start\` running?` };
  }
  const body = answer.body ?? {};
  if (answer.status !== 201) {
    const said = typeof body.error === "string" ? body.error : `HTTP ${answer.status}`;
    return { ok: false, reason: `the companion did not open a pairing window: ${said}` };
  }
  const { token, code } = body;
  const expiresAt = body.pairing?.expiresAt;
  if (typeof token !== "string" || !TOKEN.test(token) || typeof code !== "string" || !CODE.test(code) || !Number.isSafeInteger(expiresAt)) {
    return { ok: false, reason: "something answered on the companion's control page, but not with a pairing window" };
  }
  const door = body.browser ?? null;
  return { ok: true, token, code, expiresAt, door, link: pairingLink(door, token), origin: doorOrigin(door) };
}

/**
 * Close the window this run opened, and only that one: a newer window opened
 * on the desktop in the meantime is left alone (`expectedToken`).
 * @param {{ port: number, token: string, send?: typeof controlRequest }} opts
 */
export async function closePairing({ port, token, send = controlRequest }) {
  try {
    const answer = await send(port, "DELETE", `/pairing?expectedToken=${encodeURIComponent(token)}`, 5_000);
    return answer.status === 200;
  } catch {
    return false;
  }
}

/** @param {number} expiresAt @param {number} now */
export function expiryText(expiresAt, now = Date.now()) {
  const left = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  if (left === 0) return "This code has expired.";
  return `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}.`;
}

/** A sleep an abort wakes, so Ctrl-C does not wait out a poll interval.
 * @param {number} ms @param {AbortSignal} [signal] */
const pause = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(undefined); }, { once: true });
});

/**
 * Wait for the window to end, and say how.
 *
 * "Paired" is a device created after this window opened, rather than a count
 * that went up: re-pairing the same install replaces its record (spec §3.3),
 * which leaves the count where it was.
 * @param {{ port: number, token: string, expiresAt: number, openedAt: number, signal?: AbortSignal,
 *   onTick?: (text: string) => void, now?: () => number, sleep?: (ms: number, signal?: AbortSignal) => Promise<unknown>,
 *   send?: typeof controlRequest, intervalMs?: number }} opts
 */
export async function watchPairing({ port, token, expiresAt, openedAt, signal, onTick = () => {}, now = Date.now,
  sleep = pause, send = controlRequest, intervalMs = 2_000 }) {
  let misses = 0;
  for (;;) {
    if (signal?.aborted) return { outcome: "cancelled" };
    onTick(expiryText(expiresAt, now()));
    let state = null;
    try {
      state = (await send(port, "GET", "/state", 5_000)).body ?? {};
      misses = 0;
    } catch {
      if (++misses >= 3) return { outcome: "unreachable" };
    }
    if (state) {
      if (state.pairing?.token !== token) {
        const devices = Array.isArray(state.devices) ? state.devices : [];
        const fresh = devices.filter((device) => Number(device?.createdAt) >= openedAt)
          .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))[0];
        if (fresh) return { outcome: "paired", device: typeof fresh.name === "string" && fresh.name ? fresh.name : "a new device" };
        if (state.pairing) return { outcome: "replaced" };
        return { outcome: now() >= expiresAt ? "expired" : "closed" };
      }
    }
    if (now() >= expiresAt) return { outcome: "expired" };
    await sleep(intervalMs, signal);
  }
}
```
- [ ] **Step 4: Run test to verify it passes**
Run: `node --test installer/test/pair.test.mjs`
Expected: PASS (all tests).
- [ ] **Step 5: Commit**
`git add installer/lib/pair.mjs installer/test/pair.test.mjs`
`git commit -m "feat(installer): a client for the companion's pairing window"`

---

### Task C4: `murage pair` command

**Files:**
- Modify: `installer/bin/murage.mjs:32-47` (imports), `installer/bin/murage.mjs:1009-1017` (`printQr` fallback wording), `installer/bin/murage.mjs:1351-1356` (`resolveStatusPaths` names its caller), new `pair()` after `resetpass()` (ends ~1500), help at `:1507-1511`, dispatch at `:1553-1556`
- Test: `installer/test/cli.test.mjs`

**Interfaces:**
- Consumes: C3 (`openPairing`, `closePairing`, `watchPairing`, `expiryText`, `controlPort`). Also `probeDoor`, `readDoorNonce` and `deploymentOwner` (`installer/lib/door-identity.mjs`), `DOOR_PORT` (`murage.mjs:80`), `INSTALLER_VERSION` (`:223`), `qrBlock` (`installer/lib/ui.mjs:181-192`) through `printQr`, and `EXIT` (`installer/lib/unattended.mjs:34`).
- Produces: `murage pair [--no-wait] [--service-user <account>]`. Exit codes:
  - 0: paired, or `--no-wait` printed a live window
  - 1: the door is not this deployment's or is not running, or the window expired, was replaced, was closed or became unreachable
  - 2: usage
  - 130: Ctrl-C (the window is closed)

  It never prints the token-bearing URL as text. It prints only the QR, the door's origin and the 6-digit code.

- [ ] **Step 1: Write the failing test**
Append to `installer/test/cli.test.mjs`. Extend the imports to `import { execFileSync, spawnSync } from "node:child_process";` and add `import { createServer } from "node:net";`.
```js
/** A port nothing is listening on, for a run that must find nothing there. */
async function deadPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("help lists `murage pair`", () => {
  const out = execFileSync(process.execPath, [CLI, "help"], { encoding: "utf8", timeout: 20_000 });
  assert.match(out, /murage pair/);
  assert.match(out, /--no-wait/);
});

test("pair refuses when this deployment's door is not running, and opens nothing", async () => {
  const dir = scratch();
  const run = spawnSync(process.execPath, [CLI, "pair"], {
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      MURAGE_DATA_DIR: dir,
      MURAGE_ENV_FILE: join(dir, "murage.env"),
      MURAGE_BROWSER_PORT: String(await deadPort()),
      MURAGE_CONTROL_PORT: String(await deadPort()),
      NO_COLOR: "1",
    },
  });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /murage start/);
  assert.ok(!/murage_pair_/.test(run.stdout + run.stderr), "no pairing token may reach the terminal");
});

test("pair refuses a stray argument, and says pair rather than setup", () => {
  const run = spawnSync(process.execPath, [CLI, "pair", "--bogus"], { encoding: "utf8", timeout: 20_000, env: { ...process.env, NO_COLOR: "1" } });
  assert.equal(run.status, 2);
  assert.match(run.stdout, /pair does not take/);
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `node --test installer/test/cli.test.mjs`
Expected: FAIL. `help` does not match `/murage pair/`, and the `pair` runs print help and exit 0 (the unknown-subcommand branch at `murage.mjs:1560`).
- [ ] **Step 3: Write minimal implementation**

`installer/bin/murage.mjs` imports: after line 35 add
```js
import { closePairing, controlPort, expiryText, openPairing, watchPairing } from "../lib/pair.mjs";
```
`resolveStatusPaths` (line 1351). Name the caller in the refusal. Change the signature and the first `fail`:
```js
function resolveStatusPaths(argv, serviceUserFromEnv = null, command = "status") {
  const parsed = parseSetupArgs(argv);
  if (parsed.error) {
    fail(parsed.error.replace("setup does not take", `${command} does not take`));
    process.exit(EXIT.USAGE);
  }
```
(The `status` call site at line 1382 is unchanged, because the default keeps its wording.)

Add after `resetpass()`:
```js
/**
 * Pair a phone with a headless box: open a pairing window on this box's
 * companion and show the QR and the six digits, then wait for the phone.
 *
 * The door has to prove it is this deployment's before anything is opened —
 * the same proof `murage status` asks for. The control page it then talks to
 * is loopback-only and belongs to the same sidecar; refusing to go further
 * against an unproven door means a squatter on these ports cannot get a QR
 * of its choosing printed on the owner's terminal.
 *
 * The token-bearing link is never printed as text. The QR carries it, the
 * way the desktop's does; scrollback and a provisioning log do not.
 * @param {string[]} argv everything after `pair`
 */
async function pair(argv = []) {
  heading("Murage — pair a phone");
  const mode = unattendedMode(argv, "murage pair");
  const wait = !mode.rest.includes("--no-wait");
  const { dataDir, envFile } = resolveStatusPaths(mode.rest.filter((arg) => arg !== "--no-wait"), process.env.MURAGE_SERVICE_USER?.trim() || null, "pair");
  const env = { ...process.env, ...readEnvFile(envFile) };
  const dir = env.MURAGE_DATA_DIR || dataDir;

  const recorded = readDoorNonce(dir, { owner: deploymentOwner(dir) });
  const door = await probeDoor({ port: DOOR_PORT, nonce: recorded.nonce, nonceError: recorded.error ?? undefined, version: INSTALLER_VERSION });
  if (!(door.answered && door.identity === "match" && door.ready)) {
    fail(`this deployment's browser door is not running on ${c.dim(`127.0.0.1:${DOOR_PORT}`)}${door.reason ? ` (${door.reason})` : ""}.`);
    console.log(c.dim("  Start it with `murage start`, then run `murage pair` again.\n"));
    process.exit(EXIT.ENVIRONMENT);
  }

  const port = controlPort(env);
  const opened = await openPairing({ port });
  if (!opened.ok) {
    fail(opened.reason);
    process.exit(EXIT.ENVIRONMENT);
  }
  if (!opened.link) {
    await closePairing({ port, token: opened.token });
    fail("the browser door has no address a phone can open yet, so there is nothing to scan.");
    console.log(c.dim("  Check `murage status`: the tailnet has to be up and the proxy in front of the door.\n"));
    process.exit(EXIT.ENVIRONMENT);
  }

  console.log("  Scan this with the phone's camera, or with the Murage app:\n");
  printQr(opened.link);
  console.log(`\n  No camera? Open ${c.o(opened.origin)} on the phone and type this code:\n`);
  console.log(`      ${c.b(opened.code)}\n`);
  if (opened.door?.scheme === "http") {
    warn("that address is plain HTTP. A browser on your tailnet can use it; the Murage phone app needs the HTTPS address `murage setup` puts in front.");
  }
  const at = new Date(opened.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  console.log(c.dim(`  The phone must be signed into the same tailnet as this box. The code works once.`));
  console.log(c.dim(`  ${expiryText(opened.expiresAt)} (at ${at})\n`));

  if (!wait) {
    console.log(c.dim("  The window stays open until a phone uses it or it expires. Running `murage pair` again replaces it.\n"));
    return;
  }

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  const tty = Boolean(process.stdout.isTTY);
  const result = await watchPairing({
    port, token: opened.token, expiresAt: opened.expiresAt, openedAt: Date.now() - 1_000, signal: controller.signal,
    // One line, rewritten in place, on a terminal. A log gets the line above
    // and the outcome below, not six hundred countdown lines.
    onTick: (text) => { if (tty) process.stdout.write(`\r  ${c.dim(text)}   `); },
  });
  process.removeListener("SIGINT", stop);
  if (tty) process.stdout.write("\n");

  if (result.outcome === "paired") {
    ok(`paired: ${c.b(result.device)}. It can open Murage now.\n`);
    return;
  }
  if (result.outcome === "cancelled") {
    await closePairing({ port, token: opened.token });
    warn("cancelled. That code no longer works.\n");
    process.exit(130);
  }
  const why = {
    expired: "that code expired before a phone used it.",
    replaced: "a newer pairing window was opened (on the desktop, or by another `murage pair`), so this code stopped working.",
    closed: "the pairing window was closed before a phone used it.",
    unreachable: "lost contact with the companion. Check `murage status`.",
  }[result.outcome];
  fail(why);
  console.log(c.dim("  Run `murage pair` again when the phone is ready.\n"));
  process.exit(EXIT.ENVIRONMENT);
}
```
`openedAt` is `Date.now() - 1_000` because the device record's `createdAt` is stamped by the sidecar's clock. A one-second margin absorbs the gap between opening and reading, and it cannot mistake any earlier device for this one.

Help (after the `murage status` lines, `murage.mjs:1510`):
```js
  ${c.b("murage pair")}        Pair a phone: show a QR and a 6-digit code, then wait for it
      ${c.dim("[--no-wait]")}  print the code and exit; the window stays open until used or expired
```
Dispatch (after line 1555, `status`):
```js
  else if (cmd === "pair") await pair(process.argv.slice(3));
```
`printQr` (line 1016): keep it as is. Its fallback already says to install `qrencode`, and `pair` prints the origin plus the code right after it, so the code route is always on screen.

- [ ] **Step 4: Run test to verify it passes**
Run: `node --test installer/test/cli.test.mjs installer/test/pair.test.mjs`
Expected: PASS.
Manual check on Hetzner, never on this Mac, per the golden rule:
1. Run `murage start` on a scratch lane box.
2. Run `murage pair` in a second shell. Expect a QR, the origin, 6 digits and a countdown.
3. Open `/enter` from a tailnet phone. The CLI prints `paired: …`.
4. Run it again and press Ctrl-C. The desktop panel shows no open window.
- [ ] **Step 5: Commit**
`git add installer/bin/murage.mjs installer/test/cli.test.mjs`
`git commit -m "feat(installer): murage pair shows a QR and a code for a headless box"`

---

### Task C5: Keep-awake only while a phone is paired (Electron)

**Files:**
- Create: `electron/companion-keep-awake.mjs`
- Modify: `electron/main.mjs:944-952` (`syncCompanionKeepAwake`), `:1147` (decorate), `:1332`, `:1343` and `:3812` (callers)
- Test: `electron/companion-keep-awake.test.mjs`

**Interfaces:**
- Consumes: the companion state shape `{ enabled, error?, keepAwake, devices[] }` (`electron/companion.mjs:504-534`). The existing IPC `companion:keep-awake` (`main.mjs:3144-3147`) already persists the setting and returns the decorated state, so it needs no change.
- Produces: `companionShouldStayAwake(state): boolean`, and `syncCompanionKeepAwake(shouldBlock: boolean)`, which now takes one argument.

- [ ] **Step 1: Write the failing test**
```js
// When the computer is held awake for the phones.
//
// The setting reads "Keep this computer awake while a phone is paired", so
// that is the rule: the owner asked, the sidecar is really up, and there is a
// phone to serve. Holding a laptop awake for a fleet of zero is a battery bill
// for nothing, and a sidecar that failed serves nobody.
import { describe, expect, it } from "vitest";

import { companionShouldStayAwake } from "./companion-keep-awake.mjs";

const phone = { id: "p", name: "Phone", createdAt: 1, lastSeenAt: 1, cloudDesktopAccess: false };
const state = (over = {}) => ({ enabled: true, keepAwake: true, devices: [phone], ...over });

describe("keeping the computer awake", () => {
  it("holds it awake when asked, running, and a phone is paired", () => {
    expect(companionShouldStayAwake(state())).toBe(true);
  });

  it("lets it sleep when the owner has not asked", () => {
    expect(companionShouldStayAwake(state({ keepAwake: false }))).toBe(false);
  });

  it("lets it sleep when no phone is paired", () => {
    expect(companionShouldStayAwake(state({ devices: [] }))).toBe(false);
  });

  it("lets it sleep when the sidecar is off or failed", () => {
    expect(companionShouldStayAwake(state({ enabled: false }))).toBe(false);
    expect(companionShouldStayAwake(state({ error: "sidecar stopped responding" }))).toBe(false);
  });

  it("fails towards sleep on anything it cannot read", () => {
    expect(companionShouldStayAwake(null)).toBe(false);
    expect(companionShouldStayAwake(undefined)).toBe(false);
    expect(companionShouldStayAwake(state({ keepAwake: "yes" }))).toBe(false);
    expect(companionShouldStayAwake(state({ devices: undefined }))).toBe(false);
  });
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run electron/companion-keep-awake.test.mjs`
Expected: FAIL with `Failed to resolve import "./companion-keep-awake.mjs"`.
- [ ] **Step 3: Write minimal implementation**

Create `electron/companion-keep-awake.mjs`:
```js
// The one rule for holding the computer awake on the phones' behalf. Kept out
// of main.mjs so it can be tested without Electron; main.mjs owns the power
// blocker itself.

/** Whether the computer should be held awake for the phones.
 *
 * All three, or no: the owner asked (`keepAwake`, an explicit opt-in, never
 * inferred), the sidecar is actually up, and at least one device is paired.
 * Unreadable input answers no — the failure mode of a wrong yes is a laptop
 * that never sleeps.
 * @param {{ enabled?: unknown, error?: unknown, keepAwake?: unknown, devices?: unknown } | null | undefined} state */
export function companionShouldStayAwake(state) {
  return Boolean(
    state
      && state.enabled === true
      && !state.error
      && state.keepAwake === true
      && Array.isArray(state.devices)
      && state.devices.length > 0,
  );
}
```
In `electron/main.mjs`, add next to the other companion imports (the block ending ~line 935):
```js
import { companionShouldStayAwake } from "./companion-keep-awake.mjs";
```
Replace `syncCompanionKeepAwake` (lines 944-952) with:
```js
function syncCompanionKeepAwake(shouldBlock) {
  if (shouldBlock && companionPowerBlocker === null) {
    companionPowerBlocker = powerSaveBlocker.start("prevent-app-suspension");
  } else if (!shouldBlock && companionPowerBlocker !== null) {
    if (powerSaveBlocker.isStarted(companionPowerBlocker)) powerSaveBlocker.stop(companionPowerBlocker);
    companionPowerBlocker = null;
  }
}
```
Line 1147 becomes `syncCompanionKeepAwake(companionShouldStayAwake(state));`. Lines 1332, 1343 and 3812 become `syncCompanionKeepAwake(false);`. The stub at `electron/data-owner-integration.node-test.mjs:257` is `()=>{}`, so its arity does not matter.

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run electron/companion-keep-awake.test.mjs electron/companion-https-reconciliation.test.mjs`, then `pnpm test:electron`
Expected: PASS.
- [ ] **Step 5: Commit**
`git add electron/companion-keep-awake.mjs electron/companion-keep-awake.test.mjs electron/main.mjs`
`git commit -m "fix(companion): keep-awake holds the computer only while a phone is paired"`

---

### Task C6: Keep-awake offer in phone setup and the phone panel (web)

**Files:**
- Create: `src/lib/keep-awake.ts`, `src/components/KeepAwakeOffer.tsx`
- Modify: `src/components/PhoneSetupFlow.tsx:1-58` (import) and `:1528-1548` (success phase), `src/components/CompanionSection.tsx:1-30` (import) and `:548-549` (Paired devices card)
- Test: `src/lib/keep-awake.test.ts`

**Interfaces:**
- Consumes: `CompanionBridge.keepAwake(enabled)` (`PhoneSetupFlow.tsx:224`, preload `electron/preload.cjs:169`), `PhoneSetupController.act` and `.busy` and `.state` (`PhoneSetupFlow.tsx:334-382`), and `Switch` (`src/components/SettingsPrimitives.tsx:5`). C5 makes the label true.
- Produces: `KEEP_AWAKE_LABEL`, `KEEP_AWAKE_DETAIL`, `keepAwakeOffer(state, busy): { checked: boolean; disabled: boolean } | null`, `keepAwakeCall(offer)`, and `<KeepAwakeOffer c className? />`.

- [ ] **Step 1: Write the failing test**
```ts
// The keep-awake offer.
//
// A phone reaches Murage through this computer, so a computer that has gone
// to sleep looks, from the phone, exactly like a broken app. The offer is how
// the owner finds out that is a choice. It must not overpromise: a laptop
// with its lid shut sleeps whatever an app asks, and the copy has to say so.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { CompanionBridge, CompanionState } from "@/components/PhoneSetupFlow";
import { KEEP_AWAKE_DETAIL, KEEP_AWAKE_LABEL, keepAwakeCall, keepAwakeOffer } from "./keep-awake";

const state = (over: Partial<CompanionState> = {}): CompanionState => ({
  enabled: true, keepAwake: false, port: 8810, devices: [], pairing: null, ...over,
});

describe("when the offer is made", () => {
  it("offers nothing while the sidecar is off or failed", () => {
    expect(keepAwakeOffer(null, false)).toBeNull();
    expect(keepAwakeOffer(state({ enabled: false }), false)).toBeNull();
    expect(keepAwakeOffer(state({ error: "sidecar stopped responding" }), false)).toBeNull();
  });

  it("mirrors the saved setting, and waits while something else is in flight", () => {
    expect(keepAwakeOffer(state(), false)).toEqual({ checked: false, disabled: false });
    expect(keepAwakeOffer(state({ keepAwake: true }), true)).toEqual({ checked: true, disabled: true });
  });

  it("flips the setting through the bridge, never anything else", async () => {
    const asked: boolean[] = [];
    const bridge = { keepAwake: async (enabled: boolean) => { asked.push(enabled); return state({ keepAwake: enabled }); } } as unknown as CompanionBridge;
    await keepAwakeCall({ checked: false, disabled: false })(bridge);
    await keepAwakeCall({ checked: true, disabled: false })(bridge);
    expect(asked).toEqual([true, false]);
  });
});

describe("what the offer says", () => {
  it("says what it does in the owner's words", () => {
    expect(KEEP_AWAKE_LABEL).toBe("Keep this computer awake while a phone is paired");
  });

  it("says a closed lid still sleeps the computer", () => {
    expect(KEEP_AWAKE_DETAIL).toMatch(/closing the lid still puts/i);
    expect(KEEP_AWAKE_DETAIL).toMatch(/phone/);
  });
});

describe("where the offer is made", () => {
  const source = (file: string) => readFileSync(fileURLToPath(new URL(`../components/${file}`, import.meta.url)), "utf8");

  it("is on the screen that says the device is ready", () => {
    const flow = source("PhoneSetupFlow.tsx");
    const start = flow.indexOf('c.phase === "success"');
    expect(flow.slice(start, flow.indexOf("return (\n    <div className=\"flex flex-col items-center text-center\">", start))).toContain("<KeepAwakeOffer");
  });

  it("stays reachable afterwards, next to the paired devices", () => {
    const panel = source("CompanionSection.tsx");
    const start = panel.indexOf('title="Paired devices"');
    expect(panel.slice(start, panel.indexOf('<Card title="Recent activity">', start))).toContain("<KeepAwakeOffer");
  });
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run src/lib/keep-awake.test.ts`
Expected: FAIL with `Failed to resolve import "./keep-awake"`.
- [ ] **Step 3: Write minimal implementation**

Create `src/lib/keep-awake.ts`:
```ts
// The keep-awake offer, as data. The switch itself lives in
// `components/KeepAwakeOffer.tsx`; the rule for when the computer is actually
// held awake lives in the main process (`electron/companion-keep-awake.mjs`),
// because only it owns the power blocker.
import type { CompanionBridge, CompanionState } from "@/components/PhoneSetupFlow";

export const KEEP_AWAKE_LABEL = "Keep this computer awake while a phone is paired";

/** Honest about the one thing an app cannot override. `prevent-app-
 *  suspension` stops idle sleep; a shut lid on battery sleeps regardless. */
export const KEEP_AWAKE_DETAIL =
  "Your phone reaches Murage through this computer, so it can’t answer while the computer is asleep. "
  + "This stops it going to sleep on its own. Closing the lid still puts a laptop to sleep.";

export interface KeepAwakeOffer { checked: boolean; disabled: boolean }

/** Null while there is nothing it would do: no sidecar, or a failed one. */
export function keepAwakeOffer(state: CompanionState | null, busy: boolean): KeepAwakeOffer | null {
  if (!state?.enabled || state.error) return null;
  return { checked: state.keepAwake === true, disabled: busy };
}

export function keepAwakeCall(offer: KeepAwakeOffer) {
  return (companion: CompanionBridge) => companion.keepAwake(!offer.checked);
}
```
Create `src/components/KeepAwakeOffer.tsx`:
```tsx
import { KEEP_AWAKE_DETAIL, KEEP_AWAKE_LABEL, keepAwakeCall, keepAwakeOffer } from "../lib/keep-awake";
import type { PhoneSetupController } from "./PhoneSetupFlow";
import { Switch } from "./SettingsPrimitives";

/** The opt-in, wherever a phone has just been, or already is, paired. */
export function KeepAwakeOffer({ c, className = "" }: { c: PhoneSetupController; className?: string }) {
  const offer = keepAwakeOffer(c.state, c.busy);
  if (!offer) return null;
  return (
    <div className={`flex items-center justify-between gap-4 text-left ${className}`}>
      <div className="min-w-0">
        <div className="text-[13px] text-ink">{KEEP_AWAKE_LABEL}</div>
        <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">{KEEP_AWAKE_DETAIL}</div>
      </div>
      <Switch
        checked={offer.checked}
        aria-label={KEEP_AWAKE_LABEL}
        disabled={offer.disabled}
        onClick={() => void c.act(keepAwakeCall(offer))}
      />
    </div>
  );
}
```
In `src/components/PhoneSetupFlow.tsx`, add `import { KeepAwakeOffer } from "./KeepAwakeOffer";` after line 58 (`import { ConnectionDetail } …`). In the success phase, insert this between the `<p>` ending "…send new work." (line ~1537) and the Done `<button>`:
```tsx
        <KeepAwakeOffer c={c} className="mt-5 w-full max-w-[420px] rounded-xl border border-hairline/50 px-3 py-3" />
```
In `src/components/CompanionSection.tsx`, add `import { KeepAwakeOffer } from "./KeepAwakeOffer";` after line 30. In the "Paired devices" `<Card>`, after the closing `)}` of the `{pairedCount > 0 && (<ul …>)}` block (line 549) and before `</Card>`, add:
```tsx
        {pairedCount > 0 && <KeepAwakeOffer c={c} className="mt-3 border-t border-hairline/30 pt-3" />}
```
- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run src/lib/keep-awake.test.ts src/components/PhoneSetupFlow.test.ts src/components/CompanionSection.test.ts`, then `pnpm typecheck`
Expected: PASS.
- [ ] **Step 5: Commit**
`git add src/lib/keep-awake.ts src/lib/keep-awake.test.ts src/components/KeepAwakeOffer.tsx src/components/PhoneSetupFlow.tsx src/components/CompanionSection.tsx`
`git commit -m "feat(phone): offer to keep this computer awake while a phone is paired"`

---

### Task C7: The serve failure names the exact admin page (Electron)

**Files:**
- Modify: `electron/companion-remote-access.mjs:248-289` (`classifyServeFailure`) plus a new exported constant
- Test: `electron/companion-remote-access.test.mjs` (extend `describe("failure gets a reason, not a shrug")` at line 128)

**Interfaces:**
- Consumes: none new.
- Produces: `export const TAILSCALE_DNS_ADMIN_URL = "https://login.tailscale.com/admin/dns"`. The `no-certificates` message now contains that URL. A `failed` message now appends a `https://login.tailscale.com/…` URL when Tailscale printed one on a later stderr line.

- [ ] **Step 1: Write the failing test**
Add inside `describe("failure gets a reason, not a shrug", …)`. Add `TAILSCALE_DNS_ADMIN_URL` to the import list at line 16.
```js
  it("names the exact page where HTTPS certificates are turned on", () => {
    const { message } = classifyServeFailure("HTTPS is disabled for your tailnet; enable HTTPS in the admin console");
    expect(TAILSCALE_DNS_ADMIN_URL).toBe("https://login.tailscale.com/admin/dns");
    expect(message).toContain(TAILSCALE_DNS_ADMIN_URL);
    expect(message).toContain("Enable HTTPS");
    expect(message).toContain("MagicDNS");
  });

  it("keeps the link Tailscale itself printed, even when it is not on the first line", () => {
    const { reason, message } = classifyServeFailure(
      "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=nABC123\n",
    );
    expect(reason).toBe("failed");
    expect(message).toContain("Serve is not enabled on your tailnet.");
    expect(message).toContain("https://login.tailscale.com/f/serve?node=nABC123");
  });

  it("never echoes a link to anywhere but Tailscale's own console", () => {
    const { message } = classifyServeFailure("something odd\nvisit https://login.tailscale.com.evil.example/steal and https://example.com/x");
    expect(message).not.toContain("evil.example");
    expect(message).not.toContain("example.com/x");
  });
```
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run electron/companion-remote-access.test.mjs -t "failure gets a reason"`
Expected: FAIL. `TAILSCALE_DNS_ADMIN_URL` is undefined, and the `failed` message is only `…: Serve is not enabled on your tailnet.`.
- [ ] **Step 3: Write minimal implementation**
In `electron/companion-remote-access.mjs`, directly above `classifyServeFailure` (line 248) add:
```js
/** Where a tailnet's HTTPS certificates are switched on. One place, so the
 * desktop copy (`src/lib/tailnet-https.ts`) and this message cannot drift. */
export const TAILSCALE_DNS_ADMIN_URL = "https://login.tailscale.com/admin/dns";

/** The first `https://login.tailscale.com/…` link in Tailscale's own output.
 * Newer CLIs answer a tailnet that has not allowed serve with a sentence on
 * one line and the link that fixes it three lines down; quoting only the
 * first line kept the sentence and dropped the fix. Anything not on
 * Tailscale's console host is left out: this text is shown to the owner as
 * advice. */
function tailscaleConsoleLink(text) {
  for (const match of String(text).matchAll(/https:\/\/[^\s"'<>]+/g)) {
    try {
      if (new URL(match[0]).hostname === "login.tailscale.com") return match[0];
    } catch {
      /* not a URL after all */
    }
  }
  return null;
}
```
Replace the `no-certificates` return (lines 264-271) with:
```js
    return {
      reason: "no-certificates",
      message:
        "Your tailnet does not have HTTPS certificates turned on, so Tailscale cannot give Murage a secure address. " +
        `Open the Tailscale admin console at ${TAILSCALE_DNS_ADMIN_URL}, make sure MagicDNS is on, and under ` +
        "HTTPS Certificates choose Enable HTTPS. Then turn this on again. " +
        "Browser access still works over plain HTTP on your tailnet in the meantime.",
    };
```
Replace the final fallthrough (lines 280-288) with:
```js
  const first = text.split("\n").map((line) => line.trim()).find(Boolean);
  const link = tailscaleConsoleLink(text);
  const said = first ? `Tailscale could not put a secure address in front of Murage: ${first}` : "Tailscale could not put a secure address in front of Murage.";
  return {
    reason: "failed",
    message: link && !(first ?? "").includes(link) ? `${said} Tailscale says to open ${link}` : said,
  };
```
- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run electron/companion-remote-access.test.mjs`
Expected: PASS. The existing `"names the tailnet certificate setting…"` test still passes because the message still contains "admin console" and "plain HTTP".
- [ ] **Step 5: Commit**
`git add electron/companion-remote-access.mjs electron/companion-remote-access.test.mjs`
`git commit -m "fix(companion): the HTTPS failure names the exact Tailscale page to fix it"`

---

### Task C8: Plain-language HTTPS setup steps in desktop phone setup (web)

**Files:**
- Create: `src/lib/tailnet-https.ts`, `src/components/TailnetHttpsHelp.tsx`
- Modify: `src/components/PhoneSetupFlow.tsx:1313-1318` (intro, under `WebUiReadinessPanel`), `src/components/CompanionSection.tsx:128-133` (`remoteAccessSummary`) and `:361-364` and `:474-479` (problem box)
- Test: `src/lib/tailnet-https.test.ts`, `src/components/CompanionSection.test.ts` (one new `it`)

**Interfaces:**
- Consumes: `CompanionRemoteAccess.reason === "no-certificates"` (`PhoneSetupFlow.tsx:117`), set by the main process from C7's classifier. `TAILSCALE_DNS_ADMIN_URL` from C7, for an agreement test only.
- Produces: `TAILSCALE_DNS_ADMIN_URL`, `tailnetHttpsHelp(remote): TailnetHttpsHelp | null`, and `<TailnetHttpsHelpCard help className? />`.

- [ ] **Step 1: Write the failing test**
`src/lib/tailnet-https.test.ts`:
```ts
// A tailnet without HTTPS certificates.
//
// `tailscale serve` cannot give Murage a secure address until the tailnet's
// owner flips one switch in the Tailscale admin console, and the phone app
// only opens HTTPS addresses. So this is the one setup failure the owner can
// always fix in a minute, and the screen has to say exactly where and how.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { CompanionRemoteAccess } from "@/components/PhoneSetupFlow";
import { TAILSCALE_DNS_ADMIN_URL as MAIN_PROCESS_URL } from "../../electron/companion-remote-access.mjs";
import { TAILSCALE_DNS_ADMIN_URL, tailnetHttpsHelp } from "./tailnet-https";

const remote = (over: Partial<CompanionRemoteAccess> = {}): CompanionRemoteAccess => ({
  on: false, desired: true, url: null, available: true, reason: null, problem: null, ...over,
});

describe("when the steps are shown", () => {
  it("shows them for a tailnet without certificates, and for nothing else", () => {
    expect(tailnetHttpsHelp(remote({ reason: "no-certificates" }))).not.toBeNull();
    for (const reason of [null, "missing", "logged-out", "conflict", "unsupported", "failed"] as const) {
      expect(tailnetHttpsHelp(remote({ reason })), String(reason)).toBeNull();
    }
    expect(tailnetHttpsHelp(null)).toBeNull();
  });

  it("stops showing them the moment the secure address is up", () => {
    expect(tailnetHttpsHelp(remote({ on: true, reason: "no-certificates" }))).toBeNull();
  });
});

describe("what the steps say", () => {
  const help = tailnetHttpsHelp(remote({ reason: "no-certificates" }))!;

  it("links the exact page, the same one the main process names", () => {
    expect(help.url).toBe("https://login.tailscale.com/admin/dns");
    expect(TAILSCALE_DNS_ADMIN_URL).toBe(MAIN_PROCESS_URL);
  });

  it("walks through the switch in the console's own words, then back here", () => {
    expect(help.steps.join(" ")).toContain("MagicDNS");
    expect(help.steps.join(" ")).toContain("Enable HTTPS");
    expect(help.steps.at(-1)).toMatch(/Allow remote access/);
  });

  it("says why it matters for the phone, and what still works meanwhile", () => {
    expect(help.after).toMatch(/phone app/);
    expect(help.after).toMatch(/browser/);
  });
});

describe("where the steps are shown", () => {
  const source = (file: string) => readFileSync(fileURLToPath(new URL(`../components/${file}`, import.meta.url)), "utf8");

  it("in phone setup, before the code is asked for", () => {
    const flow = source("PhoneSetupFlow.tsx");
    const start = flow.indexOf('c.phase === "intro"');
    expect(flow.slice(start, flow.indexOf('c.phase === "sign-in"', start))).toContain("<TailnetHttpsHelpCard");
  });

  it("in the phone panel, in place of the bare error", () => {
    expect(source("CompanionSection.tsx")).toContain("<TailnetHttpsHelpCard");
  });
});
```
Append to `src/components/CompanionSection.test.ts`. Add `remoteAccessSummary` to the `./CompanionSection` import.
```ts
describe("the remote access line when the tailnet has no certificates", () => {
  it("points at the steps rather than repeating the whole error above them", () => {
    const line = remoteAccessSummary({ on: false, desired: true, url: null, available: true, reason: "no-certificates",
      problem: "Your tailnet does not have HTTPS certificates turned on, so … https://login.tailscale.com/admin/dns …" }, null);
    expect(line).toBe("Off. Your tailnet needs HTTPS turned on first. The steps are below.");
  });
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run src/lib/tailnet-https.test.ts src/components/CompanionSection.test.ts`
Expected: FAIL. `./tailnet-https` does not resolve, and `remoteAccessSummary` returns the raw `problem`.
- [ ] **Step 3: Write minimal implementation**
Create `src/lib/tailnet-https.ts`:
```ts
// The one-time switch a tailnet needs before `tailscale serve` can give
// Murage a secure address, said as steps a person can follow. Shown only when
// the main process has diagnosed exactly this (`remoteAccess.reason`), never
// guessed at from here.
import type { CompanionRemoteAccess } from "@/components/PhoneSetupFlow";

/** The same page `electron/companion-remote-access.mjs` names; a test keeps
 *  the two equal. */
export const TAILSCALE_DNS_ADMIN_URL = "https://login.tailscale.com/admin/dns";

export interface TailnetHttpsHelp {
  title: string;
  steps: readonly string[];
  url: string;
  linkLabel: string;
  after: string;
}

export function tailnetHttpsHelp(remote: CompanionRemoteAccess | null | undefined): TailnetHttpsHelp | null {
  if (!remote || remote.on || remote.reason !== "no-certificates") return null;
  return {
    title: "Turn on HTTPS for your tailnet",
    steps: [
      "Open the DNS page of the Tailscale admin console and sign in with the account your tailnet uses.",
      "Make sure MagicDNS is on.",
      "Under HTTPS Certificates, choose Enable HTTPS.",
      "Come back here and turn on Allow remote access again.",
    ],
    url: TAILSCALE_DNS_ADMIN_URL,
    linkLabel: "Open Tailscale DNS settings",
    after:
      "It is a one-time switch for your whole tailnet. Until it is on, a browser on your tailnet can still open "
      + "Murage at its plain address, but the Murage phone app needs the secure one.",
  };
}
```
Create `src/components/TailnetHttpsHelp.tsx`:
```tsx
import { AlertTriangle } from "lucide-react";
import type { TailnetHttpsHelp } from "../lib/tailnet-https";

export function TailnetHttpsHelpCard({ help, className = "" }: { help: TailnetHttpsHelp; className?: string }) {
  return (
    <div className={`flex items-start gap-2.5 rounded-lg border border-hairline/40 px-3 py-2.5 text-left ${className}`}>
      <AlertTriangle size={15} className="mt-0.5 shrink-0 text-ink-secondary" />
      <div className="min-w-0 text-[11.5px] leading-relaxed text-ink-secondary">
        <div className="text-[12.5px] font-medium text-ink">{help.title}</div>
        <ol className="mt-1 list-decimal pl-4">
          {help.steps.map((step) => <li key={step}>{step}</li>)}
        </ol>
        <a href={help.url} target="_blank" rel="noreferrer" className="mt-1.5 inline-block text-accent hover:opacity-80">
          {help.linkLabel}
        </a>
        <span className="ml-1 font-mono text-[11px] text-ink-secondary">{help.url}</span>
        <p className="mt-1.5">{help.after}</p>
      </div>
    </div>
  );
}
```
In `src/components/PhoneSetupFlow.tsx`:
- Add imports after line 58: `import { TailnetHttpsHelpCard } from "./TailnetHttpsHelp";` and `import { tailnetHttpsHelp } from "../lib/tailnet-https";`.
- In the intro phase, after `const readiness = webUiReadiness(c);` (line 1303), add `const httpsHelp = tailnetHttpsHelp(c.remoteAccess);`.
- Directly after the `<WebUiReadinessPanel … />` element (ends line 1318), add:
```tsx
        {httpsHelp && <TailnetHttpsHelpCard help={httpsHelp} className="mt-3 w-full max-w-[420px]" />}
```
In `src/components/CompanionSection.tsx`:
- Add the same two imports after line 30.
- In `remoteAccessSummary`, before line 132 (`if (remote.problem) return remote.problem;`), add:
```ts
  if (remote.reason === "no-certificates") return "Off. Your tailnet needs HTTPS turned on first. The steps are below.";
```
- After line 364 (`const steps = webUiSteps(…)`), add `const httpsHelp = tailnetHttpsHelp(remote);`.
- Replace lines 474-479 (the `{!remote.on && remote.problem && (…)}` box) with:
```tsx
        {httpsHelp ? (
          <TailnetHttpsHelpCard help={httpsHelp} className="mt-4" />
        ) : (
          !remote.on && remote.problem && (
            <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-hairline/40 px-3 py-2.5">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-ink-secondary" />
              <div className="text-[11.5px] leading-relaxed text-ink-secondary">{remote.problem}</div>
            </div>
          )
        )}
```
The link uses `target="_blank"`, the same as the existing Tailscale guide link at `CompanionSection.tsx:417-424`, so it opens through the same external-link path.

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run src/lib/tailnet-https.test.ts src/components/CompanionSection.test.ts src/components/PhoneSetupFlow.test.ts src/lib/first-run-phone.test.ts`, then `pnpm typecheck`
Expected: PASS. If `tsc` complains about importing `.mjs` into a `.test.ts`, add `// @ts-expect-error untyped main-process module` above that single import line. It is the agreement test's only cross-boundary import.
- [ ] **Step 5: Commit**
`git add src/lib/tailnet-https.ts src/lib/tailnet-https.test.ts src/components/TailnetHttpsHelp.tsx src/components/PhoneSetupFlow.tsx src/components/CompanionSection.tsx src/components/CompanionSection.test.ts`
`git commit -m "feat(phone): step-by-step HTTPS setup when the tailnet has no certificates"`

---

## Notes for the plan author

1. **Why the Inbox proof is the launch token and not the marker (C1/C2).** `requestSurface` treats `x-murage-companion` only as a request for the narrow answer (`sse-visibility.ts:122-130,173-186`), and the file says the marker "is not a secret". If we granted `owner:true` on the marker, any local process, including a bot's own shell, could read and mark the owner's Inbox with a single `curl -H 'x-murage-companion: 1'`. `companionAuthorized` (`server/companion-authority.ts`) is the per-launch proof built for exactly this, and both launchers supply it (`electron/main.mjs:1579`, `installer/bin/murage.mjs:1142`). The cost: a sidecar started by hand without `MURAGE_COMPANION_TOKEN` gets a 503 on the Inbox, with a sentence, the same as cloud-desktop join does today (`browser.ts:1345-1347`).
2. **Two definitions of "visible" disagree on archived rooms.** `Store.visibleThreadIds()` (`server/store.ts:1358-1374`) excludes `group.hidden` (archived channels). `visibleToCompanion` (`sse-visibility.ts:367-370`) checks only `dm`. C1 uses `visibleToCompanion`, as the brief and spec §3.3 say, and that matches `mayReadThread` (`index.ts:10242-10245`). So an archived channel's approvals will appear in the remote Inbox, though search does not show them. That is outside this group's scope. The fix belongs in `visibleToCompanion` (add `group.hidden !== true`), where it also fixes the SSE stream and transcript routes. Flag it to whoever owns `sse-visibility`.
3. **The control page has no credential (C3/C4).** Any local account on a headless box can `POST 127.0.0.1:8811/pairing` and read the token back from `GET /state` (`control.ts:314,339-349`). That is the existing posture, and `murage pair` adds no new capability. C4 still refuses to talk to the control page until the browser door proves it is this deployment's (`probeDoor` identity match), so a squatter on those ports cannot get its own QR printed. It does not stop another local user from opening a window. If that matters for multi-user boxes, the fix is a control-page credential, which is a separate task.
4. **Origin on a CLI write (C3).** `control.ts:305-308` refuses any present Origin that is not its own page's, and that includes `null`. Node's `fetch` behaviour here is the runtime's choice, so C3 uses `node:http`, which never adds Origin, and a test pins "no Origin was sent".
5. **Keep-awake semantics change (C5).** Today the blocker runs whenever the sidecar is on and the setting is on (`main.mjs:1147`), even with no devices. The spec's own label, "while a phone is paired", is only true with the `devices.length > 0` gate that C5 adds. Nobody has a UI switch for it yet, because the IPC exists (`preload.cjs:169`) but no screen calls it, so no user-visible behaviour regresses.
6. **No-certificate detection is reactive.** `no-certificates` is only diagnosed when `tailscale serve --bg --https=443` fails (`companion-remote-access.mjs:345-354`). A plain re-read (`serveState`) with no serve config returns `reason: null`, so "Check Tailscale again" clears the diagnosis and the C8 steps disappear even though certificates are still off. Proactive detection from `tailscale status --json` `CertDomains` would be better. It must not feed `serveState`'s `reason`, though, because `enableServe` returns early on any `before.reason` (`:337-339`) and a false positive would block turning HTTPS on at all. I left it out of this plan. Candidate for Plan 1 follow-up.
7. **`reason: "listener"` is not in the TS union.** `main.mjs:1111` can emit `reason: "listener"`, but `CompanionRemoteAccess.reason` (`PhoneSetupFlow.tsx:117`) does not list it. Harmless for C8, whose comparisons are by equality, but the type is lying. One-line fix for whoever owns that type.
8. **Brief deviation on test runner.** Installer tests are `node:test` files (`installer/test/cli.test.mjs:12`) and are not in vitest's `include` (`vite.config.ts:13-20`). C3 and C4 therefore run with `node --test …`, not `pnpm vitest run`.
9. **HARD RULE for implementers:** no local builds or test runs of the workspace on this Mac beyond the single allowed build. Run these suites on Hetzner (`ssh hetzner-dsm`, `/root/fuigo-builds/<lane>/`, `testlane.sh`). The C4 manual `murage start`/`murage pair` check happens there too.

**Review Focus candidates:**
- **A forged companion marker from a local process.** A bot's shell sends `x-murage-companion: 1` to `127.0.0.1:8799/api/inbox` and expects to read the owner's approvals. Test: `server/inbox-access.test.ts` "names the companion by its private launch proof, not by the marker" (marker alone, or a wrong token → `unproven` → 404), plus "still answers 404 to a caller no door vouched for".
- **A stale Inbox item id from a thread hidden after it was listed.** The phone shows an item, the owner hides that bot on the desktop, and the phone taps "mark read". It must not write metadata for a thread the phone may no longer see. Tests: "refuses a state change to a hidden thread, and writes nothing" (row count stays 0) and "follows a bot hidden after the phone last looked".
- **Tailscale's modern "Serve is not enabled" answer.** The fix link is on the third line of stderr. Today only the first line is quoted, so the user sees a sentence with no way forward. Test: `electron/companion-remote-access.test.mjs` "keeps the link Tailscale itself printed, even when it is not on the first line", plus "never echoes a link to anywhere but Tailscale's own console" (no attacker-shaped host).
