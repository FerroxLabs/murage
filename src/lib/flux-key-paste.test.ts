import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  FLUX_KEY_NOT_A_KEY,
  FLUX_KEY_REJECTED,
  FLUX_KEY_STORAGE_UNAVAILABLE,
  detectFluxKeyInComposer,
  looksLikeFluxKey,
  proveFluxKey,
  readFluxStatus,
  refreshAfterFluxKey,
  saveAndProveFluxKey,
  saveFluxKey,
} from "./flux-key-paste";

// ASSEMBLED, NOT WRITTEN DOWN.
//
// These are invented, but a key-shaped literal in a source file is exactly
// what put a live Flux key into a public test once before, and the pre-commit
// secret scan is right to refuse them on sight. Building the string at run
// time keeps the test honest about the SHAPE it is checking while leaving
// nothing in the repo for a scanner, or a person skimming a diff, to have to
// judge. The rule this respects: never allowlist a key-shaped hash, because
// the next one to be allowlisted will be the real one.
const PREFIX = ["sk", "flux", ""].join("-");
const REAL = `${PREFIX}9SxQ2vLpZa4RtKmN7bYcEw13`;
const ALSO_REAL = `${PREFIX}Ab_cd-EFgh1234ijklMNOP`;

describe("recognizing a Flux Router key", () => {
  it("accepts a real key, with or without the whitespace a paste brings", () => {
    expect(looksLikeFluxKey(REAL)).toBe(true);
    expect(looksLikeFluxKey(`  ${ALSO_REAL}\n`)).toBe(true);
  });

  it("rejects a sentence about a key, which is the whole point", () => {
    for (const prose of [
      "my flux router key is in the drawer",
      "sk-flux",
      "sk-flux-",
      "sk-flux-short",
      `I pasted ${REAL} earlier`,
      REAL.toUpperCase(),
      REAL.replace(PREFIX, "sk-ant-"),
      "",
      "flux",
    ]) {
      expect.soft(looksLikeFluxKey(prose), `${prose} was read as a key`).toBe(false);
    }
  });
});

describe("a key typed into the chat box", () => {
  it("is caught on its own, and nothing is left to send", () => {
    expect(detectFluxKeyInComposer(REAL)).toEqual({ key: REAL, rest: "" });
  });

  it("is caught in the middle of a sentence, and the sentence survives", () => {
    const found = detectFluxKeyInComposer(`here you go ${REAL} does that work`);
    expect(found).toEqual({ key: REAL, rest: "here you go does that work" });
  });

  it("is caught through the punctuation a human types around it", () => {
    expect(detectFluxKeyInComposer(`my key: "${REAL}".`)?.key).toBe(REAL);
    expect(detectFluxKeyInComposer(`(${REAL})`)?.key).toBe(REAL);
    expect(detectFluxKeyInComposer(`key=${REAL}`)).toBeNull();
  });

  it("leaves ordinary conversation alone", () => {
    for (const line of [
      "where do I put my flux router key",
      "I think the key is sk-flux something or other",
      "remind me to get a key from flux router tomorrow",
      `${PREFIX}tooshort`,
      "the book is on the shelf",
      "",
    ]) {
      expect.soft(detectFluxKeyInComposer(line), `caught a key in: ${line}`).toBeNull();
    }
  });

  it("takes the first key and leaves the message readable when two are pasted", () => {
    const found = detectFluxKeyInComposer(`${REAL} and ${ALSO_REAL}`);
    // The second is still in `rest` and the composer refuses again on the
    // next pass: one key per save, never a silent half save.
    expect(found?.key).toBe(REAL);
    expect(detectFluxKeyInComposer(found!.rest)?.key).toBe(ALSO_REAL);
  });
});

