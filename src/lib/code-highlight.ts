// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Adapted from OpenMausBot #2423, Apache-2.0 (see NOTICE).
// Syntax colour for chat code blocks from Shiki's core: the JavaScript regex
// engine plus only the grammars a transcript commonly meets, each its own lazy
// chunk. A language outside the list renders as plain text, never an error.
// The full "shiki" bundle shipped every grammar and theme in one chunk.
import type { HighlighterCore } from "shiki/core";

const LOADERS: Record<string, () => Promise<unknown>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  go: () => import("shiki/langs/go.mjs"),
};

const ALIASES: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", mjs: "javascript", cjs: "javascript", node: "javascript",
  jsonc: "json", json5: "json",
  sh: "bash", zsh: "bash", shell: "shellscript", console: "shellscript",
  py: "python", python3: "python",
  htm: "html", xml: "html", svg: "html",
  md: "markdown", yml: "yaml", patch: "diff",
  rs: "rust", golang: "go",
};

/** The grammar this fence language maps to, or null for plain text. */
export function resolveHighlightLanguage(lang: string): string | null {
  const key = lang.trim().toLowerCase();
  if (!key) return null;
  const name = Object.hasOwn(ALIASES, key) ? ALIASES[key]! : key;
  return Object.hasOwn(LOADERS, name) ? name : null;
}

const THEMES = { light: "github-light-default", dark: "github-dark-default" } as const;
let highlighter: Promise<HighlighterCore> | null = null;
const loadedLanguages = new Map<string, Promise<void>>();

function core(): Promise<HighlighterCore> {
  if (!highlighter) {
    highlighter = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] = await Promise.all([
        import("shiki/core"),
        import("shiki/engine/javascript"),
        import("shiki/themes/github-light-default.mjs"),
        import("shiki/themes/github-dark-default.mjs"),
      ]);
      return createHighlighterCore({
        themes: [light.default, dark.default],
        langs: [],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      });
    })();
    highlighter.catch(() => { highlighter = null; });
  }
  return highlighter;
}

function ensureLanguage(instance: HighlighterCore, name: string): Promise<void> {
  let pending = loadedLanguages.get(name);
  if (!pending) {
    pending = LOADERS[name]!().then((grammar) => instance.loadLanguage((grammar as { default: never }).default));
    loadedLanguages.set(name, pending);
    pending.catch(() => loadedLanguages.delete(name));
  }
  return pending;
}

/** Highlighted HTML for `code`; unknown languages come back as plain text markup. */
export async function highlightCode(code: string, lang: string): Promise<string> {
  const instance = await core();
  const name = resolveHighlightLanguage(lang);
  if (name) await ensureLanguage(instance, name);
  return instance.codeToHtml(code, { lang: name ?? "text", themes: THEMES, defaultColor: "light-dark()" });
}
