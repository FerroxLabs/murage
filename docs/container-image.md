<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Server container image

The Containerfile packages Murage's existing server and web UI. Docker and
Podman use the same file on Linux amd64 and arm64. Qualification runs on native
Linux builders. Build on the dedicated
Hetzner Linux builders, with a Node 24 toolchain and the pinned dependencies cached.
Build each architecture natively so its packaged ONNX runtime and native
helpers match. The image checks that match during the build.

Prepare a clean checkout on the builder:

```sh
pnpm install --offline --frozen-lockfile
pnpm build
pnpm build:server
node scripts/build-cloud-engine-exclusion.mjs
mkdir -p dist-server/resources
cp resources/engine-exclusion.node dist-server/resources/engine-exclusion.node
docker build --network none --pull=false -f Containerfile -t murage-server:local .
```

Use `podman` in place of `docker` and `--pull=never` in place of `--pull=false`
for Podman. The pinned base image must
already be cached. Both builders have a matching context allowlist, so source
files, Git history, user data and local environment files stay out of the
image. Build from a clean checkout and scan all layers before sharing it.
The manual qualification workflow does this separately for amd64 and arm64
on dedicated Linux builders. It does not publish to a registry.

Run the server with a new persistent data volume:

```sh
docker run --detach --name murage-server --mount source=murage-data,target=/data murage-server:local
docker exec murage-server node scripts/container-image-health.mjs
```

The default user is `node` (uid 1000). The image creates `/data` with that
owner. The data folder is `/data/murage`; its sibling lock files also stay in
the volume. A bind-mounted data folder must also be writable by uid 1000. Keep
credentials in the data volume at runtime. Do not copy them into an image.

The server listens on loopback inside the container. It keeps the existing
local harness boundary; publishing a container port does not turn it into a
public browser door. Connect it through Murage's existing authenticated Cloud
or companion deployment. This image does not install those deployment
services or the desktop app, and does not configure an engine account.

For an isolated qualification run, with gitleaks installed on the builder:

```sh
mkdir -p /path/outside/checkout/image-check
node scripts/smoke-container-image.mjs murage-server:local /path/outside/checkout/image-check
```

Set `CONTAINER_ENGINE=podman` to check a Podman image. The check uses a new
container with no network, no capabilities, a read-only root, and temporary
data. It checks real health and the runtime user, scans each saved layer and
image configuration for secrets, and removes its container and exported
layers. Small redacted reports remain in the supplied evidence folder.

The scan checks every layer and image configuration, including deleted files.
Its code allowance list contains exact full-match hashes for reviewed public
source expressions and published tool checksums. It never excludes a file,
directory, or scanner rule. A changed expression needs another review, and
new findings stop qualification. Scanner bytes stay in temporary scratch;
only redacted findings and counts are retained.
