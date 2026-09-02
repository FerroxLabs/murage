// What `pnpm dev:server` hands the harness.
//
// `devHarnessEnvironment` existed with no caller: the decision about the dev
// static tree was written down, tested, and never asked. The harness
// therefore served no static files in development, and the browser door — a
// phone proxied to the harness — had nothing to be handed. These tests are
// about the wiring, not the decision: that the launcher actually asks, that
// it asks about the repository rather than whatever directory it was invoked
// from, and that it does not overrule a person who set the variable by hand.
import path from "node:path";
import { describe, expect, it } from "vitest";

import { devHarnessEnvironment } from "../electron/harness-resources.mjs";
import { REPO_ROOT, SERVER_ENTRY, devServerEnvironment } from "./dev-server.mjs";

const built = () => true;
const unbuilt = () => false;

describe("the environment pnpm dev:server starts the harness with", () => {
  it("points the harness at dist/ so the browser door has a shell to serve", () => {
    // Without this the harness's STATIC_DIR is null and a phone that reaches
    // the door is proxied to a server with no UI to give it.
    const environment = devServerEnvironment("/repo", {}, built);
    expect(environment.MURAGE_STATIC_DIR).toBe(path.join("/repo", "dist"));
  });

  it("asks devHarnessEnvironment rather than deciding for itself", () => {
    // The point of the helper is that main.mjs, the Playwright webServer and
    // this script all get the same answer. A second copy of the rule here
    // would be a second copy to get wrong.
    expect(devServerEnvironment("/repo", {}, built))
      .toMatchObject(devHarnessEnvironment("/repo", built));
  });

  it("sets nothing at all in a checkout that has not been built", () => {
    // A path to a directory that is not there is worse than no path: the
    // harness already handles "no static tree", and `pnpm build` is the fix.
    expect(devServerEnvironment("/repo", {}, unbuilt).MURAGE_STATIC_DIR).toBeUndefined();
  });

  it("carries the rest of the environment through untouched", () => {
    const environment = devServerEnvironment("/repo", { MURAGE_PORT: "8799" }, built);
    expect(environment.MURAGE_PORT).toBe("8799");
  });

  it("leaves an explicit MURAGE_STATIC_DIR exactly as the person set it", () => {
    // Someone pointing the harness at a tree by hand made a deliberate
    // choice. Replacing it with dist/ would be the same class of bug as
    // never setting it: a path nobody asked for, with nothing saying so.
    const environment = devServerEnvironment("/repo", { MURAGE_STATIC_DIR: "/elsewhere/ui" }, built);
    expect(environment.MURAGE_STATIC_DIR).toBe("/elsewhere/ui");
  });

  it("resolves dist/ from the repository, not from the caller's cwd", () => {
    // `pnpm dev:server` can be run from any directory; the shell it serves
    // is the one in this checkout.
    expect(REPO_ROOT).toBe(path.resolve(import.meta.dirname, ".."));
    expect(devServerEnvironment(REPO_ROOT, {}, built).MURAGE_STATIC_DIR)
      .toBe(path.join(REPO_ROOT, "dist"));
  });

  it("still starts the same server entry the script used to run directly", () => {
    expect(SERVER_ENTRY).toBe(path.join("server", "index.ts"));
  });
});
