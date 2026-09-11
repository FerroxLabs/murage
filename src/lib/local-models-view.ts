// The words Settings → Models → Local models puts on screen, and the single
// next action each state offers (0.1.52 LM2, spec V1–V5).
//
// Everything here is pure. The rule it exists to enforce is Sean's "don't make
// me think": every state answers what Murage found, what it means, and the one
// thing to do next, in plain language — the diagnostics live behind a
// disclosure. Keeping that as data, not JSX, is what lets a test hold the copy
// to the rule instead of holding a screenshot to it.
import {
  AGENT_MIN_CONTEXT_TOKENS,
  AGENT_RECOMMENDED_CONTEXT_TOKENS,
  localEngineLabel,
  localEngineSupport,
  LOCAL_SERVER_KIND_LABELS,
  type LocalDetectionTarget,
  type LocalModelView,
  type LocalServerView,
  type LocalToolCheck,
  type LocalToolTestResult,
} from "../../shared/local-models";

/** The event that brings someone from the picker or an Engines row straight to
 *  Settings → Models → Local models, with "Add a server" focused. */
export const OPEN_LOCAL_MODELS_EVENT = "murage:open-local-models";
/** The event a tested model fires to send the user back to a bot's model menu —
 *  the next step after "Tools work" is choosing it, which only that menu does. */
export const OPEN_MODEL_PICKER_EVENT = "murage:open-model-picker";

/** The one name this feature has, in settings, the picker, engines and docs. */
export const LOCAL_MODELS_TITLE = "Local models";

export const LOCAL_MODELS_INTRO =
  "Models running on this computer or your own network. Murage sends them nothing until you pick one for a bot.";

/**
 * Spec V1: the empty state names every address Murage checked, so "nothing
 * answered" is a fact about known places rather than a shrug. Ports are shown
 * here because the user is being told where to start a server, which is the one
 * case where an address is the plain-language answer.
 */
export function lookedLine(targets: readonly LocalDetectionTarget[]): string {
  const where = targets.map((target) => `${LOCAL_SERVER_KIND_LABELS[target.kind]} at ${target.address}`).join(", ");
  return `Looked for ${where} — nothing answered.`;
}

export function serverStatusLine(server: LocalServerView, now: number): string {
  const checked = lastCheckedLine(server.checkedAt, now);
  if (server.status !== "running") return `Not answering · ${checked}`;
  const count = server.models.length;
  const models = count === 0 ? "no models loaded" : count === 1 ? "1 model" : `${count} models`;
  return `Running · ${models} · ${checked}`;
}

export function lastCheckedLine(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "checked just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `checked ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `checked ${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `checked ${new Date(at).toLocaleString()}`;
}

