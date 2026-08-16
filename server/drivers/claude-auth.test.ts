// Where "is Claude signed in?" is answered.
//
// The check used to be a single `existsSync` on
// ~/.claude/.credentials.json, which is where Claude Code keeps credentials
// on Linux and WSL. On macOS it uses the Keychain and writes no such file,
// so every signed-in Mac reported as signed out and the engine was greyed
// out in the model picker as "sign-in required".
//
// Every input is injected: the platform, the keychain probe, and whether
// the credentials file is there. That last one matters most. The obvious
// way to test "the file settles it" is to write the file — but the only
// path involved is the real ~/.claude/.credentials.json, so writing it
// clobbers the developer's actual credentials and the cleanup that follows
// deletes them, signing them out of Claude Code. These tests touch no
// filesystem at all.
import { describe, expect, it } from "vitest";

import { claudeSignedIn } from "./claude.ts";

const present = () => true;
const absent = () => false;

describe("claudeSignedIn", () => {
  it("takes the credentials file as proof, on any platform", async () => {
    let probed = false;
    const keychain = async () => {
      probed = true;
      return false;
    };

    expect(await claudeSignedIn("linux", keychain, present)).toBe(true);
    expect(await claudeSignedIn("darwin", keychain, present)).toBe(true);
    // the file settles it — no need to touch the keychain
    expect(probed).toBe(false);
  });

  it("does not consult a keychain that isn't there", async () => {
    let probed = false;
    const keychain = async () => {
      probed = true;
      return true;
    };

    expect(await claudeSignedIn("linux", keychain, absent)).toBe(false);
    expect(await claudeSignedIn("win32", keychain, absent)).toBe(false);
    expect(probed).toBe(false);
  });

  it("asks the keychain on macOS, where the file never exists", async () => {
    // the case that was broken: no file, signed in
    expect(await claudeSignedIn("darwin", async () => true, absent)).toBe(true);
    expect(await claudeSignedIn("darwin", async () => false, absent)).toBe(false);
  });
});
