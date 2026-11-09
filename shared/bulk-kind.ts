// SPDX-License-Identifier: AGPL-3.0-or-later
// The plain kind of an approval, from its tool name (APPROVALS-SIMPLE-1018 section 1). One function for the server's
// Approve all sheet and the client's grey row line, so a row and the sheet never name the same step differently.
// Murage's own fact, never the bot's words.

export type BulkKind = "command" | "edit" | "app" | "other";

export function bulkKindKey(tool: string): BulkKind {
  if (/^(?:mcp__.+__)?(?:[\w-]+\.)?(?:bash|shell|execute|exec_command|run_command|terminal|powershell|pwsh)$/i.test(tool)) return "command";
  if (/^(?:mcp__.+__)?(?:edit|write|multiedit|multi_edit|apply_patch|notebookedit|str_replace_editor|create_file|edit_file|write_file)$/i.test(tool)) return "edit";
  if (tool.startsWith("mcp__")) return "app";
  return "other";
}
