// WHAT IS ALREADY HERE, AS ROWS.
//
// Step two of the guided first run is a REPORT: the Chief looked around this
// computer while the person typed their name, and this is what it found. The
// words are in first-run-copy.ts with the rest of the flow's copy; the shape
// of the list is here, as a pure function of the setup view, so it can be
// executed by a test rather than read out of a component's markup.
//
// THE SPLIT, AND WHO DECIDED IT. The approved simulation hand-picks three
// detailed rows and collapses fifteen, on a machine with eighteen engines on
// it. That split is an illustration, not a rule, and the rule was settled
// afterwards: everything RUNNABLE gets a row, and the rest collapses behind
// "and N more on this computer".
//
// Runnable is not "available", and the difference is the whole release.
// Murage SHIPS the Fuigo binary, so `fuigo --version` always answers and an
// instance on a bare machine reports itself available with an empty
// catalogue. `runnable()` on the server adds the term that matters, a
// non-empty default model, and `view.agents` is already filtered by it. So
// this module never re-decides what can think: it reads the two lists the
// server already separated and arranges them.
//
// `view.signedOutAgents` is the collapsed half. Those engines are here and
// ready and nobody is signed in to them, which is worth telling somebody
// about and is not worth three lines each in the middle of their first
// minute.

import { FIRST_RUN_COPY } from "@/lib/first-run-copy";
import type { SetupAgentReading, SetupView } from "../../shared/setup";

/**
 * The three shapes a row can take, which is the same three the simulation
 * draws glyphs for.
 *
 * `local` is an engine pointed at a model on this machine: the server decodes
 * its default as `host::model` and hands over both halves, which is also what
 * lets the row be titled the way its owner names it rather than by the
 * connection type Murage reaches it through.
 *
 * `cloud` is a remote engine that can answer right now. `off` is one that is
 * installed with nobody signed in to it, which is a true and unembarrassing
 * thing to say to somebody who has done nothing wrong.
 */
export type FirstRunEngineIcon = "local" | "cloud" | "off";

export interface FirstRunEngineRow {
  /** The instance id, as `/api/instances` reports it. Keys the row. */
  id: string;
  icon: FirstRunEngineIcon;
  /** The engine as the PERSON names it. */
  title: string;
  /** One line, and it is a fact about this engine rather than a sales line. */
  detail: string;
  /** The right-hand tag. */
  tag: string;
}

export interface FirstRunDetection {
  /** Everything this machine can think with, one detailed row each. */
  rows: FirstRunEngineRow[];
  /** Here, ready, nobody signed in. Behind the "and N more" button. */
  collapsed: FirstRunEngineRow[];
  /** "and 15 more on this computer", or "" when there is nothing behind it. */
  moreLabel: string;
}

const copy = FIRST_RUN_COPY.agents.detect;

/**
 * An engine named the way its owner names it.
 *
 * A local model is named by the MODEL and the server it runs on, never by the
 * connection type: "OpenAI-compatible (OpenRouter / Groq)" is an engine id and
 * two cloud vendors, said to somebody whose model is on their own hard disk,
 * and it was the Chief's opening line once. Anyone who installed a local model
 * will recognise the model at a glance, and naming the host is what makes the
 * claim checkable: they can go and look.
 */
export function engineRowTitle(agent: SetupAgentReading): string {
  const model = agent.localModel?.model.trim() ?? "";
  if (!model) return agent.name;
  const host = agent.localModel?.host.trim() ?? "";
  return host ? `${model} on ${host}` : model;
}

/**
 * One runnable engine, as a row.
 *
 * THE TAG NEVER SAYS "using this", AND THAT IS DELIBERATE. The approved flow
 * marks one row as the engine currently answering, and the setup view does not
 * carry which one that is: `SetupLiveState.chiefInstanceId` knows, and it is
 * not on `SetupView`. Putting "using this" on every local row would be a claim
 * that is false the moment somebody has two models on their machine, which is
 * the ordinary case for the exact person who has any. So every runnable engine
 * says the thing that is true of all of them, and the stronger claim waits for
 * the field that can prove it.
 */
function runnableRow(agent: SetupAgentReading): FirstRunEngineRow {
  if (agent.localModel) {
    return { id: agent.id, icon: "local", title: engineRowTitle(agent), detail: copy.localDetail, tag: copy.readyTag };
  }
  return {
    id: agent.id,
    icon: "cloud",
    title: engineRowTitle(agent),
    // The engine Murage ships is not something the person did, and saying
    // "signed in on your own account" about it would be the Chief taking
    // credit for an account that does not exist. `installed` is exactly the
    // field that separates the two sentences.
    detail: agent.installed ? copy.cloudDetail : copy.bundledDetail,
    tag: copy.readyTag,
  };
}

function signedOutRow(agent: SetupAgentReading): FirstRunEngineRow {
  return { id: agent.id, icon: "off", title: engineRowTitle(agent), detail: copy.offDetail, tag: copy.offTag };
}

/**
 * The detection report for this machine.
 *
 * Reads the view and nothing else. A view that has not arrived yet produces an
 * empty report rather than a guess, which is the same rule the cards follow:
 * unknown is not empty, and a card that guessed would be a card that is wrong
 * on half the machines it ships to.
 */
export function firstRunDetection(view: SetupView | null | undefined): FirstRunDetection {
  const rows = (view?.agents ?? []).map(runnableRow);
  const collapsed = (view?.signedOutAgents ?? []).map(signedOutRow);
  return { rows, collapsed, moreLabel: collapsed.length > 0 ? copy.more(collapsed.length) : "" };
}
