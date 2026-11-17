#!/bin/bash
set -euo pipefail
umask 022
export GIT_CONFIG_GLOBAL=/job/git-global GIT_CONFIG_SYSTEM=/job/git-system
export SOURCE_DATE_EPOCH=0 TZ=UTC LC_ALL=C
export JAVA_HOME="$(cat /job/java-home)"
export PATH="$JAVA_HOME/bin:$PATH"
sha256sum /job/source.tar.gz /job/gradle-distribution.zip /job/jdk.tar.gz > /evidence/evidence/proof-inputs.SHA256SUMS
(cd /repo && sha256sum gradle/verification-metadata.xml gradle/verification-keyring.keys) > /evidence/evidence/gradle-verification.SHA256SUMS
java -version > /evidence/evidence/proof-java.log 2>&1
for case in strict-tampered strict-good; do
  work="/job/$case"
  test ! -e "$work"
  mkdir -p "$work/source" "$work/gradle/caches"
  tar -xzf /job/source.tar.gz --strip-components=1 -C "$work/source"
  cp -a /job/gradle/caches/modules-2 "$work/gradle/caches/"
  export GRADLE_USER_HOME="$work/gradle"
  cp /repo/gradle/verification-metadata.xml /repo/gradle/verification-keyring.keys "$work/source/gradle/"
  printf '\ndistributionUrl=file\\:/job/gradle-distribution.zip\ndistributionSha256Sum=21bd5da2de49b642904077f38c0efdc7778e92b3ed0889392dca61b97e389607\n' >> "$work/source/gradle/wrapper/gradle-wrapper.properties"
  if [[ "$case" == strict-tampered ]]; then
    python3 /evidence/tamper.py "$work/source/gradle/verification-metadata.xml" > /evidence/evidence/tamper.log
  fi
  set +e
  (cd "$work/source" && ./gradlew --offline --no-daemon --no-build-cache --no-configuration-cache --max-workers=4 --dependency-verification=strict -I /repo/scripts/signal-reproducible.init.gradle installDist) > "/evidence/evidence/$case.log" 2>&1
  result=$?
  set -e
  printf '%s\n' "$result" > "/evidence/evidence/$case.exit"
  if [[ "$case" == strict-tampered ]]; then
    [[ "$result" != 0 ]]
    grep -q 'Dependency verification failed' "/evidence/evidence/$case.log"
    grep -q 'org.gradle.kotlin.kotlin-dsl.gradle.plugin' "/evidence/evidence/$case.log"
    python3 - "$work/source" <<'PY'
import pathlib,sys
root=pathlib.Path(sys.argv[1]); reports=list(root.rglob('dependency-verification-report.html'))
assert reports,'No verification failure report'
text=reports[0].read_text()
assert '0'*64 in text and 'a74aa6bd177ed61defa0d57524f0d9429f9553d845a4dc2d7363442090e7e2b2' in text
pathlib.Path('/evidence/evidence/tamper-report.html').write_text(text)
PY
  else
    [[ "$result" == 0 ]]
    grep -q 'BUILD SUCCESSFUL' "/evidence/evidence/$case.log"
    test -f "$work/source/build/install/signal-cli/lib/signal-cli-0.14.11-SNAPSHOT.jar"
    (cd "$work/source/build/install/signal-cli/lib" && sha256sum *.jar) > /evidence/evidence/strict-output-jars.SHA256SUMS
  fi
  printf '%s exit=%s\n' "$case" "$result"
done
