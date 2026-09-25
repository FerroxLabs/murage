// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The page announcements.human.spec.ts drives. Default: the real
// AnnouncementsHost at the foot of a plain sidebar and the real Settings row
// beside it, both against the real harness (which reads a loopback stub feed).
// `?gallery=1`: every layout and accent, card and banner, drawn from static
// notices with the What's new art, for the owner to judge the look.
// `@/state/store` is aliased by the spec to a store that records dispatches.
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AnnouncementBanner, AnnouncementCard, AnnouncementsHost } from "@/components/Announcements";
import { AnnouncementsSettings } from "@/components/AnnouncementsSettings";
import type { AnnouncementView } from "@/lib/announcements";
import voiceHero from "@/assets/whats-new/voice-hero.webp";
import projectsSplit from "@/assets/whats-new/projects-split.webp";
import tileSearch from "@/assets/whats-new/tile-search.webp";
import tileHouseRules from "@/assets/whats-new/tile-houserules.webp";
import "@/styles.css";

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json" } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as { error?: string }).error ?? response.statusText);
  return data;
}
const loadImage = async (path: string) => {
  const response = await fetch(path);
  if (!response.ok) throw new Error(String(response.status));
  return response.blob();
};

function Row({ width }: { width: string }) {
  return <div className="flex items-center gap-3 rounded-xl px-3 py-2"><span className="size-7 rounded-full bg-raised" /><span className={`h-3 rounded bg-raised ${width}`} /></div>;
}

function Sidebar({ children }: { children: ReactNode }) {
  return (
    <aside className="flex w-[300px] shrink-0 flex-col gap-1 border-r border-hairline/40 bg-panel p-3">
      <div className="mb-3 h-9 rounded-xl bg-raised/60" />
      <Row width="w-32" /><Row width="w-24" /><Row width="w-40" /><Row width="w-28" />
      <div className="mt-auto" data-sidebar-footer>
        {children}
        <div className="flex h-10 items-center gap-3 rounded-xl px-3 text-[14px] text-ink-secondary">Tools</div>
      </div>
    </aside>
  );
}

function Live() {
  return (
    <div className="flex h-screen bg-app text-ink">
      <Sidebar><AnnouncementsHost desktop request={api} loadImage={loadImage} /></Sidebar>
      <main className="flex max-w-[640px] flex-1 flex-col gap-4 p-8">
        <p className="text-[14px] text-ink-secondary">The app behind the page.</p>
        <AnnouncementsSettings />
      </main>
    </div>
  );
}

const SAMPLES: Array<{ item: AnnouncementView; image: string | null }> = [
  { image: voiceHero, item: { id: "g-hero", kind: "security", layout: "hero", accent: "orange", title: "Install 0.1.61 today", body: "It closes a gap in how shared files are opened. **Your bots and chats are not affected.**\n\nIt takes about a minute.", imageAlt: "An orange waveform flowing into a glowing orb", action: { label: "Check for updates", target: "check-for-updates" } } },
  { image: projectsSplit, item: { id: "g-split", kind: "important", layout: "split", accent: "paper", title: "Projects are here", body: "Give a piece of work its own goal, files and chat. Every bot you add follows the goal.\n\nRead [how projects work](https://ferroxlabs.com/murage/projects).", imageAlt: "Small tokens around a glowing goal", link: { label: "Read more", url: "https://ferroxlabs.com/murage/projects" } } },
  { image: null, item: { id: "g-spot", kind: "important", layout: "spotlight", accent: "violet", title: "Flux is running slowly", body: "Replies from Flux models may take longer this afternoon. **Nothing is lost**; slow replies still arrive.", action: { label: "Open Models", target: "settings-models" } } },
];
const BANNERS: Array<{ item: AnnouncementView; image: string | null }> = [
  { image: tileSearch, item: { id: "b-hero", kind: "info", layout: "hero", accent: "blue", title: "Search while you talk", body: "Bots now look things up **mid-call**.", imageAlt: "A glass globe with a pulse of light", link: { label: "See how", url: "https://ferroxlabs.com/murage/search" } } },
  { image: tileHouseRules, item: { id: "b-split", kind: "info", layout: "split", accent: "gold", title: "Write House Rules once", body: "Every bot reads them first. Try a short list to start.", imageAlt: "An open notebook with a pen", action: { label: "Open House Rules", target: "settings-house-rules" } } },
  { image: null, item: { id: "b-spot", kind: "info", layout: "spotlight", accent: "mint", title: "A calmer Inbox", body: "Clear what needs nothing from you, **one at a time** or all at once." } },
];

function Gallery() {
  const noop = () => {};
  return (
    <div className="flex min-h-screen gap-8 bg-app p-8 text-ink">
      <div className="flex w-[276px] shrink-0 flex-col gap-4" data-gallery="banners">
        {BANNERS.map(({ item, image }) => <AnnouncementBanner key={item.id} item={item} imageUrl={image} onAct={noop} onDismiss={noop} />)}
      </div>
      <div className="flex flex-col gap-8" data-gallery="cards">
        {SAMPLES.map(({ item, image }) => (
          <div key={item.id} className="announce" data-accent={item.accent}>
            <AnnouncementCard item={item} imageUrl={image} onAct={noop} onDismiss={noop} />
          </div>
        ))}
      </div>
    </div>
  );
}

const params = new URLSearchParams(location.search);
document.documentElement.dataset.skin = params.get("skin") ?? "dark";
createRoot(document.getElementById("root")!).render(<StrictMode>{params.get("gallery") ? <Gallery /> : <Live />}</StrictMode>);
