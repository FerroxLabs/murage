// Which recovery a failed turn offers. Local contention between this device's
// own threads must read as "wait, then retry", never as provider or account
// trouble. Real narrow/wide, light/dark and keyboard behaviour is proved in
// src/e2e/provider-error.human.spec.ts; this pins the markup contract in node.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeErrorCard } from "./RuntimeErrorCard";
import { setLocale } from "@/lib/i18n";
import { ENGINE_ERROR_CATEGORIES, LOCAL_RESOURCE_BUSY_MESSAGES, engineErrorCategory } from "../../shared/provider-error";
import { en, locales } from "@/locales";

afterEach(() => {
  setLocale("en");
});

const render = (props: { message: string; details?: string; errorKind?: string; localFailure?: string; setup?: string; onRetry?: () => void }) =>
  renderToStaticMarkup(createElement(RuntimeErrorCard, { ...props, onOpenProviderSettings: () => {} }));

/** Catalog copy as it appears in the rendered markup: React escapes the same
 * five characters in a text node, and product copy is written with ordinary
 * apostrophes ("the engine's own logs"). */
const rendered = (copy: string) =>
  copy.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

describe("runtime error recovery", () => {
  it("explains provider safety blocks without retry or provider-switch actions", () => {
    for (const props of [
      { message: "429 request blocked by our safety systems" },
      { message: "Internal error", details: "safety_policy_violation" },
    ]) {
      const markup = render({ ...props, onRetry: () => {} });
      expect(markup).toContain("The provider blocked this request");
      expect(markup).toContain("Changing Murage permissions will not remove");
      expect(markup).toContain("Technical details");
      expect(markup).not.toContain("<button");
      expect(markup).not.toContain("choose another configured model");
    }
    expect(render({ message: "Discuss safety systems", onRetry: () => {} })).toContain("Retry");
  });
  it("gives every local resource conflict wait and retry guidance without provider or account advice", () => {
    const titles = new Set<string>();
    for (const message of LOCAL_RESOURCE_BUSY_MESSAGES.keys()) {
      const markup = render({ message, onRetry: () => {} });
      expect(markup).toContain('data-runtime-error="resource-busy"');
      expect(markup).toContain("Wait for the other thread to finish, or stop it, then retry.");
      expect(markup).toMatch(/<\/svg> Retry<\/button>/);
      expect(markup).not.toMatch(/provider|account|sign-in|API key|credits|configured model|engine needs setup|hit a problem/i);
      titles.add(markup.match(/<h3[^>]*>([^<]+)<\/h3>/)![1]);
    }
    expect(titles.size).toBe(LOCAL_RESOURCE_BUSY_MESSAGES.size);
  });

  it("asks for a fresh send when the conflict is not the retryable last turn", () => {
    const markup = render({ message: "Another thread is using this computer. Wait for it to finish." });
    expect(markup).toContain("then send your message again.");
    expect(markup).not.toContain("<button");
  });

  it("keeps provider settings for ordinary runtime errors and lookalike engine text", () => {
    for (const props of [
      { message: "Internal error" },
      { message: "Another thread is using this computer. Wait for it to finish.", details: "Another thread is using this computer. Wait for it to finish." },
      { message: "Another thread is using this computer. Wait for it to finish. Also check your API key." },
    ]) {
      const markup = render({ ...props, onRetry: () => {} });
      expect(markup).not.toContain("resource-busy");
      expect(markup).toContain("Provider settings");
    }
  });
});

