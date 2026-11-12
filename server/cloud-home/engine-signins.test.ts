// SPDX-License-Identifier: AGPL-3.0-or-later
// F4 C2: the per-bot sign-in lines, the "sign the other bots in" queue and the override, as the API answers them.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { setCloudIdentity } from "../cloud-request-identity.ts";
import { assertBotEngineSignedIn, botEngineReadings, mayMoveOffEngine, repickAutoPicked, pickDefaultEngineForBot, setupMayMoveChief, signInRequiredCopy, useEngineAfterSignIn, botSignInLines, createEngineSignInsApi, signInQueue, type BotEngineRef, type BotSignInSource } from "./engine-signins.ts";

type Answer = { signedIn: boolean; source: "home" | "bot" | null } | undefined;
const BOTS: BotEngineRef[] = [
  { id: "atlas", name: "Atlas", driverKind: "codex" }, { id: "nova", name: "Nova", driverKind: "codex" }, { id: "kit", name: "Kit", driverKind: "codex" },
  { id: "rex", name: "Rex", driverKind: "grokAgent" }, { id: "ada", name: "Ada", driverKind: "claudeAgent" }, { id: "bo", name: "Bo", driverKind: "claudeAgent" },
  { id: "fu", name: "Fu", driverKind: "fuigoAgent" },
];
const answers: Record<string, Answer> = {
  atlas: { signedIn: true, source: "bot" }, nova: { signedIn: false, source: null }, kit: { signedIn: false, source: null }, rex: { signedIn: true, source: "bot" },
  ada: { signedIn: true, source: "home" }, bo: { signedIn: true, source: "bot" },
};
const source: BotSignInSource = { signIn: async (_kind, id) => answers[id], signedInEngines: async (id) => (id === "fu" ? [] : id === "amy" ? ["codex"] : undefined) };

describe("botSignInLines", () => {
  it("answers per bot, names and booleans only, and says which Claude sign-in a bot uses", async () => {
    const lines = (await botSignInLines(BOTS, source))!;
    expect(lines.map(line => [line.id, line.label, line.signedIn, line.uses])).toEqual([
      ["atlas", "Codex", true, null], ["nova", "Codex", false, null], ["kit", "Codex", false, null], ["rex", "Grok", true, null],
      ["ada", "Claude", true, "home"], ["bo", "Claude", true, "own"],
      ["fu", "Fuigo", true, null],
    ]); // Fuigo is metered, not a sign-in; its line carries the engines the bot is already signed in to
    for (const line of lines.filter(l => l.engine !== "fuigoAgent")) expect(Object.keys(line).sort()).toEqual(["engine", "id", "label", "name", "signedIn", "uses"]);
    expect(lines.at(-1)).toMatchObject({ signedInEngines: [] });
    expect(JSON.stringify(lines)).not.toMatch(/token|key|secret|expires|account/i);
  });
  it("is undefined when the launcher cannot answer for any bot", async () => {
    expect(await botSignInLines(BOTS, { signIn: async () => undefined })).toBeUndefined();
    expect(await botSignInLines([], source)).toEqual([]);
  });
  it("a Claude bot that is not signed in uses nothing", async () => {
    const lines = (await botSignInLines([BOTS[4]!], { signIn: async () => ({ signedIn: false, source: null }) }))!;
    expect(lines).toEqual([{ id: "ada", name: "Ada", engine: "claudeAgent", label: "Claude", signedIn: false, uses: null }]);
  });
});

