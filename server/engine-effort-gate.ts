/** ACP-EFFORT L2: whether a turn is refused (409) for the bot's engine-wide `effort`. An engine that picks effort per model
 *  (`effortMode: "model"`) never refuses: the field is ignored at turn time, and the save path still validates it. */
export function turnEffortRefused(capabilities: { effortLevels?: readonly string[]; effortMode?: "model" }, effort: string | undefined): boolean {
  if (!effort) return false;
  if (capabilities.effortMode === "model") return false;
  return !capabilities.effortLevels?.includes(effort);
}
