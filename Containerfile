# SPDX-License-Identifier: AGPL-3.0-or-later
# Build the packaged payload on Linux for this image's architecture first.
# No installer, dependency download, credentials, or checkout enters a layer.
FROM node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4
WORKDIR /opt/murage
COPY dist-server/ dist-server/
COPY dist/ dist/
COPY scripts/container-image-health.mjs scripts/container-image-health.mjs
COPY LICENSE NOTICE ./
RUN node --input-type=module -e 'import fs from "node:fs"; import {createRequire} from "node:module"; const manifest=JSON.parse(fs.readFileSync("dist-server/memory-runtime-manifest.json")); if(manifest.platform!==process.platform || manifest.arch!==process.arch) throw Error("Build the runtime for this image architecture."); fs.accessSync("dist-server/index.js"); fs.accessSync("dist/index.html"); const addon=createRequire(import.meta.url)("./dist-server/resources/engine-exclusion.node"); if(typeof addon.ioMeterTotal!=="function") throw Error("Build the native runtime first.");' \
 && mkdir /data && chown node:node /data
ENV NODE_ENV=production MURAGE_DATA_DIR=/data/murage MURAGE_STATIC_DIR=/opt/murage/dist MURAGE_RESOURCES_PATH=/opt/murage/dist-server/resources
USER node
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["node", "scripts/container-image-health.mjs"]
CMD ["node", "dist-server/index.js"]
