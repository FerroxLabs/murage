// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Packaged snapshot of src/locales/{language}.json nativeBanner.* keys.
// The Node test checks every word and source hash against the renderer catalogue.
const PACKS = {
  en: ["Allow", "Deny", "Reply"],
  de: ["Erlauben", "Ablehnen", "Antworten"],
  es: ["Permitir", "Denegar", "Responder"],
  fr: ["Autoriser", "Refuser", "Répondre"],
  hi: ["अनुमति दें", "मना करें", "जवाब दें"],
  ja: ["許可", "拒否", "返信"],
  "pt-br": ["Permitir", "Negar", "Responder"],
  zh: ["允许", "拒绝", "回复"],
};

export function nativeBannerLabels(language = "en") {
  const tag = typeof language === "string" ? language.trim().toLowerCase().replace(/_/g, "-") : "en";
  const base = tag.split("-")[0];
  const code = Object.hasOwn(PACKS, tag) ? tag : base === "pt" ? "pt-br" : Object.hasOwn(PACKS, base) ? base : "en";
  const [allow, deny, reply] = PACKS[code];
  return { allow, deny, reply };
}
