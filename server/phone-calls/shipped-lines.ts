// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// Owners: F4 provides the shipped copy; F3 reads it to build the opening.
import type { AppLanguage } from "./settings.ts";

/** Shipped default lines, one per app language. `{owner}` is the owner's name. */
export const SHIPPED_AI_LINE: Record<AppLanguage, string> = {
  en: "Hi, this is an AI assistant calling for {owner}.",
  de: "Hallo, hier spricht ein KI-Assistent im Auftrag von {owner}.",
  es: "Hola, soy un asistente de IA que llama en nombre de {owner}.",
  fr: "Bonjour, je suis un assistant IA qui appelle pour {owner}.",
  hi: "नमस्ते, मैं {owner} की ओर से कॉल कर रहा एक AI सहायक हूँ।",
  ja: "こんにちは、{owner}の代わりにお電話しているAIアシスタントです。",
  "pt-br": "Olá, sou um assistente de IA ligando em nome de {owner}.",
  zh: "您好，我是代表{owner}致电的AI助手。",
};
export const SHIPPED_NOTICE: Record<AppLanguage, string> = {
  en: "This call may be recorded.",
  de: "Dieses Gespräch kann aufgezeichnet werden.",
  es: "Esta llamada puede ser grabada.",
  fr: "Cet appel peut être enregistré.",
  hi: "यह कॉल रिकॉर्ड की जा सकती है।",
  ja: "この通話は録音される場合があります。",
  "pt-br": "Esta ligação pode ser gravada.",
  zh: "本次通话可能会被录音。",
};
