import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach,expect,it } from "vitest";
import { ProviderErrorCard } from "./ProviderErrorCard";
import { setLocale } from "../lib/i18n";
import { locales,localeChoices } from "../locales";
const render=(provider?:"flux-router",retry=true)=>renderToStaticMarkup(createElement(ProviderErrorCard,{info:{kind:"payment",httpStatus:402,...(provider?{provider}:{})},onRetry:retry?()=>{}:undefined,onOpenProviderSettings:()=>{}}));
afterEach(()=>setLocale("en"));
it("generic payment copy explains HTTP402 without exhaustion or billing-link assumptions",()=>{
  setLocale("en");for(const provider of [undefined,"flux-router"] as const){const html=render(provider);expect(html).toContain("Provider payment or account access required");expect(html).toContain("does not establish that credits are exhausted");expect(html).toContain("selected-model access");expect(html).toContain("BYOK");expect(html).not.toContain("<a ");expect(html).not.toContain("Add Flux credits");expect(html).toContain("Retry");}
  expect(render(undefined,false)).not.toContain("Retry</button>");
});
it("all current languages have three payment keys and render them instead of English fallback",()=>{
  for(const{code}of localeChoices){const pack=locales[code];setLocale(code);for(const key of ["providerError.payment.title","providerError.payment.summary","providerError.payment.resolution"] as const)expect(pack[key]).toBeTruthy();const html=render();expect(html).toContain(pack["providerError.payment.title"]);expect(html).toContain("402");expect(html).toContain("BYOK");expect(html).not.toContain("<a ");}
});
it("a monthly spending limit names the limit and offers no way to buy past it",()=>{
  setLocale("en");const html=renderToStaticMarkup(createElement(ProviderErrorCard,{info:{kind:"spend-cap",httpStatus:402,provider:"flux-router"},onOpenProviderSettings:()=>{}}));
  expect(html).toContain("Flux Router has reached its monthly spending limit");
  expect(html).toContain("adding credit will not lift it");
  // The credits card's billing link and button would both be dead ends here.
  expect(html).not.toContain("Add Flux credits");
  expect(html).not.toContain("<a ");
  expect(html).not.toContain("fluxrouter.ai/home/billing");
  // Falls back to English copy, never to the "unknown" card, in every language.
  for(const{code}of localeChoices){setLocale(code);const localized=renderToStaticMarkup(createElement(ProviderErrorCard,{info:{kind:"spend-cap",httpStatus:402},onOpenProviderSettings:()=>{}}));expect(localized).not.toContain("Provider request failed");expect(localized).toContain("402");}
});
it("the existing exact-credit Flux billing action remains unchanged",()=>{
  setLocale("en");const html=renderToStaticMarkup(createElement(ProviderErrorCard,{info:{kind:"credits",httpStatus:402,provider:"flux-router"},onOpenProviderSettings:()=>{}}));expect(html).toContain("Flux Router needs credits");expect(html).toContain('href="https://fluxrouter.ai/home/billing"');expect(html).toContain("Add Flux credits");
});
