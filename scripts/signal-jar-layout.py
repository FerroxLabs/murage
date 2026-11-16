#!/usr/bin/env python3
"""One deterministic ZIP writer for CLI layout and native stripping.

Signed jars are never rewritten. Upstream bytes are authenticated before this
step; provenance records the upstream hash and every removed resource.
"""
import hashlib
import json
import pathlib
import re
import shutil
import sys
import zipfile

NATIVE = re.compile(r"\.(?:so|dylib|dll|jnilib)$", re.I)
SIGNED = re.compile(r"^META-INF/[^/]+\.SF$", re.I)
ENTRIES = {
    "linux-x64": ("libsignal_jni_amd64.so", "org/sqlite/native/Linux/x86_64/libsqlitejdbc.so", "libsignal_jni.so", "libsqlitejdbc.so"),
    "darwin-arm64": ("libsignal_jni_aarch64.dylib", "org/sqlite/native/Mac/aarch64/libsqlitejdbc.dylib", "libsignal_jni.dylib", "libsqlitejdbc.dylib"),
    "win32-x64": ("signal_jni_amd64.dll", "org/sqlite/native/Windows/x86_64/sqlitejdbc.dll", "signal_jni.dll", "sqlitejdbc.dll"),
}

def rewrite(source, destination, dependencies=None, strip=False):
    source, destination = pathlib.Path(source), pathlib.Path(destination)
    upstream = hashlib.sha256(source.read_bytes()).hexdigest()
    with zipfile.ZipFile(source) as original:
        names = original.namelist()
        if len(names) != len(set(names)):
            raise ValueError("Duplicate jar entry")
        removed = sorted(n for n in names if NATIVE.search(n))
        if removed and not strip:
            raise ValueError("Unlisted jar contains native code: " + source.name)
        if (removed or dependencies is not None) and any(SIGNED.match(n) for n in names):
            raise ValueError("Refusing rewrite of signed jar: " + source.name)
        if not removed and dependencies is None:
            shutil.copyfile(source, destination)
            return None
        with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:
            for name in sorted(set(names) - set(removed)):
                data = original.read(name)
                if dependencies is not None and name == "META-INF/MANIFEST.MF":
                    text = data.decode("utf-8").replace("\r\n", "\n").rstrip("\n")
                    if "\nClass-Path:" in text:
                        raise ValueError("Unexpected upstream Class-Path; review layout")
                    line = "Class-Path: " + " ".join("lib/" + dep for dep in sorted(dependencies))
                    folded = []
                    while len(line) > 70:
                        folded.append(line[:70])
                        line = " " + line[70:]
                    folded.append(line)
                    data = (text.replace("\n", "\r\n") + "\r\n" + "\r\n".join(folded) + "\r\n\r\n").encode()
                info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = (0o40755 if name.endswith("/") else 0o100644) << 16
                info.extra = b""
                info.comment = b""
                info.compress_type = zipfile.ZIP_DEFLATED
                output.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    return {"kind": "native-stripped", "upstreamSha256": upstream, "removed": removed} if removed else None

def assemble(dist, output, target, pin):
    dist, output = pathlib.Path(dist), pathlib.Path(output)
    names = sorted(p.name for p in dist.glob("*.jar"))
    cli = "signal-cli-0.14.11-SNAPSHOT.jar"
    if len(names) != 51 or cli not in names:
        raise ValueError("Expected the pinned 51 jars")
    pinned = {j["path"]: j for j in pin["targets"][target]["jars"]}
    provenance, natives = {}, []
    specs = dict(zip(["libsignal-client-0.106.1.jar", "sqlite-jdbc-3.54.1.0.jar"], zip(ENTRIES[target][:2], ENTRIES[target][2:])))
    for name in names:
        source = dist / name
        path = "signal-cli.jar" if name == cli else "lib/" + name
        sha = hashlib.sha256(source.read_bytes()).hexdigest()
        if name != cli:
            expected = pinned[path].get("provenance", {}).get("upstreamSha256", pinned[path]["sha256"])
            if sha != expected:
                raise ValueError("Upstream dependency hash mismatch: " + name)
        record = rewrite(source, output / path, [n for n in names if n != cli] if name == cli else None, name in specs)
        if record:
            provenance[path] = record
        if name in specs:
            entry, filename = specs[name]
            with zipfile.ZipFile(source) as jar:
                data = jar.read(entry)
            (output / "native" / filename).write_bytes(data)
            natives.append({"path": "native/" + filename, "sha256": hashlib.sha256(data).hexdigest(),
                            "provenance": {"kind": "upstream-jar", "jar": path, "entry": entry, "upstreamSha256": sha}})
    return {"jars": provenance, "natives": natives}

if __name__ == "__main__":
    if sys.argv[1] == "--assemble":
        dist, output, target, pinfile = sys.argv[2:]
        print(json.dumps(assemble(dist, output, target, json.loads(pathlib.Path(pinfile).read_text()))))
    else:
        source, destination, *dependencies = sys.argv[1:]
        rewrite(source, destination, dependencies)
