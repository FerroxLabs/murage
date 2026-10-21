// A bot's saved model can name an id its engine's own CLI no longer offers.
// Antigravity's CLI rejects any id outside its list (agy 1.4.3 dropped
// gemini-3.1-pro-high, which every 1.0.2 Antigravity bot had saved), so the
// turn would fail every time. Only engines whose CLI is verified to reject
// unlisted ids belong here; engines that accept custom ids are never touched.
const STRICT_LIST_ENGINES = new Set(["antigravity"]);

const ENGINE_NAME: Record<string, string> = { antigravity: "Antigravity" };

export function staleModelReplacement(
  driverKind: string,
  saved: string | undefined,
  catalog: { default: string; options: ReadonlyArray<{ id: string }> },
): string | null {
  if (!STRICT_LIST_ENGINES.has(driverKind) || !saved) return null;
  if (!catalog.options.length || catalog.options.some((option) => option.id === saved)) return null;
  return catalog.default && catalog.default !== saved ? catalog.default : null;
}

export function staleModelNotice(driverKind: string, old: string, next: string): string {
  return `${ENGINE_NAME[driverKind] ?? "This engine"} no longer offers ${old}; this bot now uses ${next}. Change it in Settings if you prefer another model.`;
}

export const LOCAL_CONTROL_OFF_NOTICE = "Local control is off, so this bot can't use the computer yet. Turn it on in Settings > Computer.";
