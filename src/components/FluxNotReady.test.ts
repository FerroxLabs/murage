// A Cloud home shows the one approved line for a Flux 402, 401 or 403, and nothing a customer could act on with a key or a bill.
// Desktop keeps its card and copy.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../lib/i18n";

const cloud = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/cloud-workspace", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/cloud-workspace")>()), isCloudHome: () => cloud.on }));

const { ProviderErrorCard } = await import("./ProviderErrorCard");
const { FLUX_NOT_READY_COPY } = await import("../../shared/provider-error");

const APPROVED = "Your Flux credit is still getting ready. Try again in a minute; if it keeps happening, we've been told and are on it.";
const BANNED = /BYOK|bring-your-own-key|Provider settings|Provider payment or account access required|HTTP 40[123]|API key|billing|add credit|–|—/i;
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
afterEach(() => { cloud.on = false; return setLocale("en"); });

describe("Flux refusals on a Cloud home", () => {
  it("the shared line is the approved copy, word for word", () => { expect(FLUX_NOT_READY_COPY).toBe(APPROVED); });
  for (const status of [402, 401, 403]) {
    const kind = status === 402 ? "payment" : status === 401 ? "authentication" : "permission";
    it(`a ${status} card shows exactly the copy and no banned string`, async () => {
      await setLocale("en");
      cloud.on = true;
      const html = renderToStaticMarkup(createElement(ProviderErrorCard, { info: { kind, httpStatus: status, provider: "flux-router" } as never, details: `Fuigo HTTP ${status}: Provider settings`, onOpenProviderSettings: () => {} }));
      expect(text(html)).toBe(APPROVED);
      expect(html).not.toMatch(BANNED);
      expect(html).not.toContain("<details");
      expect(html).not.toContain("<a ");
    });
  }
  it("the chat error row hands a server-worded Flux line to the card alone, on a Cloud home only (ChatView renders in a browser, so this reads the source)", () => {
    const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");
    expect(source).toContain("if (isCloudHome() && isCloudFluxLine(message)) return <FluxNotReadyCard");
    expect(source.indexOf("isCloudFluxLine(message)")).toBeLessThan(source.indexOf("if (providerError) return <ProviderErrorCard"));
  });
  it("the desktop card and copy are unchanged", async () => {
    await setLocale("en");
    cloud.on = false;
    const html = renderToStaticMarkup(createElement(ProviderErrorCard, { info: { kind: "payment", httpStatus: 402 }, onOpenProviderSettings: () => {} }));
    expect(html).toContain("Payment or account access needed");
    expect(html).toContain("402");
    expect(html).not.toContain(APPROVED);
  });
});

describe("a customer's own engine refused on a Cloud home", () => {
  const NO_ADVICE = /BYOK|API key|Provider settings|Add credits|billing|Flux|HTTP 40|safe|safety|free|will fail|–|—/i;
  for (const [status, kind] of [[401, "authentication"], [403, "permission"]] as const) {
    it(`a ${status} names the engine, offers no settings button and no details`, async () => {
      await setLocale("en");
      cloud.on = true;
      const html = renderToStaticMarkup(createElement(ProviderErrorCard, { info: { kind, httpStatus: status }, details: "raw details", engineName: "Claude Code", onRetry: () => {}, onOpenProviderSettings: () => {} }));
      expect(text(html)).toContain("Your Claude Code sign-in needs a refresh. Sign in again to carry on.");
      expect(text(html)).not.toContain(APPROVED);
      expect(text(html)).not.toMatch(NO_ADVICE);
      expect(html).not.toContain("<details");
    });
  }
  it("a 402 from the customer's own engine is plain too, with no key or billing advice", async () => {
    await setLocale("en");
    cloud.on = true;
    const html = renderToStaticMarkup(createElement(ProviderErrorCard, { info: { kind: "payment", httpStatus: 402 }, engineName: "Codex", onOpenProviderSettings: () => {} }));
    expect(text(html)).toBe("Your Codex plan needs attention before it can answer. Check it with Codex, then try again.");
    expect(html).not.toMatch(/BYOK|API key|Provider settings|Add credits|billing|–|—/i);
    expect(html).not.toContain("<details");
  });
  it("without a known engine the line still reads plainly", async () => {
    await setLocale("en");
    cloud.on = true;
    const html = renderToStaticMarkup(createElement(ProviderErrorCard, { info: { kind: "authentication", httpStatus: 401 }, onOpenProviderSettings: () => {} }));
    expect(text(html)).toBe("Your engine sign-in needs a refresh. Sign in again to carry on.");
  });
  it("a Cloud home 401 carries a Sign in again button, wired to the bot and its engine", () => {
    const card = readFileSync(new URL("./ProviderErrorCard.tsx", import.meta.url), "utf8");
    expect(card).toContain("<EngineSignInAgain bot={signInAgain.bot} engine={signInAgain.engine}");
    const chat = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");
    expect(chat).toContain("signInAgain={engine?.driverKind ? { bot: { id: bot.id, name: bot.name }, engine: engine.driverKind } : undefined}");
    const button = readFileSync(new URL("./cloud/EngineSignInAgain.tsx", import.meta.url), "utf8");
    expect(button).toContain("runOfferSignIn(bot.id, engine");
    expect(button).toContain("Sign in again");
  });
  it("desktop keeps its 401 card", async () => {
    await setLocale("en");
    cloud.on = false;
    const html = renderToStaticMarkup(createElement(ProviderErrorCard, { info: { kind: "authentication", httpStatus: 401 }, engineName: "Claude Code", onOpenProviderSettings: () => {} }));
    expect(html).toContain("401");
    expect(html).not.toContain("sign-in needs a refresh");
  });
});

describe("the Cloud home's own Flux 402 lines show as plain cards", () => {
  it("budget-exhausted and service-hold render their own wording with no settings button and no details", async () => {
    const { FluxNotReadyCard } = await import("./ProviderErrorCard");
    for (const line of [
      "You've used this month's credits. They come back on December 1. To carry on now, switch to Claude Code or Codex and sign in to your own account.",
      "This one is on our side, not something you did. Please try again soon.",
    ]) {
      const html = renderToStaticMarkup(createElement(FluxNotReadyCard, { copy: line, onRetry: () => {} }));
      expect(text(html)).toContain(line);
      expect(html).not.toMatch(/Settings|Models|<details|Technical details/);
    }
  });
  it("the chat row hands every Cloud Flux line to that card, before any provider card", () => {
    const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");
    expect(source).toContain("<FluxNotReadyCard onRetry={onRetry} retryLabel={retryLabel} copy={message} />");
  });
});
