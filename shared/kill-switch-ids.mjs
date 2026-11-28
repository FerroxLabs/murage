// Fixed registry of memory/recall kill switches (designs/RINGS-DESIGN.md K1, K5). A manifest id not listed here
// is ignored, so an older build never misreads a newer id. Kills only turn a feature off (K2).
export const KILL_SWITCH_IDS = Object.freeze([
  "memory.recall.inject",
  "memory.prewarm",
  "memory.capture",
  "memory.embed.local",
  "memory.rebuild",
]);
