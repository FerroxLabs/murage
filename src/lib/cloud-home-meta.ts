// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which Cloud home served this page, read from the meta tags the home writes into index.html. Its own module so the first
// paint can ask it (src/main.tsx) without loading the door itself (src/lib/cloud-door.ts), which only a Cloud home needs.
export function homeMeta(doc: Pick<Document, "querySelector">): { homeId: string | null; siteOrigin: string | null } {
  const read = (name: string) => doc.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? null;
  return { homeId: read("murage-home-id"), siteOrigin: read("murage-site-origin") };
}
