// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Adapted from upstream OpenMaus folded tool-step labels (Apache-2.0); see NOTICE.
//
// A folded run of tool steps in plain words ("read files, edited files, ran
// commands"). Every engine names the same action differently (Bash, shell,
// run_command, execute ...), so a name is first normalised and then looked up
// in one table. A name the table does not know is shown as it came, so a new
// engine's tool is never hidden or mislabelled.
import { t } from "@/lib/i18n";

export type ToolStepKey =
  | "runCommand"
  | "readFile"
  | "editFile"
  | "searchFiles"
  | "search"
  | "deleteFiles"
  | "moveFiles"
  | "searchWeb"
  | "openWebPage"
  | "lookAtScreen"
  | "useComputer"
  | "useBrowser"
  | "updatePlan"
  | "useConnectedApps";

const GROUPS: Record<ToolStepKey, readonly string[]> = {
  runCommand: ["bash", "shell", "runcommand", "execute", "terminal", "exec", "execcommand", "shellcommand", "runshellcommand", "localshell", "bashoutput", "killshell", "run"],
  readFile: ["read", "readfile", "readfiles", "readmanyfiles", "view", "viewfile", "openfile", "cat"],
  editFile: ["edit", "write", "multiedit", "notebookedit", "writefile", "editfile", "applypatch", "patch", "strreplace", "strreplaceeditor", "createfile", "replace"],
  searchFiles: ["grep", "glob", "ls", "find", "searchfiles", "searchfilecontent", "listfiles", "listdir", "listdirectory", "codebasesearch", "findfiles"],
  search: ["search"],
  deleteFiles: ["delete", "deletefile", "remove", "removefile"],
  moveFiles: ["move", "movefile", "rename", "renamefile"],
  searchWeb: ["websearch", "searchweb", "googlewebsearch"],
  openWebPage: ["webfetch", "fetch", "openpage", "openwebpage", "browse", "fetchurl"],
  lookAtScreen: ["screenshot", "takescreenshot", "screen", "lookatscreen"],
  useComputer: ["computer", "computeruse"],
  useBrowser: ["browser"],
  updatePlan: ["todowrite", "updateplan", "plan", "exitplanmode", "todo", "todoread"],
  useConnectedApps: [],
};

const TABLE = new Map<string, ToolStepKey>();
for (const [key, names] of Object.entries(GROUPS) as Array<[ToolStepKey, readonly string[]]>) {
  for (const name of names) TABLE.set(name, key);
}

/** "mcp__server__Read_File" -> "readfile": drop the MCP prefix, case and separators. */
function normalise(name: string): string {
  const bare = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  return bare.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The plain-words key for an engine's tool name, or null when unknown. */
export function toolStepKey(name: string | undefined): ToolStepKey | null {
  if (!name) return null;
  if (/(?:^|__)(?:composio|murage_connectors)__/i.test(name) || /^mcp__(?:composio|murage_connectors)/i.test(name)) return "useConnectedApps";
  if (/^APPS_[A-Z_]+$/.test(name)) return "useConnectedApps";
  return TABLE.get(normalise(name)) ?? null;
}

/** The words for one step: the plain label, or the raw name as a fallback. */
export function toolStepLabel(name: string | undefined): string {
  const key = toolStepKey(name);
  return key ? t(`toolStep.${key}`) : (name ?? "");
}
