#!/bin/bash
# Run only in an authorized Ubuntu image builder. Does not provision a VM.
# Base: Ubuntu 24.04 LTS amd64 or arm64 (aarch64, build host CAX), Ubuntu serial 20260926.
# One script builds either architecture; every download is pinned per architecture below.
set -euo pipefail
machine=$(uname -m)
[[ $(id -u) = 0 && ( $machine = x86_64 || $machine = aarch64 ) ]] || { echo 'An x86_64 or aarch64 root image builder is required'; exit 1; }
# Per-architecture names: node/caddy/cloudflared/docker/Claude/Codex/Grok/Kimi/OpenCode release names, the
# browser staging target and Chrome for Testing's directory name.
case $machine in
  x86_64)  node_arch=x64 caddy_arch=amd64 cloudflared_arch=amd64 docker_arch=x86_64 claude_platform=linux-x64 codex_triple=x86_64-unknown-linux-musl grok_platform=linux-x86_64 kimi_target=linux-x64 opencode_package=opencode-linux-x64-baseline browser_target=linux-x64 chrome_dir=chrome-headless-shell-linux64 ;;
  aarch64) node_arch=arm64 caddy_arch=arm64 cloudflared_arch=arm64 docker_arch=aarch64 claude_platform=linux-arm64 codex_triple=aarch64-unknown-linux-musl grok_platform=linux-aarch64 kimi_target=linux-arm64 opencode_package=opencode-linux-arm64 browser_target=linux-arm64 chrome_dir=chrome-headless-shell-linux-arm64 ;;
