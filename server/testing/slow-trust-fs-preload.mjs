// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Imported explicitly by the folder-trust turn-path fixture; never loaded by the application.
// Simulates the stuck volume behind the 65 s `turn.folder-trust` stall (1.0.22 real logs): the first synchronous file call the turn's
// folder-trust step makes on the folder under SLOW_TRUST_ROOT sleeps its whole thread for SLOW_TRUST_MS, as a blocked syscall does.
// Only calls made synchronously from `folderTrustForTurn` (or the snapshot step before it) are slowed: a call from anywhere else is not what this fixture stands in for.
// SLOW_TRUST_EXACT4 names ONE path (not a tree), slowed only once the file SLOW_TRUST_ARM4 exists: the user's home, which every native
// turn resolves, slowed for the one turn that arms it.
// SLOW_TRUST_EXACT5 (armed by SLOW_TRUST_ARM5) is the engine's trust file, slowed when a check made AFTER the turn's trust step reads it
// (a stack through FolderTrustIndex.sourceNow: the ACP launch, its epoch checks), 1.0.24 S03.
// SLOW_TRUST_EXACT6 (armed by SLOW_TRUST_ARM6) is the turn's folder, slowed when a folder-trust resolve of it (canonicalFolder, isUnrecordableTrustRoot, the automatic-choice checks) runs synchronously
// (canonicalFolder(cwd), isUnrecordableTrustRoot(key)), 1.0.24 S03.
// SLOW_TRUST_GATE_FILE: two async gates on fs.promises.stat of that one file (a held off-thread stat, the loop stays free), each armed by its
// ARM file, taken once, logged to its LOG file and held until its RELEASE file exists (1.0.24 S03, Astra 1afc268eb5):
//   SNAP: the next turn snapshot stat (trust-fs answerLive); the stat is made at once and only its answer is held (an answer from before).
//   REFRESH: the fresh stat an automatic reply waits for (refreshUpstreamTrust); held, then made.
//   BACKGROUND: every later identity stat (a background refreshIdentity, or another reply's refresh; not once) while armed; held, then made:
//   those land after the first reply has answered.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { sep } from "node:path";

const ms = Number(process.env.SLOW_TRUST_MS || 0);
const targets = [[process.env.SLOW_TRUST_ROOT, process.env.SLOW_TRUST_LOG], [process.env.SLOW_TRUST_ROOT2, process.env.SLOW_TRUST_LOG2], [process.env.SLOW_TRUST_ROOT3, process.env.SLOW_TRUST_LOG3],
  [process.env.SLOW_TRUST_EXACT4, process.env.SLOW_TRUST_LOG4, process.env.SLOW_TRUST_ARM4],
  [process.env.SLOW_TRUST_EXACT5, process.env.SLOW_TRUST_LOG5, process.env.SLOW_TRUST_ARM5, /\bsourceNow\b/],
  [process.env.SLOW_TRUST_EXACT6, process.env.SLOW_TRUST_LOG6, process.env.SLOW_TRUST_ARM6, /\b(queryAutomaticChoice|automaticFolderChoice|automaticRejectReason|safeFuigoTrustKey|isUnrecordableTrustRoot|canonicalFolder)\b/]].filter(([root]) => root);
if (targets.length && ms > 0) {
  const real = { append: fs.appendFileSync, exists: fs.existsSync };
  const spent = new Set();
  const target = path => typeof path === "string" ? targets.find(([root, , arm]) => arm ? path === root && real.exists(arm) : path === root || path.startsWith(root + sep)) : undefined;
  // the whole stack: the default 10 frames lose the turn's frame below a deep trust chain (canonicalHome, the registry walk)
  const fullStack = () => { const limit = Error.stackTraceLimit; Error.stackTraceLimit = 200; try { return new Error().stack ?? ""; } finally { Error.stackTraceLimit = limit; } };
  const slow = (name, path) => {
    const hit = target(path);
    if (!hit || spent.has(hit[0]) || !(hit[3] ?? /\bfolderTrust(ForTurn|FsSnapshot)\b/).test(fullStack())) return;
    spent.add(hit[0]);
    if (hit[1]) real.append(hit[1], `blocked ${name} ${path} ${ms}ms\n`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  };
  const wrap = (owner, name) => {
    const original = owner[name];
    owner[name] = function (path, ...rest) {
      slow(name, path);
      return original.call(this, path, ...rest);
    };
    if (original.native) owner[name].native = original.native;
  };
  for (const name of ["statSync", "lstatSync", "readdirSync", "readFileSync", "existsSync"]) wrap(fs, name);
  const native = fs.realpathSync.native;
  fs.realpathSync.native = function (path, ...rest) {
    slow("realpathSync.native", path);
    return native.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
}

const gateFile = process.env.SLOW_TRUST_GATE_FILE;
if (gateFile) {
  const real = { stat: fs.promises.stat, append: fs.appendFileSync, exists: fs.existsSync };
  const stacks = { SNAP: /\banswerLive\b/, REFRESH: /\brefreshUpstreamTrust\b/, BACKGROUND: /\b(refreshIdentity|refreshUpstreamTrust)\b/ };
  const gates = Object.keys(stacks).map(name => ({ name, arm: process.env[`SLOW_TRUST_GATE_${name}_ARM`], release: process.env[`SLOW_TRUST_GATE_${name}_RELEASE`], log: process.env[`SLOW_TRUST_GATE_${name}_LOG`],
    stack: stacks[name], spent: false })).filter(gate => gate.arm && gate.release && gate.log);
  const released = async gate => { while (!real.exists(gate.release)) await new Promise(resolve => setTimeout(resolve, 20)); };
  fs.promises.stat = async function (path, ...rest) {
    const gate = path === gateFile ? gates.find(entry => !entry.spent && real.exists(entry.arm) && entry.stack.test((() => { const limit = Error.stackTraceLimit; Error.stackTraceLimit = 200; try { return new Error().stack ?? ""; } finally { Error.stackTraceLimit = limit; } })())) : undefined;
    if (!gate) return real.stat.call(this, path, ...rest);
    if (gate.name !== "BACKGROUND") gate.spent = true;
    if (gate.name === "SNAP") {
      const answer = real.stat.call(this, path, ...rest).then(value => ({ value }), error => ({ error }));
      await answer;
      real.append(gate.log, `held ${gate.name}\n`);
      await released(gate);
      const settled = await answer;
      if ("error" in settled) throw settled.error;
      return settled.value;
    }
    real.append(gate.log, `held ${gate.name}\n`);
    await released(gate);
    return real.stat.call(this, path, ...rest);
  };
}
