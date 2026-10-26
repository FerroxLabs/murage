// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, type ReactNode } from "react";
import { DesktopImg } from "@/components/DesktopImg";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { libraryArtUrl, type LibraryArtSize } from "@/lib/library-art";

/** A template's artwork in the bot and team libraries. When the slug has no
 *  shipped image the placeholder passed as `fallback` shows, exactly as it did
 *  before the art existed. The installed bot's own avatar is not this: it keeps
 *  its mascot shape and colour. */
export function LibraryArt({
  slug,
  name,
  team,
  size,
  className,
  fallback,
}: {
  slug: string;
  name: string;
  /** a team of several bots rather than a single bot */
  team: boolean;
  size: LibraryArtSize;
  className?: string;
  fallback: ReactNode;
}) {
  // Keyed by slug so a failure on one template never hides the next one's art.
  const [failed, setFailed] = useState<string | null>(null);
  const url = libraryArtUrl(slug, size);
  if (!url || failed === slug) return <>{fallback}</>;
  return (
    <DesktopImg
      src={url}
      alt={t(team ? "library.art.teamAlt" : "library.art.botAlt", { name })}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(slug)}
      className={cn("shrink-0 rounded-xl library-art-backdrop object-cover", className)}
    />
  );
}
