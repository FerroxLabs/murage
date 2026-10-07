// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { extensionRefusal } from "./browser-extension-refusals.ts";
import { validateHeadlessBrowserCall } from "./browser-engine-policy.ts";
describe("Vultr live bug 3: refusals are not masked", () => {
  it("says the real reason, in plain words, with a browser_ code the proxy forwards", () => {
    for (const code of ["site_denied", "stale_binding", "binding_inactive", "stale_document", "action_approval_required", "human_handover", "command_timeout", "uncertain", "stale_generation", "response_too_large", "clipboard_denied", "tab_not_shared"]) {
      const r = extensionRefusal(Object.assign(new Error("internal detail https://secret.test/x"), { code }))!;
      expect(r.code, code).toMatch(/^browser_/); expect(r.error).not.toContain("secret.test"); expect(r.error).not.toMatch(/—|\bsafe|safely|safety|unsafe|Composio/i);
    }
    expect(extensionRefusal(Object.assign(new Error("x"), { code: "site_denied" }))!.error).toMatch(/declined|Never/);
  });
  it("L13: an oversize page answer gets the plain sentence", () => {
    expect(extensionRefusal(Object.assign(new Error("response_too_large"), { code: "response_too_large" }))!.error).toBe("The page answer was too large. Try a smaller part of the page.");
  });
  it("explains an uncertain command without inviting another automatic attempt", () => {
    expect(extensionRefusal(Object.assign(Error("uncertain"), { code: "uncertain" }))!.error).toMatch(/paused.*may have run.*owner/);
  });
  it("passes Murage's own argument errors, never an unknown internal error", () => {
    let said = ""; try { validateHeadlessBrowserCall("agent_browser_click", { ref: "e3" }); } catch (e) { said = extensionRefusal(e)!.error; }
    expect(said).toContain("ref"); expect(said).toContain("selector");
    expect(extensionRefusal(new Error("ECONNRESET at /Users/x/server"))).toBeUndefined(); expect(extensionRefusal(Object.assign(new Error("x"), { code: "ENOENT" }))).toBeUndefined();
  });
  it("names the missing argument", () => {
    expect(() => validateHeadlessBrowserCall("agent_browser_get_text", {})).toThrow(/selector/);
  });
});
