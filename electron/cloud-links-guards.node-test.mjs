// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Source guards for the desktop Cloud links (DESKTOP-CLOUD-LINKS.md r2). They read the code as text, so a regression fails
// here without an Electron run.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { COPY } from "./cloud-home-client.mjs";

const electronDir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(electronDir, "..");
const read = (relative) => readFileSync(path.join(repo, relative), "utf8");
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const filesUnder = (dir, pattern) => readdirSync(path.join(repo, dir), { recursive: true }).map(String).filter((name) => pattern.test(name) && !/node_modules/.test(name)).map((name) => path.join(dir, name));

test("email-code pairing symbols absent: the desktop pairs through door v2 only", () => {
  const sources = [
    ...filesUnder("electron", /\.(mjs|cjs|mts)$/).filter((file) => !/\.(node-)?test\.mjs$/.test(file)),
    ...filesUnder("src", /\.(ts|tsx)$/).filter((file) => !/\.test\.tsx?$/.test(file)),
  ];
  assert.ok(sources.length > 50);
  for (const file of sources) {
    const text = code(read(file));
    for (const symbol of [/\bstartEmailPairing\b/, /\bpairWithEmailCode\b/, /cloud-home:start-pairing/, /"cloud-home:pair"/, /\bstartPairing\s*[:(]/, /\bemailCode\b/, /\/pairing\/start\b/, /\/pairing\/code\b/]) {
      assert.ok(!symbol.test(text), `${file} still has ${symbol}`);
    }
  }
  assert.throws(() => read("src/components/cloud/PairHome.tsx"), /ENOENT/, "PairHome.tsx is deleted");
  assert.ok(!/check the code/i.test(read("electron/cloud-home-client.mjs")), "no copy asks for a code");
});

test("no link-derived console argument in cloud-door-link, cloud-link-queue, cloud-link-handoff", () => {
  for (const file of ["cloud-door-link.mjs", "cloud-link-queue.mjs", "cloud-link-handoff.mjs", "linux-url-handler.mjs"]) {
    const text = code(read(`electron/${file}`));
    assert.doesNotMatch(text, /\bconsole\s*\.|process\.std(out|err)|\bwarn\s*\(/, `${file} logs nothing: a door link carries a ticket`);
  }
  // The client and IPC log nothing link-shaped either.
  for (const file of ["cloud-home-client.mjs", "cloud-home-ipc.mjs"]) assert.doesNotMatch(code(read(`electron/${file}`)), /console\.(log|info|warn|error|debug)\([^)]*(link|ticket|url|text|clipboard)/i, file);
  // main: every console call in the Cloud link block is a fixed reason or an error code.
  const main = read("electron/main.mjs");
  const block = main.slice(main.indexOf("// Cloud links: murage://open-cloud"), main.indexOf('app.on("second-instance"'));
  const calls = block.match(/console\.\w+\([^;]*\);/g) ?? [];
  assert.ok(calls.length >= 6);
  for (const call of calls) assert.match(call, /^console\.log\(("\[cloud\] door: [a-z-]+"|`\[cloud\] door: \$\{typeof error\?\.code === "string" \? error\.code : "failed"\}`)\);$/, call);
  // The renderer never receives a link: only the kind, and an open-cloud home id.
  const preload = read("electron/preload.cjs");
  const linkEvent = preload.slice(preload.indexOf("onLinkEvent:"), preload.indexOf("removeListener(\"cloud-home:link-event\""));
  assert.match(linkEvent, /cb\(\{ kind: String\(event\?\.kind \?\? ""\), \.\.\.\(typeof event\?\.homeId === "string" \? \{ homeId: event\.homeId \} : \{\}\) \}\)/);
  assert.doesNotMatch(code(preload), /connect-paste", *[a-z]/i, "Use copied link sends no argument");
});

// A crash dump holds process memory, which can include a door link ticket. Dumps
// are kept on this computer only: the reporter may start solely with uploads off
// and an empty server address, and nothing may turn uploading on later.
const LOCAL_ONLY_START = /^crashReporter\.start\(\{ uploadToServer: false, submitURL: "", compress: true \}\)$/;
function crashReporterProblems(file, text) {
  const problems = [];
  const body = code(text);
  // Every upload setting anywhere must be the local-only one.
  for (const match of body.matchAll(/\buploadToServer\b\s*[:=(]?\s*([^,}\s)]*)/g)) if (match[1] !== "false") problems.push(`${file}: uploadToServer ${match[0]}`);
  for (const match of body.matchAll(/\bsubmitURL\b\s*[:=]?\s*([^,}\s)]*)/g)) if (match[1] !== '""') problems.push(`${file}: submitURL ${match[0]}`);
  for (const word of [/\bsetUploadToServer\b/, /\bgetUploadToServer\b/]) if (word.test(body)) problems.push(`${file}: ${word}`);
  // crashReporter is only imported, handed on, or started local-only.
  for (const match of body.matchAll(/\bcrashReporter\b(\s*\.\s*\w+\s*\([^)]*\))?/g)) {
    const member = match[1];
    if (!member) continue;
    if (!LOCAL_ONLY_START.test(match[0].replace(/\s+/g, " ").replace(/^crashReporter ?\. ?/, "crashReporter."))) problems.push(`${file}: ${match[0]}`);
  }
  const starts = body.match(/\bcrashReporter\s*\.\s*start\b/g) ?? [];
  const localStarts = body.match(/\bcrashReporter\.start\(\{ uploadToServer: false, submitURL: "", compress: true \}\)/g) ?? [];
  if (starts.length !== localStarts.length) problems.push(`${file}: crashReporter.start without the local-only options`);
  return problems;
}

