// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test-process-only preload: holds one Claude turn inside its setup, after its prompt was built and before the
// submission fence, so a test can land a memory revoke there and the fence refuses the turn before it hands its id
// back (index.ts, the rebuild at the dispatch catch). The window is the permission broker's listen: it is the only
// wait there that a process outside the server can hold, and the packaged server has no other way in.
//
// MURAGE_TEST_SETUP_HOLD   path. Nothing happens until `<path>.arm` exists, so a warm start is not held. The next
//                          broker listen writes `<path>.waiting` and goes on once `<path>` exists. It holds once.
//
// Production never loads this file: it is not in the packaged server, and only a test that passes it to `--import`
// with the variable set turns it on. It reads no input from a turn, a bot or a request.
import { existsSync, writeFileSync } from "node:fs";
import { Server } from "node:net";
import { isMainThread } from "node:worker_threads";

const gate = process.env.MURAGE_TEST_SETUP_HOLD;
if (isMainThread && gate) {
  const listen = Server.prototype.listen;
  let held = false;
  Server.prototype.listen = function hold(...args) {
    const broker = typeof args[0] === "string" && /murage-perm|perm-[^/\\]*\.sock$/.test(args[0]);
    if (held || !broker || !existsSync(`${gate}.arm`)) return listen.apply(this, args);
    held = true;
    writeFileSync(`${gate}.waiting`, "");
    const wait = () => { if (existsSync(gate)) listen.apply(this, args); else setTimeout(wait, 25); };
    wait();
    return this;
  };
}
