// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A GitHub link in a reply, drawn as a compact pill with a hover or focus card. Idea from OpenMaus (Apache-2.0,
// LinkHoverCard.tsx). The pill is a real link (the same new-window path every other link takes) and the card only restates what the
// link says: owner, repo, kind, number and where it goes. No request is made to GitHub.
import { useId, useRef, useState } from "react";
import { GitCommit, GitPullRequest, CircleDot } from "lucide-react";

import { cardPlacement, type GithubRef } from "@/lib/github-refs";
import { t } from "@/lib/i18n";

const KIND_KEY = { pull: "chatLinks.github.pull", issue: "chatLinks.github.issue", commit: "chatLinks.github.commit" } as const;

export function GithubRefPill({ link }: { link: GithubRef }) {
  const Icon = link.kind === "pull" ? GitPullRequest : link.kind === "commit" ? GitCommit : CircleDot;
  const kind = t(KIND_KEY[link.kind]);
  const cardId = useId();
  const pillRef = useRef<HTMLSpanElement>(null);
  const [place, setPlace] = useState<{ horizontal: "left" | "right"; vertical: "below" | "above" }>({ horizontal: "left", vertical: "below" });
  // Measured when the card is about to show, so it never runs off the window.
  const measure = () => {
    const box = pillRef.current?.getBoundingClientRect();
    if (box) setPlace(cardPlacement(box, { width: window.innerWidth, height: window.innerHeight }));
  };
  return (
    <span ref={pillRef} onMouseEnter={measure} onFocus={measure} className="group/ghref relative inline-block align-baseline" data-testid="github-ref">
      <a
        href={link.url}
        target="_blank"
        rel="noreferrer"
        aria-label={`${kind} ${link.label}`}
        aria-describedby={cardId}
        className="inline-flex items-center gap-1 rounded-full border border-hairline/50 bg-raised px-2 py-px text-[13px] text-ink no-underline hover:border-accent/60 focus-visible:outline-2 focus-visible:outline-focus [overflow-wrap:anywhere]"
      >
        <Icon size={12} aria-hidden="true" className="shrink-0 text-ink-secondary" />
        <span>{link.label}</span>
      </a>
      <span
        id={cardId}
        role="tooltip"
        className={`pointer-events-none absolute ${place.horizontal === "right" ? "right-0" : "left-0"} ${place.vertical === "above" ? "bottom-full mb-1" : "top-full mt-1"} z-30 hidden w-72 max-w-[calc(100vw-1rem)] rounded-lg border border-hairline/50 bg-card p-3 text-left text-[12.5px] leading-snug shadow-xl shadow-black/40 group-focus-within/ghref:block group-hover/ghref:block`}
      >
        <span className="block text-ink-secondary">{kind}</span>
        <span className="mt-0.5 block font-medium text-ink [overflow-wrap:anywhere]">{link.label}</span>
        <span className="mt-1 block text-ink-secondary [overflow-wrap:anywhere]">{link.url}</span>
        <span className="mt-1.5 block text-accent">{t("chatLinks.github.open")}</span>
      </span>
    </span>
  );
}
