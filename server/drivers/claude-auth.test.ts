// Where "is Claude signed in?" is answered. These tests inject the CLI
// runner, so they never read or mutate the developer's real credentials.
import { errorTextCases, ERROR_TEXT_LEAK } from "../testing/error-text-fixtures.ts";
import { describe, expect, it } from "vitest";

import { claudeAuthFailure, claudeAuthStatus, claudeSignedIn, claudeVersionTooOld } from "./claude.ts";
import { CLAUDE_UPDATE_MESSAGE } from "./claude-guards.ts";

describe("claudeAuthStatus", () => {
  const refusing = (stderr: string) => ((_cli, _args, _options, callback) => {
    callback(new Error("Command failed: exit code 1"), "", stderr);
  }) satisfies typeof import("../procs.ts").execCli;

  it.each(errorTextCases())("redacts the whole auth stderr before its owner cut: $name", async ({ raw, name }) => {
    const status = await claudeAuthStatus("claude", {}, refusing(raw));
    expect(status.error).toBeTruthy();
    expect(status.error).not.toMatch(ERROR_TEXT_LEAK);
    if (name === "short diagnostic") expect(status.error).toBe(raw);
    else expect(status.error).toContain("redacted");
  });

  it.each([false, true])("uses stderr truncation separately from combined output overflow: %s", async (stderrTruncated) => {
    const run = ((_cli, _args, _options, callback) => {
      callback(Object.assign(new Error("stdout or stderr maxBuffer length exceeded"), {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stderrTruncated,
      }), "x".repeat(65500), "ordinary diagnostic");
    }) satisfies typeof import("../procs.ts").execCli;
    const status = await claudeAuthStatus("claude", {}, run);
    if (stderrTruncated) {
      expect(status.error).toContain("Stderr capture truncated; later output omitted");
      expect(status.error).not.toContain("ordinary diagnostic");
    } else expect(status.error).toBe("ordinary diagnostic");
  });

  it("reads a refusal of the launch flags as an update, not a lost login", async () => {
    // rig, 2.1.281 and 2.1.295: `claude --<unknown> auth status --json` prints this on stderr, exit 1
    const status = await claudeAuthStatus("claude", {}, refusing("error: unknown option '--strict-mcp-config'\n"), ["--strict-mcp-config"]);
    expect(status).toMatchObject({ signedIn: false, refusal: { stopReason: "update_required", message: CLAUDE_UPDATE_MESSAGE } });
    expect(status.error).toBeUndefined();
  });

  it("reads a managed MCP policy's refusal as that conflict", async () => {
    const status = await claudeAuthStatus("claude", {}, refusing("You cannot use --strict-mcp-config when an enterprise MCP config is present\n"));
    expect(status.refusal).toMatchObject({ stopReason: "managed_mcp_conflict" });
  });

  it("redacts the CLI's words before cutting them to 300 characters, so a long key never loses its label", async () => {
    const status = await claudeAuthStatus("claude", {}, refusing(`error: auth failed api_key=${"Q7x".repeat(120)}\n`));
    expect(status.error).toBeDefined();
    expect(status.error).not.toMatch(/Q7|7x|xQ/);
  });

  it("keeps any other failure as the CLI's own words, signed out and no refusal", async () => {
    expect(await claudeAuthStatus("claude", {}, refusing("error: unknown option '--some-owner-flag'\n"))).toEqual({ signedIn: false, error: "error: unknown option '--some-owner-flag'" });
    expect(await claudeAuthStatus("claude", {}, refusing("error: unknown command 'auth'\n"))).toEqual({ signedIn: false, error: "error: unknown command 'auth'" });
    expect(await claudeAuthStatus("claude", {}, refusing(""))).toEqual({ signedIn: false, error: "Command failed: exit code 1" });
  });

  it("returns the status itself when the CLI gives one, even with a non-zero exit", async () => {
    const out = ((_cli, _args, _options, callback) => callback(new Error("exit code 1"), '{"loggedIn":false}', "")) satisfies typeof import("../procs.ts").execCli;
    expect(await claudeAuthStatus("claude", {}, out)).toEqual({ signedIn: false });
  });
});

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

describe("claudeVersionTooOld", () => {
  // the text the CLI relays when the API refuses a model newer than it
  const TOO_OLD = "API Error: 400 Claude Code 2.1.268 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.";

  it("reads the api-error frame for a model this install is too old for", () => {
    expect(claudeVersionTooOld({ is_api_error_message: true }, TOO_OLD)).toBe(true);
    expect(claudeVersionTooOld({ error: "invalid_request" }, TOO_OLD)).toBe(true);
  });

  it("leaves a model's own words and other api errors alone", () => {
    expect(claudeVersionTooOld({}, TOO_OLD)).toBe(false);
    expect(claudeVersionTooOld({ is_api_error_message: true }, "API Error: 400 prompt is too long")).toBe(false);
  });
});
