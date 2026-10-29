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

// The address must reach analytics from NOWHERE in this step (1.0.7, Sean:
// "no analytics, no device id"). A spy on the real export, so a call that
// came back would be seen rather than inferred from source.
const analytics = vi.hoisted(() => ({ identifyEmail: vi.fn(), setEmailGateDone: vi.fn() }));
vi.mock("@/lib/analytics", async (importOriginal) => ({ ...(await importOriginal<object>()), ...analytics }));

import { FIRST_RUN_COPY } from "@/lib/first-run-copy";
import { sellsOnPrice } from "@/lib/first-run-copy-rules";
import { helloContinue, helloEmailNote, saveHelloAnswer, skipHelloAnswer, type HelloAnswerDeps } from "./FirstRunHelloCard";

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
    markGate: (status) => gates.push(status),
    answer: async (step, answer) => { answers.push([step, answer]); },
  };
  return { calls, gates, answers, deps };
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
    expect(subscribe!.body).toEqual({ name: "Sean", email: "sean@example.com", from: "hello" });
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
    expect(analytics.identifyEmail).not.toHaveBeenCalled();
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
    expect(analytics.identifyEmail).not.toHaveBeenCalled();
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
      // NO RENDERER NETWORK CALL to the list: everything it reached is its
      // own server, never murage.ai. The post is the server's job.
      for (const [target] of fetched.mock.calls) expect(String(target)).not.toMatch(/murage\.ai|news\/subscribe/);
      expect(analytics.identifyEmail).not.toHaveBeenCalled();
    } finally {
      fetched.mockRestore();
    }
  });
});

// "Skip" passes over the email, not the name. The Windows customer
// pass typed "Sam", pressed Skip, and was then called "there".
describe("continuing with a name and no email (O16)", () => {
  it("saves the name, answers the step, and puts nobody on the list", async () => {
    const box = harness();
    const { profile, greeting } = await saveHelloAnswer({ name: "  Sean ", email: "  " }, box.deps);
    expect(box.calls).toEqual([{ path: "/api/config", method: "PUT", body: { profile: { name: "Sean" } } }]);
    expect(analytics.identifyEmail).not.toHaveBeenCalled();
    expect(box.gates).toEqual(["skipped"]);
    expect(box.answers).toEqual([["hello", "Sean"]]);
    expect(profile).toEqual({ name: "Sean", email: "" });
    expect(greeting).toContain("Sean");
  });

  it("does not answer the step when the name did not save", async () => {
    const box = harness({ savedProfile: { name: "someone else" } });
    await expect(saveHelloAnswer({ name: "Sean", email: "" }, box.deps)).rejects.toThrow();
    expect(box.answers).toEqual([]);
  });
});

describe("skipping the hello step", () => {
  const skipDeps = (box: ReturnType<typeof harness>) => {
    const skipped: string[] = [];
    return { skipped, deps: { ...box.deps, skip: async (step: "hello") => { skipped.push(step); } } };
  };

  it("keeps a typed name, and sends nobody to the list", async () => {
    const box = harness();
    const { skipped, deps } = skipDeps(box);
    const result = await skipHelloAnswer({ name: "  Sam ", email: "" }, deps);
    expect(box.calls).toEqual([{ path: "/api/config", method: "PUT", body: { profile: { name: "Sam" } } }]);
    expect(analytics.identifyEmail).not.toHaveBeenCalled();
    expect(box.gates).toEqual(["skipped"]);
    expect(skipped).toEqual(["hello"]);
    expect(result.greeting).toContain("Sam");
  });

  it("never saves a half-typed email when skipping", async () => {
    const box = harness();
    const { deps } = skipDeps(box);
    await skipHelloAnswer({ name: "Sam", email: "sam@exa" }, deps);
    expect(JSON.stringify(box.calls)).not.toContain("sam@exa");
  });

  it("saves nothing when no name was typed", async () => {
    const box = harness();
    const { skipped, deps } = skipDeps(box);
    const result = await skipHelloAnswer({ name: "   ", email: "" }, deps);
    expect(box.calls).toEqual([]);
    expect(skipped).toEqual(["hello"]);
    expect(result.greeting).toBe("");
  });

  it("does not skip past a name that did not save", async () => {
    const box = harness({ savedProfile: { name: "Somebody Else" } });
    const { skipped, deps } = skipDeps(box);
    await expect(skipHelloAnswer({ name: "Sam", email: "" }, deps)).rejects.toThrow();
    expect(skipped).toEqual([]);
  });
});

