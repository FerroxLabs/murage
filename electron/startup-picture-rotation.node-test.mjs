// SPDX-License-Identifier: AGPL-3.0-or-later
// FIRSTRUN-1019 slice B: the tip the current start showed, handed to the renderer so the rotation survives a restart (B1).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PICTURE_FILE, writeStartupPicture } from "./startup-picture.mjs";
import { registerStartupIpc } from "./startup-ipc.mjs";
import { CLASS_LOCAL_ONLY, channelClass, isClassified } from "./ipc-channel-classes.mjs";

const FACE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 30"><circle cx="15" cy="15" r="10" fill="#ff6b35"/></svg>`;
const picture = (tipNext) => ({ v: 1, tipNext, faceA: FACE, faceB: FACE, tip: { id: "search", head: "h", line: "l", try: "t" }, at: 1 });
const gate = () => {
  const handlers = new Map();
  return { handlers, handle: (channel, fn) => handlers.set(channel, fn) };
};
const withDir = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr19b-rot-"));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

test("B1 startup-picture:session-tip answers the tip the saved picture holds, or null when there is none", () => {
  withDir((dir) => {
    const g = gate();
    registerStartupIpc({ gate: g, userData: dir });
    assert.equal(g.handlers.get("startup-picture:session-tip")(), null, "no file yet");
  });
  withDir((dir) => {
    assert.equal(writeStartupPicture({ userData: dir, picture: picture(7) }), true);
    const g = gate();
    registerStartupIpc({ gate: g, userData: dir });
    assert.equal(g.handlers.get("startup-picture:session-tip")(), 7);
  });
});

test("B1 the answer is fixed for the whole session: a save made later never moves it", () => {
  withDir((dir) => {
    writeStartupPicture({ userData: dir, picture: picture(11) });
    const g = gate();
    registerStartupIpc({ gate: g, userData: dir });
    assert.equal(g.handlers.get("startup-picture:session-tip")(), 11);
    assert.equal(g.handlers.get("startup-picture:save")({}, picture(0)), true);
    assert.equal(g.handlers.get("startup-picture:session-tip")(), 11, "still the tip this start showed");
  });
});

test("B1 a save that arrives before anyone asked still latches the tip this start showed", () => {
  withDir((dir) => {
    writeStartupPicture({ userData: dir, picture: picture(5) });
    const g = gate();
    registerStartupIpc({ gate: g, userData: dir });
    g.handlers.get("startup-picture:save")({}, picture(6));
    assert.equal(g.handlers.get("startup-picture:session-tip")(), 5);
  });
});

test("B1 a bad or hostile file reads as no tip, never throws", () => {
  withDir((dir) => {
    fs.writeFileSync(path.join(dir, PICTURE_FILE), "{not json");
    const g = gate();
    registerStartupIpc({ gate: g, userData: dir });
    assert.equal(g.handlers.get("startup-picture:session-tip")(), null);
  });
});

test("A13c the new channel is an owned-main invoke like the other two picture channels", () => {
  for (const channel of ["startup-picture:save", "startup-picture:session-tip"]) {
    assert.equal(isClassified(channel), true, channel);
    assert.equal(channelClass(channel), CLASS_LOCAL_ONLY, channel);
  }
});
