// AN ENGINE THAT ANSWERS `--version` IS NOT AN ENGINE THAT CAN ANSWER YOU.
//
// Murage SHIPS the Fuigo binary. On a machine with no Flux Router key, no
// `fuigo login` and no local runtime within reach, that binary is still
// present and still answers `--version`, so its snapshot reads "available"
// while its catalogue has merged down to nothing.
//
// App.tsx used to decide "is there any engine here?" on `snapshot.state`
// alone. On exactly the machine this app most needs to help — a clean one —
// that test said yes, the setup screen was hidden, and the person landed in
// a chat with a bot that had no model behind it and no way to find out why.
//
// server/default-engine.ts has always been stricter: `pickDefaultEngine`
// filters on a non-empty `models.default` and deliberately returns an empty
// selection rather than hand a bot an engine that cannot run (its own
// comment calls the alternative "the single worst first-run experience").
// So the two halves of the product disagreed: the selector said "no engine",
// the shell said "we have one", and the person got the gap between them.
//
// This is a source test for the same reason composer-key-guard.test.ts is:
// what has to hold is a PROPERTY OF THE CODE — that this gate consults the
// catalogue and not just the process — and a render test would pass just as
// happily against a gate that checked the right thing for the wrong reason,
// or against one mounted with a fixture that happens to have a model.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * App.tsx with its prose removed.
 *
 * The comment above the gate NAMES the mistake it no longer makes, so a scan
 * of the raw text finds `snapshot.state === "available"` inside the note
 * explaining why that check is not enough, and passes a file that is wrong —
 * or fails one that is right. Code only. Same trap as the brief's section
 * headings hiding in a CSS comment, which cost an afternoon.
 */
const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/** The `const noEngines = …` declaration, up to its terminating semicolon. */
function noEnginesGate(): string {
  const at = source.indexOf("const noEngines");
  expect(at, "App.tsx no longer declares a noEngines gate").toBeGreaterThan(-1);
  const end = source.indexOf(";", at);
  expect(end, "the noEngines declaration never terminates").toBeGreaterThan(at);
  return source.slice(at, end + 1);
}

describe("the no-engines setup gate", () => {
  it("requires a usable model, not merely a process that answered", () => {
    // The whole bug in one assertion. `state === "available"` means the CLI
    // replied; `models.default` means it has something to reply WITH.
    expect(noEnginesGate(), "the gate accepts an engine with an empty catalogue")
      .toMatch(/models\?\.default/);
  });

  it("still requires the snapshot to be available", () => {
    // The fix must ADD to the old condition, not replace it. An engine with a
    // stale catalogue and a dead binary is not a working engine either.
    expect(noEnginesGate(), "the gate stopped checking whether the engine is available")
      .toContain('snapshot.state === "available"');
  });

  it("ignores an engine the owner has switched off", () => {
    // Mirrors `runnable()` in server/setup.ts. A disabled engine is not a
    // reason to hide the setup screen from somebody who has nothing else.
    expect(noEnginesGate(), "a disabled engine still counts as an engine here")
      .toMatch(/enabled\s*!==\s*false/);
  });

  it("waits for the first instances response before deciding", () => {
    // An empty list means "not asked yet", not "nothing installed". Flashing
    // the setup screen on every launch would be a worse bug than the one
    // above, and this guard is the reason it does not happen.
    const gate = noEnginesGate();
    expect.soft(gate, "the gate no longer waits for a connection").toContain("state.connected");
    expect.soft(gate, "the gate no longer waits for a non-empty instance list")
      .toMatch(/instances\.length\s*>\s*0/);
  });
});
