// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every string the app writes into the page as markup goes through here.
//
// The Cloud home serves the app with `require-trusted-types-for 'script'; trusted-types murage dompurify`
// (server/cloud-home/b1b-policy.ts). Under that header the browser refuses a plain string at every HTML sink
// (innerHTML, dangerouslySetInnerHTML, iframe srcdoc) and every script URL sink (service worker register), so
// the app creates the one "murage" policy at startup and every sink takes what it returns. The policy runs
// DOMPurify on everything, including markup an earlier step already sanitized, so nothing reaches a sink
// unsanitized; until DOMPurify has loaded, or if it cannot run, a sink gets nothing. DOMPurify parses with its own
// "dompurify" policy, which only DOMPurify holds. It loads as its own chunk (outside the first-paint budget) that
// src/main.tsx waits for before the first render.
//
// Where the browser has no Trusted Types (the desktop app, Firefox, Safari) the same sanitizer runs and the
// plain string is used.
import { useSyncExternalStore } from "react";

type Purify = typeof import("dompurify").default;

/** What a sink accepts: a TrustedHTML where the browser has Trusted Types, else the sanitized string.
 *  Typed as a branded string so React's props take it; never slice, measure or concatenate it. */
export type TrustedMarkup = string & { readonly __trustedMarkup: true };
/** Same, for a script URL (service worker register). */
export type TrustedUrl = string & { readonly __trustedUrl: true };

export const TRUSTED_TYPES_POLICY = "murage";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
/** The only script URLs the app loads by address (src/lib/register-sw.ts). */
const SCRIPT_URLS: ReadonlySet<string> = new Set(["/sw.js"]);

type Kind = "html" | "svg" | "preview";
interface Policy { createHTML(input: string, kind?: Kind): unknown; createScriptURL(input: string): unknown }
interface PolicyFactory { createPolicy(name: string, rules: { createHTML(input: string, kind?: Kind): string; createScriptURL(input: string): string }): Policy }

/** The prelude every sandboxed preview frame gets: no script, no network, nothing but inline style and data: images. */
const PREVIEW_PRELUDE = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'"><meta name="referrer" content="no-referrer">`;
const PREVIEW_DROPPED_TAGS = ["script", "iframe", "frame", "object", "embed", "base", "meta", "link", "template"];
const PREVIEW_DROPPED_ATTRS = ["href", "xlink:href", "srcset", "ping", "action", "formaction", "srcdoc", "target", "background", "poster"];

let purify: Purify | null = null;
let purifyLoad: Promise<void> | undefined;
/** Loads DOMPurify once; resolves (never rejects) when it is ready or could not load. src/main.tsx awaits it before rendering. */
export function sanitizerReady(): Promise<void> {
  return (purifyLoad ??= import("dompurify").then(module => {
    purify = module.default;
    // Claim DOMPurify's own parsing policy now, before anything else could take the "dompurify" name.
    if (purify.isSupported) purify.sanitize("");
    for (const listener of [...readyListeners]) listener();
  }, () => { /* no sanitizer: every sink gets nothing */ }));
}

const readyListeners = new Set<() => void>();
/** Whether the sanitizer has loaded. A component that writes trusted markup while it renders calls this, so it draws
 *  again once the sanitizer arrives: src/main.tsx waits for it only up to its cap (a slow phone network can take longer),
 *  and markup made before then is empty. Subscribing starts the load. */
export function useSanitizerReady(): boolean {
  return useSyncExternalStore(
    (listener) => { readyListeners.add(listener); void sanitizerReady(); return () => { readyListeners.delete(listener); }; },
    () => purify !== null,
    () => false,
  );
}

function sanitize(input: string, kind: Kind): string {
  if (!purify?.isSupported) {
    // No DOM in this realm (a server-side render in a test): nothing here parses the markup as a page.
    // Anywhere with a DOM and no working sanitizer gets nothing at all.
    return typeof document === "undefined" && kind !== "preview" ? input : "";
  }
  try {
    if (kind === "svg") return purify.sanitize(input, { NAMESPACE: SVG_NAMESPACE, USE_PROFILES: { svg: true, svgFilters: true } });
    if (kind === "preview") return previewDocument(purify, input);
    return purify.sanitize(input, { USE_PROFILES: { html: true, mathMl: true, svg: true, svgFilters: true } });
  } catch { return ""; }
}

/** A whole untrusted page for a `sandbox=""` frame: sanitized, then stripped of anything that navigates or loads, under the prelude. */
function previewDocument(purify: Purify, content: string): string {
  const root = purify.sanitize(content, { WHOLE_DOCUMENT: true, RETURN_DOM: true, FORBID_TAGS: PREVIEW_DROPPED_TAGS, FORBID_ATTR: PREVIEW_DROPPED_ATTRS }) as unknown as Element;
  // CSP alone does not reliably stop a frame navigating itself, so anything that can is removed as well.
  root.querySelectorAll(PREVIEW_DROPPED_TAGS.join(",")).forEach(node => node.remove());
  for (const node of root.querySelectorAll("*")) for (const attribute of [...node.attributes]) {
    const name = attribute.name.toLowerCase();
    if (name.startsWith("on") || PREVIEW_DROPPED_ATTRS.includes(name)
      || (name === "src" && !(node.tagName === "IMG" && /^data:image\/(png|jpeg|gif|webp);base64,/i.test(attribute.value)))) node.removeAttribute(attribute.name);
  }
  return PREVIEW_PRELUDE + root.outerHTML;
}

const rules = {
  createHTML: (input: string, kind: Kind = "html") => sanitize(input, kind),
  createScriptURL: (input: string) => {
    if (!SCRIPT_URLS.has(input)) throw new TypeError("script URL refused");
    return input;
  },
};

let policy: Policy | null | undefined;
/** Creates the "murage" policy once (src/main.tsx calls it before React renders). Null where the browser has no Trusted Types. */
export function installTrustedTypes(): Policy | null {
  if (policy !== undefined) return policy;
  const factory = (globalThis as { trustedTypes?: PolicyFactory }).trustedTypes;
  void sanitizerReady();
  if (!factory?.createPolicy) return (policy = null);
  policy = factory.createPolicy(TRUSTED_TYPES_POLICY, rules);
  return policy;
}

function make(input: string, kind: Kind): TrustedMarkup {
  const active = installTrustedTypes();
  return (active ? active.createHTML(input, kind) : rules.createHTML(input, kind)) as TrustedMarkup;
}
/** Sanitized HTML (with MathML and SVG) for innerHTML or dangerouslySetInnerHTML. */
export const trustedHtml = (html: string): TrustedMarkup => make(html, "html");
/** A sanitized SVG fragment (children of an <svg> element: paths, groups, gradients) for an SVG element's innerHTML. */
export const trustedSvg = (markup: string): TrustedMarkup => make(markup, "svg");
/** A whole untrusted page for a `sandbox=""` iframe's srcDoc: sanitized, stripped of navigation and loads, under a no-network CSP. */
export const trustedPreviewDocument = (content: string): TrustedMarkup => make(content, "preview");
/** One of the app's own script addresses (the service worker); anything else throws. */
export function trustedScriptUrl(url: string): TrustedUrl {
  const active = installTrustedTypes();
  return (active ? active.createScriptURL(url) : rules.createScriptURL(url)) as TrustedUrl;
}
