// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one list of modules that claim learning routes. Each later batch adds
// ONE import line here (B1 outcomes, B2 feedback, B3 lessons, B4 admission,
// B5 learning screen: bot-suggestions-routes.ts) and calls registerLearningRoute inside its module.
// server/index.ts only imports this file, so it never changes again.
import "./bot-lessons-routes.ts";
import "./memory/outcomes-routes.ts";
import "./bot-learning-counts-routes.ts";
import "./bot-suggestions-routes.ts";
import "./bot-learning-data-routes.ts";
export {};
