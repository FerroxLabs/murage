// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Long request text on an approval card (an image prompt, a long tool
// input). Collapsed it is about four lines with a real toggle button; expanded
// it is a block that scrolls inside a height tied to the viewport, so the card
// can never grow past the screen and push Allow, Deny and the composer out of
// reach. Short text renders exactly as before, with no toggle.
import { useId, useState, type ReactNode } from "react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";

/** Past about four lines on a phone: by length, or by line count. */
const LONG_CHARS = 240;
const LONG_LINES = 5;

export function isLongText(text: string): boolean {
  return text.length > LONG_CHARS || text.split("\n").length > LONG_LINES;
}

export function CollapsibleText({
  text,
  as: Tag = "div",
  className,
  ariaLabel,
  initiallyExpanded = false,
  children,
}: {
  text: string;
  as?: "div" | "pre";
  /** type and colour of the text itself */
  className?: string;
  ariaLabel?: string;
  /** a render starts expanded (tests; the owner always starts collapsed) */
  initiallyExpanded?: boolean;
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const id = useId();
  const long = isLongText(text);
  if (!long) {
    return <Tag tabIndex={Tag === "pre" ? 0 : undefined} aria-label={ariaLabel} className={cn("whitespace-pre-wrap break-words", className)}>{children ?? text}</Tag>;
  }
  return (
    <div>
      <Tag
        id={id}
        data-approval-held={expanded ? "expanded" : "collapsed"}
        tabIndex={expanded || Tag === "pre" ? 0 : undefined}
        aria-label={ariaLabel}
        className={cn(
          "whitespace-pre-wrap break-words",
          className,
          expanded ? "max-h-[35dvh] overflow-y-auto" : "line-clamp-4 overflow-hidden",
        )}
      >
        {children ?? text}
      </Tag>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={id}
        onClick={() => setExpanded((open) => !open)}
        className="-ml-2 mt-1 inline-flex min-h-11 items-center rounded-full px-3 text-[13px] font-medium text-accent hover:bg-control focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        {expanded ? t("approval.showLess") : t("approval.showFull")}
      </button>
    </div>
  );
}
