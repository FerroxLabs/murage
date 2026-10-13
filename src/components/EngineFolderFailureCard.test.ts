// A bot's engine folder that could not be set up (busy, not built, or an engine that needs an update) is worded from its
// structured code in the owner's language, with the engine's name, in every shipped pack, with a source hash for each string.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeErrorCard } from "./RuntimeErrorCard";
import { errorPreview } from "../lib/error-preview";
import { setLocale } from "../lib/i18n";
import { localeChoices, type LocaleKey } from "../locales";
import { allLocalePacks } from "../locales/testing";
import { classifyLocalSetupFailure } from "../../shared/provider-error";

const locales = await allLocalePacks();
const FAILURES = ["engine-folder-busy", "engine-folder-unavailable", "engine-update-required", "engine-symlink-required", "engine-login-link-lost", "engine-config-invalid"] as const;
const PARTS = ["title", "message", "resolution"] as const;
const keyOf = (failure: string, part: string) => `runtimeError.local.${failure}.${part}` as LocaleKey;
const english = "This bot's engine could not be set up in its own folder, so the turn did not start. Try again in a moment.";
const escaped = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const render = (localFailure: string, engine = "Codex") =>
  renderToStaticMarkup(createElement(RuntimeErrorCard, { message: english, localFailure, localFailureEngine: engine, onRetry: () => {}, onOpenProviderSettings: () => {} }));

afterEach(() => setLocale("en"));

describe("engine folder failures read from their code", () => {
  it("the codes are recognised from the structured field only", () => {
    for (const failure of FAILURES) expect(classifyLocalSetupFailure(english, undefined, failure)).toBe(failure);
    expect(classifyLocalSetupFailure("anything", undefined, "engine-made-up")).toBeUndefined();
  });

  it("every pack renders the title, message and resolution in its own language with the engine named, and the English line only in the details", async () => {
    for (const { code } of localeChoices) {
      await setLocale(code);
      const pack = locales[code]!;
      for (const failure of FAILURES) {
        const html = render(failure, "Grok");
        for (const part of PARTS) {
          const text = pack[keyOf(failure, part)]!.replaceAll("{engine}", "Grok");
          expect(text, `${code} ${failure} ${part}`).toBeTruthy();
          expect(html, `${code} ${failure} ${part}`).toContain(escaped(text));
        }
        expect(html).toContain(`data-local-failure="${failure}"`);
        expect(html).toContain(escaped(english)); // technical details only
        if (code !== "en") {
          const body = html.slice(0, html.indexOf("<details"));
          expect(body, `${code} ${failure} body is not English`).not.toContain(escaped(english));
        }
      }
    }
  });

  it("the sidebar line for a failed turn is the localized title", async () => {
    for (const { code } of localeChoices) {
      await setLocale(code);
      for (const failure of FAILURES) {
        const line = errorPreview({ name: `error: ${english}`, localFailure: failure, localFailureEngine: "Droid" });
        expect(line).toContain(locales[code]![keyOf(failure, "title")]!.replaceAll("{engine}", "Droid"));
      }
    }
  });

  it("the strings are translated in every pack, keep {engine}, follow the copy rules and carry the source hash of the English", () => {
    const dir = fileURLToPath(new URL("../locales/", import.meta.url));
    const read = (file: string) => JSON.parse(readFileSync(dir + file, "utf8")) as Record<string, any>;
    const en = read("en.json"), hashes = read("source-hashes.json").locales as Record<string, Record<string, string>>;
    for (const failure of FAILURES) for (const part of PARTS) {
      const source = en[keyOf(failure, part)] as string;
      if (part !== "resolution" || failure === "engine-update-required") expect(source).toContain("{engine}");
      expect(source).not.toMatch(/—|\bsafe(ly|ty)?\b|\bunsafe\b|Composio/i);
    }
    for (const locale of ["de", "es", "fr", "hi", "ja", "pt-br", "zh"]) {
      const pack = read(`${locale}.json`);
      for (const failure of FAILURES) for (const part of PARTS) {
        const key = keyOf(failure, part);
        expect(pack[key], `${locale} ${key}`).toBeTruthy();
        expect(pack[key], `${locale} ${key} is translated`).not.toBe(en[key]);
        if ((en[key] as string).includes("{engine}")) expect(pack[key], `${locale} ${key} keeps {engine}`).toContain("{engine}");
        expect(hashes[locale]![key], `${locale} ${key} hash`).toBe(createHash("sha256").update(en[key]).digest("hex"));
        expect(pack[key]).not.toMatch(/—|Composio/);
      }
    }
  });
});
