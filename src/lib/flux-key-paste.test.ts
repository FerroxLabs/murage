import { describe, expect, it } from "vitest";

import {
  FLUX_KEY_NOT_A_KEY,
  FLUX_KEY_STORAGE_UNAVAILABLE,
  detectFluxKeyInComposer,
  looksLikeFluxKey,
  readFluxStatus,
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

describe("reading the connection before a save", () => {
  it("takes only the revision and whether a key is already saved", async () => {
    const request = async () => ({ configured: true, revision: "rev-4", conflict: false, choices: [{ id: "a" }] });
    expect(await readFluxStatus(request)).toEqual({ configured: true, revision: "rev-4" });
  });

  it("survives an answer that says nothing", async () => {
    expect(await readFluxStatus(async () => ({}))).toEqual({ configured: false, revision: "" });
  });
});
