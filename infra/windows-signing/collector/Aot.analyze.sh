#!/usr/bin/env bash
# Linux pre-CI gate: runs the NativeAOT/trim analyzers (IL2026/IL3050 etc., warnings as errors) on the real
# WitnessCollector.csproj with the pinned SDK and the locked restore, so these errors surface before the Windows job.
# Usage: Aot.analyze.sh <repo-root> <dotnet-sdk-10.0.115-linux-x64.tar.gz>   (needs docker + network for the locked restore only)
set -euo pipefail
root=$(cd "${1:?repo root}" && pwd)
sdk=$(cd "$(dirname "${2:?sdk tarball}")" && pwd)/$(basename "$2")
pinned=01bf048cf0495a7ce76be07b9623d385c9d9f172237d0267ded25c31f4b19604d74f1d328d0ee5fe6bcfb23cb20c41fb072c9b84fce6582c20edb1e3d93ea012
got=$(sha512sum "$sdk" | cut -d' ' -f1)
[ "$got" = "$pinned" ] || { echo "AOT_ANALYZE_FAIL sdk tarball sha512 mismatch" >&2; exit 2; }
name="qs-aot-analyze-$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
systemd-run --scope -q docker run --name "$name" --rm \
  -v "$root/infra/windows-signing:/src/infra/windows-signing:ro" \
  -v "$root/scripts/windows-signing-witness:/src/scripts/windows-signing-witness:ro" \
  -v "$sdk:/sdk.tar.gz:ro" \
  -e DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 -e DOTNET_CLI_TELEMETRY_OPTOUT=1 -e DOTNET_NOLOGO=1 \
  mcr.microsoft.com/dotnet/sdk:10.0-noble bash -euc '
    mkdir /dotnet && tar -xzf /sdk.tar.gz -C /dotnet && export DOTNET_ROOT=/dotnet PATH=/dotnet:$PATH
    cp -r /src /w && cd /w/infra/windows-signing/collector
    [ "$(dotnet --version)" = 10.0.115 ]
    dotnet restore WitnessCollector.csproj --locked-mode -p:EnableWindowsTargeting=true -p:EnableTrimAnalyzer=true -p:EnableAotAnalyzer=true -p:IsAotCompatible=true
    dotnet build WitnessCollector.csproj --no-restore -warnaserror -p:EnableWindowsTargeting=true -p:EnableTrimAnalyzer=true -p:EnableAotAnalyzer=true -p:IsAotCompatible=true
  '
echo AOT_ANALYZE_OK