describe("saving a key", () => {
  const status = { configured: false, revision: "rev-1" };

  it("goes through the desktop bridge, the same road Settings uses", async () => {
    const seen: any[] = [];
    const bridge = async (change: any) => {
      seen.push(change);
      return { configured: true, revision: "rev-2", conflict: false, choices: [] };
    };
    const saved = await saveFluxKey(REAL, { status, bridge, desktop: true });
    expect(seen).toEqual([{ action: "connect", revision: "rev-1", key: REAL }]);
    expect(saved.configured).toBe(true);
  });

  it("replaces rather than connects when a key is already saved", async () => {
    const seen: any[] = [];
    const bridge = async (change: any) => {
      seen.push(change);
      return { configured: true, revision: "rev-3", conflict: false, choices: [] };
    };
    await saveFluxKey(REAL, { status: { configured: true, revision: "rev-2" }, bridge, desktop: true });
    expect(seen[0].action).toBe("replace");
  });

  it("refuses on the desktop when the secure bridge is missing", async () => {
    await expect(saveFluxKey(REAL, { status, desktop: true, request: async () => ({}) }))
      .rejects.toThrow(FLUX_KEY_STORAGE_UNAVAILABLE);
  });

  it("uses the web fallback only when there is no desktop shell", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const request = async (path: string, init?: RequestInit) => {
      calls.push({ path, body: JSON.parse(String(init?.body ?? "{}")) });
      return { configured: true, revision: "rev-9", conflict: false, choices: [] };
    };
    await saveFluxKey(REAL, { status, request });
    expect(calls).toEqual([{
      path: "/api/flux-connection/mutate",
      body: { action: "connect", revision: "rev-1", key: REAL },
    }]);
  });

  it("never sends something that is not a key anywhere", async () => {
    let called = false;
    const bridge = async () => {
      called = true;
      return { configured: true, revision: "x", conflict: false, choices: [] };
    };
    await expect(saveFluxKey("my key is in the drawer", { status, bridge, desktop: true }))
      .rejects.toThrow(FLUX_KEY_NOT_A_KEY);
    expect(called).toBe(false);
  });
});

/**
 * THE DEFECT THESE EXIST FOR.
 *
 * The first-run save checked the SHAPE of the key and nothing else, wrote it
 * to the keychain, and the Chief then said "That is saved, and locked away on
 * this computer" in his own voice. A revoked key, somebody else's key or a
 * key with one character wrong all earned that sentence and then failed on
 * the person's first question, with nothing on screen joining the two.
 *
 * The rule being locked down here is not only "check it". It is that the
 * three outcomes stay three: a key Flux Router refused, a key Flux Router
 * accepted, and a key nobody could ask about because nothing could reach Flux
 * Router. Collapsing the third into the first tells somebody on a train that
 * their good key is wrong, which is the more expensive lie of the two.
 */