describe("signInQueue", () => {
  it("lists only the other bots on that engine that still need their own sign-in", async () => {
    const lines = (await botSignInLines(BOTS, source))!;
    expect(signInQueue(lines, "codex", "atlas")).toEqual([{ id: "nova", name: "Nova" }, { id: "kit", name: "Kit" }, { id: "fu", name: "Fu" }]);
    expect(signInQueue(lines, "codex", "nova")).toEqual([{ id: "kit", name: "Kit" }, { id: "fu", name: "Fu" }]);
    expect(signInQueue(lines, "grokAgent", "rex")).toEqual([{ id: "fu", name: "Fu" }]); // a bot on Fuigo with no Grok sign-in
  });
  it("never offers Claude (the home's sign-in covers every bot) or an engine the home does not sign in", async () => {
    const lines = (await botSignInLines(BOTS, { signIn: async () => ({ signedIn: false, source: null }) }))!;
    expect(signInQueue(lines, "claudeAgent", "ada")).toEqual([]);
    expect(signInQueue(lines, "fuigoAgent")).toEqual([]);
  });
  it("a sign-in is never shared: signing one bot in leaves the others in the queue", async () => {
    const after = { ...answers, nova: { signedIn: true, source: "bot" as const } };
    const lines = (await botSignInLines(BOTS, { signIn: async (_k, id) => after[id as keyof typeof after] }))!;
    expect(signInQueue(lines, "codex", "nova")).toEqual([{ id: "kit", name: "Kit" }]);
  });
});