describe("the learning line (bot learning, design 7 and 12a)", () => {
  const line = FIRST_RUN_COPY.hello.welcome.learnLine;
  it("says how a bot learns in plain words: style starts right away, anything bigger asks with one tap", () => {
    expect(line).toBe("Tell any bot how you like replies, like shorter, warmer or in bullet points, and it starts right away. For anything bigger, it asks you with one tap.");
    expect(line).not.toMatch(/[\u2014\u2013]/);
    expect(line).not.toMatch(/\b(safe|safely|safety|unsafe|composio|always-on|getting smarter)\b/i);
    expect(sellsOnPrice(line)).toBeNull();
  });
  it("is on the card whether or not the form is still showing", () => {
    const source = readFileSync(fileURLToPath(new URL("./FirstRunHelloCard.tsx", import.meta.url)), "utf8");
    const line = source.split("\n").find(text => text.includes("copy.learnLine"));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/!done/);
  });
});

// THE RENDERER NEVER POSTS THE SIGNUP ITSELF. The list endpoint is named in
// server/news-signup.ts and nowhere in src/: the renderer only ever asks its
// own server. A source scan, because the claim is an absence.
describe("where the signup is posted from", () => {
  it("names the list endpoint nowhere in the renderer", async () => {
    const { readdirSync } = await import("node:fs");
    const root = fileURLToPath(new URL("../", import.meta.url));
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = dir + entry.name;
        if (entry.isDirectory()) { if (entry.name !== "locales" && entry.name !== "e2e") walk(full + "/"); continue; }
        if (!/\.(ts|tsx)$/.test(entry.name) || entry.name.includes(".test.")) continue;
        if (/news\/subscribe|murage\.ai\/api\/news/.test(readFileSync(full, "utf8"))) hits.push(full.slice(root.length));
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});

// A WRONG EMAIL EXPLAINS ITSELF (upstream 7f61ed1fc). Continue used to be
// held back with nothing said, and Enter in either box did nothing at all.
describe("a wrong email on the hello card", () => {
  const note = FIRST_RUN_COPY.hello.welcome.emailInvalid;

  it("asks for the email to be checked, from the button and from Enter alike", () => {
    expect(helloContinue("Sam", "sam@")).toBe("check-email");
    expect(helloContinue("Sam", "not an address")).toBe("check-email");
    // a wrong email is the thing to say even before a name is typed
    expect(helloContinue("", "sam@example")).toBe("check-email");
  });

  it("saves with a real address or none, and waits for a name otherwise", () => {
    expect(helloContinue("Sam", "sam@example.com")).toBe("save");
    expect(helloContinue("Sam", "  ")).toBe("save");
    expect(helloContinue("", "")).toBe("need-name");
    expect(helloContinue(" ", "sam@example.com")).toBe("need-name");
  });

  it("shows the note only once the box was left or Continue was tried", () => {
    expect(helloEmailNote("s", false)).toBe("");
    expect(helloEmailNote("sam@", true)).toBe(note);
    expect(helloEmailNote("sam@example.com", true)).toBe("");
    expect(helloEmailNote("", true)).toBe("");
  });

  it("says what to do in plain words", () => {
    expect(note).toMatch(/email address/i);
    expect(note).toMatch(/without one/i);
  });

  it("is wired to leaving the box, to Enter in both boxes and to the button", () => {
    const source = readFileSync(fileURLToPath(new URL("./FirstRunHelloCard.tsx", import.meta.url)), "utf8");
    expect(source).toContain("onBlur={() => setEmailChecked(true)}");
    expect(source.match(/if \(event\.key === "Enter"\) \{\s*event\.preventDefault\(\);\s*void save\(\);/g)).toHaveLength(2);
    expect(source).toContain('if (next === "check-email") setEmailChecked(true);');
    // the button stays pressable for a wrong email, so pressing it can say why
    expect(source).toContain("disabled={busy || !name.trim()}");
    expect(source).toContain("aria-disabled={!valid || undefined}");
    expect(source).toContain('aria-live="polite"');
  });
});
