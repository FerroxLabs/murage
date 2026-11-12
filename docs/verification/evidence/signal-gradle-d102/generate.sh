#!/bin/bash
set -euo pipefail
export GIT_CONFIG_GLOBAL=/job/git-global GIT_CONFIG_SYSTEM=/job/git-system
: > "$GIT_CONFIG_GLOBAL"
: > "$GIT_CONFIG_SYSTEM"
export SOURCE_DATE_EPOCH=0 TZ=UTC LC_ALL=C
python3 - <<'PY'
import sys, pathlib, json, tarfile, subprocess, hashlib
sys.path.insert(0,'/repo/scripts')
from fetch_build_input import fetch_input, PINS
import importlib.util
spec=importlib.util.spec_from_file_location('signal_java_inputs','/repo/scripts/signal-java-inputs.py')
mod=importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
authenticate=mod.authenticate
root=pathlib.Path('/job')
for row, name in [('D060','source.tar.gz'),('D061','gradle-distribution.zip')]:
    fetch_input(PINS[row]['urls'][0],root/name,PINS[row]['sha256'])
    print(row, hashlib.sha256((root/name).read_bytes()).hexdigest(),flush=True)
source=root/'source'
source.mkdir(exist_ok=True)
with tarfile.open(root/'source.tar.gz') as t:
    # Hash-verified upstream source, unpack without the archive's leading directory.
    for m in t.getmembers():
        bits=pathlib.PurePosixPath(m.name).parts[1:]
        if not bits: continue
        if '..' in bits: raise ValueError('Unsafe source entry')
        m.name=str(pathlib.PurePosixPath(*bits))
        t.extract(m,source)
pin=json.loads(pathlib.Path('/repo/scripts/signal-java-inputs.json').read_text())['build-jdk']
archive=root/'jdk.tar.gz'
fetch_input(pin['url'],archive,pin['sha256'])
for suffix in ['.sha256.txt','.sig']:
    fetch_input(pin['url']+suffix,pathlib.Path(str(archive)+suffix))
gnupg=root/'gnupg'
gnupg.mkdir(mode=0o700)
gpg=['gpg','--homedir',str(gnupg),'--batch','--no-auto-key-retrieve']
subprocess.run(gpg+['--import','/repo/scripts/adoptium-signing-key.asc'],check=True)
authenticate(archive,pin,pathlib.Path(str(archive)+'.sha256.txt'),pathlib.Path(str(archive)+'.sig'),gpg)
java=root/'java'
java.mkdir()
with tarfile.open(archive) as t: t.extractall(java)
homes=list(java.rglob('release'))
assert len(homes)==1
(root/'java-home').write_text(str(homes[0].parent))
print('authenticated build-jdk',pin,flush=True)
PY
export JAVA_HOME="$(cat /job/java-home)" GRADLE_USER_HOME=/job/gradle
export PATH="$JAVA_HOME/bin:$PATH"
java -version
printf '\ndistributionUrl=file\\:/job/gradle-distribution.zip\ndistributionSha256Sum=21bd5da2de49b642904077f38c0efdc7778e92b3ed0889392dca61b97e389607\n' >> /job/source/gradle/wrapper/gradle-wrapper.properties
cd /job/source
./gradlew --no-daemon --no-build-cache --max-workers=4 -I /repo/scripts/signal-reproducible.init.gradle --write-verification-metadata sha256,pgp --export-keys installDist
