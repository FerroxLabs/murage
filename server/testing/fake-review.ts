// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// Fixture: how a fake engine answers a project review run (lane review). With
// FAKE_REVIEW_VERDICT set (pass | changes | none), a turn whose prompt carries
// a review block instruction answers with that verdict in the block, reading
// the nonce from the prompt as a model does; "none" answers in plain words
// with no verdict. FAKE_REVIEW_TOOL=1 makes the engines that mount the agents
// server send it through project_review_result instead (card_id read from the
// prompt). Dependency-free: it runs inside the fake CLIs.

export function fakeReviewReply(prompt: string): string | null {
  const verdict = process.env.FAKE_REVIEW_VERDICT;
  const nonce = /<murage-review nonce="([a-f0-9]{32})">/.exec(prompt)?.[1];
  if (!verdict || !nonce) return null;
  if (verdict === "none") return "I read the result. It looks about right to me.";
  return `I checked the result against the card.\n<murage-review nonce="${nonce}">\n${verdict}\nFixture review note.\n</murage-review>`;
}

export const fakeReviewByTool = () => process.env.FAKE_REVIEW_TOOL === "1" && (process.env.FAKE_REVIEW_VERDICT === "pass" || process.env.FAKE_REVIEW_VERDICT === "changes");

/** The project_review_result input for the review in this prompt. */
export function fakeReviewToolArgs(prompt: string): { card_id: string; verdict: string; notes: string } {
  return { card_id: /card_id "([^"]+)"/.exec(prompt)?.[1] ?? "", verdict: process.env.FAKE_REVIEW_VERDICT ?? "", notes: "Fixture tool review." };
}
