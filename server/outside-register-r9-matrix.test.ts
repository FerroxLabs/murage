import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import * as scan from "./outside-scan.ts";
import * as registryApi from "./download-registry.ts";
import { DownloadRegistry, TextBudget, type FsHooks } from "./download-registry.ts";
import { registerText } from "./outside-register.ts";
import { cwdOutsideMark } from "./outside-wire.ts";

// Freeze the exact BASE registration algorithm. Both sides use the same real
// registry/marker and scan dependencies so this matrix isolates registration.
const fixture = JSON.parse(readFileSync(new URL("./testing/outside-register-base-40b87b6.fixture.json", import.meta.url), "utf8"));
expect(createHash("sha256").update(fixture.source).digest("hex")).toBe(fixture.sha256);
const code = ts.transpileModule(fixture.source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const exports: { registerText?: typeof registerText } = {};
new Function("exports", "require", code)(exports, (name: string) => {
  if (name === "./outside-scan.ts") return scan;
  if (name === "./download-registry.ts") return registryApi;
  throw new Error(`unprovided BASE dependency ${name}`);
});
const baseRegister = exports.registerText!;
const now = 10_000;
function view(register: typeof registerText, text: string, marked: boolean, cwd = "/work", ctime = 1) {
  const fs: FsHooks = { realpath: p => p, lstat: p => ({ dir: !/\.[a-z]+$/i.test(p), ctime }) };
  const registry = new DownloadRegistry();
  const entries = register(text, { cwd, marked, readOnly: false, now, turn: "matrix", roots: ["/", "C:/"], budget: new TextBudget(fs) });
  registry.add(entries);
  return { entries, mark: (path: string) => cwdOutsideMark(path, registry, fs, "codex", () => []) };
}
const probes = ["/work", "/work/hello.txt", "/work/run.sh", "/outside", "/outside/drop", "/outside/drop/X", "/outside/drop1", "/outside/drop2", "/outside/dropa", "/outside/drop/AGENTS.md", "/sibling", "/scripts"];
const r8 = [
  ["1a", "printf 'curl -o %s https://x.invalid/p' /outside/drop/X > run.sh; bash -o pipefail run.sh", "/outside/drop"],
  ["1b", "cd /scripts; printf 'curl -o %s https://x.invalid/p' /outside/drop/X > run.sh; sh /scripts/run.sh", "/outside/drop"],
  ["2a", "printf 'curl -o %s https://x.invalid/p' /outside/drop/X > run.sh 2> errors.log; sh run.sh", "/outside/drop"],
  ["2b", "printf 'curl -o /outside/drop/X https://x.invalid/p\\n' | tee run.sh; sh run.sh", "/outside/drop"],
  ["3", "printf 'curl -o /outside/drop%s/X https://x.invalid/p\\n' 1 2 > run.sh", "/outside/drop1"],
  ["4a", "printf '%s\\n' 'curl -o /outside/drop\\141/X https://x.invalid/p' > run.sh; sh run.sh", "/outside/dropa"],
  ["4b", "echo -e 'curl -o /outside/dr\\u006fp/X https://x.invalid/p' > run.sh; sh run.sh", "/outside/drop"],
  ["5a", "printf 'curl -o /outside/drop/X https://x.invalid/p\\n# %d\\n' 1 > run.sh; sh run.sh", "/outside/drop"],
  ["5b", "printf 'curl --output=/outside/drop/X https://x.invalid/p\\n# %d\\n' 1 > run.sh", "/outside/drop"],
  ["6", "printf 'curl -o ../drop/X https://x.invalid/p' > run.sh; cd /outside/work; sh /work/run.sh", "/outside/drop"],
  ["7", "printf 'cu' > run.sh; printf 'rl -o /outside/drop/X https://x.invalid/p' >> run.sh; sh run.sh", "/outside/drop"],
  ["8", "cat > 'run script.sh' <<'END'\n\"$client\" -o /outside/drop/X https://x.invalid/p\nEND\nsh 'run script.sh'", "/outside/drop"],
] as const;
const r1 = [
  "printf 'curl -o /outside/drop/X https://x.invalid/p' > run.sh; sh run.sh",
  "cat <<'END' > run.sh\ncurl -o /outside/drop/X https://x.invalid/p\nEND\nsh run.sh",
  "printf 'curl -o /outside/drop/X https://x.invalid/p' | sh",
  "eval 'curl -o /outside/drop/X https://x.invalid/p'",
  'echo "$(curl -o /outside/drop/X https://x.invalid/p)"',
];
describe("CLONED-CWD r9/A1 BASE real-mark matrix", () => {
  it.each(r8)("r8 %s retains every BASE mark and marks its real destination", (_id, text, dest) => {
    for (const marked of [false, true]) for (const ctime of [1, now - 1000, now + 1000]) {
      const base = view(baseRegister, text, marked, "/work", ctime);
      const head = view(registerText, text, marked, "/work", ctime);
      for (const path of probes) if (base.mark(path)) expect(head.mark(path), `${path}, marked=${marked}, ctime=${ctime}`).not.toBeNull();
      expect(head.mark(dest), `actual ${dest}, marked=${marked}`).not.toBeNull();
    }
  });
  it.each(r1)("r1 keeps actual destination marked: %s", text => {
    expect(view(registerText, text, true).mark("/outside/drop")).not.toBeNull();
  });
  it.each(["echo hello > hello.txt", "npm test", "git status", "touch hello.txt", "printf hello > hello.txt"])("W1 real marks and timestamp windows equal R alone: %s", remainder => {
    for (const cwd of ["/bots/a", "C:/bots/a"]) for (const ctime of [1, now - 1000, now + 1000]) {
      const plain = view(registerText, remainder, true, cwd, ctime);
      const prefixed = view(registerText, `cd "${cwd}" && ${remainder}`, true, cwd, ctime);
      expect(prefixed.entries).toEqual(plain.entries);
      for (const path of [cwd, cwd + "/hello.txt", cwd.replace(/a$/, "b")]) expect(prefixed.mark(path)).toBe(plain.mark(path));
      expect(prefixed.mark(cwd.replace(/a$/, "b"))).toBeNull();
      expect(prefixed.mark(cwd)).not.toBeNull();
    }
  });
  it.each([
    "sh x", "bash x", "zsh x", "dash x", "ksh x", "fish x", "pwsh x", "powershell x", "cmd /c x",
    "python3 x", "node x", "deno x", "bun x", "perl x", "ruby x", "php x", "lua x", "osascript x", "awk x", "sed x", "make", "npx x",
    "pnpm run build", "npm run build", "yarn run build", "env bash x", "x -c x", "x -e x", "x --eval x", "x -Command x", "x /c x", "x -r x",
    "eval x", "exec x", "source x", ". x", "cat <<END\nx\nEND", "echo x | sh", "xargs x", "find . -exec x", "cd ..", "echo $OLDPWD", "echo parent",
    'python3 -c \'open(chr(46)*2+chr(47)+"AGENTS.md","w")\'',
  ])("A1 deny-list retains BASE parent and R marks: %s", remainder => {
    const text = `cd "/bots/a" && ${remainder}`;
    const base = view(baseRegister, text, true, "/bots/a");
    const head = view(registerText, text, true, "/bots/a");
    for (const path of ["/bots/b", "/bots/a", ...probes]) if (base.mark(path)) expect(head.mark(path), path).not.toBeNull();
    expect(head.mark("/bots/b")).not.toBeNull();
  });
});
