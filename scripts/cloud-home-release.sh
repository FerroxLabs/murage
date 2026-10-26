#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Producer of the signed Cloud home release that `murage-commands update_software` installs (Lane G).
#
# The bundle is exactly the release tree deploy/cloud-home/build-image.sh produced for one revision (git archive of that revision
# plus the build). The manifest (v3) signs the archive AND the canonical tree digest (treeSha256, the home's seal walk) and names the
# launcher ABI the tree's deploy/cloud-home/launchers.txt declares: the home installs the tree into its idle slot only when the digest
# matches and refuses a release whose launcher ABI is not its image's (the root launchers are image-pinned, LANE-G r3).
# The same <arch>/manifest.json + manifest.json.sig pair is what build-image.sh consumes for a signed slot A (MURAGE_RELEASE_MANIFEST,
# MURAGE_RELEASE_MANIFEST_SIG) when the image is built from this very tree.
#
# Two steps run here, on the builder, and neither ever holds the private key (the key never leaves the Mac; scripts/cloud-home-sign.sh
# is the third step and the only one that touches it):
#   PREPARE   cloud-home-release.sh prepare ARCH REVISION SOURCE_CHECKOUT BUILT_TREE SEQUENCE OUT_DIR
#             Builds the archive and the canonical treeSha256 and writes OUT_DIR/<arch>/manifest.json (unsigned) with the archive.
#   FINALIZE  cloud-home-release.sh finalize ARCH REVISION OUT_DIR PUBLIC_KEY
#             After the Mac signed OUT_DIR/<arch>/manifest.json into manifest.json.sig: verifies that signature with the public key and
#             runs the home's own checks (verify_manifest, safe_extract, launcher ABI, tree digest) on the published bytes.
#   ARCH             x86_64 or aarch64, always explicit (never uname: the Mac is arm64). It is cross-checked against the tree: every ELF
#                    under BUILT_TREE/bin and bin/fuigo itself must be that architecture.
#   REVISION         full 40-hex commit the tree was built from
#   SOURCE_CHECKOUT  a git checkout that has REVISION (the tree's deploy files are compared with it, byte for byte)
#   BUILT_TREE       a copy of the image's /opt/murage-releases/A (stage 1 of build-image.sh), built on the architecture it will run on
#   SEQUENCE         positive integer, strictly above every release already published (homes never take a lower one)
#   OUT_DIR          receives <arch>/manifest.json, <arch>/manifest.json.sig (after signing) and <arch>/murage-cloud-home-<SEQUENCE>.tar.gz
# The same <arch>/manifest.json + manifest.json.sig pair is what build-image.sh stage 2 consumes (MURAGE_RELEASE_MANIFEST,
# MURAGE_RELEASE_MANIFEST_SIG) when the image is built from this very tree.
# Trust: every program that runs here (this script, murage-commands' parse_manifest/verify_manifest/safe_extract, install-launchers.py's
# plan) comes from the checkout this script lives in, never from REVISION, the tree or the archive being produced. The payload is only read
# as data (hashed, listed, extracted by safe_extract, which executes nothing).
set -euo pipefail
# Never let a python helper write __pycache__ into the source checkout (it dirties it and the stage 2 clean-checkout test refuses).
export PYTHONDONTWRITEBYTECODE=1
umask 077

mode=${1:?Usage: cloud-home-release.sh prepare ARCH REVISION SOURCE_CHECKOUT BUILT_TREE SEQUENCE OUT_DIR | finalize ARCH REVISION OUT_DIR PUBLIC_KEY}
shift
# The trusted tooling: the checkout this script is part of.
trusted=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
trusted_commands=$trusted/deploy/cloud-home/murage-commands
trusted_installer=$trusted/deploy/cloud-home/install-launchers.py
[[ -f $trusted_commands && -f $trusted_installer ]] || { echo 'Trusted tooling not found next to this script'; exit 1; }
# This script holds no key and takes none: a signing key in the environment is a mistake, not an input.
[[ -z ${MURAGE_RELEASE_SIGNING_KEY:-} ]] || { echo 'MURAGE_RELEASE_SIGNING_KEY must not be set here; the key is only used by scripts/cloud-home-sign.sh on the signing host'; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# e_machine of an ELF file (little endian): 0x3e x86_64, 0xb7 aarch64. Anything else, or not an ELF at all, prints "other".
elf_arch() {
    local head
    head=$(head -c 20 "$1" | od -An -tx1 | tr -d ' \n')
    [[ $head == 7f454c46??01* ]] || { echo other; return; }
    case ${head:36:4} in
      3e00) echo x86_64 ;;
      b700) echo aarch64 ;;
      *) echo other ;;
    esac
}