export function tokensLabel(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1024)}K` : String(tokens);
}

/** What context this model actually gets, and whether that is enough for agent
 *  work — the number alone means nothing to most people. */
export function contextLine(model: LocalModelView): string {
  const window = model.context?.contextWindow;
  if (!window) return "Context size not reported by this server";
  if (window < AGENT_MIN_CONTEXT_TOKENS) {
    return `${tokensLabel(window)} context loaded — too small for agents, which need ${tokensLabel(AGENT_MIN_CONTEXT_TOKENS)} or more`;
  }
  return `${tokensLabel(window)} context loaded`;
}

/** Spec V2: which engines can use this model right now, by their own names. */
export function enginesLine(model: LocalModelView): string {
  if (!model.engines.length) return "No engine can use this model yet — run the test first";
  return `Usable by ${model.engines.map(localEngineLabel).join(", ")}`;
}

/** Spec T1: one plain-language outcome, never a diagnostic. */
export function testOutcomeLine(test: LocalToolTestResult): string {
  switch (test.outcome) {
    case "tools-work":
      return "Tools work — ready for agents";
    case "tools-partial":
      return "Tools work, with gaps — some agent behaviour may be unreliable";
    case "text-instead-of-tools":
      return "This model answers but can't use tools (it came back as text)";
    case "context-too-small":
      return test.context?.contextWindow
        ? `Context too small for agents (loaded ${tokensLabel(test.context.contextWindow)}; agents need ${tokensLabel(AGENT_MIN_CONTEXT_TOKENS)}+)`
        : `Context too small for agents (agents need ${tokensLabel(AGENT_MIN_CONTEXT_TOKENS)}+)`;
    case "server-rejects-tools":
      return "This server rejects tools — it has to be started with them enabled";
    case "model-not-found":
      return "This server no longer has that model";
    case "unreachable":
      return "The server did not answer";
  }
}

/** Which API surfaces the test proved, in the terms the engines are chosen by. */
export function surfacesLine(test: LocalToolTestResult): string {
  const proven: string[] = [];
  if (test.surfaces.chat) proven.push("chat tools");
  if (test.surfaces.responses) proven.push("Codex (responses)");
  if (test.surfaces.messages) proven.push("Claude (messages)");
  return proven.length ? `Proven: ${proven.join(", ")}` : "Nothing proven yet";
}

const CHECK_TITLES: Record<string, string> = {
  "chat.auto": "Calls a tool when it should",
  "chat.required": "Calls a tool when told to",
  "chat.stream": "Streams tool calls",
  "chat.roundtrip": "Uses a tool result",
  "chat.manyTools": "Handles a full tool set",
  "messages.toolUse": "Anthropic-style tools (Claude)",
  "responses.functionCall": "Responses-style tools (Codex)",
};

const CHECK_DETAILS: Record<string, string> = {
  ok: "passed",
  "text-instead-of-tool": "answered with text instead of calling the tool",
  "wrong-tool-call": "called a different tool",
  "bad-arguments": "sent arguments that could not be read",
  "tools-rejected": "the server refused the request's tools",
  "context-exceeded": "the prompt did not fit in the loaded context",
  "model-not-found": "the server does not have this model",
  "no-endpoint": "this server does not offer that endpoint",
  "http-error": "the server returned an error",
  network: "the server could not be reached",
  timeout: "the server did not answer in time",
  "redirect-refused": "the server tried to redirect the request elsewhere",
  "no-first-call": "no tool call arrived",
};

/** The technical half, for the disclosure only. */
export function checkLine(check: LocalToolCheck): string {
  const title = CHECK_TITLES[check.name] ?? check.name;
  const mark = check.status === "pass" ? "Pass" : check.status === "skipped" ? "Skipped" : "Fail";
  return `${title}: ${mark} — ${CHECK_DETAILS[check.detail] ?? check.detail}`;
}

export type LocalModelActionKind =
  | "test"
  | "retest"
  | "use"
  | "copy-flag"
  | "ollama-context-copy"
  | "pick-other-model";

export interface LocalModelAction {
  kind: LocalModelActionKind;
  label: string;
  /** The exact flag or setting a copy action puts on the clipboard. */
  value?: string;
  /** One sentence under the button saying what it will do. */
  help: string;
}

/**
 * Spec UX rule: exactly one primary action per state, and never a bare status.
 * `serverKind` decides only whether the Ollama helper is offered, because it is
 * the one server whose context cannot be raised per request.
 */
export function nextActionFor(server: LocalServerView, model: LocalModelView): LocalModelAction {
  if (server.status !== "running") {
    return { kind: "retest", label: "Check again", help: "Asks this address once more." };
  }
  const test = model.test;
  if (!test) {
    return {
      kind: "test",
      label: `Test ${model.model}`,
      help: "Runs seven checks on this computer. No cloud provider is called and nothing is billed.",
    };
  }
  switch (test.outcome) {
    case "tools-work":
    case "tools-partial":
      return { kind: "use", label: "Use with a bot", help: "Opens the model menu so you can pick it for the bot you are in." };
    case "context-too-small":
      if (server.kind === "ollama") {
        return {
          kind: "ollama-context-copy",
          label: `Create a ${tokensLabel(AGENT_RECOMMENDED_CONTEXT_TOKENS)} copy`,
          help: `Makes a copy of this model on your Ollama server with a ${tokensLabel(AGENT_RECOMMENDED_CONTEXT_TOKENS)} context. The original is untouched.`,
        };
      }
      return {
        kind: "copy-flag",
        label: "Copy the fix",
        value: test.fix?.value ?? `-c ${AGENT_RECOMMENDED_CONTEXT_TOKENS}`,
        help: "Copies the setting to start this server with, then test again.",
      };
    case "server-rejects-tools":
      return {
        kind: "copy-flag",
        label: "Copy the fix",
        value: test.fix?.value ?? "--jinja",
        help: "Copies the setting to start this server with, then test again.",
      };
    case "text-instead-of-tools":
      return { kind: "pick-other-model", label: "Try another model", help: "This model cannot run agents. Pick another one on this server and test it." };
    case "model-not-found":
      return { kind: "retest", label: "Check again", help: "Reads this server's model list again." };
    case "unreachable":
      return { kind: "retest", label: "Check again", help: "Asks this address once more." };
  }
}

/**
 * Spec V4: one line per engine row. An engine that cannot use a local server
 * at all gets nothing rather than a line that would have to say "no" — the
 * absence is the honest answer, and the row stays short.
 */
export function engineLocalLine(driver: string): string {
  const support = localEngineSupport(driver);
  if (support === "tools") return `Works with ${LOCAL_MODELS_TITLE.toLowerCase()} — manage them under Models → ${LOCAL_MODELS_TITLE}`;
  if (support === "chat-only") return `${LOCAL_MODELS_TITLE}: chat only (no tools)`;
  return "";
}
