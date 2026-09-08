// Where "is Claude signed in?" is answered. These tests inject the CLI
// runner, so they never read or mutate the developer's real credentials.
import { describe, expect, it } from "vitest";

import { claudeAuthFailure, claudeSignedIn } from "./claude.ts";

describe("claudeSignedIn", () => {
  it("uses the CLI's machine-readable auth status", async () => {
    const run = ((cli, args, options, callback) => {
      expect(cli).toBe("claude-custom");
      expect(args).toEqual(["auth", "status", "--json"]);
      expect(options).toMatchObject({ timeout: 8000, env: { PATH: "/custom/bin" } });
      callback(null, '{"loggedIn":true}');
    }) satisfies typeof import("../procs.ts").execCli;

    expect(await claudeSignedIn("claude-custom", { PATH: "/custom/bin" }, run)).toBe(true);
  });

  it("uses loggedIn:false even though the real CLI exits with code 1", async () => {
    const run = ((_cli, _args, _options, callback) => {
      callback(new Error("exit code 1"), '{"loggedIn":false,"authMethod":"none"}');
    }) satisfies typeof import("../procs.ts").execCli;

    expect(await claudeSignedIn("claude", {}, run)).toBe(false);
  });

  it("fails closed when the command has no valid status", async () => {
    const failed = ((_cli, _args, _options, callback) => {
      callback(new Error("auth status unavailable"), "");
    }) satisfies typeof import("../procs.ts").execCli;
    const malformed = ((_cli, _args, _options, callback) => {
      callback(null, "not json");
    }) satisfies typeof import("../procs.ts").execCli;

    expect(await claudeSignedIn("claude", {}, failed)).toBe(false);
    expect(await claudeSignedIn("claude", {}, malformed)).toBe(false);
  });
});


describe("claudeAuthFailure", () => {
  const login = "Not logged in · Please run /login";
  it("requires a CLI error flag before classifying login text", () => {
    expect(claudeAuthFailure({ error: "authentication_failed", is_api_error_message: true }, login)).toBe(true);
    expect(claudeAuthFailure({ error: "authentication_failed" }, "")).toBe(true);
    expect(claudeAuthFailure({ is_api_error_message: true }, login)).toBe(true);
    expect(claudeAuthFailure({ error: "api_error" }, "401 unauthorized")).toBe(true);
    for (const frame of [{}, { is_api_error_message: false }, { is_api_error_message: "true", error: false }]) expect(claudeAuthFailure(frame, login)).toBe(false);
    expect(claudeAuthFailure({}, "You are not logged in to npm; run npm login.")).toBe(false);
  });
  it("does not relabel non-auth provider errors as sign-in failures", () => {
    expect(claudeAuthFailure({ error: "api_error", is_api_error_message: true }, "API Error (529): overloaded")).toBe(false);
    expect(claudeAuthFailure({ error: "api_error" }, "Request timed out")).toBe(false);
  });
});
