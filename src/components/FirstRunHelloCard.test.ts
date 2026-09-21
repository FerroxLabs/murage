// THE SIGNUP, RUN.
//
// THE DEFECT. The only guard on the one thing in the first run that leaves
// the machine for a mailing list was a `readFileSync` of FirstRunHelloCard.tsx
// grepping for `"/api/subscribe"` (server/setup-api.test.ts). A reviewer
// replaced the real call with a dead constant of the same name and 22 tests
// stayed green. Sendlane would have collected nothing, from everybody, and
// the suite would have said the wiring was intact. A grep cannot tell a call
// from a constant, a comment, or dead code.
//
// So the sequence is executed here with fakes standing in for the network:
// what it calls, in what order, and what it declines to call when the save
// did not stick.
//
// This suite runs in the node environment and has no DOM, so what is executed
// is `saveHelloAnswer` — the whole of the step's behaviour. The component
// around it is now a form and a try/catch with nothing else in it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { saveHelloAnswer, type HelloAnswerDeps } from "./FirstRunHelloCard";

interface Call {
  path: string;
  method?: string;
  body?: unknown;
}

/** The harness: every call recorded, the config PUT answering however the
 *  test wants it to. */
function harness(over: {
  savedProfile?: unknown;
  subscribe?: () => Promise<unknown>;
} = {}) {
  const calls: Call[] = [];
  const identified: string[] = [];
  const gates: string[] = [];
  const answers: Array<[string, string]> = [];
  const deps: HelloAnswerDeps = {
    api: async (path, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path, method: init?.method, body });
      if (path === "/api/config") {
        return { profile: over.savedProfile ?? body.profile };
      }
      if (path === "/api/subscribe") return over.subscribe ? await over.subscribe() : { ok: true };
      return {};
    },
    identify: (email) => identified.push(email),
    markGate: (status) => gates.push(status),
    answer: async (step, answer) => { answers.push([step, answer]); },
  };
  return { calls, identified, gates, answers, deps };
}

const TYPED = { name: "  Sean  ", email: "  Sean@Example.COM " };

describe("the hello step's answer", () => {
  it("puts the address on the list, server side, once the profile is saved", async () => {
    const box = harness();
    const { profile, greeting } = await saveHelloAnswer(TYPED, box.deps);

    const subscribe = box.calls.find((call) => call.path === "/api/subscribe");
    expect(subscribe, "the hello card stopped posting the signup").toBeTruthy();
    expect(subscribe!.method).toBe("POST");
    // Trimmed and lower cased, because that is what the list is keyed by and
    // what the Chief will use.
    expect(subscribe!.body).toEqual({ name: "Sean", email: "sean@example.com" });
    expect(profile).toEqual({ name: "Sean", email: "sean@example.com" });
    expect(greeting).toContain("Sean");

    // The renderer never learns the credential exists: it asks its own
    // server, which holds the key.
    expect(box.calls.map((call) => call.path)).not.toContain("/api/sendlane");
  });

  // NOT A WIRING CHECK. A SECRET SCAN.
  //
  // The list's key is a write credential for the account, and an Electron
  // renderer bundle is readable by anybody who installs the app. So the
  // provider is named server side and nowhere else, and the only way to
  // assert an ABSENCE from a bundle is to look. Nothing about behaviour is
  // being inferred from source here.
  it("never names the list provider anywhere in the renderer's own card", () => {
    const source = readFileSync(fileURLToPath(new URL("./FirstRunHelloCard.tsx", import.meta.url)), "utf8");
    expect(source, "the renderer learned which provider holds the list").not.toMatch(/sendlane/i);
  });

  it("saves the profile first, and confirms the save before anything else happens", async () => {
    const box = harness();
    await saveHelloAnswer(TYPED, box.deps);
    expect(box.calls.map((call) => call.path)).toEqual(["/api/config", "/api/subscribe"]);
    expect(box.calls[0].method).toBe("PUT");
    expect(box.identified).toEqual(["sean@example.com"]);
    expect(box.gates).toEqual(["submitted"]);
  });

  it("records what they told the Chief, both halves, in the transcript", async () => {
    const box = harness();
    await saveHelloAnswer(TYPED, box.deps);
    expect(box.answers).toEqual([["hello", "Sean, sean@example.com"]]);
  });

  // A PUT THAT ANSWERED IS NOT A PUT THAT SAVED. The Chief using a name it
  // does not have, all week, is the defect that check exists for; nothing
  // downstream may run on an unconfirmed save.
  it("subscribes nobody when the profile did not actually save", async () => {
    const box = harness({ savedProfile: { name: "Somebody Else", email: "other@example.com" } });
    await expect(saveHelloAnswer(TYPED, box.deps)).rejects.toThrow();
    expect(box.calls.map((call) => call.path)).toEqual(["/api/config"]);
    expect(box.identified).toEqual([]);
    expect(box.answers).toEqual([]);
  });

  // Entry to the app has never been allowed to depend on a marketing list
  // being reachable, and this is the half of that the server cannot prove:
  // the caller does not await it and does not let it throw.
  it("does not hold the person up, or fail them, when the list is unreachable", async () => {
    const box = harness({ subscribe: () => Promise.reject(new Error("sendlane is down")) });
    const { greeting } = await saveHelloAnswer(TYPED, box.deps);
    expect(greeting).toContain("Sean");
    expect(box.answers).toHaveLength(1);
    // let the rejected fire-and-forget settle; an unhandled rejection here
    // would be a crash in a real renderer
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("is what the card runs, with its own dependencies, when nobody passes any", async () => {
    // The default argument is the live wiring. Handing it nothing must reach
    // the real `api`, which in this environment has no server to talk to, so
    // the assertion is that it TRIED rather than quietly doing nothing.
    const fetched = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no server here"));
    try {
      await expect(saveHelloAnswer({ name: "Sean", email: "sean@example.com" })).rejects.toThrow();
      // The real client asks the harness for its desktop proof before it
      // sends anything, so the proof that the default wiring is live is that
      // this reached the network at all rather than a stub.
      expect(fetched).toHaveBeenCalled();
      expect(fetched.mock.calls.map((call) => String(call[0])).join(" ")).toMatch(/\/api\//);
    } finally {
      fetched.mockRestore();
    }
  });
});
