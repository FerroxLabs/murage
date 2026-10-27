// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CAGE_BUILD_IMAGE, floorDockerArgs, LINUX_FLOOR_IMAGE, verifyGlibcFloor, verifyNeededLibraries } from "./linux-floor.mjs";
import { CAGE_BUILD_IMAGE as cageImage, verifyGlibcFloor as cageFloor } from "./build-murage-cage.mjs";

describe("shared Linux floor contract", () => {
  it("preserves cage exports and rejects unexpected NEEDED libraries", () => {
    expect(cageImage).toBe(LINUX_FLOOR_IMAGE);
    expect(CAGE_BUILD_IMAGE).toBe(LINUX_FLOOR_IMAGE);
    expect(cageFloor).toBe(verifyGlibcFloor);
    expect(() => verifyNeededLibraries("(NEEDED) Shared library: [libc.so.6]")).not.toThrow();
    for (const text of ["(NEEDED) [libm.so.6]", "(NEEDED) malformed"]) expect(() => verifyNeededLibraries(text)).toThrow("DYNAMIC_DEPENDENCY");
    expect(() => verifyNeededLibraries("undefined napi_create_object")).not.toThrow();
  });
  it.each(["x64", "arm64"])("maps %s to a fixed platform with only numeric identity env", arch => {
    expect(floorDockerArgs({ arch, mounts: [{ source: "/host source", target: "/source", readOnly: true }, { source: "/host output", target: "/work" }], env: { MURAGE_BUILD_UID: 1000, MURAGE_BUILD_GID: 1001 } })).toEqual([
      "run", "--rm", "--platform", arch === "x64" ? "linux/amd64" : "linux/arm64",
      "--mount", "type=bind,source=/host source,target=/source,readonly", "--mount", "type=bind,source=/host output,target=/work",
      "--workdir", "/work", "--env", "MURAGE_BUILD_UID=1000", "--env", "MURAGE_BUILD_GID=1001", LINUX_FLOOR_IMAGE, "/bin/bash", "/work/build.sh",
    ]);
  });
  it("refuses malformed ids, additional env, invalid mounts and unknown architectures", () => {
    const base = { arch: "x64", mounts: [], env: { MURAGE_BUILD_UID: 1, MURAGE_BUILD_GID: 2 } };
    for (const value of [-1, 1.5, "1;id", "", undefined, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => floorDockerArgs({ ...base, env: { ...base.env, MURAGE_BUILD_UID: value } })).toThrow("INVALID_ID");
    expect(() => floorDockerArgs({ ...base, env: { ...base.env, CC: "gcc" } })).toThrow("INVALID_ENV");
    for (const source of ["relative", "/tmp/x,target=/etc", "/tmp/\npath"]) expect(() => floorDockerArgs({ ...base, mounts: [{ source, target: "/work" }] })).toThrow("INVALID_MOUNT");
    expect(() => floorDockerArgs({ ...base, arch: "riscv64" })).toThrow("ARCH_UNSUPPORTED");
  });
});

// Python's producer is host-gated at import time. Verify its cross-language
// recipe contract here; real compilation and bundle scans belong to the gate.
describe("GEPA floor producer contract", () => {
  const source = readFileSync(new URL("../native/gepa/build-linux.py", import.meta.url), "utf8");
  const recipe = source.match(/FLOOR_BUILD_SCRIPT = r"""([\s\S]*?)"""/)?.[1];
  it("uses the same image and one constant container recipe", () => {
    expect(source).toContain(`LINUX_FLOOR_IMAGE = "${LINUX_FLOOR_IMAGE}"`);
    expect(source.match(/run\("floor-build", \["docker", "run"/g)).toHaveLength(1);
    expect(source).toContain('"type=bind,source=" + str(ROOT) + ",target=/work"');
    expect(source).toContain('(ROOT / "build.sh").write_text(FLOOR_BUILD_SCRIPT)');
    expect(recipe).toContain('trap \'chown -R "$MURAGE_BUILD_UID:$MURAGE_BUILD_GID" /work\' EXIT');
    expect(recipe).not.toMatch(/\$\{|str\(ROOT\)|--privileged|--cap-add|--network host/);
    for (const pkg of ["gcc-8.5.0-29.el8_10.alma.1", "make-4.2.1-11.el8", "binutils-2.30-128.el8_10", "xz-5.2.4-4.el8_6", "tar-1.30-13.el8_10", "perl-5.26.3-423.el8_10.1", "zlib-devel-1.2.11-25.el8", "bzip2-devel-1.0.6-28.el8_10", "readline-devel-7.0-10.el8", "sqlite-devel-3.26.0-21.el8_10", "libffi-devel-3.1-24.el8", "xz-devel-5.2.4-4.el8_6"]) expect(recipe).toContain(pkg);
    expect(recipe).toContain("rpm -q");
    expect(source).toContain('receipt(packages=(ROOT / "packages.txt").read_text().splitlines())');
  });
  it("hashes OpenSSL on the host, builds it before Python, installs only hashed local wheels", () => {
    expect(source).toContain('OPENSSL_SHA256 = "603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a"');
    expect(source.indexOf('if openssl_digest != OPENSSL_SHA256:')).toBeLessThan(source.indexOf('run("floor-build"'));
    expect(recipe.indexOf("./Configure --prefix=/work/openssl --libdir=lib shared no-tests")).toBeLessThan(recipe.indexOf("./configure --prefix=/work/prefix"));
    expect(recipe).toContain("--with-openssl=/work/openssl --with-openssl-rpath=auto");
    expect(recipe).toContain(String.raw`assert ssl.OPENSSL_VERSION_INFO[:4]==(3,5,0,9) and ssl.OPENSSL_VERSION.startswith(\"OpenSSL 3.5.9 \")`);
    expect(recipe).toContain("pip install --no-index --find-links /work/wheelhouse --only-binary=:all: --require-hashes");
    expect(recipe).not.toContain("pip download");
    expect(source).toContain('run("download-wheels", ["/usr/bin/python3", "-I", "-m", "pip"');
    expect(source).toContain('"--python-version", "3.13", "--implementation", "cp", "--abi", "cp313"');
  });
  it("checks each bundle ELF on the host before the fixture and staging", () => {
    expect(source).toContain('run(stage, ["objdump", "-T", path])');
    expect(source).toContain('native[-1]["glibcMax"] = maximum');
    expect(source).toContain('glibc_version_parts(maximum) > (2, 28, 0)');
    expect(source.indexOf('receipt(nativeFiles=native)')).toBeLessThan(source.indexOf('if over_floor:'));
    expect(source.indexOf('run(stage, ["objdump"')).toBeLessThan(source.indexOf('run("offline-fixture"'));
    expect(source.indexOf('run("offline-fixture"')).toBeLessThan(source.indexOf('shutil.copytree(bundle, DESTINATION'));
    expect(source).toContain('run("offline-fixture", ["/usr/bin/python3", "-I"');
  });
});
