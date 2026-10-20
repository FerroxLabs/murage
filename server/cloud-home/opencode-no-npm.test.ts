// SPDX-License-Identifier: AGPL-3.0-or-later
// OpenCode 1.19.0 never needs npm for a Go or Zen turn, and registry.npmjs.org stays off the
// engine allowlist. Measured 2026-10-15 (build host, the pinned linux-x64-baseline binary): Go
// and Zen models of every SDK family load with ~/.cache/opencode/packages empty, because the
// binary embeds each SDK their catalogues name. Its remaining on-demand npm fetch is the
// @opencode-ai/plugin install into any WRITABLE config directory it loads; the rigoc request
// named a writable OPENCODE_CONFIG_DIR (~/tmp/occonf) and the egress proxy refused that call.
// These tests pin what keeps every such fetch from starting: the launcher's OpenCode
// environment, the read-only config directories, and the embedded-SDK check in the image build.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { fixtureEngineBytes } from "./engine-launch-fixture.ts";

const launcher = fileURLToPath(new URL("../../deploy/cloud-home/murage-turn-launch.py", import.meta.url));
const buildImage = fileURLToPath(new URL("../../deploy/cloud-home/build-image.sh", import.meta.url));
const validate = `import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location("launcher_fixture",sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
result=module.validate_request(json.loads(sys.argv[2]),manifest_path=sys.argv[3],manifest_uid=os.getuid(),engine_root=sys.argv[4],cache_root=sys.argv[5])
print(json.dumps({"env":result[5]}))`;
const mount = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("launcher_fixture",sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
home,cwd=sys.argv[2],sys.argv[3]
module.WORKSPACE_ROOT=sys.argv[4]
argv,blobs=module.turn_mount_args("opencodeGo",([("/fixture/anchor/cwd",cwd)] if cwd!=home else []),home,cwd,"/opt/murage/bin/opencode",["acp"],None)
mounted={argv[i+2]:blobs[argv[i+1][len("@fd:"):]] for i,a in enumerate(argv) if a=="--ro-bind-data"}
print(json.dumps({"readOnly":[argv[i+1] for i,a in enumerate(argv) if a=="--remount-ro"],"files":mounted}))`;
const GITIGNORE = "node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore";

let root: string, engineRoot: string, home: string, command: string, manifest: string;
beforeEach(() => {
  root = mkdtempSync(join(process.cwd(), ".murage-opencode-npm-")); engineRoot = join(root, "engine-homes"); home = join(engineRoot, "opencodeGo");
  mkdirSync(home, { recursive: true }); mkdirSync(join(root, "bin"));
  command = join(root, "bin", "fixture-opencode"); const bytes = fixtureEngineBytes();
  writeFileSync(command, bytes, { mode: 0o755 });
  manifest = join(root, "engine-manifest.json");
  writeFileSync(manifest, JSON.stringify({ opencodeGo: [{ path: command, sha256: createHash("sha256").update(bytes).digest("hex") }] }), { mode: 0o644 });
});
afterEach(() => removeTempDirSync(root));

it("pins OpenCode to the read-only config directory and off every npm path, whatever the request names", () => {
  // The rigoc request shape: a writable config directory and no npm flags, plus a hostile inline config.
  const env = { LANG: "C.UTF-8", OPENCODE_CONFIG_DIR: `${home}/tmp/occonf`, OPENCODE_CONFIG: `${home}/tmp/occonf/opencode.json`, OPENCODE_CONFIG_CONTENT: '{"plugin":["fixture-evil"]}', OPENCODE_PURE: "0", OPENCODE_API_KEY: "fixture-key" };
  const input = { engine: "opencodeGo", bot: "fixture-bot", command, args: ["acp"], cwd: home, env };
  const result = JSON.parse(execFileSync("python3", ["-I", "-c", validate, launcher, JSON.stringify(input), manifest, engineRoot, join(root, "digest-cache")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  expect(result.env).toMatchObject({
    OPENCODE_CONFIG_DIR: `${home}/.config/opencode`, OPENCODE_CONFIG: `${home}/.config/opencode/opencode.json`,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_PURE: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_API_KEY: "fixture-key",
  });
  expect(result.env).not.toHaveProperty("OPENCODE_CONFIG_CONTENT");
});

it.each([["in a workspace", true], ["in the engine home", false]])("makes every config directory OpenCode loads read-only %s", (_label, inWorkspace) => {
  // A workspace .opencode is masked when it exists; an absent one is left absent (no mount point in the owner's tree).
  const workspace = inWorkspace ? join(root, "workspaces", "ws") : "";
  if (workspace) mkdirSync(join(workspace, ".opencode"), { recursive: true });
  const fixtureHome = "/fixture/engine-homes/opencodeGo", cwd = workspace || fixtureHome;
  const result = JSON.parse(execFileSync("python3", ["-I", "-c", mount, launcher, fixtureHome, cwd, join(root, "workspaces")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  // OpenCode 1.19.0 ConfigPaths.directories: Global config, ~/.opencode, OPENCODE_CONFIG_DIR (and,
  // with project config on, .opencode up from the working folder). Npm.install skips a directory it
  // cannot write, so each one being a read-only shadow is what keeps @opencode-ai/plugin off npm.
  const expected = [`${fixtureHome}/.config/opencode`, `${fixtureHome}/.opencode`, ...(workspace ? [`${workspace}/.opencode`] : [])];
  // r5 R5.1: a workspace cwd also carries every other MASK_NAMES mask (empty tmpfs, no .gitignore).
  expect(result.readOnly).toEqual([...expected, ...(workspace ? [".claude", ".codex", ".fuigo", ".grok", ".kimi-code"].map(name => `${workspace}/${name}`) : [])]);
  for (const dir of expected) expect(result.files[`${dir}/.gitignore`]).toBe(GITIGNORE);
  const managed = result.files[`${fixtureHome}/.config/opencode/opencode.json`];
  expect(result.files[`${fixtureHome}/.opencode/opencode.json`]).toBe(managed);
  expect(result.files[`${fixtureHome}/.opencode/opencode.jsonc`]).toBe(managed);
});

it("fails the image build when the pinned OpenCode stops embedding a Go or Zen provider SDK", () => {
  const script = readFileSync(buildImage, "utf8");
  // The SDK families the Go and Zen catalogues name (models.opencode.ai, 2026-10-15).
  expect(script).toContain("for sdk in @ai-sdk/openai-compatible @ai-sdk/openai @ai-sdk/anthropic @ai-sdk/google @ai-sdk/mistral; do");
  expect(script).toContain(`grep -aqF "\\"$sdk\\":()=>import(" bin/opencode || { echo "OpenCode $opencode_version does not embed $sdk" >&2; exit 1; }`);
  expect(script.indexOf("for sdk in @ai-sdk/")).toBeGreaterThan(script.indexOf('install -o root -g root -m 0755 "$stage/opencode/package/bin/opencode" bin/opencode'));
  expect(script).not.toMatch(/registry\.npmjs\.org\/@ai-sdk/);
  expect(readFileSync(fileURLToPath(new URL("../../deploy/cloud-home/egress-allow.json", import.meta.url)), "utf8")).not.toContain("npmjs");
});