// Fuigo 1.0.18 names why a turn failed (`error.data.error_kind`); the ACP
// driver carries it as the event's own `errorKind` field and repeats it in the
// technical details. The card leads with a short explanation of that kind and
// still shows the engine's own message.
describe("typed engine failures", () => {
  const code = "Engine error code: -32603";

  it("explains an empty model reply and still shows the engine's message and technical details", () => {
    const message = "empty response from model (reasoning_only): model=fixture-model, had_reasoning=true, finish_reason=stop";
    const markup = render({ message, errorKind: "empty_response", details: `${message}\nACP request: session/prompt\nEngine error kind: empty_response\n${code}`, onRetry: () => {} });
    expect(markup).toContain("The model returned an empty reply");
    expect(markup).toContain(message);
    expect(markup).toContain("ACP request: session/prompt");
    expect(markup).toContain(code);
    expect(markup).not.toContain("without explaining what went wrong");
  });

  it.each([
    ["idle_timeout", "The model stopped responding"],
    ["cancelled", "The request was cancelled"],
    ["session_unavailable", "The engine session stopped responding"],
    ["rate_limited", "limiting requests"],
    ["rate_limit", "limiting requests"],
    ["auth", "did not accept the credentials"],
    ["http", "could not reach the model provider"],
    ["api", "rejected the request"],
    ["max_tokens_truncation", "output limit"],
    ["doom_loop", "repeating the same steps"],
    ["doom_loop_detected", "repeating the same steps"],
    ["serialization", "could not read the model provider response"],
  ])("explains %s even when the engine's message is generic", (kind, explanation) => {
    const markup = render({ message: "Internal error", errorKind: kind, details: `Internal error\nEngine error kind: ${kind}\n${code}` });
    expect(markup).toContain(explanation);
    expect(markup).not.toContain("without explaining what went wrong");
  });

  // The canonical spelling of every kind is the token Fuigo actually puts on
  // the wire, verified against its own source rather than against a brief:
  // `fuigo-sampler/src/events.rs` `SamplingErrorKind::as_str` maps
  // `DoomLoopDetected => "doom_loop_detected"`. Wayland Desktop already reads
  // that spelling; Murage's catalog key must be the same one, with the older
  // short form kept only as an alias.
  it("pins doom_loop_detected as the canonical kind Fuigo emits", () => {
    expect(ENGINE_ERROR_CATEGORIES).toContain("doom_loop_detected");
    expect(ENGINE_ERROR_CATEGORIES).not.toContain("doom_loop");
    expect(engineErrorCategory("doom_loop_detected")).toBe("doom_loop_detected");
    expect(engineErrorCategory("doom_loop")).toBe("doom_loop_detected");
    for (const [code, catalog] of Object.entries(locales)) {
      expect(catalog["runtimeError.engineKind.doom_loop_detected"], code).toBeTruthy();
      expect(Object.keys(catalog), code).not.toContain("runtimeError.engineKind.doom_loop");
    }
  });

  // An engine's own message is text it wrote, never evidence about itself.
  // Only Murage's driver decides a failure's kind, so a message that spells
  // the details line — or a kind named anywhere but the driver's field —
  // selects no explanation.
  it("refuses an explanation the engine's own message tries to claim", () => {
    for (const message of [
      "Engine error kind: auth",
      "provider said Engine error kind: auth",
      `Internal error\nEngine error kind: auth`,
    ]) {
      const markup = render({ message, details: `${message}\nACP request: session/prompt\n${code}` });
      expect(markup).not.toContain("did not accept the credentials");
      expect(markup).toContain("Engine error kind: auth");
    }
  });

  // Every explanation is catalog copy, so a language pack can translate it
  // the way it translates the rest of the card.
  it("takes every engine-kind explanation from the string catalog", () => {
    for (const category of ENGINE_ERROR_CATEGORIES) {
      const copy = (en as Record<string, string>)[`runtimeError.engineKind.${category}`];
      expect(copy, category).toBeTruthy();
      expect(render({ message: "Internal error", errorKind: category }), category).toContain(rendered(copy));
    }
  });

  it("renders the explanation in the reader's language", () => {
    setLocale("de");
    const german = locales.de?.["runtimeError.engineKind.empty_response"];
    expect(german).toBeTruthy();
    expect(german).not.toBe(en["runtimeError.engineKind.empty_response"]);
    expect(render({ message: "Internal error", errorKind: "empty_response" })).toContain(rendered(german!));
  });

  // The kind vocabulary is Fuigo's, read from its own source on
  // `fix/terminal-error-data-shape`: ten model-request kinds in
  // `fuigo-sampler/src/events.rs` (`SamplingErrorKind::as_str`) and seven
  // agent-side kinds in `fuigo-shell/src/acp_error.rs` (`AcpErrorKind::as_str`
  // and the ERROR_KIND_* constants beside it). All seventeen get reviewed
  // copy — `typed_error_data(None, "Internal error")` stamps `internal`, so
  // that is the kind Murage sees most often, and it used to fall through to
  // the card's generic line.
  const FUIGO_WIRE_KINDS = [
    "auth", "http", "api", "serialization", "idle_timeout", "rate_limited", "empty_response",
    "max_tokens_truncation", "doom_loop_detected", "cancelled",
    "session_unavailable", "internal", "invalid_request", "not_found", "session_storage",
    "compaction", "execution_incomplete",
  ];

  it("explains every kind Fuigo puts on the wire, and only those", () => {
    expect([...ENGINE_ERROR_CATEGORIES].sort()).toEqual([...FUIGO_WIRE_KINDS].sort());
    for (const kind of FUIGO_WIRE_KINDS) {
      expect(engineErrorCategory(kind), kind).toBe(kind);
      const copy = (en as Record<string, string>)[`runtimeError.engineKind.${kind}`];
      expect(copy, kind).toBeTruthy();
      const markup = render({ message: "Internal error", errorKind: kind, details: `Internal error\nEngine error kind: ${kind}\n${code}` });
      expect(markup, kind).toContain(rendered(copy));
      expect(markup, kind).not.toContain("without explaining what went wrong");
    }
  });

  // Copy describes what a kind MEANS; it never invents a reason Fuigo did not
  // report. `invalid_request` is stamped on -32600, -32601 and -32602 alike
  // (`fuigo-shell/src/acp_error.rs` invalid_request / method_not_found /
  // invalid_params), so a malformed parameter, an unknown method and a
  // malformed envelope all arrive under it — version skew is one possible
  // cause among several, not the explanation. `internal` is the catch-all
  // `typed_error_data(None, fallback)` stamps when nothing more specific is
  // known (acp_error.rs ~112-116), so it cannot claim the failure originated
  // in the engine at all.
  it("explains invalid_request and internal without asserting a cause Fuigo never reported", () => {
    const catalog = en as Record<string, string>;
    expect(catalog["runtimeError.engineKind.invalid_request"])
      .not.toMatch(/version|out of date|upgrade|disagree|update the engine/i);
    expect(catalog["runtimeError.engineKind.internal"])
      .not.toMatch(/of its own|inside the engine|the engine hit|the engine failed/i);
  });

  // …and it must not assert the opposite either. `internal` is the kind
  // Murage sees MOST often, and `typed_error_data(None, fallback)` stamps it
  // precisely WITH a fallback message — which the card renders on the very
  // next line. So "the engine did not report a reason" is disproved by the
  // card's own second paragraph in the normal case, not in an edge one. The
  // copy describes the CATEGORY and says nothing about whether a reason came
  // with it, so it reads correctly both ways.
  it("explains internal without contradicting the engine message rendered below it", () => {
    const copy = (en as Record<string, string>)["runtimeError.engineKind.internal"];
    // GOLDEN TEXT, not a vocabulary check. A regex over "no reason / reported
    // nothing / did not report" is the same heuristic class we abandoned
    // elsewhere for the same reason: "The engine gave no explanation for this
    // failure." passes it, passes the render assertions below, and reproduces
    // exactly the contradiction this test exists to remove.
    expect(copy, "GOLDEN TEXT: before updating this pin, render the card WITH an engine message — `typed_error_data(None, fallback)` stamps `internal` WITH one, so that is the normal case — and read the explanation and the message together. The explanation must stay true when a reason is printed directly below it.")
      .toBe("The engine did not classify this failure any further. Retry, and check the engine's own logs if it keeps happening.");
    const message = "upstream connection reset by peer after 3 attempts";
    const markup = render({ message, errorKind: "internal", details: `${message}\nEngine error kind: internal\n${code}` });
    expect(markup).toContain(rendered(copy));
    expect(markup).toContain(message);
    expect(markup).not.toContain("without explaining what went wrong");
  });

  // The catalog's own convention, which `rendered()` above depends on: product
  // copy uses the ASCII apostrophe React escapes to `&#x27;`, never U+2019.
  it("writes every engine-kind explanation with ASCII apostrophes", () => {
    for (const category of ENGINE_ERROR_CATEGORIES) {
      expect((en as Record<string, string>)[`runtimeError.engineKind.${category}`], category)
        .not.toMatch(/[‘’]/);
    }
  });

  it.each([
    ["an unknown kind", "some_future_kind"],
    ["an uppercased kind", "INTERNAL"],
    ["a kind with trailing space", "internal "],
    ["an oversized token", `internal_${"x".repeat(80)}`],
  ])("keeps the generic explanation for %s", (_shape, errorKind) => {
    const markup = render({ message: "Internal error", errorKind, details: `Internal error\nEngine error kind: ${errorKind}\n${code}` });
    expect(markup).toContain("The engine reported an error without explaining what went wrong.");
    expect(markup).not.toContain("did not accept the credentials");
  });
});