describe("proving a saved key against Flux Router", () => {
  const catalogue = (body: any) => {
    const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
    return {
      calls,
      request: async (path: string, init?: RequestInit) => {
        calls.push({ path, method: init?.method, body: init?.body });
        if (body instanceof Error) throw body;
        return body;
      },
    };
  };

  it("proves a key the catalogue answered for", async () => {
    const probe = catalogue({ modelCount: 412 });
    expect(await proveFluxKey(probe.request)).toBe("proved");
    // The route reads the saved credential server side. Nothing here holds
    // the key, so nothing here can leak it.
    expect(probe.calls).toEqual([{ path: "/api/flux-connection/test", method: "POST", body: undefined }]);
  });

  it("calls a key Flux Router refused refused, and only those two codes", async () => {
    for (const code of ["unauthorized", "forbidden"]) {
      expect
        .soft(await proveFluxKey(catalogue({ modelCount: 0, error: "The provider rejected this key.", code }).request), code)
        .toBe("rejected");
    }
  });

  it("never calls a trip that failed a bad key", async () => {
    // Every one of these is a statement about the network, the rate limiter
    // or the payload. None of them is Flux Router's verdict on the key, and
    // reporting one as a refusal is the lie this test exists to stop.
    for (const code of ["offline", "rate-limited", "unavailable", "invalid-catalog", "connection-changed"]) {
      expect.soft(await proveFluxKey(catalogue({ modelCount: 0, error: "Could not reach the provider.", code }).request), code)
        .toBe("unproved");
    }
  });

  it("treats a route that would not answer at all as unproved", async () => {
    // A 409 while the credential store is mid change, a dropped connection,
    // a server restart. The person is offline, not wrong.
    expect(await proveFluxKey(catalogue(new Error("Flux credentials are being changed.")).request)).toBe("unproved");
    expect(await proveFluxKey(catalogue({}).request)).toBe("unproved");
  });

  it("saves first and only then asks, and reports what the asking said", async () => {
    const saved: any[] = [];
    const bridge = async (change: any) => {
      saved.push(change);
      return { configured: true, revision: "rev-2", conflict: false, choices: [] };
    };
    const asked: string[] = [];
    const request = async (path: string) => {
      asked.push(path);
      // The save has to have happened before the question is asked, or the
      // question is about the previous key.
      expect(saved).toHaveLength(1);
      return { modelCount: 7 };
    };
    const proof = await saveAndProveFluxKey(REAL, { status: { configured: false, revision: "rev-1" }, bridge, request, desktop: true });
    expect(proof).toBe("proved");
    expect(saved[0]).toMatchObject({ action: "connect", key: REAL });
    expect(asked).toEqual(["/api/flux-connection/test"]);
  });

  it("hands back the refusal rather than swallowing it", async () => {
    const bridge = async () => ({ configured: true, revision: "rev-2", conflict: false, choices: [] });
    const request = async () => ({ modelCount: 0, error: "The provider rejected this key.", code: "unauthorized" });
    expect(await saveAndProveFluxKey(REAL, { status: { configured: false, revision: "rev-1" }, bridge, request, desktop: true }))
      .toBe("rejected");
  });

  it("puts the key in no message a person can read", () => {
    for (const line of [FLUX_KEY_REJECTED, FLUX_KEY_NOT_A_KEY, FLUX_KEY_STORAGE_UNAVAILABLE]) {
      expect.soft(line).not.toContain(PREFIX);
      expect.soft(line).not.toMatch(/\bsk-/);
      expect.soft(line).not.toContain("—");
    }
  });
});

/**
 * THE WIRING, WHICH IS WHERE THE DEFECT ACTUALLY LIVED.
 *
 * The library above can be perfect and the card can still congratulate
 * somebody over an unchecked key, because the card is what answers the step
 * and the answer is what makes the Chief speak. There is no DOM in this
 * suite, so this is a read of the source with its comments stripped first,
 * said plainly: comments in these files discuss the old behaviour at length
 * and would satisfy any substring check on their own.
 */