esac
# SHA-256 pins per architecture. Each equals the vendor's own published checksum
# (nodejs.org SHASUMS256.txt, Caddy checksums.txt [sha512 there], GitHub release asset
# digests, Anthropic's signed manifest.json, Kimi Code's release manifest.json, the npm
# registry integrity for OpenCode) except Docker and Grok, which publish none: Docker's
# pins are hashes of download.docker.com over TLS, and Grok's are hashes of x.ai/cli over
# TLS that equal the md5 Google Cloud Storage publishes for the same object.
declare -A node_sha256=([x86_64]=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6 [aarch64]=6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2)
declare -A caddy_sha256=([x86_64]=527fbf917c39189a1e3b31d34fa955601680b2d5c8055d2a87b8b9588dec7bb9 [aarch64]=52d42ae12b3462097e9868da6dfed3c9648ae12edd3b3638102312af84cb6904)
declare -A cloudflared_sha256_by_arch=([x86_64]=fcfb02b575a52ca1af2e3267af4e1517bcdeb30ac48c834c69abaed3c0576ad2 [aarch64]=7747d94570fb390cf47dcb4f9555c193c6355cda9793f0d878d9049e5d6a7790)
declare -A docker_sha256_by_arch=([x86_64]=4f798b3ee1e0140eab5bf30b0edc4e84f4cdb53255a429dc3bbae9524845d640 [aarch64]=e6b53725a73763ab3f988c73f8772eaed429754c1a579db5ff11f21990fd1817)
declare -A claude_sha256_by_arch=([x86_64]=a967e7b1d8b4e47ee421d5433027880347952b0c0857abf880e2c942a4ec93b3 [aarch64]=24caa9e6ff13bf227049a2626f1c816fc895023050f0ec3b12dbf14d897367e0)
declare -A codex_sha256_by_arch=([x86_64]=86f268d81b898f3e144c5ecff2ad2fda2c5802e042d6195b72538fe0fa125057 [aarch64]=bf3ca2719f1143b1440fbd85c149379e696c782c50ad7991f8bfcec60b2600c1)
declare -A grok_sha256_by_arch=([x86_64]=1668414b047e1050a96d25fe17dfc3efe63190fbf66d8cc1c3de8633caf50d11 [aarch64]=fc32410b6883c15a39b9f33ec04a6bfb7d070b383e5dbad7efbc48c787e5050d)
declare -A kimi_sha256_by_arch=([x86_64]=8ee7405d82958f0a50a3aab0773aba9e01057978bad93ba379eaf89e5b6111af [aarch64]=db89c9999efcd5cce0ddd87d8857c41028a50b9fa3c1297d31559b1557c14e85)
declare -A opencode_sha256_by_arch=([x86_64]=6bdf946045ebfa5773811d0037c1ca8c8a3831880434289b9e4a40c2f1fe8432 [aarch64]=8481102c5d475013302d2f4766cea02b7390e76e74c146408a8cebe2b7f6778f)
source /etc/os-release
[[ $ID = ubuntu && $VERSION_ID = 24.04 ]] || { echo 'Ubuntu 24.04 LTS is required'; exit 1; }
# The reviewed lane commit is an explicit immutable build input, never a branch.
revision=${1:?Usage: build-image.sh FULL_MURAGE_COMMIT SOURCE_CHECKOUT}
source_dir=${2:?Source checkout is required}
# Optional Cloud packaging requires an independently supplied public trust key.
# Without this input the root transport remains unconfigured and admission closed.
control_public_key=${3:-}
if [[ -n $control_public_key ]]; then
    [[ $control_public_key = /* ]] || { echo 'Public trust input must be an absolute file path'; exit 1; }
    python3 -I - "$control_public_key" <<'PY'
import base64, json, sys
with open(sys.argv[1], encoding="utf-8") as stream:
    key = json.load(stream)
assert isinstance(key, dict) and key.get("kty") == "EC" and key.get("crv") == "P-256"
assert set(key) <= {"kty", "crv", "x", "y", "kid", "use", "alg", "key_ops", "ext"} and "d" not in key
for name in ("x", "y"):
    value = key[name]
    assert isinstance(value, str) and len(value) == 43
    decoded = base64.urlsafe_b64decode(value + "=")
    assert len(decoded) == 32 and base64.urlsafe_b64encode(decoded).decode().rstrip("=") == value
PY
fi
[[ $revision =~ ^[a-f0-9]{40}$ && $(git -C "$source_dir" rev-parse HEAD) = "$revision" ]] || exit 1
[[ -z $(git -C "$source_dir" status --porcelain) ]] || { echo 'Source checkout must be clean'; exit 1; }
export DEBIAN_FRONTEND=noninteractive
# snapshot.ubuntu.com answers intermittent 5xx during outages (2026-10-14). Retry each
# fetch with backoff instead of failing the build; the pins are unchanged. Build-only:
# the file is removed below before the snapshot is taken.
printf 'Acquire::Retries "30";\nAcquire::Retries::Delay::Maximum "20";\n' > /etc/apt/apt.conf.d/99murage-build-retries
# A failed snapshot fetch only warns and exits 0, so any W:/E: line fails the build.
# Provider images point apt at their own mirrors (mirror.hetzner.com), which
# apt snapshots cannot pin; use the official archive so -S resolves.
install -d -m 0755 /etc/apt/murage-provider-sources
for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
    [[ -f $f ]] && mv "$f" /etc/apt/murage-provider-sources/
done
cat > /etc/apt/sources.list.d/ubuntu.sources <<'SOURCES'
Types: deb
URIs: http://archive.ubuntu.com/ubuntu/
Suites: noble noble-updates noble-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: http://security.ubuntu.com/ubuntu/
Suites: noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
SOURCES
if [[ $machine = aarch64 ]]; then
# arm64 is not on archive.ubuntu.com (ports.ubuntu.com serves it, and is NOT snapshotted), and
# `apt -S` also fetches the plain archive index, which 404s for arm64. snapshot.ubuntu.com/ubuntu
# carries the arm64 indexes, so the same pinned timestamp is written into the sources and the
# `-S <ts>` option is dropped (the calls below stay identical on both architectures).
cat > /etc/apt/sources.list.d/ubuntu.sources <<'SOURCES'
Types: deb
URIs: https://snapshot.ubuntu.com/ubuntu/20260930T000000Z/
Suites: noble noble-updates noble-backports noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
SOURCES
apt-get() {
    local args=()
    while (( $# )); do
        if [[ $1 = -S ]]; then shift 2; else args+=("$1"); shift; fi
    done
    command apt-get "${args[@]}"
}
fi
apt_update_log=$(apt-get -S 20260930T000000Z update 2>&1) || { printf '%s\n' "$apt_update_log"; echo 'apt-get update failed'; exit 1; }
printf '%s\n' "$apt_update_log"
# grep reads all input (no -q): under pipefail an early exit SIGPIPEs the writer,
# which would turn this refusal into a silent pass.
if printf '%s\n' "$apt_update_log" | grep -E '^[WE]:' >/dev/null; then echo 'apt-get update reported W:/E: lines; refusing to build from unpinned lists'; exit 1; fi
apt-get -S 20260930T000000Z install -y ca-certificates curl xz-utils unzip python3 sudo bubblewrap passt libseccomp-dev apparmor apparmor-utils nftables build-essential git libnss3 libatk-bridge2.0-0 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libasound2t64 libdrm2 libcups2 libxkbcommon0 libxfixes3
apt-get -S 20260930T000000Z install -y cryptsetup e2fsprogs util-linux
# ssh client for the owner's own server (docker -H ssh://...); client only, no daemon.
apt-get -S 20260930T000000Z install -y openssh-client
apt-get -S 20260930T000000Z install -y restic
# Self-service export (murage-commands): zstd + age.
apt-get -S 20260930T000000Z install -y zstd age
# Every package at the pinned snapshot, including the kernel and openssl
# (audit: the image carried 160+ fixed High CVEs from the unupgraded base).
# snapd is not used by a home and carried its own fixed Criticals: removed.
apt-get -S 20260930T000000Z -o Dpkg::Options::=--force-confold full-upgrade -y
apt-get purge -y --auto-remove snapd
rm -rf /snap /var/snap /var/lib/snapd /var/cache/snapd
if ! dpkg-query -W -f='${Status}' iproute2 2>/dev/null | grep 'install ok installed' >/dev/null; then
    apt-get -S 20260930T000000Z install -y iproute2
fi
iproute_version=$(dpkg-query -W -f='${Version}' iproute2)
dpkg --compare-versions "$iproute_version" ge 6.1.0
dpkg -L iproute2 | grep -E '^/(usr/)?s?bin/ip$' >/dev/null
stage=$(mktemp -d /tmp/murage-image.XXXXXXXX)
trap '[[ $stage == /tmp/murage-image.* ]] && rm -r -- "$stage"' EXIT
curl -fsSL "https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-$node_arch.tar.xz" -o "$stage/node.tar.xz"
printf '%s  %s\n' "${node_sha256[$machine]}" "$stage/node.tar.xz" | sha256sum -c -
tar -xJf "$stage/node.tar.xz" -C /usr/local --strip-components=1
curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v2.11.4/caddy_2.11.4_linux_$caddy_arch.tar.gz" -o "$stage/caddy.tar.gz"
printf '%s  %s\n' "${caddy_sha256[$machine]}" "$stage/caddy.tar.gz" | sha256sum -c -
tar -xzf "$stage/caddy.tar.gz" -C "$stage" caddy
install -o root -g root -m 0755 "$stage/caddy" /usr/local/bin/caddy
install -d /usr/local/share/licenses/caddy
curl -fsSL https://raw.githubusercontent.com/caddyserver/caddy/v2.11.4/LICENSE -o /usr/local/share/licenses/caddy/LICENSE
# cloudflared 2026.8.2: the SAME version and digest the desktop app pins in
# scripts/prepare-cloudflared.mjs and third_party/cloudflared/README.md (Linux x64
# release asset, which is the executable itself). A mismatch is fatal (set -e).
# The home dials out with it; no inbound port is ever opened.
cloudflared_version=2026.8.2
cloudflared_sha256=${cloudflared_sha256_by_arch[$machine]}
curl -fsSL "https://github.com/cloudflare/cloudflared/releases/download/$cloudflared_version/cloudflared-linux-$cloudflared_arch" -o "$stage/cloudflared"
printf '%s  %s\n' "$cloudflared_sha256" "$stage/cloudflared" | sha256sum -c -
install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 "$stage/cloudflared" /usr/local/libexec/murage-cloudflared
# Docker CLI 27.5.1 (static client only; the daemon and runc/containerd are not
# installed). The home drives a container on the owner's own server with it
# over ssh. Pinned digest; a mismatch is fatal (set -e).
docker_version=27.5.1
docker_sha256=${docker_sha256_by_arch[$machine]}
curl -fsSL "https://download.docker.com/linux/static/stable/$docker_arch/docker-$docker_version.tgz" -o "$stage/docker.tgz"
printf '%s  %s\n' "$docker_sha256" "$stage/docker.tgz" | sha256sum -c -
tar -xzf "$stage/docker.tgz" -C "$stage" docker/docker
install -o root -g root -m 0755 "$stage/docker/docker" /usr/local/bin/docker
install -d /usr/local/share/licenses/cloudflared
curl -fsSL "https://raw.githubusercontent.com/cloudflare/cloudflared/$cloudflared_version/LICENSE" -o /usr/local/share/licenses/cloudflared/LICENSE
getent passwd murage >/dev/null || useradd --system --create-home --home-dir /data/server-home --shell /usr/sbin/nologin murage
getent passwd murage-turn >/dev/null || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin murage-turn
getent passwd murage-browser >/dev/null || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin murage-browser
getent passwd murage-proxy >/dev/null || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin murage-proxy
getent passwd murage-egress >/dev/null || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin murage-egress
getent passwd murage-dns >/dev/null || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin murage-dns
getent passwd murage-tunnel >/dev/null || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin murage-tunnel
usermod -aG murage-turn murage
# Only turns may execute /usr/bin/bwrap (not murage, murage-proxy, murage-browser).
getent group murage-sandbox >/dev/null || groupadd --system murage-sandbox
usermod -aG murage-sandbox murage-turn
# Browsers get their own bwrap copy and AppArmor pair (browser-bwrap.apparmor):
# Chromium's sandbox needs capabilities inside its own user namespace, which
# Ubuntu's unpriv_bwrap denies. Only murage-browser may execute the copy.
getent group murage-browser-sandbox >/dev/null || groupadd --system murage-browser-sandbox
usermod -aG murage-browser-sandbox murage-browser
dpkg-statoverride --list /usr/bin/bwrap >/dev/null || dpkg-statoverride --update --add root murage-sandbox 0750 /usr/bin/bwrap
chown root:murage-sandbox /usr/bin/bwrap; chmod 0750 /usr/bin/bwrap
install -D -o root -g murage-browser-sandbox -m 0750 /usr/bin/bwrap /usr/local/libexec/murage-browser-bwrap
# One system group per cloud engine (names mirror CLOUD_ENGINES / ENGINES). No
# service user is a member; murage-turn-launch adds exactly one inside a turn.
engines=(claudeAgent codex pi antigravity grokAgent geminiAgent kimiAgent droidAgent cursorAgent customAcp fuigoAgent hermesAgent opencodeGo qwenAgent)
engine_gids=
for engine in "${engines[@]}"; do
  getent group "murage-eng-$engine" >/dev/null || groupadd --system "murage-eng-$engine"
  engine_gids+="${engine_gids:+,}\"$engine\":$(getent group "murage-eng-$engine" | cut -d: -f3)"
done
install -d -o root -g root -m 0755 /opt/murage /etc/murage-home /usr/local/libexec
# Copy the exact commit, including its lockfile and third-party notices.
git -C "$source_dir" archive "$revision" | tar -x -C /opt/murage
# The archive drops every export-ignore path in .gitattributes (maintainer notes,
# agent records, the mobile app). Every customer home gets this tree, so the
# build stops if any check-repository-custody rule (private path or private
# content) still matches under it. Runs before install: only the archive is read.
node /opt/murage/scripts/check-repository-custody.mjs --tree /opt/murage
cd /opt/murage
corepack enable
corepack prepare pnpm@10.33.0 --activate
pnpm install --frozen-lockfile
# `tsc -b` (the first step of `pnpm build`) outgrows node's default heap (about 2 GB) and dies with
# "JavaScript heap out of memory" on the documented 8 GB builder (vc2-4c-8gb; measured 2026-10-16). The
# heap is sized to the build machine: three quarters of RAM, at least 6144 MB (what built the image on
# 8 GB), at most 12288 MB; MURAGE_BUILD_HEAP_MB overrides. It is set on the build commands only, never
# exported into the image or the services. A caller that already set --max-old-space-size in NODE_OPTIONS
# (qualify/hz-live.py sizes its own builder) keeps its value.
build_ram_mb=$(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo)
[ "$build_ram_mb" -ge 7000 ] || echo "build-image: only ${build_ram_mb} MB of RAM; the build needs the documented 8 GB builder" >&2
build_heap_mb=${MURAGE_BUILD_HEAP_MB:-$((build_ram_mb * 3 / 4))}
[ "$build_heap_mb" -ge 6144 ] || build_heap_mb=6144
[ "$build_heap_mb" -le 12288 ] || build_heap_mb=12288
build_node_options=${NODE_OPTIONS:-}
[[ $build_node_options == *max-old-space-size* ]] || build_node_options="${build_node_options:+$build_node_options }--max-old-space-size=$build_heap_mb"
NODE_OPTIONS="$build_node_options" pnpm build
# The home serves this directory (MURAGE_STATIC_DIR); an image without it would have no UI.
test -f dist/index.html && test -f dist/.vite/manifest.json
NODE_OPTIONS="$build_node_options" pnpm build:server
pnpm exec esbuild server/cloud-home/supervisor.ts --bundle --platform=node --target=node24 --format=esm --packages=external --outfile=dist-server/cloud-home-supervisor.js
# Home-only pins: Chromium 154.0.8037.92 and agent-browser 0.38.1.
MURAGE_CLOUD_ROLE=home node scripts/prepare-browser.mjs --target "$browser_target"
node scripts/prepare-fuigo.mjs --target "$browser_target"
install -d resources bin
cp -a "dist-native/browser/$browser_target" resources/browser-engine
# Fuigo is the redistributable engine currently confirmed by this repository.
cp "dist-native/fuigo/$browser_target/fuigo" bin/fuigo
chmod 0755 bin/fuigo
# Sean's five Cloud engines, each a single native ELF (the launcher's manifest rule),
# pinned to an exact version with a SHA-256 per architecture (verified 2026-10-15):
#   Claude Code 2.1.292: official native binary from downloads.claude.ai; SHA-256 equals
#     platforms.<platform>.checksum in the release manifest.json, which Anthropic signs
#     with GPG key 31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE.
#   Codex 0.162.1: official musl release; SHA-256 equals the GitHub release asset digest.
#   Grok Build 1.0.52 (the `stable` channel of x.ai/cli/install.sh): the bare static
#     binary the installer downloads; no checksum is published, so the pin is the TLS
#     origin hash, cross-checked against the GCS fallback object's md5.
#   Kimi Code 2.2.0 (code.kimi.com/kimi-code/install.sh): the bare binary; SHA-256 equals
#     platforms.<target>.checksum in binaries/2.2.0/manifest.json.
#   OpenCode 1.19.0 (opencode-ai's per-platform npm package): the package tarball; its
#     sha512 equals the npm registry dist.integrity. Only package/bin/opencode is used.
#     x86_64 takes the official "baseline" glibc package (opencode-linux-x64-baseline, an
#     optionalDependency of opencode-ai 1.19.0), which runs on every x86-64 CPU, not
#     only those with AVX2; checked with --version under qemu -cpu Nehalem.
# A mismatch is fatal (set -e); no CLI is ever signed in or configured here.
claude_version=2.1.292
claude_sha256=${claude_sha256_by_arch[$machine]}
codex_version=0.162.1
codex_sha256=${codex_sha256_by_arch[$machine]}
grok_version=1.0.52
grok_sha256=${grok_sha256_by_arch[$machine]}
kimi_version=2.2.0
kimi_sha256=${kimi_sha256_by_arch[$machine]}
opencode_version=1.19.0
opencode_sha256=${opencode_sha256_by_arch[$machine]}
curl -fsSL "https://downloads.claude.ai/claude-code-releases/$claude_version/$claude_platform/claude" -o "$stage/claude"
printf '%s  %s\n' "$claude_sha256" "$stage/claude" | sha256sum -c -
install -o root -g root -m 0755 "$stage/claude" bin/claude
curl -fsSL "https://github.com/openai/codex/releases/download/rust-v$codex_version/codex-$codex_triple.tar.gz" -o "$stage/codex.tar.gz"
printf '%s  %s\n' "$codex_sha256" "$stage/codex.tar.gz" | sha256sum -c -
tar -xzf "$stage/codex.tar.gz" -C "$stage" "codex-$codex_triple"
install -o root -g root -m 0755 "$stage/codex-$codex_triple" bin/codex
curl -fsSL "https://x.ai/cli/grok-$grok_version-$grok_platform" -o "$stage/grok"
printf '%s  %s\n' "$grok_sha256" "$stage/grok" | sha256sum -c -
install -o root -g root -m 0755 "$stage/grok" bin/grok
curl -fsSL "https://code.kimi.com/kimi-code/binaries/$kimi_version/kimi-code-$kimi_target" -o "$stage/kimi"
printf '%s  %s\n' "$kimi_sha256" "$stage/kimi" | sha256sum -c -
install -o root -g root -m 0755 "$stage/kimi" bin/kimi
curl -fsSL "https://registry.npmjs.org/$opencode_package/-/$opencode_package-$opencode_version.tgz" -o "$stage/opencode.tgz"
printf '%s  %s\n' "$opencode_sha256" "$stage/opencode.tgz" | sha256sum -c -
install -d "$stage/opencode"
tar -xzf "$stage/opencode.tgz" -C "$stage/opencode" package/bin/opencode
install -o root -g root -m 0755 "$stage/opencode/package/bin/opencode" bin/opencode
# OpenCode installs a provider SDK from npm on first use unless the binary embeds it, and
# registry.npmjs.org is never on the engine allowlist. Every SDK the Go and Zen catalogues
# name is embedded in 1.19.0 (its provider table maps each to a bundled chunk); fail the
# build if a pinned binary stops embedding one, rather than ship a turn that needs npm.
for sdk in @ai-sdk/openai-compatible @ai-sdk/openai @ai-sdk/anthropic @ai-sdk/google @ai-sdk/mistral; do
  grep -aqF "\"$sdk\":()=>import(" bin/opencode || { echo "OpenCode $opencode_version does not embed $sdk" >&2; exit 1; }
done
chrome_dir=$chrome_dir python3 - <<'PY'
import hashlib, json, os
chrome_dir = os.environ["chrome_dir"]
manifest = {}
# Each entry is a single native executable (no interpreter or script), pinned by digest above.
for engine, path in [("fuigoAgent", "/opt/murage/bin/fuigo"), ("claudeAgent", "/opt/murage/bin/claude"), ("codex", "/opt/murage/bin/codex"), ("grokAgent", "/opt/murage/bin/grok"), ("kimiAgent", "/opt/murage/bin/kimi"), ("opencodeGo", "/opt/murage/bin/opencode")]:
    with open(path, "rb") as stream:
        manifest[engine] = [{"path": path, "sha256": hashlib.file_digest(stream, "sha256").hexdigest()}]
# The MCP proxies a Cloud turn's rendered config may start (the launcher's MCP_PROXIES):
# node plus one of these bundled scripts, each pinned by digest like an engine binary.
manifest["mcpProxies"] = []
for relative in ["permission-proxy", "drivers/agents-proxy", "drivers/memory-proxy", "drivers/phone-proxy", "drivers/unified-browser-proxy", "computer-proxy",
                 "drivers/host-computer-proxy", "drivers/dweb-proxy", "connector-proxy", "drivers/remote-mcp-proxy", "cloud-home/vps-relay-mcp"]:
    path = "/opt/murage/dist-server/" + relative + ".js"
    with open(path, "rb") as stream:
        manifest["mcpProxies"].append({"path": path, "sha256": hashlib.file_digest(stream, "sha256").hexdigest()})
# The saved-browser-session step the launcher runs as the browser user (browser-restore modes): node plus
# this one bundled script, pinned by digest like a proxy.
path = "/opt/murage/dist-server/browser-restore-cli.js"
with open(path, "rb") as stream:
    manifest["browserRestore"] = [{"path": path, "sha256": hashlib.file_digest(stream, "sha256").hexdigest()}]
manifest["browser"] = []
for path in ["/opt/murage/resources/browser-engine/agent-browser", "/opt/murage/resources/browser-engine/chrome/%s/chrome-headless-shell" % chrome_dir]:
    with open(path, "rb") as stream:
        manifest["browser"].append({"path": path, "sha256": hashlib.file_digest(stream, "sha256").hexdigest()})
path = "/opt/murage/engine-manifest.json"
with open(path, "w", encoding="utf-8") as stream:
    json.dump(manifest, stream, sort_keys=True)
os.chown(path, 0, 0)
os.chmod(path, 0o644)
PY
printf '%s\n' "$revision" > /etc/murage-home/source-commit
printf '{"uid":%s,"gid":%s,"turnGid":%s,"proxyUid":%s,"proxyGid":%s,"engineGids":{%s}}\n' "$(id -u murage)" "$(id -g murage)" "$(id -g murage-turn)" "$(id -u murage-proxy)" "$(id -g murage-proxy)" "$engine_gids" > /etc/murage-home/identity.json
chmod 0600 /etc/murage-home/identity.json
install -m 0755 deploy/cloud-home/murage-turn-launch.py /usr/local/libexec/murage-turn-launch
install -o root -g root -m 0755 deploy/cloud-home/murage-browser-namespace.py /usr/local/libexec/murage-browser-namespace
install -o root -g root -m 0755 deploy/cloud-home/murage-browser-network.py /usr/local/libexec/murage-browser-network
# Per-engine outbound allowlist for turns (SNI proxy); the allowlist is root-owned
# and read-only to the proxy, and a malformed file keeps the proxy from starting.
install -o root -g root -m 0755 deploy/cloud-home/murage-egress-proxy.py /usr/local/libexec/murage-egress-proxy
install -o root -g root -m 0755 deploy/cloud-home/murage-miner-watch.py /usr/local/libexec/murage-miner-watch
install -o root -g root -m 0755 deploy/cloud-home/murage-backup-authorize /usr/local/libexec/murage-backup-authorize
install -o root -g root -m 0755 deploy/cloud-home/murage-scrub-userdata /usr/local/libexec/murage-scrub-userdata
install -m 0644 deploy/cloud-home/murage-backup-authorize.service /etc/systemd/system/murage-backup-authorize.service
install -m 0644 deploy/cloud-home/murage-scrub-userdata.path /etc/systemd/system/
install -m 0644 deploy/cloud-home/murage-scrub-userdata.service /etc/systemd/system/murage-scrub-userdata.service
install -d -o root -g root -m 0755 /etc/murage
install -o root -g root -m 0644 deploy/cloud-home/egress-allow.json /etc/murage/egress-allow.json
printf '%s\n' "$iproute_version" > /etc/murage-home/iproute2-version
chmod 0644 /etc/murage-home/iproute2-version
install -m 0440 deploy/cloud-home/murage-turn.sudoers /etc/sudoers.d/murage-turn
visudo -cf /etc/sudoers.d/murage-turn
cc -std=c11 -O2 -Wall -Wextra -Werror deploy/cloud-home/murage-seccomp.c -lseccomp -o "$stage/murage-seccomp"
"$stage/murage-seccomp" "$stage/murage-seccomp.bpf"
install -o root -g root -m 0644 "$stage/murage-seccomp.bpf" /usr/local/libexec/murage-seccomp.bpf
# Chromium's user namespace now comes from the murage-browser profile pair
# (browser-bwrap.apparmor); a path-attached chromium profile would deny it network.
rm -f /etc/apparmor.d/murage-chromium
# Replaces Ubuntu's stock profile of the same name; no second /usr/bin/bwrap attachment.
rm -f /etc/apparmor.d/murage-bwrap
install -m 0644 deploy/cloud-home/bwrap.apparmor /etc/apparmor.d/bwrap-userns-restrict
apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
install -m 0644 deploy/cloud-home/browser-bwrap.apparmor /etc/apparmor.d/murage-browser-bwrap
apparmor_parser -r /etc/apparmor.d/murage-browser-bwrap
# Noble confines /usr/bin/passt only; pasta gets its own profile built on
# Ubuntu's abstractions/pasta (turns attach pasta to their netns).
test -f /etc/apparmor.d/abstractions/pasta
install -m 0644 deploy/cloud-home/pasta.apparmor /etc/apparmor.d/murage-pasta
apparmor_parser -r /etc/apparmor.d/murage-pasta
install -m 0644 deploy/cloud-home/Caddyfile /etc/murage-home/Caddyfile
install -m 0644 deploy/cloud-home/murage-home.service /etc/systemd/system/murage-home.service
install -m 0644 deploy/cloud-home/murage-turns.slice /etc/systemd/system/murage-turns.slice
install -m 0644 deploy/cloud-home/murage-browsers.slice /etc/systemd/system/murage-browsers.slice
install -m 0644 deploy/cloud-home/murage-proxy.service /etc/systemd/system/murage-proxy.service
install -m 0644 deploy/cloud-home/murage-egress-proxy.service /etc/systemd/system/murage-egress-proxy.service
install -m 0644 deploy/cloud-home/murage-egress-dns.service /etc/systemd/system/murage-egress-dns.service
install -m 0644 deploy/cloud-home/murage-miner-watch.service /etc/systemd/system/murage-miner-watch.service
install -m 0644 deploy/cloud-home/murage-tunnel.service /etc/systemd/system/murage-tunnel.service
install -m 0644 deploy/cloud-home/murage-tunnel-token.service /etc/systemd/system/murage-tunnel-token.service
install -m 0644 deploy/cloud-home/murage-egress.nft /etc/murage-home/murage-egress.nft
install -d -m 0755 /etc/systemd/journald.conf.d
install -m 0644 deploy/cloud-home/murage-journald.conf /etc/systemd/journald.conf.d/murage.conf
# Apply now, so the rest of the build (and its shutdown) never writes /var/log/journal.
systemctl restart systemd-journald
# rsyslog would still copy kernel messages (nft logs) to /var/log on the
# unencrypted root disk; masked rather than purged so no metapackage goes.
systemctl disable rsyslog.service syslog.socket >/dev/null 2>&1 || true
systemctl mask rsyslog.service >/dev/null 2>&1 || true
# Browser veth pairs are network hotplug events; cloud-init's hotplug hook then
# runs, fails ("Failed to detect ... in updated metadata") and leaves a failed
# unit. A home never hot-plugs a real NIC, so the hook is off.
systemctl mask cloud-init-hotplugd.socket cloud-init-hotplugd.service >/dev/null 2>&1 || true
# Ubuntu's daily unattended upgrade runs needrestart, which restarts every service
# using an upgraded library. On a soak home that restarted murage-control (and the
# soak) seven times in three minutes. Security updates stay automatic; Murage's own
# units are never restarted by it (they pick the update up on the next planned
# restart), and needrestart only lists what it would have done.
install -d -m 0755 /etc/needrestart/conf.d
cat > /etc/needrestart/conf.d/50-murage.conf <<'NEEDRESTART'
$nrconf{restart} = 'l';
$nrconf{override_rc}{qr(^murage-)} = 0;
$nrconf{override_rc}{qr(^mcq-)} = 0;
$nrconf{override_rc}{qr(^cloudflared)} = 0;
NEEDRESTART
chmod 0644 /etc/needrestart/conf.d/50-murage.conf
rm -rf /var/log/journal/* /var/log/syslog* /var/log/kern.log* /var/log/auth.log* 2>/dev/null || true
install -m 0644 deploy/cloud-home/murage-egress.service /etc/systemd/system/murage-egress.service
install -m 0644 deploy/cloud-home/data.mount /etc/systemd/system/data.mount
install -m 0644 deploy/cloud-home/murage-volume.service /etc/systemd/system/murage-volume.service
install -m 0644 deploy/cloud-home/murage-home-recover.service /etc/systemd/system/murage-home-recover.service
install -m 0644 deploy/cloud-home/murage-home-recover.timer /etc/systemd/system/murage-home-recover.timer
install -m 0755 deploy/cloud-home/murage-backup /usr/local/libexec/murage-backup
install -m 0644 deploy/cloud-home/backup-excludes.txt /etc/murage-home/backup-excludes.txt
install -m 0644 deploy/cloud-home/murage-backup.service /etc/systemd/system/murage-backup.service
install -m 0644 deploy/cloud-home/murage-backup.timer /etc/systemd/system/murage-backup.timer
# 1.0.9 Sentinel: a separate, non-root, network-less observer of /data/home/health only (docs/sentinel.md).
install -m 0755 deploy/cloud-home/murage-sentinel-descriptor.mjs /usr/local/libexec/murage-sentinel-descriptor.mjs
install -m 0644 deploy/cloud-home/murage-sentinel.service /etc/systemd/system/murage-sentinel.service
install -m 0644 deploy/cloud-home/murage-sentinel.timer /etc/systemd/system/murage-sentinel.timer
install -m 0755 deploy/cloud-home/start-home.sh /usr/local/libexec/murage-home-start
install -m 0755 deploy/cloud-home/murage-enroll /usr/local/libexec/murage-enroll
cc -std=c11 -O2 -Wall -Wextra -Werror deploy/cloud-home/murage-clock.c -o "$stage/murage-clock"
install -o root -g root -m 0755 "$stage/murage-clock" /usr/local/libexec/murage-clock
install -o root -g root -m 0755 deploy/cloud-home/murage-control /usr/local/libexec/murage-control
install -m 0644 deploy/cloud-home/murage-control.service /etc/systemd/system/murage-control.service
install -o root -g root -m 0755 deploy/cloud-home/murage-commands /usr/local/libexec/murage-commands
install -m 0644 deploy/cloud-home/murage-commands.service /etc/systemd/system/murage-commands.service
install -d -o root -g root -m 0700 /var/cache/restic
if [[ -n $control_public_key ]]; then
    install -o root -g root -m 0644 "$control_public_key" /etc/murage-home/control-plane-public-key.json
fi
# Optional signed release channel for "Update my Cloud" (murage-commands update_software). Without both
# inputs the home answers an update with "unsupported". The key is an Ed25519 public key (PEM).
if [[ -n ${MURAGE_RELEASE_CHANNEL_URL:-} || -n ${MURAGE_RELEASE_PUBLIC_KEY:-} ]]; then
    [[ $MURAGE_RELEASE_CHANNEL_URL =~ ^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._/-]*)?$ && $MURAGE_RELEASE_PUBLIC_KEY = /* ]] || { echo 'Release channel needs an https URL and an absolute key path'; exit 1; }
    openssl pkey -pubin -in "$MURAGE_RELEASE_PUBLIC_KEY" -noout -text | grep '^ED25519 Public-Key' >/dev/null || { echo 'Release key must be an Ed25519 public key'; exit 1; }
    install -o root -g root -m 0644 "$MURAGE_RELEASE_PUBLIC_KEY" /etc/murage-home/release-public-key.pem
    printf '{"channelUrl":"%s"}\n' "$MURAGE_RELEASE_CHANNEL_URL" > /etc/murage-home/release.json
    chmod 0644 /etc/murage-home/release.json
fi
install -d -o root -g root -m 0755 /etc/claude-code /etc/codex /etc/grok /etc/fuigo
install -o root -g root -m 0644 deploy/cloud-home/managed/claude-settings.json /etc/claude-code/managed-settings.json
install -o root -g root -m 0644 deploy/cloud-home/managed/codex-requirements.toml /etc/codex/requirements.toml
install -o root -g root -m 0644 deploy/cloud-home/managed/grok-requirements.toml /etc/grok/requirements.toml
# Fuigo's root-owned system tiers (highest authority): plugin discovery, the leader and the
# Claude import are off whatever a writable tier says (CLOUD-ENGINES-DESIGN.md r2 R2/R3).
install -o root -g root -m 0644 deploy/cloud-home/managed/fuigo-requirements.toml /etc/fuigo/requirements.toml
install -o root -g root -m 0644 deploy/cloud-home/managed/fuigo-managed_config.toml /etc/fuigo/managed_config.toml
# SPDX metadata belongs to our source file, not the vendor settings schema.
python3 - <<'PY'
import json
path = "/etc/claude-code/managed-settings.json"
with open(path, encoding="utf-8") as stream:
    settings = json.load(stream)
settings.pop("_license", None)
with open(path, "w", encoding="utf-8") as stream:
    json.dump(settings, stream, sort_keys=True)
PY
printf 'kernel.yama.ptrace_scope = 2\n' > /etc/sysctl.d/60-murage-home.conf
# inotify limits are per uid and every turn runs as murage-turn, so concurrent
# engines (file watchers, dev servers, language servers) share one budget. The
# kernel defaults (128 instances, ~8k-65k watches) starve them. 2048 instances
# and 524288 watches cost at most ~270 MB of unswappable kernel memory (about
# 540 bytes per watch), far below a home's RAM, and cover 14 engines at once.
install -d -m 0755 /etc/sysctl.d
printf 'fs.inotify.max_user_instances = 2048\nfs.inotify.max_user_watches = 524288\n' > /etc/sysctl.d/61-murage-inotify.conf
# A VM image, not a container. proc restrictions apply to all service processes.
if ! grep -q '^proc /proc proc .*hidepid=2' /etc/fstab; then printf 'proc /proc proc defaults,hidepid=2 0 0\n' >> /etc/fstab; fi
chown -R root:root /opt/murage
chmod -R go-w /opt/murage
test "$(stat -c %U /opt/murage/dist)" = root && test -f /opt/murage/dist/index.html
systemctl daemon-reload
systemctl enable data.mount murage-egress.service
systemctl enable murage-volume.service
# Enabled so every boot after enrollment brings the home back by itself (a real
# CX23/CPX home rebooted with egress, home and proxy all inactive). The gate is
# the dependency chain: home/proxy Require data.mount, which Requires
# murage-volume, which unlocks only for an enrolled machine. Before enrollment
# they fail on that dependency and nothing listens.
systemctl enable murage-home.service murage-proxy.service murage-egress-proxy.service murage-egress-dns.service
# A transient volume-unlock failure (CP 5xx, network not up) fails the oneshot and
# strands home/proxy; the timer restarts them, except after terminal exit 78.
systemctl enable murage-home-recover.timer
# Abuse control: alerts and flags sustained CPU on processes outside our engine list. Never kills.
systemctl enable murage-miner-watch.service
# Nightly encrypted backup of /data (restic over SFTP). Inert until /etc/murage-home/backup.json exists.
systemctl enable murage-backup.timer
systemctl enable murage-sentinel.timer
systemctl enable murage-commands.service
# First boot: install the backup public key on the Storage Box, then destroy every on-disk copy of the cloud-init
# user-data (it carried the enrollment token and backup credentials; the metadata service is also root-only in nft).
systemctl enable murage-backup-authorize.service murage-scrub-userdata.path
# The tunnel is the home's only way to the internet's users. The token service
# fetches the connector token every boot and starts murage-tunnel.service; the
# tunnel unit itself is deliberately not enabled (it must not start without one).
systemctl enable murage-tunnel-token.service
# >>> boot ordering gate (server/cloud-home/unit-order.test.ts runs this block)
# A cycle makes systemd delete one job of it at boot, a different one on different boots (a cycle through
# cloud-final.service once dropped cloud-init runcmd). verify enqueues each unit's start job like boot does. Its exit 1
# also covers unrelated unit warnings, so only its cycle lines fail the build; any other non-zero exit (126/127: not
# runnable, 128+: killed) means it did not verify and fails the build too.
order_rc=0
order_log=$(systemd-analyze verify --man=no default.target multi-user.target cloud-final.service $(cd /etc/systemd/system && ls murage-*.service murage-*.timer murage-*.path data.mount) 2>&1) || order_rc=$?
if [ "$order_rc" -gt 1 ]; then printf '%s\n' "$order_log"; echo "systemd-analyze verify did not run (exit $order_rc); refusing to build"; exit 1; fi
if printf '%s\n' "$order_log" | grep -Ei 'ordering cycle|order is cyclic|break ordering'; then echo 'systemd ordering cycle in the image units; refusing to build'; exit 1; fi
# verify runs without generators, so it never sees the multi-user.target.wants/cloud-init.target link that cloud-init's
# generator makes at boot, and cannot see a cycle through cloud-final.service. unit-order-check.py emulates that
# generator and models the same ordering rules: it is the gate that fails on such a cycle. Any non-zero exit fails,
# including 2 (load error) and 127 (no python3).
python3 -I deploy/cloud-home/qualify/unit-order-check.py --root / || { echo 'boot ordering cycle in the image units; refusing to build'; exit 1; }
# <<< boot ordering gate
if [[ $machine = aarch64 ]]; then
# The pinned snapshot was only for building. A running home keeps receiving security
# updates from the live arm64 archive, as the x86 image does from archive.ubuntu.com.
cat > /etc/apt/sources.list.d/ubuntu.sources <<'SOURCES'
Types: deb
URIs: http://ports.ubuntu.com/ubuntu-ports/
Suites: noble noble-updates noble-backports noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
SOURCES
fi
rm -f /etc/apt/apt.conf.d/99murage-build-retries
