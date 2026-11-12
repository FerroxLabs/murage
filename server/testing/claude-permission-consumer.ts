// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// A dependency-free fake of Claude Code's permission-prompt consumer, not the CLI.
// Source: @anthropic-ai/claude-code 2.1.305: FJt/rs/RA; 2.1.81: wTY.
// Require updatedInput as in 2.1.81, so replies work with older consumers too.
// Token counts are injected: fixtures can exercise overflow without a tokenizer
// or any model/network request. The real CLI counts tokens after a cheap estimate.
export function consumePermissionResult(
  result: { content: Array<{ type: string; text: string }> },
  env: NodeJS.ProcessEnv,
  tokens: number,
  mode: "persist" | "truncate" = "persist",
): { behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string } {
  const limit = parseInt(env.MAX_MCP_OUTPUT_TOKENS ?? "25000", 10);
  const content = tokens > limit
    ? mode === "persist" ? "Error: result exceeds maximum allowed tokens. Output has been saved to a file."
      : result.content.map((block) => ({ ...block, text: block.text.slice(0, limit * 4) }))
    : result.content;
  if (!Array.isArray(content) || content[0]?.type !== "text" || typeof content[0]?.text !== "string") {
    throw new Error('Permission prompt tool returned an invalid result. Expected a single text block param with type="text" and a string text value.');
  }
  const decision = JSON.parse(content[0].text);
  if (decision.behavior === "allow" && decision.updatedInput && typeof decision.updatedInput === "object" && !Array.isArray(decision.updatedInput)) return decision;
  if (decision.behavior === "deny" && typeof decision.message === "string") return decision;
  throw new Error("Permission prompt tool returned a schema-invalid result");
}
