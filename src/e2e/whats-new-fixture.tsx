// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The page whats-new.human.spec.ts drives: the real WhatsNewHost, the real
// useWhatsNew against the real harness routes, and the real Tools menu, in a
// plain app frame painted with the app's own tokens so both skins show what
// surrounds the cards. `@/state/store` is aliased by the spec to a store that
// records what it is asked to do.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Megaphone } from "lucide-react";
import { SidebarMoreMenu } from "@/components/SidebarMoreMenu";
import { WhatsNewHost } from "@/components/WhatsNewHost";
import { useWhatsNew } from "@/lib/whats-new";
import "@/styles.css";

type Recorder = { __actions: string[] };
const recorder = window as unknown as Recorder;
recorder.__actions = [];

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json" } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as { error?: string }).error ?? response.statusText);
  return data;
}

function Row({ width }: { width: string }) {
  return <div className="flex items-center gap-3 rounded-xl px-3 py-2"><span className="size-7 rounded-full bg-raised" /><span className={`h-3 rounded bg-raised ${width}`} /></div>;
}

function Frame() {
  const whatsNew = useWhatsNew(true, api);
  return (
    <div className="flex h-screen bg-app text-ink">
      <aside className="flex w-[300px] shrink-0 flex-col gap-1 border-r border-hairline/40 bg-panel p-3">
        <div className="mb-3 h-9 rounded-xl bg-raised/60" />
        <Row width="w-32" /><Row width="w-24" /><Row width="w-40" /><Row width="w-28" />
        <div className="mt-auto">
          <SidebarMoreMenu items={[
            { key: "keyboard-shortcuts", label: "Keyboard shortcuts", icon: <Megaphone size={18} />, onSelect: () => {} },
            ...(whatsNew.available ? [{ key: "whats-new", label: "What's new", icon: <Megaphone size={18} />, onSelect: whatsNew.reopen }] : []),
          ]} />
        </div>
      </aside>
      <main className="flex flex-1 flex-col gap-4 p-8">
        <div className="h-12 w-3/5 rounded-2xl bg-card" />
        <div className="h-24 w-[70%] rounded-2xl bg-card" />
        <p className="text-[14px] text-ink-secondary">The app behind the page.</p>
      </main>
      <WhatsNewHost whatsNew={whatsNew} onNewProject={() => recorder.__actions.push("project")} onNavigate={() => {}} />
    </div>
  );
}

const skin = new URLSearchParams(location.search).get("skin") ?? "dark";
document.documentElement.dataset.skin = skin;
createRoot(document.getElementById("root")!).render(<StrictMode><Frame /></StrictMode>);
