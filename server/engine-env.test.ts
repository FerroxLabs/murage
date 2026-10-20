// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Rule 74 (APP-GRANT-DESIGN-FINAL.AGREED-r10.md): the owner's interactive
// login capture (74a), the handed map with the pins written last (74a(3),
// 74c), and the consistency check that can only remove (74d).

import { chmodSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ABSENT_PINS, valuePins, type PinRun } from "../shared/arg-vocabulary.ts";
import { compareCheck, execEnvNow, handEnv, noteStartupFileEvent } from "./engine-env.ts";
import { askTouchesStartup } from "./startup-files.ts";
import { captureOwnerEnv, invalidateEnvCapture, ownerEnvState, parseEnvBlock, readCapture, resetPathCacheForTests, setOwnerEnvStore } from "./env-path.ts";

let dir: string;
/** The pin probes (`ssh -V`, `git config`) answered as on a machine with neither. */
const noRun: PinRun = async () => ({ ok: false, stdout: "", stderr: "" });
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "engine-env-")));
  resetPathCacheForTests();
  invalidateEnvCapture("test start");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in account shell: prints rc-file noise around the real capture. */
function fakeShell(body: string): string {
  const file = join(dir, "fake-shell");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

// The account-shell capture and the pinned /bin/sh check are POSIX only: on Windows Murage never runs a login shell (the launch
// environment is read live; env-check-again.test.ts has the Windows row), so the #!/bin/sh stand-ins cannot run there.
const posixShell = process.platform !== "win32";

describe("the capture (Rule 74a)", () => {
  it.skipIf(!posixShell)("reads the whole exported map between the markers, past startup noise", async () => {
    const shell = fakeShell(`echo "welcome to zsh"; export PROJECT_DOCS=./docs; export PATH=/opt/nvm/bin:/usr/bin; export HOME=${dir}; shift 3; exec /bin/sh -c "$1"`);
    setOwnerEnvStore(join(dir, "env"));
    const owner = await captureOwnerEnv({ shell });
    expect(owner.capture).toBe("session");
    expect(owner.env.PROJECT_DOCS).toBe("./docs");
    expect(owner.env.PATH).toBe("/opt/nvm/bin:/usr/bin");
    expect(owner.env.MURAGE_ENV_MARK).toBeUndefined();
    // persisted 0600, NUL-separated, readable through the same parser
    const stored = readdirFile(join(dir, "env"));
    expect(statSync(stored).mode & 0o777).toBe(0o600);
    expect(parseEnvBlock(readFileSync(stored, "utf8"))?.PROJECT_DOCS).toBe("./docs");
  });

  it.skipIf(!posixShell)("an incomplete capture is never handed: the last validated map is kept, then the told fallback", async () => {
    const shell = fakeShell(`export PATH=/good/bin:/usr/bin:/bin; export HOME=${dir}; shift 3; exec /bin/sh -c "$1"`);
    setOwnerEnvStore(join(dir, "env"));
    expect((await captureOwnerEnv({ shell })).capture).toBe("session");
    // the server restarts and the same shell's capture now fails: the persisted map is handed
    resetPathCacheForTests();
    writeFileSync(shell, "#!/bin/sh\nexit 3\n");
    const kept = await captureOwnerEnv({ shell });
    expect(kept.capture).toBe("kept");
    expect(kept.env.PATH).toBe("/good/bin:/usr/bin:/bin");
    expect(kept.cause).toBeTruthy();
    // a shell with no validated map at all gets the told fallback, never silently
    resetPathCacheForTests();
    const other = join(dir, "other-shell");
    writeFileSync(other, "#!/bin/sh\necho PATH=/x\n");
    chmodSync(other, 0o755);
    const fallback = await captureOwnerEnv({ shell: other });
    expect(fallback.capture).toBe("fallback");
    expect(fallback.cause).toBeTruthy();
  });

  it("a map missing PATH or HOME, a missing marker, or a block that does not parse whole is incomplete", () => {
    const mark = "__M__";
    expect(readCapture(`${mark}PATH=/b\0HOME=/h\0${mark}`, mark)).toEqual({ PATH: "/b", HOME: "/h" });
    expect(readCapture(`${mark}PATH=/b\0${mark}`, mark)).toBeNull();
    expect(readCapture(`PATH=/b\0HOME=/h\0${mark}`, mark)).toBeNull();
    expect(readCapture(`${mark}PATH=/b\0HOME=/h${mark}`, mark)).toBeNull();
    expect(readCapture(`${mark}=x\0PATH=/b\0HOME=/h\0${mark}`, mark)).toBeNull();
  });
});

function readdirFile(folder: string): string {
  const name = readdirSync(folder).find((entry) => entry.startsWith("owner-env."));
  if (!name) throw new Error("no stored map");
  return join(folder, name);
}

describe("the handed map (Rule 74a(3), 74c)", () => {
  it("writes every value pin last and deletes every absence pin, recording it as trusted absence", async () => {
    const owner = { env: { PATH: "/usr/bin", HOME: "/h", PAGER: "less", PYTHONINSPECT: "1", BASH_ENV: "/h/.bashrc", OPENAI_API_KEY: "x" }, capture: "session" as const };
    const handed = await handEnv(owner, { platform: "linux", run: noRun, strip: (env) => Object.fromEntries(Object.entries(env).filter(([name]) => !/KEY|SECRET|TOKEN/.test(name))) });
    for (const [name, value] of valuePins("linux")) expect(handed.env[name], name).toBe(value);
    for (const name of ABSENT_PINS) expect(name in handed.env, name).toBe(false);
    expect(handed.absent.sort()).toEqual([...ABSENT_PINS].sort());
    expect(handed.env.OPENAI_API_KEY).toBeUndefined();
    expect(handed.env.HOME).toBe("/h");
    expect(Object.keys(handed.env).some((name) => handed.absent.includes(name))).toBe(false);
  });
});

describe("the consistency check (Rule 74d)", () => {
  const handed = { env: { PATH: "/usr/bin:/bin", HOME: "/h", PAGER: "cat" }, absent: ["POSIXLY_CORRECT", "BASH_ENV"], capture: "session" as const, ownerStartup: {}, pins: new Map() };

  it("only removes: a changed, missing or new name becomes Unknown; an absent name the print holds leaves absent", () => {
    const printed = "PATH=/usr/bin:/bin\0HOME=/h\0PAGER=less\0POSIXLY_CORRECT=1\0NEW=1\0SHLVL=1\0\0/p\n";
    const result = compareCheck(handed, "/p", printed);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env).toEqual({ PATH: "/usr/bin:/bin", HOME: "/h" });
    expect(result.absent).toEqual(["BASH_ENV"]);
    expect(result.unknown.sort()).toEqual(["NEW", "PAGER", "POSIXLY_CORRECT"]);
    expect(result.cwdKnown).toBe(true);
    expect(compareCheck(handed, "/q", printed)).toMatchObject({ ok: true, cwdKnown: false });
  });

  it("a check that cannot be read is U20: the F12 record carries no env and no absence", async () => {
    expect(compareCheck(handed, "/p", "garbage")).toMatchObject({ ok: false });
    const failed = await execEnvNow("s1", ["/bin/sh", "-c"], { ...handed, env: { ...handed.env, PATH: "/nonexistent" } }, "/nonexistent-dir");
    expect(failed).toMatchObject({ env: {}, absent: [], cwd: "/nonexistent-dir" });
  });

  it.skipIf(!posixShell)("runs the pinned form for real and keeps an untouched map", async () => {
    const real = { env: { PATH: "/usr/bin:/bin", HOME: dir, PAGER: "cat" }, absent: ["POSIXLY_CORRECT"], capture: "session" as const, ownerStartup: {}, pins: new Map() };
    const result = await execEnvNow("s2", ["/bin/sh", "-c"], real, dir);
    expect(result).toMatchObject({ cwd: dir, absent: ["POSIXLY_CORRECT"] });
    expect(result.env).toEqual(real.env);
  });
});