if [[ $mode = prepare ]]; then
arch=${1:?ARCH is required (x86_64 or aarch64)}
revision=${2:?REVISION is required}
source_dir=${3:?Source checkout is required}
tree=${4:?Built tree is required}
sequence=${5:?Sequence is required}
out_dir=${6:?Output directory is required}
[[ $arch = x86_64 || $arch = aarch64 ]] || { echo "ARCH must be x86_64 or aarch64, not '$arch'"; exit 1; }
[[ $revision =~ ^[0-9a-f]{40}$ ]] || { echo 'REVISION must be a full 40-hex commit'; exit 1; }
[[ $sequence =~ ^[1-9][0-9]{0,8}$ ]] || { echo 'SEQUENCE must be a positive integer'; exit 1; }
[[ -d $tree && ! -L $tree ]] || { echo 'BUILT_TREE must be a directory'; exit 1; }
[[ $(git -C "$source_dir" rev-parse --verify --quiet "$revision^{commit}") = "$revision" ]] || { echo 'REVISION is not a commit of SOURCE_CHECKOUT'; exit 1; }

# ARCH is the operator's word; the tree is the evidence. Every native binary in the tree must be that architecture, and bin/fuigo
# (installed by every image build) must exist and be one.
[[ -f $tree/bin/fuigo && ! -L $tree/bin/fuigo ]] || { echo 'BUILT_TREE lacks bin/fuigo (cannot confirm its architecture)'; exit 1; }
while IFS= read -r -d '' binary; do
    found=$(elf_arch "$binary")
    [[ $found = "$arch" || $found = other ]] || { echo "BUILT_TREE ${binary#"$tree"/} is $found, not $arch"; exit 1; }
done < <(find "$tree/bin" -maxdepth 1 -type f -print0)
[[ $(elf_arch "$tree/bin/fuigo") = "$arch" ]] || { echo "BUILT_TREE bin/fuigo is not a $arch ELF: ARCH does not match the tree"; exit 1; }

# The tree must be the one this revision builds: the home-side files it will install are identical to the revision's (compared as
# bytes; nothing from the revision or the tree is executed).
for required in dist-server/cloud-home-supervisor.js dist-server/index.js; do
    [[ -f $tree/$required ]] || { echo "BUILT_TREE lacks $required"; exit 1; }
done
launcher_files=$(python3 -I -B - "$trusted_installer" "$tree/deploy/cloud-home" <<'PY'
import importlib.machinery, importlib.util, sys
loader = importlib.machinery.SourceFileLoader("il", sys.argv[1])
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)
try:
    entries = module.plan(sys.argv[2])
except module.LauncherError as error:
    sys.exit("BUILT_TREE launchers refused: " + error.code)
print("\n".join(["launchers.txt", "launcher-abi", "install-launchers.py", "murage-home-launch.py"] + [source for source, _name, _mode in entries]))
PY
)
while IFS= read -r file; do
    in_tree=$(sha256sum "$tree/deploy/cloud-home/$file" | cut -d' ' -f1)
    in_revision=$(git -C "$source_dir" show "$revision:deploy/cloud-home/$file" | sha256sum | cut -d' ' -f1)
    [[ $in_tree = "$in_revision" ]] || { echo "BUILT_TREE deploy/cloud-home/$file is not the one in $revision"; exit 1; }
