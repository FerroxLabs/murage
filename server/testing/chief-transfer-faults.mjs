// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { BotTurnState } from "../bot-turn-state.ts";

const dir = process.env.MURAGE_DATA_DIR;
const postCommitFault = join(dir, "roster-post-commit-fault");
const journalFault = join(dir, "transfer-journal-fault");
const slackSaveFault = join(dir, "slack-transfer-write-fault");
const readOnlyAtBoot = join(dir, "transfer-read-only-start");
const checkpoint = BotTurnState.prototype.checkpoint;
BotTurnState.prototype.checkpoint = function (bots, base) {
  if (fs.existsSync(postCommitFault) && bots.some(bot => bot.chiefScope === "workspace" && bot.id === fs.readFileSync(postCommitFault, "utf8"))) {
    fs.unlinkSync(postCommitFault);
    throw new Error("fixture failed the sidecar after the roster commit");
  }
  return checkpoint.call(this, bots, base);
};

const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (to === join(dir, "chief-transfer.json") && fs.existsSync(journalFault)) {
    const entry = JSON.parse(fs.readFileSync(from, "utf8"));
    if (entry.state !== "intent") throw new Error("fixture failed a post-role journal write");
  }
  if (to === join(dir, "channels", "slack", "connection.json") && fs.existsSync(slackSaveFault)) {
    const entry = JSON.parse(fs.readFileSync(from, "utf8"));
    if (entry.chosen.chiefBotId === fs.readFileSync(slackSaveFault, "utf8") && !entry.paused) {
      fs.unlinkSync(slackSaveFault);
      throw new Error("fixture failed the selected Slack connection write");
    }
  }
  rename(from, to);
};
const statfs = fs.statfsSync;
fs.statfsSync = (path, options) => {
  const disk = statfs(path, options);
  if (path !== dir || !fs.existsSync(readOnlyAtBoot)) return disk;
  return { ...disk, bavail: typeof disk.bavail === "bigint" ? 0n : 0 };
};
syncBuiltinESMExports();
