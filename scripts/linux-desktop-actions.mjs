// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

const TASKS = ["new-chief", "needs-you", "pause"];
const wrappedHelpers = new WeakSet();

/** Use the target's launch command, retaining its quoting and fixed arguments. */
export function bindLinuxDesktopActions(desktop) {
  const sections = desktop.split(/(?=^\[)/m);
  const entry = sections.find(section => section.startsWith("[Desktop Entry]\n"));
  const commands = entry?.match(/^Exec=.+$/gm) ?? [];
  if (commands.length !== 1) throw new Error("Linux desktop entry needs one launch command.");
  // File/URL field codes belong to the main entry. An action supplies a task.
  const launch = commands[0].slice(5).replace(/ %[fFuU]$/, "");
  for (const task of TASKS) {
    const header = `[Desktop Action ${task}]\n`;
    const matches = sections.flatMap((section, index) => section.startsWith(header) ? [index] : []);
    if (matches.length !== 1) throw new Error(`Linux desktop action is missing or repeated: ${task}`);
    const index = matches[0];
    // Replace any old command too, so a target override cannot restore a PATH alias.
    sections[index] = sections[index].replace(/^Exec=.*\n?/gm, "").trimEnd()
      + `\nExec=${launch} --murage-task=${task}\n\n`;
  }
  return sections.join("");
}

/**
 * electron-builder 26.15.3 shares a LinuxTargetHelper across artifact targets.
 * Its AppImage and deb targets compute their desktop entries after beforePack.
 * Bind the serialized output so each action follows that target's own Exec:
 * AppRun can be relocated along with the main entry by AppImage integration.
 * Do not cache an executable on the shared helper or it can leak across targets.
 */
export default function beforePack(context) {
  if (context.electronPlatformName !== "linux") return;
  for (const target of context.targets) {
    if (!["appimage", "deb"].includes(target.name.toLowerCase())) continue;
    const helper = target.helper;
    if (typeof helper?.computeDesktopEntry !== "function") {
      throw new Error("Linux desktop generation changed. Review the packaging hook.");
    }
    if (wrappedHelpers.has(helper)) continue;
    const compute = helper.computeDesktopEntry;
    helper.computeDesktopEntry = async function (...args) {
      return bindLinuxDesktopActions(await compute.apply(this, args));
    };
    wrappedHelpers.add(helper);
  }
}