// Gap (c) of steps 1..3 (Rule 74a): an APPROVED write to a startup-file row re-captures before the next spawn
describe("re-capture after an approved startup-file write", () => {
  it.skipIf(!posixShell)("re-captures only when an ask naming a startup file is answered allow", async () => {
    const shell = fakeShell(`export PATH=/usr/bin:/bin; export HOME=${dir}; shift 3; exec /bin/sh -c "$1"`);
    setOwnerEnvStore(join(dir, "env"));
    expect((await captureOwnerEnv({ shell })).capture).toBe("session");
    await handEnv({ env: { PATH: "/usr/bin:/bin", HOME: dir }, capture: "session" }, { run: noRun });
    expect(askTouchesStartup({ toolCall: { name: "edit", input: { file_path: join(dir, ".zshrc") } } })).toBe(true);
    expect(askTouchesStartup({ toolCall: { name: "shell", input: { command: "echo export X=1 >> ~/.bash_profile", cwd: dir } } })).toBe(true);
    expect(askTouchesStartup({ toolCall: { name: "edit", input: { file_path: join(dir, "src", "app.ts") } } })).toBe(false);
    // a denied startup-file ask and an allowed ordinary ask leave the capture alone
    noteStartupFileEvent({ type: "request.opened", requestType: "permission", threadId: "t", requestId: "r1", toolCall: { name: "edit", input: { file_path: "~/.zprofile" } } } as never);
    expect(noteStartupFileEvent({ type: "request.resolved", threadId: "t", requestId: "r1", behavior: "deny" })).toBe(false);
    noteStartupFileEvent({ type: "request.opened", requestType: "permission", threadId: "t", requestId: "r2", toolCall: { name: "edit", input: { file_path: join(dir, "README.md") } } } as never);
    expect(noteStartupFileEvent({ type: "request.resolved", threadId: "t", requestId: "r2", behavior: "allow" })).toBe(false);
    expect(ownerEnvState()?.capture).toBe("session");
    // the allowed one asks for the re-capture: the next spawn captures again
    noteStartupFileEvent({ type: "request.opened", requestType: "permission", threadId: "t", requestId: "r3", filePaths: [join(dir, ".zshrc")] } as never);
    expect(noteStartupFileEvent({ type: "request.resolved", threadId: "t", requestId: "r3", behavior: "allow" })).toBe(true);
    // the capture in use is not marked kept (r3 (f)); the next capture runs the shell again
    writeFileSync(shell, `#!/bin/sh\nexport PATH=/usr/bin:/bin HOME=${dir} RECAPTURED=1; shift 3; exec /bin/sh -c "$1"\n`);
    expect(ownerEnvState()?.capture).not.toBe("kept");
    const again = await captureOwnerEnv({ shell });
    expect(again.capture).toBe("session");
    expect(again.env.RECAPTURED).toBe("1");
  });
});
