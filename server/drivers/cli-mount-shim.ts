// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Dumb stdio transport. No child credentials, release authority, retry or reply.
import "../../shared/win-hide-child-process.mjs";
import { connect } from "node:net";
import { turnSecret } from "../turn-credential.ts";

const index = process.argv.indexOf("--server");
const server = index >= 0 ? process.argv[index + 1] : undefined;
const ticket = turnSecret("MURAGE_RELAY_TICKET");
const path = turnSecret("MURAGE_RELAY_SOCKET");
if (!server || !ticket || !path) process.exit(1);
const socket = connect(path);
const fail = () => { socket.destroy(); process.exitCode = 1; process.stdin.destroy(); process.stdout.destroy(); };
socket.on("error", fail);
process.stdin.on("error", fail);
process.stdout.on("error", fail);
socket.once("connect", () => {
  socket.write(JSON.stringify({ ticket, server }) + "\n");
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
socket.once("close", () => { process.stdin.destroy(); process.stdout.end(); });
