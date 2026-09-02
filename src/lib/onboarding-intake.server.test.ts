// The intake against the real server.
//
// Everything else about this feature can be proved with pure functions and a
// recorded transport. One thing cannot: that accepting a suggestion configures
// THE BOT YOU ARE IN and leaves the workspace otherwise exactly as it was. The
// failure mode — an orphan blank bot sitting in the sidebar next to the one you
// thought you were setting up — is only visible by counting bots before and
// after against a live store, so that is what this does.
//
// Boots `node server/index.ts` against a throwaway HOME with one deliberately
// unknown driver pinned, the same trick server/index.test.ts uses to keep the
// suite off the network and off any agent CLI the host happens to have.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const PORT = 19100 + Math.floor(Math.random() * 5_000);
const BASE = `http://127.0.0.1:${PORT}`;

/** A profile that ships INSIDE this build (library/assistants/beacon.json), so
 *  applying it never reaches the network. */
const LOCAL_PROFILE = "beacon";

let child: ChildProcess;
let home: string;
let stderr = "";

/** The renderer's proof, pinned for this child. Saying "desktop" is not
 *  enough any more — see server/sse-visibility.ts. */
const DESKTOP_SECRET = "1a2b3c4d5e6f7089".repeat(4);

/** Desktop by default — that is what the renderer's `api()` always sends, and
 *  the writing routes refuse anything else. `surface: "remote"` is how a test
 *  asks the question a paired phone would ask. */
const call = async (
  method: string,
  path: string,
  options: { body?: unknown; surface?: "desktop" | "remote" } = {},
): Promise<{ status: number; body: any }> => {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.surface !== "remote") {
    headers["x-murage-surface"] = "desktop";
    headers["x-murage-surface-secret"] = DESKTOP_SECRET;
  }
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "murage-intake-test-"));
  mkdirSync(join(home, ".murage"), { recursive: true });
  writeFileSync(
    join(home, ".murage", "config.json"),
    JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } } }),
  );
  child = spawn(process.execPath, [join(REPO, "server", "index.ts")], {
    cwd: REPO,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      MURAGE_PORT: String(PORT),
      MURAGE_WEBHOOK_PORT: String(PORT + 1),
      // The desktop marker stopped being believed on its own: `requestSurface`
      // now wants this launch's secret alongside it. The dev injection pins
      // the value so a caller outside Electron can hold the same one.
      MURAGE_DEV_DESKTOP_SECRET: DESKTOP_SECRET,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (chunk) => (stderr += chunk));

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early\n${stderr}`);
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
      /* still starting */
    }
    if (Date.now() >= deadline) throw new Error(`server never became healthy\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 60_000);

afterAll(async () => {
  child?.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 300));
  child?.kill("SIGKILL");
  rmSync(home, { recursive: true, force: true });
});

describe("GET /api/library/suggest", () => {
  it("answers a plain sentence with a profile and the skills it brings", async () => {
    // Deliberately a sentence whose topic words appear NOWHERE in Smart
    // Trader's catalogue entry — it says "read their own charts", never
    // "trading". Only the skills' own manifests carry that word, so this
    // passes if and only if the route feeds them to the relevance gate.
    const response = await call(
      "GET",
      `/api/library/suggest?q=${encodeURIComponent("I want help with trading stocks and options")}`,
    );
    expect(response.status).toBe(200);
    expect(response.body.profile?.slug).toBe("smart-trader");
    expect(response.body.profile.skills.map((skill: any) => skill.id)).toContain("chart-analysis");
    // Names and descriptions, not bare ids — the card has to say what arrives.
    const chart = response.body.profile.skills.find((skill: any) => skill.id === "chart-analysis");
    expect(chart).toMatchObject({ name: expect.any(String), description: expect.any(String) });
    // The manifest's own trigger terms ride along. They are never shown; they
    // are what tells the gate `chart-analysis` is about trading when the
    // catalogue entry never says the word.
    expect(chart.terms).toContain("trading");
    // Profile first: loose skills are the FALLBACK, so they are absent here.
    expect(response.body.skills).toEqual([]);
  });

  it("answers plain speech too, not just keywords", async () => {
    const response = await call("GET", `/api/library/suggest?q=${encodeURIComponent("help me read my trading charts")}`);
    expect(response.body.profile?.slug).toBe("smart-trader");
  });

  it("suggests nothing rather than the top-ranked stranger", async () => {
    // Both of these rank a profile first inside the catalogue's own bm25 —
    // measured, `say "hi"` ranks a book editor and `NOT OR AND` a co-working
    // profile. The relevance gate is the only thing between them and the card.
    for (const q of ["say%20%22hi%22", "NOT%20OR%20AND"]) {
      const response = await call("GET", `/api/library/suggest?q=${q}`);
      expect(response.status, q).toBe(200);
      expect(response.body.profile, q).toBeNull();
    }
  });

  it('ANSWERS "hi" WITH NOTHING — no profile, and NO SKILLS', async () => {
    // The headline bug, against the real route: typing "hi" came back with
    // eight skills and the card pre-ticked every one of them. "hi" carries no
    // topic word, so the only honest answer is none.
    const response = await call("GET", "/api/library/suggest?q=hi");
    expect(response.status).toBe(200);
    expect(response.body.profile).toBeNull();
    expect(response.body.skills).toEqual([]);
  });

  it("answers filler with nothing, however many words of filler there are", async () => {
    for (const q of ["hey%20there", "help%20me", "help%20me%20with%20stuff%20and%20things", "what%20should%20I%20do"]) {
      const response = await call("GET", `/api/library/suggest?q=${q}`);
      expect(response.status, q).toBe(200);
      expect(response.body.profile, q).toBeNull();
      expect(response.body.skills, q).toEqual([]);
    }
  });

  it("never offers more than three loose skills", async () => {
    // Was eight, ungated. Three is a list a person reads; eight is a list a
    // person scrolls past and accepts.
    for (const q of ["writing%20blog%20posts", "chasing%20invoices", "bookkeeping"]) {
      const response = await call("GET", `/api/library/suggest?q=${q}`);
      expect(response.body.skills.length, q).toBeLessThanOrEqual(3);
    }
  });

  it("survives the punctuation FTS5 treats as syntax", async () => {
    for (const q of ["c%2B%2B", "say%20%22hi%22", "%5Eweird", "", "%20%20"]) {
      const response = await call("GET", `/api/library/suggest?q=${q}`);
      expect(response.status, q).toBe(200);
    }
  });
});

