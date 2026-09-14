import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { APPROVAL_SOUND, approvalOptions, approvalPayload, createApprovalNotifications } from "./approval-notification.mjs";
const payload = { botId: "bot", threadId: "task", requestId: "request", messageId: "card", title: "Approval <needed>", body: "Review & decide" };
function fixture(platform = "darwin", limit = 1024) {
  const notices = [], opened = [];
  class FakeNotification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; notices.push(this); }
    show() { this.shown = true; }
  }
  return { notices, opened, show: createApprovalNotifications({ Notification: FakeNotification, platform, limit, onOpen: target => opened.push(target) }) };
}
test("fixed native sounds with normal non-looping presentation and escaped Windows content", () => {
  assert.equal(approvalOptions(payload, "darwin").sound, APPROVAL_SOUND);
  const windows = approvalOptions(payload, "win32").toastXml;
  assert.match(windows, /Notification.Reminder/); assert.match(windows, /loop="false"/);
  assert.match(windows, /Approval &lt;needed&gt;/); assert.match(windows, /Review &amp; decide/);
  assert.doesNotMatch(windows, /scenario=|critical|<needed>/);
  assert.equal(approvalOptions(payload, "linux"), null);
});
test("payload allows bounded scalars only, never caller paths, XML or commands", () => {
  assert.deepEqual(approvalPayload(payload), payload);
  for (const bad of [null, [], { ...payload, requestId: "" }, { ...payload, botId: "https://host" }, { ...payload, body: {} }, { ...payload, title: "x".repeat(301) }, { ...payload, sound: "/tmp/custom" }, { ...payload, toastXml: "<toast/>" }]) assert.equal(approvalPayload(bad), null);
});
test("one native cue per request and a click navigates once without approval actions", () => {
  const f = fixture();
  assert.deepEqual(f.show(payload), { accepted: true });
  assert.deepEqual(f.show({ ...payload, body: "new text", messageId: "other-card" }), { accepted: false });
  f.notices[0].emit("click"); f.notices[0].emit("click");
  assert.deepEqual(f.opened, [{ botId: "bot", threadId: "task" }]);
  f.show({ ...payload, threadId: "other-task" });
  f.show({ ...payload, requestTurnId: "next-turn" });
  assert.equal(f.notices.length, 3);
});
test("native failures stay consumed and old callback retention is bounded", () => {
  const f = fixture("darwin", 1);
  f.show(payload); f.notices[0].emit("failed");
  assert.deepEqual(f.show(payload), { accepted: false });
  f.show({ ...payload, requestId: "second" });
  f.show({ ...payload, requestId: "third" });
  assert.equal(f.notices[1].listenerCount("click"), 0);
});
test("fixed WAV has valid finite PCM and ships at the native resource lookup root", () => {
  const wave = readFileSync(new URL("./resources/murage-approval.wav", import.meta.url));
  assert.equal(wave.toString("ascii", 0, 4), "RIFF"); assert.equal(wave.toString("ascii", 8, 12), "WAVE");
  assert.equal(wave.readUInt32LE(4), wave.length - 8);
  assert.equal(wave.readUInt16LE(20), 1); assert.equal(wave.readUInt16LE(22), 1);
  assert.equal(wave.readUInt16LE(34), 16); assert.equal(wave.readUInt32LE(40), wave.length - 44);
  assert.equal(wave.readUInt32LE(40) / wave.readUInt32LE(28), 0.48);
  assert.ok(wave.subarray(44).some(byte => byte !== 0));
  const build = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
  assert.match(build, /from: electron\/resources\/murage-approval.wav\s+to: murage-approval.wav/);
  assert.equal(APPROVAL_SOUND, "murage-approval.wav");
});
