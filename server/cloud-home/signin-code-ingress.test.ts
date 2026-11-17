// SPDX-License-Identifier: AGPL-3.0-or-later
// AGY-ON-CLOUD design section 4 item 0: on a home, a whole message shaped like a Google sign-in code is refused on every ingress that
// persists chat, before anything is stored, logged or sent. These pin the wiring in server/index.ts (the home's HTTP server cannot be
// booted as a Cloud home inside a unit test) and the removal of the old in-chat flow.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cloudHomeCopy } from "./copy.ts";

const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const routeBody = (route: string, until: string): string => { const at = index.indexOf(route); expect(at, route).toBeGreaterThan(0); return index.slice(at, index.indexOf(until, at)); };

describe("the sign-in code never enters chat", () => {
  it("guards /messages, POST /api/groups/:id/messages and the edit route, each before its first store call", () => {
    const direct = routeBody("m = path.match(/^\\/api\\/bots\\/([\\w-]+)\\/messages$/);", "const bot = requestedDirectBot(m[1],body.threadId);");
    expect(direct).toContain("if (cloudHome && looksLikeSignInCode(text))");
    expect(direct.indexOf("looksLikeSignInCode")).toBeLessThan(direct.indexOf("messageTooLargeRefusal"));
    const group = routeBody("m = path.match(/^\\/api\\/groups\\/([\\w-]+)\\/messages$/);", "const group = store.group(m[1]);");
    expect(group).toContain("if (cloudHome && looksLikeSignInCode(text)) return json(res, 422,");
    const edit = routeBody("m = path.match(/^\\/api\\/bots\\/([\\w-]+)\\/messages\\/([\\w-]+)\\/edit$/);", "const source = store.messageById(bot.threadId, messageId);");
    expect(edit).toContain("if (cloudHome && looksLikeSignInCode(text)) return json(res, 422,");
    expect(index.match(/looksLikeSignInCode\(text\)/g)).toHaveLength(3);
    expect(cloudHomeCopy.signinCodeInChat).toBe("That looks like a sign-in code. Paste it in the sign-in dialog, not here.");
  });
  it("is not conditioned on a pending sign-in, and the in-chat flow, its route and its policy rows are gone", () => {
    expect(index).not.toMatch(/swallowPastedCode|acceptSigninCode|configureAgySignin|agySigninHolds/);
    // The carried legacy unit tests remain as required by the integration brief. Their helpers are unreachable from the server.
    for (const legacy of ["agy-signin-start.ts", "agy-signin-code.ts", "agy-signin-routes.ts"]) expect(index).not.toContain(`./cloud-home/${legacy}`);
    expect(index).toContain("looksLikeSignInCode(text)");
    for (const policy of ["../route-policy.ts", "../browser-owner-policy.ts"]) expect(readFileSync(new URL(policy, import.meta.url), "utf8")).not.toContain("engine-signin/code");
  });
});
