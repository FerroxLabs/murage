// Mac speech: the reply is spoken, never read as an option to `say`.
//
// `say` treats any argument that starts with a dash as one of its own
// options, so a reply or voice note that began "--output-file=/some/path"
// wrote the audio there, and "--input-file=/etc/hosts" read that file aloud.
// The text now follows `--`. The runner is a fake: nothing is spoken here.
import { writeFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { synthesizeSystem, type Runner } from "./system-voices.ts";

describe("synthesizeSystem", () => {
  it("passes the text after `--`, so text that looks like an option is spoken", async () => {
    for (const text of ["--input-file=/etc/hosts", "--output-file=/tmp/elsewhere.wav", "-v Alex", "- a list item", "hello"]) {
      const calls: string[][] = [];
      const run: Runner = async (_file, args) => {
        calls.push(args);
        await writeFile(args[args.indexOf("-o") + 1]!, "RIFF");
        return { stdout: "" };
      };
      const audio = await synthesizeSystem(`  ${text}  `, "Samantha", run);
      expect(audio.mime).toBe("audio/wav");
      expect(calls).toHaveLength(1);
      const args = calls[0]!;
      expect(args.slice(-2), text).toEqual(["--", text]);
      // Every option of ours comes before the separator, and the text is the only thing after it.
      expect(args.indexOf("--"), text).toBe(args.length - 2);
      expect(args.slice(0, -2), text).toEqual(["-o", args[1], "--data-format=LEI16@22050", "-v", "Samantha"]);
    }
  });

  it("keeps the separator when no voice is chosen", async () => {
    const calls: string[][] = [];
    const run: Runner = async (_file, args) => {
      calls.push(args);
      await writeFile(args[args.indexOf("-o") + 1]!, "RIFF");
      return { stdout: "" };
    };
    await synthesizeSystem("--output-file=/tmp/x.wav", undefined, run);
    expect(calls[0]!.slice(-2)).toEqual(["--", "--output-file=/tmp/x.wav"]);
    expect(calls[0]).not.toContain("-v");
  });

  it("runs nothing for empty text", async () => {
    let ran = false;
    const audio = await synthesizeSystem("   ", "Samantha", async () => { ran = true; return { stdout: "" }; });
    expect(ran).toBe(false);
    expect(audio.bytes.byteLength).toBe(0);
  });
});