describe("the first-run cards do not confirm a key they have not proved", () => {
  const source = (file: string) =>
    readFileSync(new URL(file, import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it("answers the key step only through the proof, and never on a refusal", () => {
    const card = source("../components/FirstRunFluxCard.tsx");
    expect(card).toContain("saveAndProveFluxKey(key,");
    expect(card).not.toContain("saveFluxKey(key,");
    // The only two answers it can send are the two the Chief has a true
    // sentence for. A literal here is how the old one said "key saved".
    expect(card).toContain("SETUP_FLUX_PROVED_ANSWER");
    expect(card).toContain("SETUP_FLUX_UNPROVED_ANSWER");
    expect(card).not.toMatch(/answerSetupStep\("flux", "/);
    // A refusal leaves the step unanswered: the failure is shown and the
    // function returns before anything is recorded.
    const refusal = card.indexOf('proof === "rejected"');
    expect(refusal, "the refusal branch has been renamed or removed").toBeGreaterThan(-1);
    expect(card.indexOf('answerSetupStep("flux"')).toBeGreaterThan(refusal);
    expect(card.slice(refusal, refusal + 200)).toContain("FLUX_KEY_REJECTED");
    expect(card.slice(refusal, refusal + 200)).toMatch(/\n\s+return;\n/);
  });

  it("holds the job card to the same rule, because it takes the same paste", () => {
    const card = source("../components/FirstRunJobsCard.tsx");
    expect(card).toContain("saveAndProveFluxKey(key,");
    expect(card).not.toContain("saveFluxKey(key,");
    const refusal = card.indexOf('proof === "rejected"');
    expect(refusal, "the refusal branch has been renamed or removed").toBeGreaterThan(-1);
    // It must not walk on to the job on a key Flux Router refused.
    expect(card.indexOf("setStage(afterConnect(job, { ...world, fluxReady: true }))")).toBeGreaterThan(refusal);
    expect(card.slice(refusal, refusal + 200)).toMatch(/\n\s+return;\n/);
  });
});

describe("reading the connection before a save", () => {
  it("takes only the revision and whether a key is already saved", async () => {
    const request = async () => ({ configured: true, revision: "rev-4", conflict: false, choices: [{ id: "a" }] });
    expect(await readFluxStatus(request)).toEqual({ configured: true, revision: "rev-4" });
  });

  it("survives an answer that says nothing", async () => {
    expect(await readFluxStatus(async () => ({}))).toEqual({ configured: false, revision: "" });
  });
});

// THE WINDOW HAS TO LEARN ABOUT THE KEY, NOT ONLY THE KEYCHAIN.
//
// The 0.1.59 customer pass saved a key in the welcome and kept the window's
// pre-key reading: "Install an AI engine to get started" on Linux and
// Windows, and the Flux voice greyed out on a Mac, until a reload. Every save
// now ends by asking the store to read the engines and settings again.
describe("after a key is saved, the window reads the engines and settings again", () => {
  const bridge = async () => ({ configured: true, revision: "rev-2", conflict: false, choices: [] });

  it("refreshes once the key is proved, not before", async () => {
    const order: string[] = [];
    const request = async (path: string) => { order.push(path); return { modelCount: 3 }; };
    const refresh = async () => { order.push("refresh"); };
    expect(await saveAndProveFluxKey(REAL, { status: { configured: false, revision: "rev-1" }, bridge, request, desktop: true, refresh })).toBe("proved");
    expect(order).toEqual(["/api/flux-connection/test", "refresh"]);
  });

  it("refreshes after a plain save too, the composer's road", async () => {
    let refreshed = 0;
    await saveFluxKey(REAL, { status: { configured: false, revision: "rev-1" }, bridge, desktop: true, refresh: async () => { refreshed += 1; } });
    expect(refreshed).toBe(1);
  });

  it("refreshes on a refused key as well, since the saved key did change", async () => {
    let refreshed = 0;
    const request = async () => ({ modelCount: 0, code: "unauthorized" });
    expect(await saveAndProveFluxKey(REAL, { status: { configured: false, revision: "rev-1" }, bridge, request, desktop: true, refresh: async () => { refreshed += 1; } })).toBe("rejected");
    expect(refreshed).toBe(1);
  });

  it("does not turn a failed refresh into a failed save", async () => {
    const request = async () => ({ modelCount: 3 });
    const refresh = async () => { throw new Error("offline"); };
    expect(await saveAndProveFluxKey(REAL, { status: { configured: false, revision: "rev-1" }, bridge, request, desktop: true, refresh })).toBe("proved");
  });

  it("the store refresh reads both the settings and the engines", async () => {
    const asked: string[] = [];
    const applied: unknown[] = [];
    await refreshAfterFluxKey({
      request: async (path: string) => { asked.push(path); return { flux: { configured: true } }; },
      applyConfig: (config) => { applied.push(config); },
      refreshInstances: async () => { asked.push("instances"); },
    });
    expect(asked.sort()).toEqual(["/api/config", "instances"]);
    expect(applied).toEqual([{ flux: { configured: true } }]);
  });

  it("every place that saves a key passes the store's refresh", () => {
    const source = (file: string) =>
      readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const file of ["../components/FirstRunFluxCard.tsx", "../components/FirstRunJobsCard.tsx", "../components/Composer.tsx"]) {
      const text = source(file);
      const saves = text.match(/save(AndProve)?FluxKey\([^)]*\{[\s\S]*?\}\)/g) ?? [];
      expect(saves.length, file).toBeGreaterThan(0);
      for (const call of saves) expect(call, file).toMatch(/\brefresh\b/);
    }
  });
});
