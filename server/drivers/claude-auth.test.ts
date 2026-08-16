// Where "is Claude signed in?" is answered.
//
// The check used to be a single `existsSync` on
// ~/.claude/.credentials.json, which is where Claude Code keeps credentials
// on Linux and WSL. On macOS it uses the Keychain and writes no such file,
// so every signed-in Mac reported as signed out and the engine was greyed
// out in the model picker as "sign-in required".
//
// The platform and the keychain probe are injected here so the decision is
// testable off a Mac, and without depending on whoever runs the suite being
// signed into Claude.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { claudeSignedIn } from "./claude.ts";

const credentialsDir = join(homedir(), ".claude");
const credentialsFile = join(credentialsDir, ".credentials.json");

const writeCredentialsFile = () => {
  mkdirSync(credentialsDir, { recursive: true });
  writeFileSync(credentialsFile, "{}");
};

describe("claudeSignedIn", () => {
  afterEach(() => {
    rmSync(credentialsFile, { force: true });
  });

  it("takes the credentials file as proof, on any platform", async () => {
    writeCredentialsFile();
    let probed = false;
    const keychain = async () => {
      probed = true;
      return false;
    };

    expect(await claudeSignedIn("linux", keychain)).toBe(true);
    expect(await claudeSignedIn("darwin", keychain)).toBe(true);
    // the file settles it — no need to touch the keychain
    expect(probed).toBe(false);
  });

  it("does not consult a keychain that isn't there", async () => {
    let probed = false;
    const keychain = async () => {
      probed = true;
      return true;
    };

    expect(await claudeSignedIn("linux", keychain)).toBe(false);
    expect(await claudeSignedIn("win32", keychain)).toBe(false);
    expect(probed).toBe(false);
  });

  it("asks the keychain on macOS, where the file never exists", async () => {
    // the case that was broken: no file, signed in
    expect(await claudeSignedIn("darwin", async () => true)).toBe(true);
    expect(await claudeSignedIn("darwin", async () => false)).toBe(false);
  });
});
