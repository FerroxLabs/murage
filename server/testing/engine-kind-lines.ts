// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 fuigo-emptyresp-label: the owner-facing line for every recognized engine error kind, written out here as literals
// so a witness compares production against fixed words (never against the table it is testing).
// Owner: lane fuigo-emptyresp-label-1022.
export const EXPECTED_KIND_LINES: Record<string, string> = {
  empty_response: "The model thought it through but sent no reply. Try again or switch model.",
  idle_timeout: "The model went quiet for too long, so Murage stopped waiting. Try again or switch model.",
  cancelled: "This turn was cancelled before it finished. Send your message again when you are ready.",
  rate_limited: "The AI service asked for a short pause. Wait a moment and try again.",
  auth: "The AI service did not accept the saved sign-in. Sign in again in Models & engines.",
  http: "The AI service could not be reached cleanly. Try again in a moment.",
  api: "The AI service reported a problem with this request. Try again or switch model.",
  max_tokens_truncation: "The reply reached the model's length limit and was cut short. Ask for a smaller piece or switch model.",
  doom_loop_detected: "Murage stopped this turn because the model kept repeating itself. Try rewording or switch model.",
  serialization: "The model's answer could not be read. Try again or switch model.",
  session_unavailable: "The engine's session is not available right now. Send your message again to open a fresh one.",
  internal: "The engine hit a problem of its own. Try again.",
  invalid_request: "The engine could not accept that request. Try rewording it.",
  not_found: "The engine could not find something it needed. Try again.",
  session_storage: "The engine could not save its session. Try again.",
  compaction: "The engine could not shorten the conversation to fit. Start a new chat or switch model.",
  execution_incomplete: "The engine stopped before the work was finished. Try again.",
};