done <<< "$launcher_files"

archive_name="murage-cloud-home-$sequence.tar.gz"
commit_time=$(git -C "$source_dir" show -s --format=%ct "$revision")
# Regular files, directories and in-tree links only; hard links are written as copies (the home refuses link entries it cannot place).
# File names reach tar NUL-separated and verbatim (--null --verbatim-files-from): a name such as --checkpoint-action=exec=... is
# archived as data and can never be read as a tar option.
(cd "$tree" && find . -mindepth 1 -printf '%P\0' | LC_ALL=C sort -z) \
  | tar -C "$tree" --no-recursion --null --verbatim-files-from --owner=0 --group=0 --numeric-owner --hard-dereference --mtime="@$commit_time" -T - -cf - \
  | gzip -n -9 > "$work/$archive_name"
bytes=$(stat -c %s "$work/$archive_name")
digest=$(sha256sum "$work/$archive_name" | cut -d' ' -f1)
# The launcher sources in the tree carry their manifest modes (install-launchers.py apply_modes), exactly as the home sets them after
# safe_extract and as build-image.sh sets them in slot A, so the three digests (producer, image, home) are one. Then the tree digest,
# from the trusted checkout's own code.
python3 -I -B - "$trusted_installer" "$tree" <<'PY'
import importlib.machinery, importlib.util, os, sys
loader = importlib.machinery.SourceFileLoader("il", sys.argv[1])
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)
module.apply_modes(sys.argv[2], module.plan(os.path.join(sys.argv[2], "deploy", "cloud-home")))
PY
tree_sha256=$(python3 -I -B - "$trusted_commands" "$tree" <<'PY'
import importlib.machinery, importlib.util, os, sys
loader = importlib.machinery.SourceFileLoader("mc", sys.argv[1])
spec = importlib.util.spec_from_loader(loader.name, loader)
home = importlib.util.module_from_spec(spec)
loader.exec_module(home)
fd = os.open(sys.argv[2], home.SLOT_OPEN)
try:
    print(home.seal_walk_digest(fd, False))
finally:
    os.close(fd)
PY
)
launcher_abi=$(python3 -I -B - "$trusted_installer" "$tree/deploy/cloud-home" <<'PY'
import importlib.machinery, importlib.util, sys
loader = importlib.machinery.SourceFileLoader("il", sys.argv[1])
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)
print(module.abi(sys.argv[2]))
PY
)
[[ $tree_sha256 =~ ^[0-9a-f]{64}$ && $launcher_abi =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || { echo 'Tree digest or launcher ABI unavailable'; exit 1; }
printf '{"format":"murage-cloud-home-release-v3","sequence":%s,"revision":"%s","arch":"%s","archive":"%s","bytes":%s,"sha256":"%s","treeSha256":"%s","launcherAbi":"%s"}' \
  "$sequence" "$revision" "$arch" "$archive_name" "$bytes" "$digest" "$tree_sha256" "$launcher_abi" > "$work/manifest.json"
[[ $tree_sha256 =~ ^[0-9a-f]{64}$ && $launcher_abi =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || { echo 'Tree digest or launcher ABI unavailable'; exit 1; }
printf '{"format":"murage-cloud-home-release-v3","sequence":%s,"revision":"%s","arch":"%s","archive":"%s","bytes":%s,"sha256":"%s","treeSha256":"%s","launcherAbi":"%s"}' \
  "$sequence" "$revision" "$arch" "$archive_name" "$bytes" "$digest" "$tree_sha256" "$launcher_abi" > "$work/manifest.json"

# The home's own checks, all but the signature (none exists yet), from the trusted checkout's murage-commands.
python3 -I -B - "$work" "$archive_name" "$trusted_commands" "$trusted_installer" "$arch" <<'PY'
import importlib.machinery, importlib.util, os, sys
work, archive, trusted_commands, trusted_installer, arch = sys.argv[1:6]
loader = importlib.machinery.SourceFileLoader("mc", trusted_commands)
spec = importlib.util.spec_from_loader(loader.name, loader)
home = importlib.util.module_from_spec(spec)
loader.exec_module(home)
raw = open(os.path.join(work, "manifest.json"), "rb").read()
manifest = home.parse_manifest(raw, arch)
home.safe_extract(os.path.join(work, archive), os.path.join(work, "check"))
for required in ("dist-server/cloud-home-supervisor.js", "dist-server/index.js", "deploy/cloud-home/launchers.txt"):
    assert os.path.isfile(os.path.join(work, "check", required)), required
loader = importlib.machinery.SourceFileLoader("il", trusted_installer)
spec = importlib.util.spec_from_loader(loader.name, loader)
installer = importlib.util.module_from_spec(spec)
loader.exec_module(installer)
entries = installer.plan(os.path.join(work, "check", "deploy", "cloud-home"))
installer.apply_modes(os.path.join(work, "check"), entries)
installer.check_abi(os.path.join(work, "check"), manifest["launcherAbi"])
fd = os.open(os.path.join(work, "check"), home.SLOT_OPEN)
try:
    assert home.seal_walk_digest(fd, False) == manifest["treeSha256"], "the extracted tree's digest is not the manifest's treeSha256"
finally:
    os.close(fd)
PY

install -d -m 0755 "$out_dir/$arch"
# A signature that is not over these bytes must never sit beside them.
rm -f "$out_dir/$arch/manifest.json.sig"
install -m 0644 "$work/$archive_name" "$work/manifest.json" "$out_dir/$arch/"
cmp -s "$work/manifest.json" "$out_dir/$arch/manifest.json" || { echo 'Prepared manifest differs from the one checked'; exit 1; }
[[ $(stat -c %s "$out_dir/$arch/$archive_name") = "$bytes" && $(sha256sum "$out_dir/$arch/$archive_name" | cut -d' ' -f1) = "$digest" ]] \
  || { echo 'Prepared archive is not the one the manifest names'; exit 1; }
echo "Prepared release $sequence ($revision, $arch): $bytes bytes, sha256 $digest, treeSha256 $tree_sha256, launcherAbi $launcher_abi"
echo "Next: copy $out_dir/$arch/manifest.json to the signing Mac and run scripts/cloud-home-sign.sh MANIFEST $revision $arch $sequence; copy manifest.json.sig back beside it, then cloud-home-release.sh finalize."

elif [[ $mode = finalize ]]; then
arch=${1:?ARCH is required (x86_64 or aarch64)}
revision=${2:?REVISION is required}
out_dir=${3:?Output directory is required}
public_key=${4:?PUBLIC_KEY (the release public key, PEM) is required}
[[ $arch = x86_64 || $arch = aarch64 ]] || { echo "ARCH must be x86_64 or aarch64, not '$arch'"; exit 1; }
[[ $revision =~ ^[0-9a-f]{40}$ ]] || { echo 'REVISION must be a full 40-hex commit'; exit 1; }
published=$out_dir/$arch
[[ -f $public_key && -f $published/manifest.json && -f $published/manifest.json.sig ]] || { echo 'PUBLIC_KEY, manifest.json and manifest.json.sig are all required'; exit 1; }
openssl pkey -pubin -in "$public_key" -noout -text | grep '^ED25519 Public-Key' >/dev/null || { echo 'PUBLIC_KEY must be an Ed25519 public key'; exit 1; }
# Work on a private copy of the published files, so what is checked cannot change underneath the check.
archive_name=$(python3 -I -B -c 'import json,sys; print(json.load(open(sys.argv[1]))["archive"])' "$published/manifest.json")
[[ $archive_name =~ ^murage-cloud-home-[1-9][0-9]{0,8}\.tar\.gz$ && -f $published/$archive_name ]] || { echo 'The archive the manifest names is not in OUT_DIR'; exit 1; }
cp "$published/manifest.json" "$published/manifest.json.sig" "$published/$archive_name" "$work/"
cmp -s "$work/manifest.json" "$published/manifest.json" && cmp -s "$work/manifest.json.sig" "$published/manifest.json.sig" || { echo 'Published files changed while being read'; exit 1; }
# The home's own checks, from the trusted checkout's murage-commands: the signature first (verify_manifest), then the archive.
python3 -I -B - "$work" "$archive_name" "$trusted_commands" "$trusted_installer" "$public_key" <<'PY'
import importlib.machinery, importlib.util, os, sys
work, archive, trusted_commands, trusted_installer, public = sys.argv[1:6]
loader = importlib.machinery.SourceFileLoader("mc", trusted_commands)
spec = importlib.util.spec_from_loader(loader.name, loader)
home = importlib.util.module_from_spec(spec)
loader.exec_module(home)
raw = open(os.path.join(work, "manifest.json"), "rb").read()
signature = open(os.path.join(work, "manifest.json.sig"), "rb").read()
manifest = home.verify_manifest({"verify": home.verify_signature}, raw, signature, public)
home.safe_extract(os.path.join(work, archive), os.path.join(work, "check"))
for required in ("dist-server/cloud-home-supervisor.js", "dist-server/index.js", "deploy/cloud-home/launchers.txt"):
    assert os.path.isfile(os.path.join(work, "check", required)), required
loader = importlib.machinery.SourceFileLoader("il", trusted_installer)
spec = importlib.util.spec_from_loader(loader.name, loader)
installer = importlib.util.module_from_spec(spec)
loader.exec_module(installer)
entries = installer.plan(os.path.join(work, "check", "deploy", "cloud-home"))
installer.apply_modes(os.path.join(work, "check"), entries)
installer.check_abi(os.path.join(work, "check"), manifest["launcherAbi"])
fd = os.open(os.path.join(work, "check"), home.SLOT_OPEN)
try:
    assert home.seal_walk_digest(fd, False) == manifest["treeSha256"], "the extracted tree's digest is not the manifest's treeSha256"
finally:
    os.close(fd)
PY

# The signed manifest is for the revision and arch the operator named, and names exactly the archive that was copied.
python3 -I -B - "$work/manifest.json" "$revision" "$arch" "$work/$archive_name" <<'PY'
import hashlib, json, os, sys
manifest = json.load(open(sys.argv[1]))
assert manifest["revision"] == sys.argv[2], "the signed manifest is for another revision"
assert manifest["arch"] == sys.argv[3], "the signed manifest is for another architecture"
data = open(sys.argv[4], "rb").read()
assert len(data) == manifest["bytes"] and hashlib.sha256(data).hexdigest() == manifest["sha256"], "the archive is not the one the manifest names"
PY
openssl pkeyutl -verify -pubin -inkey "$public_key" -rawin -in "$published/manifest.json" -sigfile "$published/manifest.json.sig" >/dev/null \
  || { echo 'Published manifest does not verify'; exit 1; }
# The published archive itself, hashed again now (the checks above ran on the private copy): a swap after the copy must not pass.
python3 -I -B - "$published/manifest.json" "$published/$archive_name" <<'PY' || { echo 'The published archive is not the one the manifest names'; exit 1; }
import hashlib, json, sys
manifest = json.load(open(sys.argv[1]))
data = open(sys.argv[2], "rb").read()
assert len(data) == manifest["bytes"] and hashlib.sha256(data).hexdigest() == manifest["sha256"], "published archive differs from the manifest"
PY
tree_sha256=$(python3 -I -B -c 'import json,sys; print(json.load(open(sys.argv[1]))["treeSha256"])' "$published/manifest.json")
echo "Release finalized ($revision, $arch): signature verified, archive and tree digest $tree_sha256 re-checked"
echo "Slot A inputs for build-image.sh stage 2 (MURAGE_IMAGE_STAGE=seal): MURAGE_RELEASE_MANIFEST=$published/manifest.json MURAGE_RELEASE_MANIFEST_SIG=$published/manifest.json.sig"

else
echo "Unknown mode '$mode' (prepare or finalize)"; exit 1
fi
