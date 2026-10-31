// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The plain-words glossary (designs/PLAIN-WORDS-1014.md is the readable copy).
// A non-technical owner should never meet a word they have to look up. Each
// term has the plain words that replace it on layer 1 and 2 screens, and a
// one-line explanation (80 characters or fewer, the Tip limit) for the rare
// place a term has to stay: a developer page, a Technical details fold, or a
// company's own name for its page. The explanations are catalogue strings
// (ux.lcopya.glossary.<id>), so they are translated like any other copy.
//
// src/copy-jargon.test.ts reads `match` to find the terms in shipped copy; the
// frozen names below are never a glossary term and never replaced.
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

/** The video-safety rule (build plan section 6): never renamed, re-cased or extended. */
export const FROZEN_NAMES = {
  levels: ["Ask", "Auto", "Full access", "No limits"],
  doors: ["Today", "Chats", "Routines", "Needs you"],
  /** The first bot, and the mockup's bot names that are in the name pool (server/names.ts). */
  bots: ["Ember", "Nova", "Ivy", "Juno"],
} as const;

export interface GlossaryEntry {
  /** Stable id; the explanation's catalogue key is ux.lcopya.glossary.<id>. */
  readonly id: string;
  /** The term as the inventory counts it. */
  readonly term: string;
  /** What to say instead on an owner's screen. */
  readonly plain: string;
  /** Finds the term in a sentence (whole word). */
  readonly match: RegExp;
}

const entry = (id: string, term: string, plain: string, match: RegExp): GlossaryEntry => ({ id, term, plain, match });

/** Every term from UX-PLAIN-LANGUAGE-INVENTORY.md section 1, plus BYOK and bare HTTP codes. */
export const GLOSSARY: readonly GlossaryEntry[] = [
  entry("mcp", "MCP", "Connected tools", /\bMCP\b/i),
  entry("acp", "ACP", "compatible AI app", /\bACP\b/i),
  entry("apiKey", "API key", "key", /\bAPI[- ]keys?\b/i),
  entry("api", "API", "connection", /\bAPIs?\b(?![- ]keys?\b)(?!\.\w)/i),
  entry("byok", "BYOK", "your own key", /\bBYOK\b|\bbring[- ]your[- ]own[- ]key\b/i),
  entry("token", "token", "usage, or sign-in", /\btokens?\b/i),
  entry("path", "path", "location", /\bpaths?\b/i),
  entry("cli", "CLI", "AI app on this computer", /\bCLIs?\b/i),
  entry("json", "JSON", "settings file", /\bJSON\b/i),
  entry("yaml", "YAML", "settings file", /\bYAML\b/i),
  entry("config", "config", "settings, or settings file", /\bconfigs?\b/i),
  entry("oauth", "OAuth", "sign in with the service", /\bOAuth\b/i),
  entry("provider", "provider", "your AI service", /\bproviders?\b/i),
  entry("endpoint", "endpoint", "address", /\bendpoints?\b/i),
  entry("modelId", "model id", "model name", /\bmodel ids?\b/i),
  entry("schema", "schema", "format", /\bschemas?\b/i),
  entry("payload", "payload", "what was sent", /\bpayloads?\b/i),
  entry("webhook", "webhook", "trigger link", /\bwebhooks?\b/i),
  entry("stdout", "stdout", "output", /\bstdout\b/i),
  entry("stderr", "stderr", "error output", /\bstderr\b/i),
  entry("exitCode", "exit code", "it stopped with an error", /\bexit codes?\b/i),
  entry("sandbox", "sandbox", "a walled-off space", /\bsandbox(?:es|ed)?\b/i),
  entry("daemon", "daemon", "background helper", /\bdaemons?\b/i),
  entry("runtime", "runtime", "the part that runs it", /\bruntimes?\b/i),
  entry("env", "environment variable", "setting", /\benvironment variables?\b|\benv\b/i),
  entry("localhost", "localhost", "this computer", /\blocalhost\b/i),
  entry("port", "port", "connection", /\bports?\b/i),
  entry("ssh", "SSH", "secure connection to your server", /\bSSH\b/i),
  entry("regex", "regex", "pattern", /\bregex(?:es)?\b/i),
  entry("repo", "repo", "code project", /\brepos?\b/i),
  entry("commit", "commit", "saved change", /\bcommits?\b/i),
  entry("httpCode", "HTTP code", "plain words (the code only inside Technical details)", /\bHTTP ?[1-5]\d\d\b|\b(?:code|status|error) [1-5]\d\d\b/i),
];

/** The glossary entry a word or phrase belongs to, if any. */
export function glossaryEntry(text: string): GlossaryEntry | undefined {
  const words = withoutPlaceholders(text);
  return GLOSSARY.find((item) => item.match.test(words));
}

/** A catalogue placeholder ("{provider}") is filled with a name at run time; it is not a word the owner reads. */
const withoutPlaceholders = (text: string) => text.replace(/\{[A-Za-z0-9_.]+\}/g, " ");

/** The one-line explanation for a term (for a Tip), in the owner's language. */
export function glossaryExplanation(id: string): string | undefined {
  const item = GLOSSARY.find((candidate) => candidate.id === id);
  return item ? t(`ux.lcopya.glossary.${item.id}` as LocaleKey) : undefined;
}

/** Every glossary term a piece of copy uses, by id. */
export function jargonIn(text: string): string[] {
  const words = withoutPlaceholders(text);
  return GLOSSARY.filter((item) => item.match.test(words)).map((item) => item.id);
}
