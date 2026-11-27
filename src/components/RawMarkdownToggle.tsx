// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, type ComponentProps } from "react";
import { t } from "@/lib/i18n";
import { ChatMarkdown } from "./ChatMarkdown";

/** Both views read the same already-masked message. There is no separate
 * original-text request, and table repair applies only to the formatted view. */
export function RawMarkdownToggle(props: ComponentProps<typeof ChatMarkdown>) {
  const [raw, setRaw] = useState(false);
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-pressed={raw}
        onClick={() => setRaw(value => !value)}
        className="mb-1 min-h-8 rounded px-2 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
      >
        {t(raw ? "markdownEditor.modeRich" : "markdownEditor.modeSource")}
      </button>
      {raw
        ? <pre className="whitespace-pre-wrap font-mono text-[13px] leading-relaxed text-ink [overflow-wrap:anywhere]">{props.text}</pre>
        : <ChatMarkdown {...props} />}
    </div>
  );
}
