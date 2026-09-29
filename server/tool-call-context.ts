// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// The tool-call style of the turn a harness request serves.
//
// A refusal like "list_prompt_blocks shows the ones you can use" is written
// deep inside the image library, far from the request that knows which engine
// will read it. The agents proxy sends its turn's style on every internal call
// (shared/murage-tool-names.ts TOOL_CALL_STYLE_HEADER); the route records it
// here and such text asks for it with murageTool(). Outside a request, or for
// any caller that sent nothing, the style is "direct": the bare name, as before.
import { AsyncLocalStorage } from "node:async_hooks";
import { murageToolName, type ToolCallStyle } from "../shared/murage-tool-names.ts";

const requests = new AsyncLocalStorage<{ style?: ToolCallStyle }>();

/** One HTTP request's scope; its internal route fills in the style. */
export function withToolCallScope<T>(run: () => T): T {
  return requests.run({}, run);
}

export function setToolCallStyle(style: ToolCallStyle): void {
  const scope = requests.getStore();
  if (scope) scope.style = style;
}

/** For work that runs with a known style outside a request, and for tests. */
export function withToolCallStyle<T>(style: ToolCallStyle, run: () => T): T {
  return requests.run({ style }, run);
}

export function currentToolCallStyle(): ToolCallStyle {
  return requests.getStore()?.style ?? "direct";
}

/** A Murage agents tool, named the way the calling turn's engine calls it. */
export function murageTool(tool: string): string {
  return murageToolName(tool, currentToolCallStyle());
}
