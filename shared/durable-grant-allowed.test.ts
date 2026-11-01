// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-TRUST-MOMENTS-1012 test 5 (gate tier), the rule itself: a payment and a
// browser stop are never kept for good, nor the shapes the loaders drop; a
// stop key is judged by its kind, never by a folder that happens to share a
// tool's name.
import { describe, expect, it } from "vitest";

import { durableGrantAllowed, withoutRefusedGrants } from "./durable-grant-allowed.ts";
import { exactCommandKey } from "./exact-command.ts";

describe("durableGrantAllowed", () => {
  it("refuses payments, browser stops, questions, stale app shapes and bare command tools", () => {
    for (const key of ["stop:pay:stripe:brightline", "stop:browser:delete:x", "AskUserQuestion", "local-computer:mcp__box__ask_user", "PowerShell", "Bash", "other", "acp-tool:mcp:github__create_issue", "stop:unknown:x", "", "stop:delete:"]) {
      expect(durableGrantAllowed(key), key).toBe(false);
    }
  });

  it("keeps deletes, messages, public posts, programs, tools, actions, exact commands", () => {
    const exact = exactCommandKey({ engine: "claude", cwd: "/tmp", command: "git push" })!;
    for (const key of ["stop:delete:/Users/alex/site", "stop:delete:/Users/alex/question", "stop:delete:/x/y.bash", "stop:message:dana@acme.example", "stop:public:github:o/r", "Bash:git", "Read", "app-action:GMAIL_SEND_EMAIL", "ask_bot:@Helper", exact]) {
      expect(durableGrantAllowed(key), key).toBe(true);
    }
  });

  it("counts what a stored list loses", () => {
    expect(withoutRefusedGrants(["Read", "stop:pay:a:b", "stop:delete:/a", "stop:pay:c:d"])).toEqual({ kept: ["Read", "stop:delete:/a"], dropped: 2 });
  });
});