describe("POST /api/bots/:id/assistant-profile", () => {
  let botId = "";

  it("configures the bot you are in without creating another", async () => {
    const before = await call("GET", "/api/bots");
    const created = await call("POST", "/api/bots", { body: {} });
    expect(created.status).toBe(201);
    botId = created.body.bot.id;
    // A blank bot: this is what "New Bot" hands you today.
    expect((await call("GET", `/api/bots/${botId}/skills`)).body.skills).toEqual([]);

    const applied = await call("POST", `/api/bots/${botId}/assistant-profile`, {
      body: { slug: LOCAL_PROFILE },
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body.bot.id).toBe(botId);
    expect(applied.body.installed.length).toBeGreaterThan(0);

    // The persona landed on THIS bot.
    const patched = (await call("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === botId);
    expect(patched.name).toBe("Channels");
    expect(patched.title).toBeTruthy();
    expect(patched.description).toBeTruthy();

    // Its skills landed, and switched ON — a skill nobody enabled is a file
    // on disk, not a capability.
    const skills = (await call("GET", `/api/bots/${botId}/skills`)).body.skills;
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.every((skill: any) => skill.enabled)).toBe(true);

    // THE ASSERTION THIS FILE EXISTS FOR: exactly one bot appeared, and it is
    // the one we created. Applying a profile added none.
    const after = await call("GET", "/api/bots");
    expect(after.body.bots.length).toBe(before.body.bots.length + 1);
  });

  it("does not renumber the bot it is configuring when applied twice", async () => {
    const again = await call("POST", `/api/bots/${botId}/assistant-profile`, { body: { slug: LOCAL_PROFILE } });
    expect(again.status).toBe(200);
    expect(again.body.bot.name).toBe("Channels");
  });

  it("keeps the name when asked to", async () => {
    const created = await call("POST", "/api/bots", { body: { name: "Bruce" } });
    const applied = await call("POST", `/api/bots/${created.body.bot.id}/assistant-profile`, {
      body: { slug: LOCAL_PROFILE, rename: false },
    });
    expect(applied.status).toBe(200);
    expect(applied.body.bot.name).toBe("Bruce");
    expect(applied.body.bot.title).toBeTruthy();
  });

  it("refuses any surface but the desktop", async () => {
    // An enabled skill is instructions an engine will follow, and an agent can
    // put text into another agent's thread. The person at the machine decides.
    const refused = await call("POST", `/api/bots/${botId}/assistant-profile`, {
      body: { slug: LOCAL_PROFILE },
      surface: "remote",
    });
    expect(refused.status).toBe(404);
  });

  it("refuses a slug that is not a library profile name", async () => {
    for (const slug of ["../../etc", "Not A Slug", ""]) {
      const response = await call("POST", `/api/bots/${botId}/assistant-profile`, { body: { slug } });
      expect(response.status, slug).toBe(400);
    }
  });

  it("404s for a bot that does not exist", async () => {
    const response = await call("POST", "/api/bots/no-such-bot/assistant-profile", { body: { slug: LOCAL_PROFILE } });
    expect(response.status).toBe(404);
  });
});

describe("assigning one skill from the library", () => {
  it("adds it to the named agent, switched on, and creates nothing", async () => {
    const before = await call("GET", "/api/bots");
    const created = await call("POST", "/api/bots", { body: {} });
    const botId = created.body.bot.id;
    const assigned = await call("POST", `/api/bots/${botId}/skills/library`, {
      body: { ids: ["car-buying-guide"] },
    });
    expect(assigned.status).toBe(201);
    const skills = (await call("GET", `/api/bots/${botId}/skills`)).body.skills;
    expect(skills.map((skill: any) => skill.name)).toEqual(["car-buying-guide"]);
    expect(skills[0].enabled).toBe(true);
    const after = await call("GET", "/api/bots");
    expect(after.body.bots.length).toBe(before.body.bots.length + 1);
  });
});
