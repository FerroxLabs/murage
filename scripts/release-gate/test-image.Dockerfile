# Build during dependency preparation; every test invocation remains offline.
FROM node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4
RUN apt-get update \
 && apt-get install -y --no-install-recommends zsh xvfb xauth libgtk-3-0 libnss3 libgbm1 libasound2 \
 && apt-get clean
# Keep the desktop runtime outside the shared, read-only dependency cache.
# This version is the electron pin in pnpm-lock.yaml; no runtime download.
RUN npm install --prefix /opt/murage-test-electron --ignore-scripts --no-audit --no-fund electron@43.8.1 \
 && env -u ELECTRON_SKIP_BINARY_DOWNLOAD node /opt/murage-test-electron/node_modules/electron/install.js \
 && test -x /opt/murage-test-electron/node_modules/electron/dist/electron
ENV ELECTRON_OVERRIDE_DIST_PATH=/opt/murage-test-electron/node_modules/electron/dist
