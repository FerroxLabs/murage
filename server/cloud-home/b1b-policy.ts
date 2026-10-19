// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ServerResponse, OutgoingHttpHeaders } from "node:http";
/** Inspect parsed data, including import envelopes, before any writer executes. */
export function homeRememberedGrantWrite(method: string, path: string, body: unknown): boolean {
  if (["GET","HEAD","OPTIONS"].includes(method)) return false;
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    return Object.entries(value).some(([key,v]) => key === "alwaysAllow" || visit(v));
  };
  return visit(body) || /\/always-allow$/.test(path) || (/\/(?:respond|approvals?)(?:\/|$)/.test(path) && !!body && typeof body === "object" && Object.values(body).includes("always"));
}
/** The app's own page policy. Trusted Types: the app's "murage" policy sanitizes every markup sink (src/lib/trusted-html.ts),
 *  and "dompurify" is the sanitizer's own parsing policy, claimed by the app at startup. No 'default' policy, no duplicates. */
export const HOME_PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types murage dompurify";
/** The chat's diagram frame (src/mermaid-frame, served with `sandbox allow-scripts; script-src '<its hash>'`): an opaque-origin
 *  document with no network that the app frames. Only its one hashed inline script runs, and only the app may frame it.
 *  Trusted Types are not required in it: it is not the app's document, it holds nothing of the app's (no DOM, cookies,
 *  storage or bridge), and mermaid writes markup through d3 with no policy hook, so requiring them there would need a
 *  'default' policy. Its output is sanitized by DOMPurify before it is shown, and the app reads only its height. */
const frameCsp = (scriptSrc: string) => `default-src 'none'; script-src ${scriptSrc}; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts`;
/** The policy a Cloud home sends with an HTML response, given what the route asked for. A route's own `sandbox` is kept. */
export function homePagePolicy(prior: string): string {
  const sandbox = /(?:^|;)\s*(sandbox(?:\s+[^;]+)?)/i.exec(prior)?.[1];
  const scriptSrc = /(?:^|;)\s*script-src\s+((?:'sha256-[A-Za-z0-9+/]+={0,2}'\s*)+)(?:;|$)/i.exec(prior)?.[1]?.trim();
  if (sandbox && /^sandbox\s+allow-scripts\s*$/i.test(sandbox) && scriptSrc) return frameCsp(scriptSrc);
  return HOME_PAGE_CSP + (sandbox ? `; ${sandbox}` : "");
}
/** `sandbox allow-scripts`, plus the frame page's own script hash when its meta CSP names one. */
export function mermaidFrameCsp(page: Buffer | string): string {
  const hash = /<meta http-equiv="Content-Security-Policy" content="[^"]*script-src '(sha256-[A-Za-z0-9+/]+={0,2})'/.exec(String(page).slice(0, 4096))?.[1];
  return "sandbox allow-scripts" + (hash ? `; script-src '${hash}'` : "");
}
/** Install before routing so errors, static HTML and artifacts share the gate. */
export function secureHomeHtml(res: ServerResponse): void {
  const original = res.writeHead;
  res.writeHead = function (this: ServerResponse, ...args: [number, (string | OutgoingHttpHeaders | string[])?, (OutgoingHttpHeaders | string[])?]) {
    const headers = typeof args[1] === "object" ? args[1] : args[2];
    const supplied = headers && !Array.isArray(headers) ? headers as Record<string, unknown> : {};
    const flat = Array.isArray(headers) ? headers as string[] : undefined;
    const headerValue = (name: string) => flat ? flat.reduce<string | undefined>((value,key,index)=>index % 2 === 0 && key.toLowerCase() === name ? flat[index+1] : value,undefined) : Object.entries(supplied).find(([key])=>key.toLowerCase() === name)?.[1];
    const contentType = headerValue("content-type") ?? this.getHeader("content-type");
    if (String(contentType).toLowerCase().includes("text/html")) {
      const prior = String(headerValue("content-security-policy") ?? this.getHeader("content-security-policy") ?? "");
      this.setHeader("content-security-policy", homePagePolicy(prior));
      this.setHeader("x-content-type-options","nosniff");
      // Explicit route headers must not replace the home security policy.
      for (const key of Object.keys(supplied)) if (key.toLowerCase() === "content-security-policy") delete supplied[key];
      if(flat) for(let index=flat.length-2;index>=0;index-=2) if(flat[index]!.toLowerCase() === "content-security-policy") flat.splice(index,2);
    }
    return (original as (...values: unknown[]) => ServerResponse).apply(this,args);
  } as ServerResponse["writeHead"];
}
