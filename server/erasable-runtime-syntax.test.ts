import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// The server runs under Node type stripping, which rejects TypeScript-only runtime syntax
// (constructor parameter properties, enums, namespaces). One such file stops the whole server from booting.
// A modifier right after "(" or "," and before the parameter name; "readonly" as a TYPE modifier (x: readonly T[]) is fine.
const PARAM_PROPERTY = /constructor\s*\((?:[^)]*,)?\s*(?:private|public|protected|readonly)\s+(?:readonly\s+)?[A-Za-z_$][\w$]*\s*[?:=,)]/;
const ENUM_OR_NAMESPACE = /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?(?:enum|namespace)\s+[A-Za-z_$]/m;

function runtimeFiles(): string[] {
  let listing: string;
  try {
    listing = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    // Rig shards run a tracked-tree copy without .git and supply this exact inventory.
    // A missing inventory must fail the gate, never silently scan an empty tree.
    listing = readFileSync("server/testing/.git-ls-files.fixture", "utf8");
  }
  return listing.split("\0").filter((f) => /^(?:server|shared|scripts)\/.*\.ts$/.test(f) && !f.endsWith(".test.ts") && !f.includes("/testing/") && !f.endsWith(".d.ts"));
}

describe("runtime TypeScript stays erasable", () => {
  it("has no parameter properties, enums or namespaces in server, shared or scripts runtime files", () => {
    const files = runtimeFiles();
    expect(files).toContain("server/browser-control-token.ts");
    const offenders = files.filter((f) => {
      const text = readFileSync(f, "utf8");
      return PARAM_PROPERTY.test(text) || ENUM_OR_NAMESPACE.test(text);
    });
    expect(offenders).toEqual([]);
  });
});
