// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const launcher = fileURLToPath(new URL("../../deploy/cloud-home/murage-home-launch.py", import.meta.url));

it("preserves the documented email opt-in and excludes every other inherited environment field", () => {
  const result = spawnSync("python3", ["-I", "-c", String.raw`
import importlib.machinery, importlib.util, json, os, sys
loader = importlib.machinery.SourceFileLoader("launch", sys.argv[1])
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)
metadata = {"MURAGE_CLOUD_ROLE": "home", "MURAGE_CLOUD_MACHINE_ID": "fixture-home", "MURAGE_CLOUD_ADMIN_URL": "https://admin.example", "MURAGE_PUBLIC_ORIGIN": "https://home.example"}
fixed = {"PATH", "LANG", "MURAGE_CLOUD_SECRETS_FD", "MURAGE_RELEASE_ROOT", "MURAGE_HOME_IDENTITY"}
forwarded = 0
for flag in (None, "", "0", "true", "1"):
    os.environ.clear()
    os.environ.update({"NODE_OPTIONS": "inherited-node-option", "LD_PRELOAD": "inherited-library", "HOME": "inherited-home", "PATH": "inherited-path", "MURAGE_TEST_ENV": "inherited-test-setting", "MURAGE_CLOUD_UNKNOWN": "inherited-setting"})
    if flag is not None:
        os.environ["MURAGE_CLOUD_BOT_EMAIL"] = flag
    env = module.supervisor_env(metadata, "A", {"uid": 2001, "gid": 2001}, False)
    expected = set(metadata) | fixed
    if flag == "1":
        assert env.get("MURAGE_CLOUD_BOT_EMAIL") == "1", "documented email opt-in was dropped"
        expected.add("MURAGE_CLOUD_BOT_EMAIL")
        forwarded += 1
    assert set(env) == expected, (flag, sorted(env))
    assert env["PATH"] == "/usr/local/bin:/usr/bin:/bin"
    assert env["LANG"] == "C.UTF-8"
    assert env["MURAGE_CLOUD_SECRETS_FD"] == "3"
    assert env["MURAGE_RELEASE_ROOT"] == "/opt/murage-releases/A"
    assert json.loads(env["MURAGE_HOME_IDENTITY"]) == {"uid": 2001, "gid": 2001}
    assert all(env[name] == value for name, value in metadata.items())
print(json.dumps({"cases": 5, "forwarded": forwarded}))
`, launcher], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ cases: 5, forwarded: 1 });
});

it("the image launcher prepares the restore spool and lock before dropping privileges, with descriptor ownership and link refusals", () => {
  const source = readFileSync(launcher, "utf8");
  const main = source.slice(source.indexOf("def main():"));
  expect(main.indexOf("prepare_data_ops_lock(identity)")).toBeGreaterThan(-1);
  expect(main.indexOf("prepare_data_ops_lock(identity)")).toBeLessThan(main.indexOf("drop_privileges(identity)"));
  const bind = source.slice(source.indexOf("def bind_home_volume("), source.indexOf("def prepare_home_events_dir("));
  expect(bind.indexOf("prepare_home_events_dir(data_dir, gid)")).toBeGreaterThan(bind.indexOf("validate_volume_marker("));
  const result = spawnSync("python3", ["-I", "-c", String.raw`
import importlib.machinery, importlib.util, json, os, stat, sys, tempfile
loader = importlib.machinery.SourceFileLoader("launch", sys.argv[1])
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)
owners = []
module.os.fchown = lambda fd, uid, gid: owners.append([stat.S_IFMT(os.fstat(fd).st_mode), uid, gid])
with tempfile.TemporaryDirectory() as root:
    spool = os.path.join(root, ".murage-events")
    lock = os.path.join(root, "data-ops.lock")
    module.prepare_home_events_dir(root, 4242)
    module.prepare_data_ops_lock({"gid": 4242}, lock)
    assert owners == [[stat.S_IFDIR, 0, 4242], [stat.S_IFREG, 0, 4242]], owners
    assert stat.S_IMODE(os.stat(spool).st_mode) == 0o1770
    assert stat.S_IMODE(os.stat(lock).st_mode) == 0o660
    os.chmod(spool, 0o700)
    os.chmod(lock, 0o600)
    module.prepare_home_events_dir(root, 4242)
    module.prepare_data_ops_lock({"gid": 4242}, lock)
    assert stat.S_IMODE(os.stat(spool).st_mode) == 0o1770
    assert stat.S_IMODE(os.stat(lock).st_mode) == 0o660
    os.unlink(lock)
    os.symlink(spool, lock)
    try:
        module.prepare_data_ops_lock({"gid": 4242}, lock)
        raise AssertionError("lock symlink accepted")
    except ValueError:
        pass
    os.unlink(lock)
    os.mkdir(lock)
    try:
        module.prepare_data_ops_lock({"gid": 4242}, lock)
        raise AssertionError("lock directory accepted")
    except ValueError:
        pass
    os.rmdir(spool)
    os.symlink(lock, spool)
    try:
        module.prepare_home_events_dir(root, 4242)
        raise AssertionError("spool symlink accepted")
    except ValueError:
        pass
    assert len(owners) == 4, owners
print(json.dumps({"ownership": "descriptor", "repaired": True, "refused": 3}))
`, launcher], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ownership: "descriptor", repaired: true, refused: 3 });
});
