#!/usr/bin/env bash
# Run only in the digest-pinned Linux builder. No foreign JVM/JNI is executed.
# Two independent source/build/Gradle directories are mandatory, even without --check.
set -euo pipefail
export SOURCE_DATE_EPOCH=0 TZ=UTC LC_ALL=C
umask 022
root=$(cd "$(dirname "$0")/.." && pwd)
out=$(realpath -m "${1:?usage: build-signal-runtime-inputs.sh OUTPUT [--check]}")
expected_image=$(node -p "JSON.parse(require('fs').readFileSync('$root/scripts/signal-builder.json')).image")
[[ -f /.dockerenv && "$expected_image" =~ @sha256:[0-9a-f]{64}$ && ${SIGNAL_BUILDER_IMAGE:-} == "$expected_image" ]] || { echo 'Digest-pinned builder container required' >&2; exit 1; }
gradle_sha=$(node -p "JSON.parse(require('fs').readFileSync('$root/scripts/signal-builder.json')).gradleDistributionSha256")
[[ "$gradle_sha" =~ ^[0-9a-f]{64}$ ]] || { echo "Pinned Gradle distribution checksum required" >&2; exit 1; }
[[ ! -e "$out" ]] || { echo 'Fresh output directory required' >&2; exit 1; }
mkdir -p "$out"
# These private files are safe even when upstream tooling writes git configuration.
export GIT_CONFIG_GLOBAL="$out/git-global" GIT_CONFIG_SYSTEM="$out/git-system"
: > "$GIT_CONFIG_GLOBAL"
: > "$GIT_CONFIG_SYSTEM"
for attempt in first-build second-independent-build; do
  work="$out/$attempt"
  mkdir -p "$work"
  date -u +%FT%TZ > "$work/started-at.txt"
  python3 "$root/scripts/signal-java-inputs.py" "$work/java" > "$work/java.log" 2>&1
  export JAVA_HOME GRADLE_USER_HOME
  JAVA_HOME=$(cat "$work/java/build-jdk.home")
  GRADLE_USER_HOME="$work/gradle"
  export PATH="$JAVA_HOME/bin:$PATH"
  java -version 2>&1 | tee "$work/jdk-build.log"
  commit=$(node --input-type=module -e "import { SIGNAL_CLI_COMMIT } from '$root/server/channels/signal/evidence.mjs'; console.log(SIGNAL_CLI_COMMIT)")
  node --input-type=module -e "import { BUILD_INPUTS } from '$root/scripts/fetch-build-input.mjs'; if (!BUILD_INPUTS.D060.urls[0].endsWith('/' + process.argv[1])) process.exit(1)" "$commit"
  node "$root/scripts/fetch-build-input.mjs" D060 "$work/source.tar.gz"
  mkdir -p "$work/source"
  tar -xzf "$work/source.tar.gz" --strip-components=1 -C "$work/source"
  printf '%s\n' "$commit" > "$work/source.commit"
  node "$root/scripts/fetch-build-input.mjs" D061 "$work/gradle-distribution.zip"
  # Java Properties uses the last value: the wrapper reads only the verified local ZIP.
  printf '\ndistributionUrl=file\\:%s\ndistributionSha256Sum=%s\n' "$work/gradle-distribution.zip" "$gradle_sha" >> "$work/source/gradle/wrapper/gradle-wrapper.properties"
  # Root verification also covers buildSrc, plugins and dependency metadata.
  # Missing verification inputs fail before Gradle can resolve anything.
  cp "$root/gradle/verification-metadata.xml" "$root/gradle/verification-keyring.keys" "$work/source/gradle/"
  (cd "$root" && sha256sum gradle/verification-metadata.xml gradle/verification-keyring.keys) > "$work/gradle-verification.SHA256SUMS"
  (cd "$work/source" && ./gradlew --no-daemon --no-build-cache --no-configuration-cache --max-workers=4 --dependency-verification=strict -I "$root/scripts/signal-reproducible.init.gradle" installDist) 2>&1 | tee "$work/build.log"
  python3 "$root/scripts/signal-jdeps-inputs.py" "$work/source/build/install/signal-cli/lib" "$work/jdeps-classes"
  "$JAVA_HOME/bin/jdeps" --multi-release 25 --ignore-missing-deps --print-module-deps "$work/jdeps-classes" > "$work/jdeps.txt"
  for target in darwin-arm64 win32-x64 linux-x64; do
    node "$root/scripts/normalize-signal-runtime.mjs" "$work/source/build/install/signal-cli/lib" \
      "$(cat "$work/java/$target.home")" "$target" "$work" '25.0.5+8-LTS'
  done
  date -u +%FT%TZ > "$work/finished-at.txt"
done
for target in darwin-arm64 win32-x64 linux-x64; do
  name="signal-runtime-0.14.11-48a0a5e-r1-$target.tar.gz"
  if ! cmp "$out/first-build/$name" "$out/second-independent-build/$name"; then
    python3 "$root/scripts/signal-diffoscope.py" "$out/diffoscope-$target.txt" "$out/first-build/$name" "$out/second-independent-build/$name" || true
    test -s "$out/diffoscope-$target.txt" || { echo 'diffoscope failed to produce its report' >&2; exit 1; }
    exit 1
  fi
  if ! cmp "$out/first-build/pin-fragment-$target.json" "$out/second-independent-build/pin-fragment-$target.json"; then
    python3 "$root/scripts/signal-diffoscope.py" "$out/diffoscope-fragment-$target.txt" "$out/first-build/pin-fragment-$target.json" "$out/second-independent-build/pin-fragment-$target.json" || true
    exit 1
  fi
  cp "$out/first-build/$name" "$out/$name"
  cp "$out/first-build/pin-fragment-$target.json" "$out/pin-fragment-$target.json"
done
(cd "$out" && sha256sum ./*.tar.gz > SHA256SUMS)
printf '%s\n' "$expected_image" > "$out/container-image.txt"
if [[ ${2:-} == --check ]]; then node "$root/scripts/merge-signal-runtime-inputs.mjs" --check "$out"; fi
