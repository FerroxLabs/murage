import { describe, expect, it } from "vitest";

import { FIRST_RUN_COPY, lookedAroundLine } from "./first-run-copy";
import { engineRowTitle, firstRunDetection } from "./first-run-detect";
import type { SetupAgentReading, SetupView } from "../../shared/setup";

const copy = FIRST_RUN_COPY.agents.detect;

const agent = (over: Partial<SetupAgentReading> & { id: string }): SetupAgentReading => ({
  name: over.id,
  installed: true,
  ...over,
});

const view = (over: Partial<SetupView>): SetupView =>
  ({ agents: [], signedOutAgents: [], ownerName: "", ...over }) as SetupView;

describe("what is already here: the split", () => {
  // THE RULE, SETTLED AFTER THE SIMULATION WAS DRAWN. The simulation shows
  // three detailed rows and fifteen collapsed on an eighteen-engine machine,
  // and that split is an illustration. The rule is that everything RUNNABLE
  // gets a row and the rest collapses, so a machine with six usable engines
  // shows six and does not hide three of them behind a button.
  it("gives every runnable engine a row, however many there are", () => {
    const many = Array.from({ length: 6 }, (_, index) => agent({ id: `engine-${index}` }));
    const detection = firstRunDetection(view({ agents: many }));
    expect(detection.rows).toHaveLength(6);
    expect(detection.rows.map((row) => row.title)).toEqual(many.map((one) => one.name));
    expect(detection.collapsed).toHaveLength(0);
    expect(detection.moreLabel).toBe("");
  });

  // `view.agents` is already filtered by `runnable()` on the server, whose
  // third term is a non-empty default model. Everything here is therefore
  // something that can answer, and everything in `signedOutAgents` is
  // something that is here and cannot, which is exactly the line the collapse
  // is drawn on.
  it("collapses the engines nobody is signed in to, and counts them", () => {
    const detection = firstRunDetection(view({
      agents: [agent({ id: "claude", name: "Claude Code" })],
      signedOutAgents: [
        agent({ id: "codex", name: "Codex" }),
        agent({ id: "gemini", name: "Gemini CLI" }),
      ],
    }));
    expect(detection.rows.map((row) => row.title)).toEqual(["Claude Code"]);
    expect(detection.collapsed.map((row) => row.title)).toEqual(["Codex", "Gemini CLI"]);
    expect(detection.moreLabel).toBe("and 2 more on this computer");
  });

  it("says nothing at all before the view has arrived", () => {
    // Unknown is not empty. A report built from a guess is a report that is
    // wrong on half the machines it ships to.
    for (const nothing of [null, undefined]) {
      const detection = firstRunDetection(nothing);
      expect(detection.rows).toHaveLength(0);
      expect(detection.collapsed).toHaveLength(0);
      expect(detection.moreLabel).toBe("");
    }
  });
});

describe("what is already here: one row", () => {
  it("names a local model by the model and its host, never by the connection", () => {
    // "You already had OpenAI-compatible (OpenRouter / Groq)" was the Chief's
    // opening line to somebody whose model was on their own hard disk: an
    // engine id and two cloud vendors, neither of which was theirs.
    expect(engineRowTitle(agent({
      id: "generic",
      name: "OpenAI-compatible (OpenRouter / Groq)",
      localModel: { model: "qwen3:8b", host: "Ollama" },
    }))).toBe("qwen3:8b on Ollama");
    expect(engineRowTitle(agent({
      id: "generic",
      name: "OpenAI-compatible (OpenRouter / Groq)",
      localModel: { model: "qwen3:8b", host: "  " },
    }))).toBe("qwen3:8b");
    expect(engineRowTitle(agent({ id: "claude", name: "Claude Code" }))).toBe("Claude Code");
  });

  it("marks a local model local and promises nothing leaves the machine", () => {
    const [row] = firstRunDetection(view({
      agents: [agent({ id: "ollama", name: "generic", localModel: { model: "qwen3:8b", host: "Ollama" } })],
    })).rows;
    expect(row.icon).toBe("local");
    expect(row.detail).toBe(copy.localDetail);
    expect(row.tag).toBe(copy.readyTag);
  });

  // THE ENGINE IN THE BOX IS NOT SOMETHING THEY DID.
  //
  // `installed` separates the two sentences the Chief has to be able to say.
  // Telling somebody they are "signed in on your own account" about the engine
  // Murage shipped would be the Chief taking credit for an account that does
  // not exist, on a machine where they have signed in to nothing.
  it("tells the engine in the box apart from one the person signed in to", () => {
    const rows = firstRunDetection(view({
      agents: [
        agent({ id: "claude", name: "Claude Code", installed: true }),
        agent({ id: "fuigo", name: "Fuigo", installed: false }),
      ],
    })).rows;
    expect(rows[0].icon).toBe("cloud");
    expect(rows[0].detail).toBe(copy.cloudDetail);
    expect(rows[1].icon).toBe("cloud");
    expect(rows[1].detail).toBe(copy.bundledDetail);
    expect(rows[1].detail).not.toBe(copy.cloudDetail);
  });

  it("says a signed-out engine is here without saying anything is broken", () => {
    const [row] = firstRunDetection(view({
      agents: [agent({ id: "claude" })],
      signedOutAgents: [agent({ id: "codex", name: "Codex", signInCommand: "codex login" })],
    })).collapsed;
    expect(row.icon).toBe("off");
    expect(row.detail).toBe(copy.offDetail);
    expect(row.tag).toBe(copy.offTag);
    expect(`${row.detail} ${row.tag}`).not.toMatch(/broken|error|fail|wrong|cannot/i);
  });

  // NO ROW CLAIMS TO BE THE ONE ANSWERING.
  //
  // The approved flow tags one row "using this". Which engine the Chief is
  // actually on lives on `SetupLiveState.chiefInstanceId` and is not carried
  // on the view, so this build cannot prove it. Put on every local row it
  // would be false the moment somebody has two models on their machine, which
  // is the ordinary case for the exact person who has any. If the field ever
  // reaches the view, this is the test that says what to do with it.
  it("never claims an engine is the one answering, because it cannot prove which", () => {
    const detection = firstRunDetection(view({
      agents: [
        agent({ id: "a", localModel: { model: "qwen3:8b", host: "Ollama" } }),
        agent({ id: "b", localModel: { model: "llama3", host: "llama.cpp" } }),
      ],
    }));
    for (const row of detection.rows) expect.soft(row.tag).not.toMatch(/using this/i);
  });
});

describe("what is already here: the words around the rows", () => {
  it("opens with the greeting, and drops the name clause when there is no name", () => {
    expect(lookedAroundLine("Sean")).toBe("Good to meet you, Sean. I had a look around this computer while you typed.");
    expect(lookedAroundLine("  Sean  ")).toContain("Good to meet you, Sean.");
    expect(lookedAroundLine("")).toBe("Good to meet you. I had a look around this computer while you typed.");
    expect(lookedAroundLine(null)).not.toContain("there");
    expect(lookedAroundLine(undefined)).not.toContain("undefined");
  });

  it("hands over to the next screen without claiming the person is finished", () => {
    // What was found can answer questions. What it cannot do is reach their
    // mail, their calendar or their apps, and saying both halves is what makes
    // the next screen an offer rather than a pitch.
    expect(copy.closing).toBe(
      "That is enough for me to answer you. It is not enough for me to do the interesting part.",
    );
    expect(copy.action).toBe("Show me the interesting part");
    expect(copy.heading).toBe("What is already here.");
    expect(copy.more(15)).toBe("and 15 more on this computer");
    expect(copy.hide).toBe("Hide them");
  });
});
