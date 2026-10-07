#!/usr/bin/env bash
# Build or unit-test the Android app on the build host. Gradle never runs on the Mac
# (the project's build rule): this script ships the sources to
# /root/mb-mobile/plan2 and runs Gradle inside the Android SDK image there.
#
#   scripts/android-remote.sh build   -> apps/mobile/build/app-debug.apk
#   scripts/android-remote.sh test    -> apps/mobile/build/junit/*.xml
#   scripts/android-remote.sh clean   -> deletes the lane's caches and outputs
#
# Run `pnpm sync` first: Gradle needs the files `cap sync` generates.
set -euo pipefail
cmd=${1:?usage: android-remote.sh build|test|clean}
HERE=$(cd "$(dirname "$0")/.." && pwd)      # apps/mobile
HOST=build-host
LANE=/root/mb-mobile/plan3b
QLANE=$(printf %q "$LANE")                  # every remote command quotes the lane

if [[ $cmd == clean ]]; then
  ssh "$HOST" "rm -rf $QLANE/gradle-home $QLANE/apps-mobile/android/app/build $QLANE/apps-mobile/android/build $QLANE/apps-mobile/android/.gradle && du -sh $QLANE && df -h / | tail -1"
  exit 0
fi

case $cmd in
  build) task=assembleDebug ;;
  test) task=testDebugUnitTest ;;
  *) echo "unknown command $cmd" >&2; exit 2 ;;
esac

# `cap sync` writes the Android copy of capacitor.config.ts, which is not
# committed. Refuse an APK whose copy leaves CapacitorCookies on (P21 review):
# run `pnpm sync` first.
SYNCED="$HERE/android/app/src/main/assets/capacitor.config.json"
if ! node -e 'const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit(c.plugins && c.plugins.CapacitorCookies && c.plugins.CapacitorCookies.enabled === false ? 0 : 1)' "$SYNCED" 2>/dev/null; then
  echo "android/app/src/main/assets/capacitor.config.json must have \"CapacitorCookies\": {\"enabled\": false}; run pnpm sync first" >&2
  exit 1
fi

# The exact node_modules path `cap sync` wrote into capacitor.settings.gradle
# (pnpm's .pnpm/… store path), relative to apps/mobile, so it resolves the same
# way on the build host as it does here. cap_path refuses anything outside node_modules.
source "$HERE/scripts/android-cap-path.sh"
CAP=$(cap_path "$HERE")
QCAP=$(printf %q "$CAP")

ssh "$HOST" "df -h / | tail -1; mkdir -p $QLANE/apps-mobile/$QCAP $QLANE/gradle-home $QLANE/dot-android"
rsync -a --delete --exclude build/ --exclude .gradle/ --exclude local.properties "$HERE/android/" "$HOST:$LANE/apps-mobile/android/"
# google-services.json is the maintainer's (never committed): copied after the --delete sync above.
GS="$HOME/.config/murage-mobile/google-services.json"
if [[ -f "$GS" ]]; then rsync -a "$GS" "$HOST:$LANE/apps-mobile/android/app/google-services.json"; else echo "no google-services.json: building with push off"; fi
if [[ -d "$HERE/contract" ]]; then rsync -a --delete "$HERE/contract/" "$HOST:$LANE/apps-mobile/contract/"; fi
# $LANE is a constant and cap_path limits $CAP to [A-Za-z0-9._@+/-], so the
# host:path arguments below are safe even though rsync's remote side splits them.
# -L: node_modules/@capacitor/android is a pnpm symlink; ship the real files.
rsync -aL --delete "$HERE/$CAP/" "$HOST:$LANE/apps-mobile/$CAP/"

# dot-android keeps the debug keystore, so every APK has the same signature and
# installs over the last one without wiping the WebView's cookies.
ssh "$HOST" "docker run --rm \
  -v $QLANE/apps-mobile:/w -v $QLANE/gradle-home:/gh -v $QLANE/dot-android:/root/.android \
  -e GRADLE_USER_HOME=/gh -w /w/android ghcr.io/cirruslabs/android-sdk:35 \
  bash -c 'yes | sdkmanager --licenses >/dev/null 2>&1; sdkmanager \"platforms;android-36\" \"build-tools;35.0.0\" >/dev/null 2>&1; chmod +x gradlew; ./gradlew --no-daemon --console=plain $task'"

mkdir -p "$HERE/build"
if [[ $cmd == build ]]; then
  scp "$HOST:$LANE/apps-mobile/android/app/build/outputs/apk/debug/app-debug.apk" "$HERE/build/app-debug.apk"
  ls -la "$HERE/build/app-debug.apk"
else
  rsync -a --delete "$HOST:$LANE/apps-mobile/android/app/build/test-results/testDebugUnitTest/" "$HERE/build/junit/"
  grep -h -o 'tests="[0-9]*" skipped="[0-9]*" failures="[0-9]*" errors="[0-9]*"' "$HERE/build/junit/"*.xml
fi
