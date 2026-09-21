// Built-in Windows speech synthesis — the zero-key voice provider, on Windows.
//
// The exact sibling of system-voices.ts, which does this with `/usr/bin/say`
// on a Mac. Same three exports, same injectable Runner, same 22 kHz mono WAV
// out, so `tts/index.ts` can treat "the platform can already speak" as one
// idea rather than two.
//
// WHY IT HAD TO EXIST. Murage has exactly three ways to turn text into audio
// and, before this, a Windows machine had none of them on day one.
// ElevenLabs needs the person's own key. The Mac path is a Darwin binary.
// And Flux Router has no synthesis endpoint at all, which is not an oversight
// on our side but a fact about that service, written out at the top of
// server/voice/flux-voice.ts. So the first run could not speak a single word
// to a Windows owner, which is most owners.
//
// System.Speech ships with .NET on every supported Windows, so this needs no
// install, no key and no network.
//
// THE TEXT IS NEVER PUT IN THE COMMAND LINE. It is base64 on the way in and
// decoded inside PowerShell. The text here is a sentence the app composed,
// but it will not always be: a spoken reply is model output, and model output
// is downstream of the person's mail. A quote or a backtick in a PowerShell
// argument is a command, so the only safe amount of untrusted text to put in
// an argument is none.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Audio, Voice } from "./elevenlabs.ts";

const POWERSHELL = "powershell";
const execFileAsync = promisify(execFile);

export function windowsVoicesAvailable(platform: string = process.platform): boolean {
  return platform === "win32";
}

export type Runner = (file: string, args: string[], timeout: number) => Promise<{ stdout: string }>;

const defaultRun: Runner = (file, args, timeout) =>
  execFileAsync(file, args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true });

/** `-NoProfile` because a developer's profile can print a banner into stdout
 *  and turn a voice list into gibberish, and `-NonInteractive` so a prompt
 *  can never hold the turn open until the timeout. */
const shell = (script: string): string[] => [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
  script,
];

/** One name per line, exactly as `say -v ?` gives one voice per line. The
 *  locale and the sample sentence are what make a list of voices choosable
 *  rather than a list of strings, so they come across too. */
export function parseVoiceList(stdout: string): Voice[] {
  const voices: Voice[] = [];
  for (const line of stdout.split("\n")) {
    const parts = line.trimEnd().split("\t");
    const id = (parts[0] ?? "").trim();
    if (!id) continue;
    const locale = (parts[1] ?? "").trim();
    const sample = (parts[2] ?? "").trim();
    voices.push({
      id,
      label: id,
      description: [locale, sample].filter(Boolean).join(" — "),
    });
  }
  return voices;
}

const LIST_SCRIPT = [
  "Add-Type -AssemblyName System.Speech;",
  "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
  "$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {",
  "  $i = $_.VoiceInfo;",
  '  Write-Output ($i.Name + "`t" + $i.Culture.Name + "`t" + $i.Description)',
  "};",
  "$s.Dispose()",
].join(" ");

export async function listWindowsVoices(run: Runner = defaultRun): Promise<Voice[]> {
  try {
    const { stdout } = await run(POWERSHELL, shell(LIST_SCRIPT), 10_000);
    return parseVoiceList(stdout);
  } catch {
    // Same contract as the Mac path: a machine that cannot answer has no
    // voices, rather than an error that has to be handled at every call site.
    return [];
  }
}

/**
 * Synthesize one utterance to 22 kHz mono WAV.
 *
 * The same format the Mac path produces, for the same reason: it is small and
 * every browser plays it without a conversion step. `SetOutputToWaveFile`
 * writes the container itself.
 *
 * An empty or unknown voice id falls back to the machine's own default, which
 * is what a fresh Windows already sounds like. Selecting a voice that is not
 * installed throws inside PowerShell, so it is attempted and then abandoned
 * rather than validated up front: a voice list can go stale between the pick
 * and the speaking, and an utterance in the wrong voice beats silence.
 */
export async function synthesizeWindows(
  text: string,
  voiceId: string | undefined,
  run: Runner = defaultRun,
): Promise<Audio> {
  const trimmed = text.trim();
  if (!trimmed) return { bytes: new Uint8Array(), mime: "audio/wav" };
  const dir = await mkdtemp(join(tmpdir(), "murage-say-"));
  const out = join(dir, "utterance.wav");
  try {
    const encoded = Buffer.from(trimmed, "utf8").toString("base64");
    const select = voiceId?.trim()
      ? `try { $s.SelectVoice(${quote(voiceId.trim())}) } catch { };`
      : "";
    const script = [
      "Add-Type -AssemblyName System.Speech;",
      "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
      select,
      `$s.SetOutputToWaveFile(${quote(out)});`,
      `$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${quote(encoded)}));`,
      "$s.Speak($t);",
      "$s.Dispose()",
    ]
      .filter(Boolean)
      .join(" ");
    await run(POWERSHELL, shell(script), 30_000);
    return { bytes: new Uint8Array(await readFile(out)), mime: "audio/wav" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * A PowerShell single-quoted string.
 *
 * Inside single quotes PowerShell expands nothing: no `$`, no backtick, no
 * subexpression. The one character that can end the string is a single quote,
 * and doubling it is the documented escape. So this is the whole rule.
 *
 * The utterance never comes through here, only a voice name and a path we
 * built ourselves, but they are quoted the same way because "this argument
 * happens to be safe today" is how the unsafe one gets added later.
 */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
