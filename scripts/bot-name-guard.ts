// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// D8-4 item 6: the roster of bot names, read from source, and the check that no shipped string writes one in.
// Customers' bots have their own names, so a string says {bot} (desktop) or %1$s (Android) and the app fills it in.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const REPO_ROOT = join(import.meta.dirname, "..");

function agentNames(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) { for (const item of value) agentNames(item, out); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (key === "agents" && Array.isArray(inner)) {
      for (const agent of inner) { const name = (agent as { name?: unknown } | null)?.name; if (typeof name === "string") out.add(name); }
    }
    agentNames(inner, out);
  }
}

/** Every bot name the repository itself knows: the contract's list, the fixtures' bot names, and the shipped library's agents. */
export function botRoster(root = REPO_ROOT): string[] {
  const names = new Set<string>();
  const listed = JSON.parse(readFileSync(join(root, "apps", "mobile", "contract", "bot-names.json"), "utf8")) as { names: string[] };
  for (const name of listed.names) names.add(name);
  const jobs = JSON.parse(readFileSync(join(root, "apps", "mobile", "contract", "phone-jobs.json"), "utf8")) as unknown;
  const fixtureBots = (o: unknown): void => {
    if (Array.isArray(o)) { o.forEach(fixtureBots); return; }
    if (!o || typeof o !== "object") return;
    for (const [key, inner] of Object.entries(o as Record<string, unknown>)) {
      if (key === "bot" && inner && typeof inner === "object" && typeof (inner as { name?: unknown }).name === "string") names.add((inner as { name: string }).name);
      fixtureBots(inner);
    }
  };
  fixtureBots(jobs);
  const packages = join(root, "library", "packages");
  if (existsSync(packages)) for (const file of readdirSync(packages).filter((f) => f.endsWith(".json"))) agentNames(JSON.parse(readFileSync(join(packages, file), "utf8")), names);
  return [...names].filter((name) => name.trim().length > 0).sort();
}

/** The `key: roster name` pairs where a string (or its key) names a bot, matched as whole words, case-sensitively. */
export function botNamesWrittenIn(strings: Record<string, string>, roster: string[]): string[] {
  const found: string[] = [];
  for (const [key, text] of Object.entries(strings)) {
    for (const name of roster) {
      const word = new RegExp(`(^|[^A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9])`);
      if (word.test(text) || word.test(key)) found.push(`${key}: ${name}`);
    }
  }
  return found;
}

/** Android string resources as key to text (the shipped files use plain text and %1$s placeholders). */
export function androidStrings(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of xml.matchAll(/<string\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/string>/g)) out[match[1]] = match[2];
  return out;
}
