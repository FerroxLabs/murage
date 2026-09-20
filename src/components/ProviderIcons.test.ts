// Every brand mark honours the size it is given. The fallback initial — the
// mark an engine with no official logo gets, e.g. the OpenAI-compatible row —
// did not: it was `size-full`, so as a flex item in the onboarding engine
// list it stretched to the whole row and pushed the engine's name out of it.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProviderMark } from "./ProviderIcons";

const render = (driverKind: string, size = 20) =>
  renderToStaticMarkup(createElement(ProviderMark, { driverKind, size }));

describe("ProviderMark fallback", () => {
  it("is drawn at the size it was asked for", () => {
    const markup = render("openai-compat");
    expect(markup).toContain("width:20px");
    expect(markup).toContain("height:20px");
  });

  it("never takes the size of whatever contains it", () => {
    for (const kind of ["openai-compat", "somethingNew", "piAgentish"]) {
      expect(render(kind), kind).not.toContain("size-full");
    }
  });

  it("cannot be squeezed out or stretched by its row", () => {
    expect(render("openai-compat")).toContain("shrink-0");
  });

  it("still shows the engine's initial", () => {
    expect(render("openai-compat")).toContain(">O<");
    expect(render("claudeAgent")).not.toContain(">C<");
  });

  it("gives a known engine its official mark at that size", () => {
    expect(render("claudeAgent", 20)).toContain('width="20"');
  });
});
