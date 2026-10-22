// A bot's saved model can name an id its engine's own CLI no longer offers.
// Antigravity's CLI rejects any id outside its list (agy 1.4.3 dropped
// gemini-3.1-pro-high, which every 1.0.2 Antigravity bot had saved), so the
// turn would fail every time. Only engines whose CLI is verified to reject
// unlisted ids belong here (opencodeGo: its models are live from `opencode
// models`; cursorAgent: guard, cursor-agent rejects unlisted ids); engines that accept custom ids are never touched.
const STRICT_LIST_ENGINES = new Set(["antigravityAgent", "antigravity", "opencodeGo", "cursorAgent"]);

const ENGINE_NAME: Record<string, string> = { antigravityAgent: "Antigravity", antigravity: "Antigravity", opencodeGo: "OpenCode", cursorAgent: "Cursor" };

export function staleModelReplacement(
  driverKind: string,
  saved: string | undefined,
  catalog: { default: string; options: ReadonlyArray<{ id: string }>; source?: "live" | "static" },
): string | null {
  if (!STRICT_LIST_ENGINES.has(driverKind) || !saved) return null;
  // Only a successful live list in this process may judge a saved id gone: a
  // timed-out or failed probe falls back to a built-in list that knows nothing
  // of the person's custom providers.
  if (catalog.source !== "live") return null;
  if (!catalog.options.length || catalog.options.some((option) => option.id === saved)) return null;
  // OpenCode takes ids from any provider the person configured. An id whose
  // provider the live list does not mention at all is theirs, not retired.
  if (driverKind === "opencodeGo") {
    const prefix = saved.split("/")[0];
    if (!catalog.options.some((option) => option.id.split("/")[0] === prefix)) return null;
  }
  return catalog.default && catalog.default !== saved ? catalog.default : null;
}

export function staleModelNotice(driverKind: string, old: string, next: string): string {
  return `${ENGINE_NAME[driverKind] ?? "This engine"} no longer offers ${old}; this bot now uses ${next}. Change it in Settings if you prefer another model.`;
}

export const LOCAL_CONTROL_OFF_NOTICE = "Local control is off, so this bot can't use the computer yet. Turn it on in Settings > Computer.";