test("crash dumps stay local: crashReporter starts only with uploads off and no submitURL", () => {
  const sources = filesUnder("electron", /\.(mjs|cjs|js)$/).filter((file) => !/\.(node-)?test\.mjs$|electron-smoke/.test(file));
  const problems = sources.flatMap((file) => crashReporterProblems(file, read(file)));
  assert.deepEqual(problems, []);
  const users = sources.filter((file) => /\bcrashReporter\b/.test(code(read(file)))).sort();
  assert.deepEqual(users, ["electron/crash-dumps.mjs", "electron/main.mjs"].map((file) => path.normalize(file)), "only these files touch crashReporter");
  const starts = users.flatMap((file) => code(read(file)).match(/\bcrashReporter\.start\(/g) ?? []);
  assert.equal(starts.length, 1, "one local-only start");
});

test("the crash reporter guard fails on any upload or submitURL", () => {
  const good = 'crashReporter.start({ uploadToServer: false, submitURL: "", compress: true });';
  assert.deepEqual(crashReporterProblems("x.mjs", good), []);
  for (const bad of [
    'crashReporter.start({ uploadToServer: true, submitURL: "", compress: true });',
    'crashReporter.start({ uploadToServer: false, submitURL: "https://crash.example/upload", compress: true });',
    'crashReporter.start({ submitURL: "https://crash.example", compress: true });',
    'crashReporter.start({ compress: true });',
    'crashReporter.start(options);',
    'const options = { uploadToServer: enabled, submitURL: url };',
    'crashReporter.setUploadToServer(true);',
    'crashReporter.addExtraParameter("k", "v");',
  ]) assert.notDeepEqual(crashReporterProblems("x.mjs", bad), [], bad);
});

test("main's Cloud link words are the en.json words", () => {
  const en = JSON.parse(read("src/locales/en.json"));
  const pairs = {
    linkExpired: "cloudConnect.result.expired", holdRequired: "cloudConnect.result.holdRequired", tooManyDevices: "cloudConnect.result.tooManyDevices",
    connectRefused: "cloudConnect.result.refused", tooManyTries: "cloudConnect.result.tooManyTries", homeBusy: "cloudConnect.result.homeBusy",
    lostAnswer: "cloudConnect.result.lost", tookTooLong: "cloudConnect.result.tookTooLong", removeOnMyCloud: "cloudConnect.result.removeOnMyCloud",
    otherConnect: "cloudConnect.result.otherConnect", badLink: "cloudConnect.result.badLink", pinMismatch: "cloudConnect.result.pinMismatch",
    unreachable: "cloudConnect.result.unreachable", notLive: "cloudConnect.notLive",
  };
  for (const [copy, key] of Object.entries(pairs)) {
    assert.equal(COPY[copy], en[key], `${copy} = ${key}`);
    assert.doesNotMatch(en[key], /\u2014|\b(?:safe|safely|safety|unsafe)\b/i, key);
  }
  for (const [key, value] of Object.entries(en).filter(([key]) => key.startsWith("cloudConnect."))) assert.doesNotMatch(value, /\u2014|\b(?:safe|safely|safety|unsafe)\b/i, key);
});
