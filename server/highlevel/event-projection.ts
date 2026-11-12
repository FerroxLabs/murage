import type { RuntimeEvent, ItemOrigin } from "../contracts.ts";
export const ORIGIN_VARIANTS = [["item.started", "tool"], ["item.completed", "assistant_text"]] as const;
/** Only these variants declare origin; tool completions remain origin-free. */
export function originRequired(e: RuntimeEvent): e is Extract<RuntimeEvent, { origin: ItemOrigin }> {
  void e; throw new Error("C4 implements");
}
