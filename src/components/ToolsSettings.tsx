// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Tools (1.0.3 L4): the web search provider, images (the setup and the library tabs) and voice
// transcription first; each tool's provider keys and the daily image check under the page's one Advanced. The cards
// that hold those parts send them to the slot with <InAdvanced>.
import { Suspense, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { settingsSectionLabel } from "@/lib/settings-sections";
import { ImageSettings } from "./ImageSettings";
import { LazyBoundary, retryableLazy } from "./LazyBoundary";
import { SearchSettings } from "./SearchSettings";
import { Anchor } from "./SettingsAnchor";
import { AdvancedHost, AdvancedSection, AdvancedSlotTarget, Card } from "./SettingsPrimitives";
import { TranscriptionSettings } from "./TranscriptionSettings";
import type { PageAdvanced } from "./BotsSettings";

// The same chunk ImageSettings opens behind its button elsewhere.
const ImageLibrary = retryableLazy(() => import("./ImageLibrary"));

function ImagesSettings() {
  const [tab, setTab] = useState<"setup" | "library">("setup");
  const tabs = [
    { id: "setup" as const, label: t("settings.images.setup") },
    { id: "library" as const, label: t("settings.images.library") },
  ];
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const next = tab === "setup" ? "library" : "setup";
    setTab(next);
    document.getElementById(`images-tab-${next}`)?.focus();
  };
  return (
    <>
      <div role="tablist" aria-label={settingsSectionLabel("images")} onKeyDown={onKeyDown} className="flex gap-1 rounded-lg bg-control/50 p-1 self-start">
        {tabs.map(({ id, label }) => (
          <button
            key={id}
            id={`images-tab-${id}`}
            type="button"
            role="tab"
            aria-selected={tab === id}
            aria-controls={tab === id ? `images-panel-${id}` : undefined}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            className={cn(
              "min-h-9 rounded-md px-3.5 text-[13px] max-md:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
              tab === id ? "bg-panel font-medium text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div id={`images-panel-${tab}`} role="tabpanel" aria-labelledby={`images-tab-${tab}`} className="min-w-0">
        {tab === "setup" ? (
          <ImageSettings showLibrary={false} />
        ) : (
          <div className="rounded-xl bg-card p-4">
            <LazyBoundary inline onRetry={ImageLibrary.retry}>
              <Suspense fallback={<p role="status" className="text-[12px] text-ink-secondary">{t("imageLibrary.busy")}</p>}>
                <ImageLibrary.Component />
              </Suspense>
            </LazyBoundary>
          </div>
        )}
      </div>
    </>
  );
}

/** `cloudImagesOnly`: a Cloud window that asked for Images. Tools is computer-only there (the search and voice keys are
 *  this computer's, src/lib/cloud-settings.ts), so only the images card renders. */
export function ToolsSettings({ advanced, cloudImagesOnly = false }: { advanced: PageAdvanced; cloudImagesOnly?: boolean }) {
  return (
    <AdvancedHost>
      {!cloudImagesOnly && <Anchor id="search-settings-heading"><SearchSettings /></Anchor>}
      <ImagesSettings />
      {!cloudImagesOnly && (
        <Anchor id="voice-settings-heading">
          <Card title={t("settings.voice.title")} subtitle={t("settings.voice.note")}>
            <TranscriptionSettings />
          </Card>
        </Anchor>
      )}
      <AdvancedSection {...advanced} summary={t("settings.l4.advanced.webSearch")}><AdvancedSlotTarget /></AdvancedSection>
    </AdvancedHost>
  );
}
