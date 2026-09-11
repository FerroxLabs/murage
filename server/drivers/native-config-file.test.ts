import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  displayConfigPath,
  NativeConfigRefusal,
  parseNativeJsonConfig,
  readNativeJsonConfig,
  type NativeConfigProblem,
} from "./native-config-file.ts";

const scratchDirs: string[] = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function refusalFor(text: string): NativeConfigRefusal | null {
  try {
    parseNativeJsonConfig(text, "cfg.json");
    return null;
  } catch (error) {
    if (error instanceof NativeConfigRefusal) return error;
    throw error;
  }
}
const problem = (text: string): NativeConfigProblem | null => refusalFor(text)?.problem ?? null;

describe("parseNativeJsonConfig", () => {
  it("parses a plain JSON object and treats whitespace-only text as empty", () => {
    expect(parseNativeJsonConfig('{"a":{"b":[1,2]}}', "cfg.json")).toEqual({ a: { b: [1, 2] } });
    expect(parseNativeJsonConfig(" \n\t", "cfg.json")).toEqual({});
  });

  it("tells a valid commented (JSONC) config apart from broken JSON", () => {
    expect(problem('{\n  // the CLI reads comments\n  "a": 1\n}\n')).toBe("comments");
    expect(problem('{ /* block */ "a": [1, 2,], }')).toBe("comments");
    // "//" inside a string is data, not a comment; the trailing comma is JSONC
    expect(problem('{ "url": "http://127.0.0.1:8080//v1", }')).toBe("comments");
    expect(problem('{ "quote": "a\\"//b", }')).toBe("comments");
    expect(problem('{ "url": "http://x//y" oops }')).toBe("invalid-json");
    expect(problem('{ /* unterminated "a": 1 }')).toBe("invalid-json");
    expect(problem("{not-json")).toBe("invalid-json");
  });

  it("refuses JSON that is not a plain object", () => {
    expect(problem("[1, 2]")).toBe("not-object");
    expect(problem("null")).toBe("not-object");
    expect(problem('"text"')).toBe("not-object");
  });

  it("never echoes file content (which can hold keys) in the guidance", () => {
    const refusal = refusalFor('{"apiKey": "sk-should-not-leak" oops}');
    expect(refusal?.message).toBe("cfg.json is not valid JSON, so Murage left it unchanged. Fix or move the file, then try again.");
    expect(refusal?.message).not.toContain("sk-should-not-leak");
  });
});

describe("readNativeJsonConfig", () => {
  const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-native-config-"));
    scratchDirs.push(dir);
    return dir;
  };

  it("returns null only for a missing or whitespace-only file", () => {
    const home = scratch();
    expect(readNativeJsonConfig(join(home, "absent.json"), home)).toBeNull();
    writeFileSync(join(home, "blank.json"), "\n");
    expect(readNativeJsonConfig(join(home, "blank.json"), home)).toBeNull();
    writeFileSync(join(home, "ok.json"), '{"keep":true}');
    expect(readNativeJsonConfig(join(home, "ok.json"), home)).toEqual({ text: '{"keep":true}', value: { keep: true } });
  });

  it("refuses a file it cannot read rather than treating it as missing", () => {
    const home = scratch();
    mkdirSync(join(home, ".tool", "settings.json"), { recursive: true });
    expect(() => readNativeJsonConfig(join(home, ".tool", "settings.json"), home)).toThrow(
      `Murage could not read ${join("~", ".tool", "settings.json")} (EISDIR) and left it unchanged. Check its permissions, then try again.`,
    );
  });
});

describe("displayConfigPath", () => {
  it("abbreviates paths under home and leaves others alone", () => {
    const home = join(tmpdir(), "murage-home");
    expect(displayConfigPath(join(home, ".qwen", "settings.json"), home)).toBe(join("~", ".qwen", "settings.json"));
    expect(displayConfigPath(`${home}${sep}`, `${home}${sep}`)).toBe(`~${sep}`);
    // a sibling that merely shares the prefix is not inside home
    expect(displayConfigPath(`${home}-other${sep}x.json`, home)).toBe(`${home}-other${sep}x.json`);
    expect(displayConfigPath(join(tmpdir(), "elsewhere.json"), home)).toBe(join(tmpdir(), "elsewhere.json"));
  });
});