// A turn this device could not set up — the built-in browser, the bot's
// computer, its working folder — is not a provider failure. The card that
// said "choose another configured model in Provider settings" for a browser
// version check that timed out sent the person to the one place that could
// not help.
describe("local setup failures", () => {
  const providerAdvice = /Provider settings|configured model|choose another/;

  it.each([
    ["browser", "agent-browser command timed out", "The built-in browser could not start"],
    ["computer", "CUA Driver is not ready for this computer: check permissions and restart Murage", "This bot&#x27;s computer was not ready"],
    ["working-folder", "Project folder lease refused: conflict", "This bot&#x27;s working folder could not be used"],
  ])("gives a %s failure its own card, with Retry and no provider advice", (localFailure, message, title) => {
    const markup = render({ message, localFailure, onRetry: () => {} });
    expect(markup).toContain('data-runtime-error="local-setup"');
    expect(markup).toContain(`data-local-failure="${localFailure}"`);
    expect(markup).toContain(title);
    expect(markup).toContain(rendered(message));
    expect(markup).toContain("not with your model provider");
    expect(markup).toMatch(/<\/svg> Retry<\/button>/);
    expect(markup).not.toMatch(providerAdvice);
    expect(markup).not.toContain("This request hit a problem");
  });

  // Turns saved by earlier builds, when a browser check failed the whole
  // turn, carry no tag. Their Murage-authored copy still gets the honest card.
  it.each([
    "agent-browser command timed out",
    "agent-browser command failed (1)",
    "agent-browser 0.36.0 is required",
    "No verified pinned agent-browser or executable on PATH; install the optional browser engine",
  ])("recognises the saved browser failure %j without a tag", (message) => {
    const markup = render({ message, onRetry: () => {} });
    expect(markup).toContain('data-local-failure="browser"');
    expect(markup).not.toMatch(providerAdvice);
  });

  it("never lets engine text or an unknown tag claim a local failure", () => {
    for (const props of [
      // Engine output always carries details; its message cannot choose the card.
      { message: "agent-browser command timed out", details: "agent-browser command timed out\nACP request: session/prompt" },
      { message: "provider said agent-browser command timed out" },
      { message: "CUA Driver is not ready for this computer: check permissions and restart Murage" },
      { message: "Internal error", localFailure: "provider" },
      { message: "Internal error", localFailure: "Browser" },
    ]) {
      const markup = render({ ...props, onRetry: () => {} });
      expect(markup, JSON.stringify(props)).not.toContain("local-setup");
      expect(markup, JSON.stringify(props)).toContain("Provider settings");
    }
  });

  it("keeps a setup card for an engine that needs setup, whatever the tag", () => {
    const markup = render({ message: "agent-browser command timed out", localFailure: "browser", setup: "install" });
    expect(markup).toContain("This engine needs setup");
    expect(markup).not.toContain("local-setup");
  });
});
