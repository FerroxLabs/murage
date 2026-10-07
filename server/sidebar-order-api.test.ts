// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The sidebar's section order through the real HTTP routes on a verification
// server with its own data directory: saved with `{ order }` on the filing
// route every door already reaches, handed back in the GET /api/bots
// hydration, pushed as a `sidebar.order` frame, and uploaded `initial` by the
// desktop only. The storage rules are pinned in sidebar-order.test.ts.
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer, owner: Record<string, string> = {};

const call = async (method: string, path: string, body?: unknown, headers = owner) => {
  const response = await fetch(`${fixture.info.url}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
};
const remote = {} as Record<string, string>;
// The phone app and a browser through the door reach the order save with the
// door's launch proof: POST /api/sidebar-sections is companion class in the
// route policy (server/route-policy.ts), and the door forwards it with proof
// (companion/src/routes.ts OWNER_DECISION_ROUTES). Reads stay unproven.
const COMPANION = "c".repeat(64); // the suite's launch secret (server/testing/setup.ts)
const phone = { "x-murage-companion": "1", "x-murage-companion-token": COMPANION };

beforeAll(async () => {
  // Set before companion-authority.ts reads the environment.
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `process.env.MURAGE_COMPANION_TOKEN = ${JSON.stringify(COMPANION)};` });
  const proof = await fetch(`${fixture.info.url}/api/desktop-secret`).then((r) => r.json() as any);
  owner = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 60000);

afterAll(async () => {
  await fixture?.close();
});

/** Read SSE frames of one kind from a stream until `count` arrive. */
async function frames(stream: Response, kind: string, count: number): Promise<any[]> {
  const reader = stream.body!.getReader();
  const found: any[] = [];
  let text = "";
  const deadline = Date.now() + 5000;
  while (found.length < count && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
    const lines = text.split("\n");
    text = lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const frame = JSON.parse(line.slice(6));
      if (frame.kind === kind) found.push(frame);
    }
  }
  await reader.cancel();
  return found;
}

it("keeps one section order on the computer for every device", async () => {
  // Ops holds a bot every device can see; Vault holds only an archived one.
  const ops = (await call("POST", "/api/bots", { name: "Ava" })).body.bot;
  const vault = (await call("POST", "/api/bots", { name: "Old" })).body.bot;
  expect((await call("POST", "/api/sidebar-sections", { name: "Ops", botIds: [ops.id] })).status).toBe(200);
  expect((await call("POST", "/api/sidebar-sections", { name: "Vault", botIds: [vault.id] })).status).toBe(200);
  expect((await call("PATCH", `/api/bots/${vault.id}`, { hidden: true })).status).toBe(200);

  // Nothing saved yet: every device hydrates null and keeps its local copy.
  expect((await call("GET", "/api/bots?messages=1", undefined, remote)).body.sidebarSectionOrder).toBeNull();

  // A phone or browser can never upload its (default) order as the first one.
  const phoneFirst = await call("POST", "/api/sidebar-sections", { order: ["builtin:pinned"], initial: true }, phone);
  expect(phoneFirst.status).toBe(403);
  // Anything on the loopback port without a proof is refused at the gate.
  expect(await call("POST", "/api/sidebar-sections", { order: ["builtin:pinned"] }, remote)).toEqual({ status: 404, body: { error: "no such route" } });
  expect((await call("GET", "/api/bots?messages=1")).body.sidebarSectionOrder).toBeNull();

  // The desktop's first load uploads its arrangement...
  const full = ["section:Vault", "section:Ops", "builtin:projects", "builtin:pinned"];
  const remoteStream = await fetch(`${fixture.info.url}/api/events`);
  const desktopStream = await fetch(`${fixture.info.url}/api/events`, { headers: owner });
  const uploaded = await call("POST", "/api/sidebar-sections", { order: full, initial: true });
  expect(uploaded).toEqual({ status: 200, body: { order: full } });
  // ...and a second first load never replaces it.
  expect((await call("POST", "/api/sidebar-sections", { order: ["builtin:pinned"], initial: true })).body.order).toEqual(full);

  // Told live: the desktop gets the whole order, a scoped stream only the
  // teams it can see, and never the archived-only team's name.
  const [desktopFrame] = await frames(desktopStream, "sidebar.order", 1);
  expect(desktopFrame.order).toEqual(full);

  // Hydration is cut the same way.
  const phoneView = (await call("GET", "/api/bots?messages=1", undefined, remote)).body.sidebarSectionOrder;
  expect(phoneView).toEqual(["section:Ops", "builtin:projects", "builtin:pinned"]);
  expect(JSON.stringify(phoneView)).not.toContain("Vault");
  expect((await call("GET", "/api/bots?messages=1")).body.sidebarSectionOrder).toEqual(full);

  // A drag on a phone saves; the team it cannot see keeps its place next to
  // its neighbour (before Ops), and the phone is answered with its own view.
  const dragged = await call("POST", "/api/sidebar-sections", { order: ["builtin:pinned", "section:Ops", "builtin:projects"] }, phone);
  expect(dragged).toEqual({ status: 200, body: { order: ["builtin:pinned", "section:Ops", "builtin:projects"] } });
  expect((await call("GET", "/api/bots?messages=1")).body.sidebarSectionOrder)
    .toEqual(["builtin:pinned", "section:Vault", "section:Ops", "builtin:projects"]);
  // The scoped stream saw both saves, and only ever its own cut: a whole
  // order leaking to it would show up here as a frame naming Vault.
  const remoteFrames = await frames(remoteStream, "sidebar.order", 3);
  expect(remoteFrames.map((frame) => frame.order)).toEqual([
    ["section:Ops", "builtin:projects", "builtin:pinned"],
    ["builtin:pinned", "section:Ops", "builtin:projects"],
  ]);

  // A phone naming a team it cannot see does not move it.
  await call("POST", "/api/sidebar-sections", { order: ["section:Vault", "builtin:pinned", "section:Ops", "builtin:projects"] }, phone);
  expect((await call("GET", "/api/bots?messages=1")).body.sidebarSectionOrder)
    .toEqual(["builtin:pinned", "section:Vault", "section:Ops", "builtin:projects"]);

  // A desktop drag saves the whole order.
  const desktopDrag = await call("POST", "/api/sidebar-sections", { order: ["section:Ops", "section:Vault", "builtin:pinned", "builtin:projects"] });
  expect(desktopDrag.body.order).toEqual(["section:Ops", "section:Vault", "builtin:pinned", "builtin:projects"]);
}, 30000);

it("refuses a malformed order and leaves the filing body alone", async () => {
  for (const body of [
    { order: "builtin:pinned" },
    { order: [""] },
    { order: ["section:a"], initial: "yes" },
    { order: ["section:a"], name: "Ops" },
    { order: Array.from({ length: 101 }, (_, i) => `section:${i}`) },
  ]) {
    expect((await call("POST", "/api/sidebar-sections", body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
  }
  // A filing request without `order` still answers as before.
  expect((await call("POST", "/api/sidebar-sections", { name: "Ops", botIds: [] })).status).toBe(400);
});
