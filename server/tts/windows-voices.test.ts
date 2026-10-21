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
// Since 1.0.3 the voice is SAPI through the engine-exclusion addon, not
// PowerShell (murage-releases #1). What matters: a voice saved in a bot's
// settings before 1.0.3 (an id from System.Speech's listing) still names the
// same voice, and the text reaches SAPI as data, never as markup or a command.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { listWindowsVoices, synthesizeWindows, voiceOf, windowsVoicesAvailable, type WindowsSpeech } from "./windows-voices.ts";

// What System.Speech listed on a stock Windows 11 (VoiceInfo.Name, Culture.Name, Description), the shape the 1.0.2 PowerShell
// listing printed one per line as "<Name>\t<Culture>\t<Description>". The Name is the id a bot's settings hold.
const SYSTEM_SPEECH_ROWS = [
  ["Microsoft David Desktop", "en-US", "Microsoft David Desktop - English (United States)"],
  ["Microsoft Zira Desktop", "en-US", "Microsoft Zira Desktop - English (United States)"],
  ["Microsoft Hedda Desktop", "de-DE", "Microsoft Hedda Desktop - German"],
] as const;
// The 1.0.2 listing's own parse of those lines: what a bot could have saved.
const SAVED_IDS = SYSTEM_SPEECH_ROWS.map(([name, culture, description]) => `${name}\t${culture}\t${description}`.split("\t")[0]!.trim());

function fakeSpeech(rows = SYSTEM_SPEECH_ROWS.map(([name, culture, description]) => ({ name, culture, description }))) {
  const spoken: Array<{ text: string; voice: string; path: string }> = [];
  const speech: WindowsSpeech = {
    speechVoices: async () => rows,
    speechToWave: async (text, voice, path) => {
      spoken.push({ text, voice, path });
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path, Buffer.from("RIFF....WAVEfmt "));
      return rows.some((row) => row.name === voice);
    },
  };
  return { spoken, speech: () => speech };
}

describe("where the zero-key voice exists", () => {
  it("is Windows only, the same way the other one is Darwin only", () => {
    expect(windowsVoicesAvailable("win32")).toBe(true);
    expect(windowsVoicesAvailable("darwin")).toBe(false);
    expect(windowsVoicesAvailable("linux")).toBe(false);
  });
});

describe("voices saved before 1.0.3 still resolve", () => {
  it("lists the same ids System.Speech gave, with the locale and description", async () => {
    const { speech } = fakeSpeech();
    const voices = await listWindowsVoices(speech);
    expect(voices.map((voice) => voice.id)).toEqual(SAVED_IDS);
    expect(voices[0]).toEqual({ id: "Microsoft David Desktop", label: "Microsoft David Desktop", description: "en-US: Microsoft David Desktop - English (United States)" });
  });

  it("speaks a saved id with that very voice, not the default", async () => {
    const { speech, spoken } = fakeSpeech();
    for (const id of SAVED_IDS) {
      const audio = await synthesizeWindows("hello", id, speech);
      expect(audio.mime).toBe("audio/wav");
      expect(Buffer.from(audio.bytes).toString("ascii", 0, 4)).toBe("RIFF");
    }
    expect(spoken.map((call) => call.voice)).toEqual(SAVED_IDS);
  });

  it("an unknown or empty id is the machine's default voice, never silence", async () => {
    const { speech, spoken } = fakeSpeech();
    await synthesizeWindows("hello", "A Voice Removed Since", speech);
    await synthesizeWindows("hello", undefined, speech);
    await synthesizeWindows("hello", "  ", speech);
    expect(spoken.map((call) => call.voice)).toEqual(["A Voice Removed Since", "", ""]);
  });

  it("a nameless voice row is left out; a machine that cannot answer has no voices", async () => {
    expect(voiceOf({ name: " ", culture: "en-US", description: "x" })).toBeNull();
    const broken: WindowsSpeech = { speechVoices: async () => { throw new Error("SAPI unavailable"); }, speechToWave: async () => false };
    expect(await listWindowsVoices(() => broken)).toEqual([]);
    expect(await listWindowsVoices(() => { throw new Error("no addon"); })).toEqual([]);
  });
});

describe("what reaches the speech engine", () => {
  it("hands the utterance over unchanged, as data: no command line, no quoting, no markup step", async () => {
    const hostile = [`'; Remove-Item C:\\ -Recurse -Force; '`, "$(Get-Content C:/secrets.txt)", "`n; whoami", '<volume level="0">quiet</volume>', "$env:FLUX_API_KEY"].join(" ");
    const { speech, spoken } = fakeSpeech();
    await synthesizeWindows(`  ${hostile}  `, "Microsoft Zira Desktop", speech);
    expect(spoken[0]!.text).toBe(hostile);
    expect(spoken[0]!.path).toMatch(/murage-say-.*utterance\.wav$/);
    // the module starts nothing: no child process, no PowerShell
    const source = readFileSync(new URL("./windows-voices.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/child_process|execFile|spawn\(/);
    expect(source.split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n")).not.toMatch(/powershell/i);
  });

  it("an empty utterance is empty audio, with nothing spoken", async () => {
    const { speech, spoken } = fakeSpeech();
    expect((await synthesizeWindows("   ", "Microsoft David Desktop", speech)).bytes.length).toBe(0);
    expect(spoken).toEqual([]);
  });
});
