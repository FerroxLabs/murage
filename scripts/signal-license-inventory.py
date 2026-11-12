#!/usr/bin/env python3
"""Generate a licence record for every staged jar from Gradle's resolved POMs.

Parent POMs and embedded licence/notice documents are retained, never inferred
from a jar filename. Canonical licence texts live alongside this generated data.
"""
import hashlib
import json
import pathlib
import re
import shutil
import sys
import xml.etree.ElementTree as ET
import zipfile

dist, cache, source, output, staged = map(pathlib.Path, sys.argv[1:])
NS = {"m": "http://maven.apache.org/POM/4.0.0"}
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
poms = {}
for p in sorted(cache.glob("*/*/*/*/*.pom")):
    x = ET.parse(p).getroot()
    if x.tag == "project":
        for node in x.iter():
            node.tag = "{" + NS["m"] + "}" + node.tag
    parent = x.find("m:parent", NS)
    def text(n, key):
        return n.findtext("m:" + key, namespaces=NS) if n is not None else None
    key = (text(x, "groupId") or text(parent, "groupId"), text(x, "artifactId"), text(x, "version") or text(parent, "version"))
    poms[key] = (p, x)

def info(key, seen=()):
    if key in seen or key not in poms:
        raise ValueError(f"Missing/cyclic POM {key}")
    p, x = poms[key]
    name = "-".join(key) + ".pom"
    dest = output / "poms" / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(p, dest)
    licenses = [{"name": n.findtext("m:name", namespaces=NS), "url": n.findtext("m:url", namespaces=NS)}
                for n in x.findall("m:licenses/m:license", NS)]
    chain = [{"path": str(dest.relative_to(output)), "sha256": sha(dest)}]
    parent = x.find("m:parent", NS)
    if not licenses and parent is not None:
        parentkey = tuple(parent.findtext("m:" + n, namespaces=NS) for n in ["groupId", "artifactId", "version"])
        licenses, inherited = info(parentkey, (*seen, key))
        chain += inherited
    if not licenses:
        raise ValueError(f"No licence declared for {key}")
    return licenses, chain

records = []
for jar in sorted(dist.glob("*.jar")):
    local = jar.name in ["signal-cli-0.14.11-SNAPSHOT.jar", "libsignal-cli-0.14.11-SNAPSHOT.jar"]
    if local:
        coordinate = "org.asamk:" + jar.stem.replace("-0.14.11-SNAPSHOT", "") + ":0.14.11-SNAPSHOT"
        licenses = [{"name": "GPL-3.0", "url": "https://www.gnu.org/licenses/gpl-3.0.txt"}]
        chain = [{"path": "signal-cli/LICENSE.txt", "sha256": sha(output / "signal-cli/LICENSE.txt")}]
    else:
        matches = [key for key, (p, _) in poms.items() if p.name == jar.stem + ".pom"]
        if len(matches) != 1:
            raise ValueError(f"Ambiguous/missing POM for {jar.name}: {matches}")
        key = matches[0]
        coordinate = ":".join(key)
        licenses, chain = info(key)
    embedded = []
    with zipfile.ZipFile(jar) as z:
        for item in z.infolist():
            if item.is_dir() or item.filename.endswith(".class") or not re.search(r"(^|/)(LICENSE|LICENCE|NOTICE|COPYING)([._-]|$)", item.filename, re.I):
                continue
            path = pathlib.PurePosixPath(item.filename)
            if path.is_absolute() or ".." in path.parts:
                raise ValueError("Unsafe licence path")
            dest = output / "embedded" / jar.stem / path
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(z.read(item))
            if dest.stat().st_size:
                embedded.append({"path": str(dest.relative_to(output)), "sha256": sha(dest)})
    records.append({"path": "signal-cli.jar" if jar.name.startswith("signal-cli-") else "lib/" + jar.name,
                    "sha256": sha(staged / ("signal-cli.jar" if jar.name.startswith("signal-cli-") else "lib/" + jar.name)), "coordinate": coordinate, "licenses": licenses, "pomChain": chain, "embedded": embedded})
if len(records) != 51:
    raise ValueError("Expected exactly 51 licence records")
documents = []
components = {"signal-cli/LICENSE.txt": "signal-cli", "libsignal/LICENSE.txt": "libsignal",
              "temurin/LICENSE.txt": "temurin", "temurin/CLASSPATH_EXCEPTION.txt": "classpath-exception"}
for p in sorted(output.rglob("*")):
    if p.is_file() and p.name != "manifest.json" and p.stat().st_size:
        path = str(p.relative_to(output))
        documents.append({"component": components.get(path, "dependency"), "path": path, "sha256": sha(p)})
(output / "manifest.json").write_text(json.dumps({"documents": documents, "jars": records}, indent=2) + "\n")
print(f"Licence inventory: {len(records)} jars, {len(documents)} documents")
