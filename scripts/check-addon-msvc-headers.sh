#!/bin/sh
# Compile-checks every native/engine-exclusion/*.c against the REAL Windows SDK + MSVC CRT headers on Linux (clang in cl mode with the
# headers fetched by xwin, https://github.com/Jake-Shadle/xwin). Catches what mingw accepts and MSVC rejects (e.g. C2371 from
# <winternl.h> with <ntsecapi.h> in one file). Compile only, /W4, no link.
# Usage: scripts/check-addon-msvc-headers.sh <xwin splat dir> [node include dir]   (splat dir holds crt/ and sdk/)
set -eu
X=${1:?xwin splat output directory}; N=${2:-/usr/include/node}
D=$(cd "$(dirname "$0")/../native/engine-exclusion" && pwd); rc=0; O=$(mktemp -d)
for f in "$D"/*.c; do
  if clang --driver-mode=cl --target=x86_64-pc-windows-msvc /c /W4 /nologo -DNAPI_VERSION=9 \
      -imsvc "$N" -imsvc "$X/crt/include" -imsvc "$X/sdk/include/ucrt" -imsvc "$X/sdk/include/um" -imsvc "$X/sdk/include/shared" \
      "/I$D" "/Fo$O/x.obj" "$f"; then echo "OK $(basename "$f")"; else echo "FAILED $(basename "$f")"; rc=1; fi
done
rm -rf "$O"; exit $rc
