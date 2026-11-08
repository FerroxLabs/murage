import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("@/state/store", () => ({ api: {}, useStore: () => ({ state: { bots: [] }, dispatch: vi.fn() }) }));
import { ResultCard } from "./PhoneCallsSettings";
import type { PhoneCallCard, PhoneCopy } from "@/lib/phone-calls";
it("renders Cancel on a current-revision scheduled result card, but not an ended card", () => {
  const card = { id: "call", call: "call", status: "scheduled", to: "+15550123456", settings_revision: 1, language: "en", dashboard: "https://dashboard.vapi.ai/calls/vendor" } as PhoneCallCard;
  const copy: PhoneCopy = key => key;
  const html = renderToStaticMarkup(createElement(ResultCard, { card, copy }));
  expect(html).toMatch(/<button[^>]*>phoneCalls.cancel<\/button>/);
  expect(renderToStaticMarkup(createElement(ResultCard, { card: { ...card, status: "ended" }, copy }))).not.toContain("phoneCalls.cancel");
});

it("renders the localized abandonment explanation without offering Cancel again", () => {
  const card = { id: "call", call: "call", status: "abandoned", to: "+15550123456",
    settings_revision: 1, language: "en", dashboard: "" } as PhoneCallCard;
  const html = renderToStaticMarkup(createElement(ResultCard, { card, copy: key => key }));
  expect(html).toContain("phoneCalls.status.abandoned");
  expect(html).not.toContain("phoneCalls.cancel");
});