describe("GET /api/cloud/engine-signins", () => {
  let server: Server;
  afterEach(async () => { await new Promise(resolve => server.close(resolve)); server.closeAllConnections(); });
  const serve = async (scope: string, revoked = 0) => {
    const api = createEngineSignInsApi({ bots: () => BOTS, source });
    server = createServer((req, res) => {
      setCloudIdentity(req.headers, { id: "dev1", account: "a", scope: scope as "owner-desktop", publicKey: "", assertionKey: "", revoked, factor: false });
      void api(req, res, new URL(req.url ?? "/", "http://localhost")).then(took => { if (!took) { res.writeHead(404); res.end(); } });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  it("answers the lines, and the queue when an engine is named", async () => {
    const base = await serve("owner-desktop");
    const all = await (await fetch(`${base}/api/cloud/engine-signins`)).json() as { bots: unknown[]; queue?: unknown };
    expect(all.bots).toHaveLength(7);
    expect(all).not.toHaveProperty("queue");
    const queued = await (await fetch(`${base}/api/cloud/engine-signins?engine=codex&after=atlas`)).json() as { queue: unknown };
    expect(queued.queue).toEqual([{ id: "nova", name: "Nova" }, { id: "kit", name: "Kit" }, { id: "fu", name: "Fu" }]);
  });
  it("refuses a device that is not an owner, a revoked one, other methods and unknown query", async () => {
    let base = await serve("guest");
    expect((await fetch(`${base}/api/cloud/engine-signins`)).status).toBe(403);
    await new Promise(resolve => server.close(resolve)); server.closeAllConnections();
    base = await serve("owner-desktop", 1);
    expect((await fetch(`${base}/api/cloud/engine-signins`)).status).toBe(403);
    await new Promise(resolve => server.close(resolve)); server.closeAllConnections();
    base = await serve("owner-desktop");
    expect((await fetch(`${base}/api/cloud/engine-signins`, { method: "POST" })).status).toBe(404); // only GET is this route
    expect((await fetch(`${base}/api/cloud/engine-signins?engine=codex&x=1`)).status).toBe(400);
    expect((await fetch(`${base}/api/cloud/engine-signins?after=atlas`)).status).toBe(400);
    expect((await fetch(`${base}/api/cloud/engine-signins?engine=a/b`)).status).toBe(400);
    expect((await fetch(`${base}/api/other`)).status).toBe(404);
  });
});


describe("the turn guard", () => {
  const nova = { id: "nova", name: "Nova" };
  it("refuses a bot with no sign-in for its engine, before anything spawns, with the plain prompt", async () => {
    await expect(assertBotEngineSignedIn("codex", nova, source)).rejects.toThrow("Sign Nova in to Codex first. Open Settings, then Connect, to sign in.");
    expect(signInRequiredCopy("Nova", "Codex")).toContain("Sign Nova in to Codex");
  });
  it("lets a signed-in bot through, and passes when the launcher cannot say, off a home, and for engines it does not gate", async () => {
    await expect(assertBotEngineSignedIn("codex", { id: "atlas", name: "Atlas" }, source)).resolves.toBeUndefined();
    await expect(assertBotEngineSignedIn("codex", nova, { signIn: async () => undefined })).resolves.toBeUndefined();
    await expect(assertBotEngineSignedIn("fuigoAgent", nova, { signIn: async () => ({ signedIn: false, source: null }) })).resolves.toBeUndefined();
    await expect(assertBotEngineSignedIn("antigravityAgent", nova, { signIn: async () => ({ signedIn: false, source: null }) })).rejects.toThrow("Sign Nova in to Antigravity first.");
    await expect(assertBotEngineSignedIn("antigravityAgent", nova, { signIn: async () => ({ signedIn: true, source: "bot" }) })).resolves.toBeUndefined();
  });
  it("a bot stored on signed-in Claude whose chat is set to unsigned Codex is refused by the guard, in plain words", async () => {
    // The guard is handed the driver of the engine the CHAT runs (server/index.ts sendProjectUsageTurn: instance.driverKind), not the bot's stored one.
    const perEngine = { signIn: async (driverKind: string) => ({ signedIn: driverKind === "claudeAgent", source: "bot" as const }) };
    await expect(assertBotEngineSignedIn("claudeAgent", nova, perEngine)).resolves.toBeUndefined();
    await expect(assertBotEngineSignedIn("codex", nova, perEngine)).rejects.toThrow("Sign Nova in to Codex first. Open Settings, then Connect, to sign in.");
  });
});

import { pickDefaultEngine, type EngineReading } from "../default-engine.ts";
describe("a bot's default engine on a Cloud home comes only from its own sign-in (never another bot's)", () => {
  const readings = [
    { instanceId: "fuigo", driverKind: "fuigoAgent", snapshot: { state: "available", authenticated: true }, models: { default: "flux-1" } },
    { instanceId: "codex", driverKind: "codex", snapshot: { state: "available", authenticated: true }, models: { default: "gpt" } }, // the account-level reading: signed in somewhere
  ] as unknown as EngineReading[];
  const pick = (id: string | null, src: Pick<BotSignInSource, "signIn">) => pickDefaultEngineForBot(readings, id, pickDefaultEngine, src);
  const home = (run: () => Promise<void>) => async () => { process.env.MURAGE_CLOUD_ROLE = "home"; try { await run(); } finally { delete process.env.MURAGE_CLOUD_ROLE; } };
  it("A signed in to Codex, B not: B's default is Fuigo, and A's is Codex", home(async () => {
    expect((await pick("nova", source)).instanceId).toBe("fuigo");
    expect((await pick("atlas", source)).instanceId).toBe("codex");
  }));
  it("a bot not created yet, and unknown status, start on Fuigo", home(async () => {
    expect((await pick(null, source)).instanceId).toBe("fuigo");
    expect((await pick("atlas", { signIn: async () => undefined })).instanceId).toBe("fuigo");
  }));
  it("off a home the machine's own pick is unchanged", async () => {
    expect((await pick("nova", source)).instanceId).toBe("codex");
  });
  it("B's turn on Fuigo is not refused by the guard", async () => {
    await expect(assertBotEngineSignedIn("fuigoAgent", { id: "nova", name: "Nova" }, source)).resolves.toBeUndefined();
  });
});

describe("after a bot's own sign-in ends (the queue)", () => {
  it("a bot on Fuigo that is now signed in to the engine moves onto it", async () => {
    const moved: string[] = [];
    expect(await useEngineAfterSignIn("codex", { id: "atlas", driverKind: "fuigoAgent" }, kind => { moved.push(kind); return true; }, source)).toBe("codex");
    expect(moved).toEqual(["codex"]);
  });
  it("is not moved without its own sign-in, never moved off an engine the owner chose, and Claude never moves a bot", async () => {
    const moved: string[] = [];
    const move = (kind: string) => { moved.push(kind); return true; };
    expect(await useEngineAfterSignIn("codex", { id: "nova", driverKind: "fuigoAgent" }, move, source)).toBeNull();
    expect(await useEngineAfterSignIn("codex", { id: "atlas", driverKind: "grokAgent" }, move, source)).toBeNull();
    expect(await useEngineAfterSignIn("claudeAgent", { id: "ada", driverKind: "fuigoAgent" }, move, source)).toBeNull();
    expect(moved).toEqual([]);
  });
  it("the backstop: a store that went missing after the engine was chosen refuses the turn with the plain prompt", async () => {
    await expect(assertBotEngineSignedIn("codex", { id: "nova", name: "Nova" }, source)).rejects.toThrow("Sign Nova in to Codex first");
  });
});

describe("Ember lands on Fuigo whichever comes first, the Flux key or the bot", () => {
  const fuigoEmpty = { instanceId: "fuigo", driverKind: "fuigoAgent", snapshot: { state: "available", authenticated: true }, models: { default: "" } };
  const fuigoKeyed = { ...fuigoEmpty, models: { default: "flux-auto", options: [{ id: "flux-auto" }] } };
  const claude = { instanceId: "claude", driverKind: "claudeAgent", snapshot: { state: "available", authenticated: true }, models: { default: "sonnet", options: [{ id: "sonnet" }] } };
  const signedOut: Pick<BotSignInSource, "signIn"> = { signIn: async () => ({ signedIn: false, source: null }) };
  const signedIn: Pick<BotSignInSource, "signIn"> = { signIn: async () => ({ signedIn: true, source: "home" }) };
  const pick = (readings: unknown[], src: Pick<BotSignInSource, "signIn">) => pickDefaultEngineForBot(readings as unknown as EngineReading[], "ember", pickDefaultEngine, src);
  const home = (run: () => Promise<void>) => async () => { process.env.MURAGE_CLOUD_ROLE = "home"; try { await run(); } finally { delete process.env.MURAGE_CLOUD_ROLE; } };

  it("key before Ember is created: Fuigo", home(async () => {
    expect((await pick([fuigoKeyed, claude], signedOut)).instanceId).toBe("fuigo");
  }));
  it("key after: Ember starts on the unsigned engine, then the key lands and it is re-picked to Fuigo", home(async () => {
    const atBoot = await pick([fuigoEmpty, claude], signedOut);
    expect(atBoot.instanceId).toBe("claude");
    const nowPick = await pick([fuigoKeyed, claude], signedOut);
    const move = repickAutoPicked({ engineAutoPicked: true }, { driverKind: "claudeAgent" }, nowPick, "fuigoAgent");
    expect(move).toEqual({ instanceId: "fuigo", model: "flux-auto" });
  }));
  it("an owner's explicit choice (no marker) is never re-picked, whatever lands", home(async () => {
    const nowPick = await pick([fuigoKeyed, claude], signedOut);
    expect(repickAutoPicked({}, { driverKind: "claudeAgent" }, nowPick, "fuigoAgent")).toBeNull();
    expect(repickAutoPicked({ engineAutoPicked: false }, { driverKind: "claudeAgent" }, nowPick, "fuigoAgent")).toBeNull();
  }));
  it("a Murage pick that is signed in keeps its engine, and a bot already on Fuigo is not touched", home(async () => {
    const nowPick = await pick([fuigoKeyed, claude], signedIn);
    expect(nowPick.instanceId).toBe("claude");
    expect(repickAutoPicked({ engineAutoPicked: true }, { driverKind: "claudeAgent" }, nowPick, "claudeAgent")).toBeNull();
    expect(repickAutoPicked({ engineAutoPicked: true }, { driverKind: "fuigoAgent" }, { instanceId: "fuigo", model: "x" }, "fuigoAgent")).toBeNull();
  }));
  it("off a home (the desktop) nothing is re-picked", () => {
    expect(repickAutoPicked({ engineAutoPicked: true }, { driverKind: "claudeAgent" }, { instanceId: "fuigo", model: "flux-auto" }, "fuigoAgent")).toBeNull();
  });
  it("the line names the bot's own instance so a chat on another engine can tell", async () => {
    const lines = (await botSignInLines([{ id: "ember", name: "Ember", driverKind: "claudeAgent", instanceId: "claude" }], { signIn: async () => ({ signedIn: false, source: null }) }))!;
    expect(lines[0]).toMatchObject({ engine: "claudeAgent", instanceId: "claude", signedIn: false });
  });
});

import { conversationLive } from "../setup-conversation.ts";
import { setupCardKey } from "../../shared/setup-card.ts";
describe("a bot leaves its engine for Fuigo only on a definite signed-out read of that engine (C2)", () => {
  const fuigoKeyed = { instanceId: "fuigo", driverKind: "fuigoAgent", snapshot: { state: "available", authenticated: true }, models: { default: "flux-auto", options: [{ id: "flux-auto" }] } };
  const claude = { instanceId: "claude", driverKind: "claudeAgent", snapshot: { state: "available", authenticated: true }, models: { default: "sonnet", options: [{ id: "sonnet" }] } };
  const unanswered: Pick<BotSignInSource, "signIn"> = { signIn: async () => undefined };
  const throwing: Pick<BotSignInSource, "signIn"> = { signIn: async () => { throw new Error("launcher down"); } };
  const signedOut: Pick<BotSignInSource, "signIn"> = { signIn: async () => ({ signedIn: false, source: null }) };
  const signedIn: Pick<BotSignInSource, "signIn"> = { signIn: async () => ({ signedIn: true, source: "home" }) };
  const home = (run: () => Promise<void>) => async () => { process.env.MURAGE_CLOUD_ROLE = "home"; try { await run(); } finally { delete process.env.MURAGE_CLOUD_ROLE; } };
  // The steps both move paths take (the re-pick and the Chief's setup move): the default pick, then the last word on the current engine.
  const wouldMove = async (src: Pick<BotSignInSource, "signIn">) => {
    const pick = await pickDefaultEngineForBot([fuigoKeyed, claude] as unknown as EngineReading[], "ember", pickDefaultEngine, src).catch(() => null);
    const move = pick ? repickAutoPicked({ engineAutoPicked: true }, { driverKind: "claudeAgent" }, pick, pick.instanceId === "fuigo" ? "fuigoAgent" : "claudeAgent") : null;
    return move !== null && await mayMoveOffEngine("claudeAgent", "ember", src);
  };
  it("an unanswered read (undefined) never moves a signed-in Ember off Claude, in the re-pick or the Chief move", home(async () => {
    expect(await mayMoveOffEngine("claudeAgent", "ember", unanswered)).toBe(false);
    expect(await wouldMove(unanswered)).toBe(false);
  }));
  it("a read that throws never moves the bot either", home(async () => {
    expect(await mayMoveOffEngine("claudeAgent", "ember", throwing)).toBe(false);
    expect(await mayMoveOffEngine("codex", "ember", throwing)).toBe(false);
  }));
  it("a definite signed-out read moves it; a signed-in read keeps it", home(async () => {
    expect(await mayMoveOffEngine("claudeAgent", "ember", signedOut)).toBe(true);
    expect(await wouldMove(signedOut)).toBe(true);
    expect(await mayMoveOffEngine("claudeAgent", "ember", signedIn)).toBe(false);
    expect(await wouldMove(signedIn)).toBe(false);
  }));
  it("already on Fuigo (only the model changes), an engine with no sign-in, and off a home: the pick decides as before", async () => {
    expect(await mayMoveOffEngine("claudeAgent", "ember", unanswered)).toBe(true);
    process.env.MURAGE_CLOUD_ROLE = "home";
    try {
      expect(await mayMoveOffEngine("fuigoAgent", "ember", unanswered)).toBe(true);
      expect(await mayMoveOffEngine("someLocalEngine", "ember", unanswered)).toBe(true);
    } finally { delete process.env.MURAGE_CLOUD_ROLE; }
  });
});

describe("the Chief the owner put on Claude stays there across setup reads (C1)", () => {
  const view = { firstRun: false } as unknown as Parameters<typeof conversationLive>[0];
  const present = new Set([setupCardKey("hello", "welcome")]);
  it("on a Cloud home, mark clear, welcome card present: never moved, however many reads", () => {
    process.env.MURAGE_CLOUD_ROLE = "home";
    try {
      expect(conversationLive(view, present)).toBe(true);
      for (let read = 0; read < 5; read++) expect(setupMayMoveChief({}, () => conversationLive(view, present))).toBe(false);
      expect(setupMayMoveChief({ engineAutoPicked: false }, () => true)).toBe(false);
      expect(setupMayMoveChief({ engineAutoPicked: true }, () => false)).toBe(true);
    } finally { delete process.env.MURAGE_CLOUD_ROLE; }
  });
  it("the desktop still moves the Chief only while the first run is live", () => {
    expect(setupMayMoveChief({}, () => conversationLive(view, present))).toBe(true);
    expect(setupMayMoveChief({}, () => false)).toBe(false);
  });
});

describe("a line names every engine the bot is signed in to, so a chat on another engine can be gated (H)", () => {
  it("a bot on Codex also carries its signed-in engines; absent when the launcher did not say", async () => {
    const withAmy: BotSignInSource = { signIn: async (kind, id) => (id === "amy" ? { signedIn: true, source: "home" } : source.signIn(kind, id)), signedInEngines: source.signedInEngines };
    const lines = (await botSignInLines([{ id: "amy", name: "Amy", driverKind: "claudeAgent", instanceId: "claude" }, { id: "nova", name: "Nova", driverKind: "codex" }], withAmy))!;
    expect(lines.find(line => line.id === "amy")).toMatchObject({ engine: "claudeAgent", signedInEngines: ["codex"] });
    expect(lines.find(line => line.id === "nova")?.signedInEngines).toBeUndefined();
  });
});

describe("the pick with an unknown read: the middle rank, never signed out (d, M3)", () => {
  // Codex reads a definite signed out; the Claude read did not answer. The driver's own Claude answer is false (it cannot see the
  // launcher's stores on a home): that false must not survive as the signed-out rank when the read was unanswered.
  const fuigo = { instanceId: "fuigo", driverKind: "fuigoAgent", snapshot: { state: "available", authenticated: true }, models: { default: "flux-auto" } };
  const claude = { instanceId: "claude", driverKind: "claudeAgent", snapshot: { state: "available", authenticated: false }, models: { default: "sonnet" } };
  const codex = { instanceId: "codex", driverKind: "codex", snapshot: { state: "available", authenticated: false }, models: { default: "gpt" } };
  const reads = (claudeRead: "unknown" | "throw"): Pick<BotSignInSource, "signIn"> => ({ signIn: async (kind) => {
    if (kind === "claudeAgent") { if (claudeRead === "throw") throw new Error("launcher down"); return undefined; }
    return { signedIn: false, source: null };
  } });
  const home = (run: () => Promise<void>) => async () => { process.env.MURAGE_CLOUD_ROLE = "home"; try { await run(); } finally { delete process.env.MURAGE_CLOUD_ROLE; } };
  for (const claudeRead of ["unknown", "throw"] as const) {
    it(`a Claude read that is ${claudeRead} leaves Claude's authenticated undefined (over the driver's false); Codex reads false`, home(async () => {
      let seen: readonly EngineReading[] = [];
      const capture = (readings: readonly EngineReading[]) => { seen = readings; return pickDefaultEngine(readings); };
      await pickDefaultEngineForBot([fuigo, claude, codex] as unknown as EngineReading[], "ember", capture, reads(claudeRead));
      const claudeSnap = seen.find(item => item.instanceId === "claude")!.snapshot;
      expect("authenticated" in claudeSnap).toBe(true);
      expect(claudeSnap.authenticated).toBeUndefined();
      expect(seen.find(item => item.instanceId === "codex")!.snapshot.authenticated).toBe(false);
      const { unanswered } = await botEngineReadings([fuigo, claude, codex], "ember", reads(claudeRead));
      expect(unanswered).toEqual(["claudeAgent"]);
    }));
  }
  it("a bot not created yet reads every sign-in engine signed out, and nothing is unanswered (new-bot defaults unchanged)", home(async () => {
    const { readings, unanswered } = await botEngineReadings([fuigo, claude, codex], null, reads("unknown"));
    expect(unanswered).toEqual([]);
    expect(readings.filter(item => item.driverKind !== "fuigoAgent").map(item => (item.snapshot as { authenticated?: boolean }).authenticated)).toEqual([false, false]);
  }));
});
