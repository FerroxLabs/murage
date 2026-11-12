#!/usr/bin/env bash
# Explicit Linux CI execution leg; never skipped when Docker is missing.
set -euo pipefail
image='node@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4'
name="nolim-containment-${GITHUB_RUN_ID:-local}-$$"
trap 'docker rm -f "${name:?}" >/dev/null 2>&1 || true' EXIT
# No host data mount. Verify UID, read-only root, writable private scratch,
# no credential env, and refusal to reach an external test address.
timeout --signal=TERM --kill-after=5s 90s docker run --name "$name" --network none --read-only \
 --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 --memory 256m \
 --tmpfs /scratch:rw,nosuid,nodev,size=16m,mode=0700,uid=10001,gid=10001 \
 "$image" node --input-type=module -e '
import assert from "node:assert/strict";import fs from "node:fs";import net from "node:net";
assert.equal(process.getuid(),10001);assert.equal(fs.statSync("/scratch").mode&511,448);
fs.writeFileSync("/scratch/probe","fixture",{mode:384});assert.equal(fs.readFileSync("/scratch/probe","utf8"),"fixture");
assert.throws(()=>fs.writeFileSync("/root-probe","x"));assert(!process.env.GH_TOKEN&&!process.env.OPENAI_API_KEY);
await new Promise((resolve,reject)=>{const socket=net.connect({host:"192.0.2.1",port:443});socket.on("connect",()=>{socket.destroy();reject(Error("network escaped"))});socket.on("error",resolve);socket.setTimeout(3000,()=>{socket.destroy();resolve()})});
console.log("PASS: Linux Docker UID, mounts, read-only root and network namespace");'
