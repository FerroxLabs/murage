// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The words a person agreed to when they joined Murage news (1.0.7).
//
// murage.ai keeps, with every signup, the exact wording the card showed
// (`consentText`, at most 500 characters). Two cards can take an address:
// the Chief's hello card on the first run, and Settings > About > Get Murage
// news. The server builds the text from the same constants those cards draw,
// so what is sent is what was on the screen, and nothing is typed twice.
//
// Data only, no React: the local server imports this file.
import { FIRST_RUN_COPY } from "./first-run-copy.ts";

/** Settings > About > Get Murage news. */
export const NEWS_COPY = {
  title: "Get the setup guide and every new release",
  subtitle: "Insights, how-tos and tutorials so you always know the newest things Murage can do for you.",
  emailLabel: "Your email",
  submit: "Add me",
  working: "Adding you",
  onList: "You are on the list.",
  justAdded: "You are on the list. Your guide to getting set up is on its way.",
  invalid: "That does not look like an email address.",
  failure: "That did not go through. Try once more.",
} as const;

/** Which card the address was typed into. */
export type NewsSignupFrom = "hello" | "settings";

export const NEWS_CONSENT_MAX = 500;

/** Anything but "settings" is the hello card, the first and usual way in. */
export function newsSignupFrom(value: unknown): NewsSignupFrom {
  return value === "settings" ? "settings" : "hello";
}

/** The card's heading and its promise, line by line as shown, capped at 500. */
export function newsConsentText(from: NewsSignupFrom): string {
  const hello = FIRST_RUN_COPY.hello.welcome;
  const lines = from === "settings" ? [NEWS_COPY.title, NEWS_COPY.subtitle] : [hello.heading, hello.lead];
  let text = lines.join("\n").slice(0, NEWS_CONSENT_MAX);
  // never end on half of a surrogate pair
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  return text;
}
