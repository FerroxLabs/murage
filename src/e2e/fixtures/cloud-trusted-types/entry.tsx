// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Cloud home's markup sinks in one built page (src/e2e/cloud-trusted-types.human.spec.ts): a chat bubble with
// markdown, a highlighted code block, maths and a diagram, the animated and still mascot, and an artifact preview
// frame. It starts the way src/main.tsx does, so the "murage" policy exists before React renders.
import "@/lib/zod-config";
import { installTrustedTypes, sanitizerReady } from "@/lib/trusted-html";
import { createRoot } from "react-dom/client";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { BotAvatar } from "@/components/Avatar";
import { RootErrorBoundary } from "@/components/RootErrorBoundary";
import { artifactPreviewHtml } from "@/components/Files";
import { SandboxedFrame } from "@/components/SandboxedFrame";
import { registerServiceWorker } from "@/lib/register-sw";
import "@/styles.css";

installTrustedTypes();
registerServiceWorker();

const CHAT = [
  "# Weekly notes",
  "",
  "**Bold**, _italic_ and `inline code`, with a [link](https://example.com).",
  "",
  "```ts",
  "const total = [1, 2, 3].reduce((sum, n) => sum + n, 0);",
  "```",
  "",
  "$$E=mc^2$$",
  "",
  "and inline \\(a^2+b^2=c^2\\) too.",
  "",
  "```mermaid",
  "flowchart TD",
  "  A[Start] --> B{Is it?}",
  "  B -->|Yes| C[OK]",
  "```",
].join("\n");
const PREVIEW = '<!doctype html><html><head><style>h1{color:#c33}</style></head><body><h1 id="preview-title">Report</h1><p onclick="parent.__pwned=1">Body</p><script>parent.__pwned=2</script><a href="https://example.com">away</a></body></html>';
const bot = { name: "Vega", color: "orange" as const };

void sanitizerReady().then(() => createRoot(document.getElementById("root")!).render(
  <RootErrorBoundary>
    <div data-testid="chat"><ChatMarkdown text={CHAT} /></div>
    <div data-testid="avatar-animated"><BotAvatar bot={bot} size={96} /></div>
    <div data-testid="avatar-still"><BotAvatar bot={bot} size={96} animated={false} /></div>
    <SandboxedFrame data-testid="preview" title="Preview" sandbox="" referrerPolicy="no-referrer" html={artifactPreviewHtml(PREVIEW)} style={{ width: "100%", height: 200, background: "white" }} />
  </RootErrorBoundary>,
));
