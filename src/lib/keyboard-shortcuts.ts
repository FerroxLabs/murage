// Display-only reference inspired by upstream #946; no global key listener.
// Each entry corresponds to the named handler in the current Murage source.
export interface Shortcut { id: string; description: string; keys: string[]; context: string }
export interface ShortcutGroup { title: string; items: Shortcut[] }
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  { title: "Navigation", items: [
    { id: "palette", description: "Search and switch conversations", keys: ["Mod", "K"], context: "Command palette" },
    { id: "new-bot", description: "Create a new bot", keys: ["Mod", "N"], context: "App-wide" },
    { id: "jump-bot", description: "Jump to bot 1–9", keys: ["Mod", "1–9"], context: "Visible roster order" },
    { id: "find", description: "Find in the current conversation", keys: ["Mod", "F"], context: "Bot or channel" },
    { id: "close", description: "Close the focused dialog or search", keys: ["Escape"], context: "Dialog, palette or find bar" },
  ] },
  { title: "Composer", items: [
    { id: "send", description: "Send the draft", keys: ["Enter"], context: "When ready; suggestion menu closed" },
    { id: "newline", description: "Insert a new line", keys: ["Shift", "Enter"], context: "Composer" },
    { id: "edit", description: "Edit your last message", keys: ["↑"], context: "Empty composer, when editing is available" },
    { id: "suggestion", description: "Choose the highlighted suggestion", keys: ["Enter / Tab"], context: "Mention or slash-command menu" },
  ] },
  { title: "Workspace", items: [
    { id: "bulletin", description: "Save a channel bulletin", keys: ["Mod", "Enter"], context: "Bulletin editor" },
    { id: "reorder", description: "Move a sidebar section", keys: ["Alt", "↑ / ↓"], context: "Focused, movable section heading" },
  ] },
];
export function shortcutPlatformIsMac(): boolean {
  if (typeof window !== "undefined" && window.muragebox?.platform) return window.muragebox.platform === "darwin";
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
}
export function shortcutKeys(item: Shortcut, mac: boolean): string[] {
  return item.keys.map(key => key === "Mod" ? mac ? "⌘" : "Ctrl" : key === "Alt" && mac ? "Option" : key === "Escape" ? "Esc" : key === "Enter" && mac ? "Return" : key);
}
export function filterShortcuts(query: string, mac: boolean): ShortcutGroup[] {
  const q = query.trim().toLowerCase();
  return SHORTCUT_GROUPS.map(group => ({ ...group, items: group.items.filter(item =>
    `${group.title} ${item.description} ${item.context} ${shortcutKeys(item, mac).join(" ")} ${item.keys.join(" ")} ${item.keys.includes("Mod") ? mac ? "command cmd" : "control ctrl" : ""}`.toLowerCase().includes(q),
  ) })).filter(group => group.items.length > 0);
}
