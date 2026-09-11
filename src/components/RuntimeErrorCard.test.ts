// Which recovery a failed turn offers. Local contention between this device's
// own threads must read as "wait, then retry", never as provider or account
// trouble. Real narrow/wide, light/dark and keyboard behaviour is proved in
// src/e2e/provider-error.human.spec.ts; this pins the markup contract in node.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RuntimeErrorCard } from "./RuntimeErrorCard";
import { LOCAL_RESOURCE_BUSY_MESSAGES } from "../../shared/provider-error";

const render = (props: { message: string; details?: string; setup?: string; onRetry?: () => void }) =>
  renderToStaticMarkup(createElement(RuntimeErrorCard, { ...props, onOpenProviderSettings: () => {} }));

describe("runtime error recovery", () => {
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
