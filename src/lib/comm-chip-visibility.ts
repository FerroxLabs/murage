// What tapping a "Messaged @X" comm chip (ChatView's ActivityChip) does. A
// companion (phone) never receives a bot⇄bot group — the server's
// `visibleToCompanion` (server/sse-visibility.ts) keeps `dm: true` groups
// off it — so its `groups` never carries that id. Selecting an id state
// does not have used to fall through to `state.bots[0]` in App.tsx (E1,
// 2026-09-28): tapping Dax's "Messaged @Kessler" chip opened Numbers
// instead. This keeps the phone from ever trying. Desktop always has every
// group, so it keeps opening exactly as it does today.
export function commChipAction({
  phone,
  groupId,
  groups,
}: {
  phone: boolean;
  groupId: string;
  groups: Array<{ id: string }>;
}): "open" | "blocked" {
  if (!phone) return "open";
  return groups.some((g) => g.id === groupId) ? "open" : "blocked";
}
