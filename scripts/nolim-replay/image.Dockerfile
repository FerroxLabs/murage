# Dependency preparation happens before this offline build. No downloads here.
ARG BASE_IMAGE=node@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4
FROM ${BASE_IMAGE}
ARG SOURCE_SHA
ARG LOCK_SHA256
LABEL org.murage.nolim.source-sha=${SOURCE_SHA} org.murage.nolim.lock-sha256=${LOCK_SHA256}
WORKDIR /app
COPY --chown=10001:10001 . /app
USER 10001:10001
ENV HOME=/scratch/home TMPDIR=/scratch/tmp NODE_ENV=test NOLIM_REPLAY_MODE=release NOLIM_REPLAY_CORPUS=/corpus
ENTRYPOINT ["node", "/app/server/testing/nolim-replay/runner.ts"]
