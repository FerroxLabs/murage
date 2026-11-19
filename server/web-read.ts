// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readWithBrowserAuthority, type EngineReadContext, type EngineReadOptions } from "./browser-extension-engine-read.ts";
import { validateWebRange, type WebDocuments, type WebPage } from "./web-documents.ts";

export type WebReadContext = Pick<EngineReadContext, "fetch" | "admitUrl" | "authorize"> & { documents: WebDocuments; scope: string };
/** URL reads and browser reads use the same conversion and saved-range contract.
 * URL mode fetches the requested document once, without speculative .md/llms reads. */
export async function readWebPage(input: EngineReadOptions, context: WebReadContext): Promise<WebPage> {
  validateWebRange(input, ["url"]);
  if (input.handle) {
    if (!context.authorize()) throw new Error("Web read is no longer active.");
    return context.documents.read(context.scope, input);
  }
  if (!input.url || typeof input.url !== "string") throw new Error("Use a page URL or a saved document handle.");
  const output = await readWithBrowserAuthority(input, { ...context, currentUrl: input.url, activeHtml: async () => { throw new Error("A page URL is required."); }, direct: true });
  const { content: text, handle, total_length, offset, next_offset, eof, offset_unit, finalUrl: url } = output.structuredContent;
  return { text, handle, total_length, offset, next_offset, eof, offset_unit, url };
}
