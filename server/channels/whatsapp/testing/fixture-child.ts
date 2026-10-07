// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A bridge child for host tests: forked exactly like the real bridge, but running the real engine against a
// scripted fake socket (never Baileys, never the network). WA_FIXTURE_MODE picks the behaviour:
//   engine    the real Bridge over IPC; the fake socket emits a QR, and opens when WA_FIXTURE_OPEN=1
//   silent    sends `ready`, then ignores everything (no pong), so the host must kill it
//   crash     sends `ready`, then exits with code 3
//   mute      never sends `ready`, so the handshake deadline must kill it
import { runBridgeProcess, type ProcessLike } from "../bridge.ts";
import { makeFakeLib, type FakeSocket } from "./fake-baileys.ts";

const mode = process.env.WA_FIXTURE_MODE ?? "engine";
const proc = process as unknown as ProcessLike;

if (mode === "mute") {
  setInterval(() => undefined, 1000);
} else if (mode === "silent") {
  proc.on("message", (m: { kind: string }) => { if (m.kind === "init") proc.send?.({ kind: "initialized" }); });
  proc.send?.({ kind: "ready", v: 1 });
  setInterval(() => undefined, 1000);
} else if (mode === "crash") {
  proc.send?.({ kind: "ready", v: 1 });
  setTimeout(() => process.exit(3), 20);
} else {
  const fake = makeFakeLib();
  const make = fake.lib.makeWASocket;
  fake.lib.makeWASocket = (config) => {
    const socket = make(config) as FakeSocket;
    socket.onSend = async () => undefined;
    setTimeout(() => {
      socket.qr("2@fixture-qr");
      if (process.env.WA_FIXTURE_OPEN === "1") setTimeout(() => socket.open(), 20);
    }, 10);
    return socket;
  };
  await runBridgeProcess(proc, fake.lib);
}
