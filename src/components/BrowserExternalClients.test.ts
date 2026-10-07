// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe,it,expect } from "vitest";
import { BrowserExternalClients } from "./BrowserExternalClients";
describe("external browser settings initial render",()=>{
 it("starts disabled until settings are loaded",()=>{const html=renderToStaticMarkup(createElement(BrowserExternalClients));expect(html).toContain('role="switch"');expect(html).toContain('aria-checked="false"');expect(html).toContain('disabled=""');});
 it("does not expose pairing or configuration before opt-in",()=>{const html=renderToStaticMarkup(createElement(BrowserExternalClients));expect(html).not.toContain('Pair agent');expect(html).not.toContain('<textarea');expect(html).not.toContain('token');});
 it("explains separate conversations and running-app requirement",()=>{const html=renderToStaticMarkup(createElement(BrowserExternalClients));expect(html).toContain('Each gets its own conversation and permissions');expect(html).toContain('Murage must stay open');expect(html).toContain('aria-labelledby="external-browser-title"');});
});
