// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// THE ONE SHAPE OF A BOX (Sean 11-01). Title and buttons at the top, the content
// in the middle, a Save row at the bottom, and only the middle scrolls.
//
// The head and the foot sit outside the scroller instead of being pinned inside
// it. So nothing can slide under them, the scrollbar is the body's alone, and a
// focused field scrolls into the body's own view and never behind the head.
//
//   <div role="dialog" aria-modal="true" className={cn(BOX_FRAME, "max-h-[...] w-[...]")}>
//     <BoxHead>title and buttons</BoxHead>
//     <BoxBody>content</BoxBody>
//     <BoxFoot>Save</BoxFoot>
//   </div>
//
// A native <dialog> uses BOX_DIALOG instead, because `display: flex` would show
// a closed dialog. When a child component draws the head and the body, the root
// names it: data-box-content="Inbox". A box with a side list uses BOX_PANES and gives each pane its
// own scroller. src/components/ui/box-shell.test.ts fails any new box that skips
// this file.
import type { ComponentPropsWithRef } from "react";
import { cn } from "@/lib/cn";

/** Root of a box built on a plain element. overflow-clip, not overflow-hidden: a hidden box can still be scrolled by focus, which slides the head away. */
export const BOX_FRAME = "flex min-h-0 flex-col overflow-clip";
/** Root of a box built on a native dialog element. box-dialog (styles.css) keeps it centred in what the on-screen keyboard leaves. */
export const BOX_DIALOG = "box-dialog min-h-0 overflow-clip open:flex open:flex-col";
/** Root of a box with panes side by side, such as a section list beside a page. */
export const BOX_PANES = "flex min-h-0 overflow-clip";
/** The Save row of a long form inside a page that has more than that form. It holds to the bottom of the page's scroller for as long as its form is on screen, and gives way with the form. Give it the form's own background. A sticky edge stops at the scroller's padding, so a scroller with bottom padding states it in --box-pad and the row sits on the true edge, with nothing showing beneath it. */
export const BOX_SAVE_ROW = "sticky bottom-[calc(-1*var(--box-pad,0px))] z-10 py-2";

export function BoxHead({ className, ...props }: ComponentPropsWithRef<"header">) {
  return <header data-box-head {...props} className={cn("flex shrink-0 items-center justify-between gap-3", className)} />;
}

/** The only part of a box that scrolls. scroll-py gives a focused field room inside the view. */
export function BoxBody({ className, ...props }: ComponentPropsWithRef<"div">) {
  return <div data-box-body {...props} className={cn("min-h-0 min-w-0 flex-auto scroll-py-3 overflow-y-auto overscroll-contain", className)} />;
}

export function BoxFoot({ className, ...props }: ComponentPropsWithRef<"footer">) {
  return <footer data-box-foot {...props} className={cn("flex shrink-0 items-center justify-end gap-2", className)} />;
}
