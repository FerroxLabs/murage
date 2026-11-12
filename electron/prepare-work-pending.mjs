import { readFileSync } from "node:fs";
import en from "../src/locales/en.json" with { type: "json" };
import { resolveStepUpLanguage, usableText } from "./step-up-locale.mjs";

const key = "recovery.downgradeWorkPending";
const cache = new Map();

/** The desktop uses its saved app language; the English CLI uses the same catalogue line. */
export function downgradeWorkPendingMessage(language = "en") {
  const code = resolveStepUpLanguage(language) ?? "en";
  if (code === "en") return en[key];
  if (!cache.has(code)) {
    try {
      const pack = JSON.parse(readFileSync(new URL(`../src/locales/${code}.json`, import.meta.url), "utf8"));
      cache.set(code, usableText(pack[key]) ? pack[key] : en[key]);
    } catch { cache.set(code, en[key]); }
  }
  return cache.get(code);
}
