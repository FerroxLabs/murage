import type { Page } from "@playwright/test";
import type { MemoryRecord } from "../../../shared/memory";
import type { SkillSummary } from "../../lib/skills-api";

const bot = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, color: "blue", threadId: `thread-${id}`, modelSelection: { instanceId: "fixture", model: "fixture" },
  tasks: [], messages: [], description: "", title: "", ...extra,
});
export const BOTS = [
  bot("nova", "Nova", { chiefOfStaff: true, chiefScope: "workspace" }),
  bot("ada", "Ada"), bot("bea", "Bea"), bot("cleo", "Cleo"), bot("yan", "Yan"), bot("zed", "Zed"), bot("dina", "Dina"),
  bot("amir", "Amir"), bot("ines", "Inès"), bot("kai", "Kai"), bot("luz", "Luz"), bot("mei", "Mei"),
  bot("niko", "Niko"), bot("omar", "Omar"), bot("priya", "Priya"), bot("ravi", "Ravi"), bot("sofia", "Sofía"),
  bot("tala", "Tala"), bot("uma", "Uma"), bot("wei", "Wei"), bot("yuki", "Yuki"),
  bot("research", "Research and competitive intelligence for international markets"),
  bot("operations", "Operations, customer follow-up and weekly planning coordinator"),
  bot("accessibility", "Accessibility and multilingual documentation review assistant"),
];

export const SKILLS: SkillSummary[] = [
  { ref: "collection:weekly-brief", name: "Weekly brief", description: "Summarise decisions and next steps.", kind: "collection", verdict: "clean", source: "Imported", usedBy: [{ botId: "nova", botName: "Nova", enabled: true }] },
  { ref: "collection:research-notes", name: "Research notes", description: "Keep sources beside each finding.", kind: "collection", verdict: "review", source: "Imported", usedBy: [{ botId: "ada", botName: "Ada", enabled: true }] },
  { ref: "library:meeting-prep", name: "Meeting preparation", description: "Prepare an agenda and questions.", kind: "library", verdict: "clean", source: "Library", usedBy: [] },
];
export const RECORDS: MemoryRecord[] = [
  { id: "memory-coffee", version: 1, scopeId: "workspace", kind: "fact", text: "Sean prefers coffee meetings after 10am.", assertion: "owner-statement", state: "active", ownerPinned: true, validFrom: 1794225600000, validTo: null },
  { id: "memory-brief", version: 1, scopeId: "workspace", kind: "fact", text: "Weekly briefs should include sources and next steps.", assertion: "owner-statement", state: "active", ownerPinned: false, validFrom: 1794225600000, validTo: null },
  { id: "memory-waiting", version: 1, scopeId: "workspace", kind: "fact", text: "Check whether Friday is the preferred planning day.", assertion: "assistant-inference", state: "candidate", reviewReason: "Please check this before bots use it.", ownerPinned: false, validFrom: 1794225600000, validTo: null },
];

// Same StoreProvider, SettingsModal and window owner used by App.tsx; no replacement page components.
export const fixtureEntry = `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { api, StoreProvider, useStore } from '/src/state/store.tsx';
  import { SettingsModal } from '/src/components/SettingsModal.tsx';
  import { BotSettingsDialog } from '/src/components/BotSettingsDialog.tsx';
  import { LazyOverlay } from '/src/components/LazyOverlay.tsx';
  import { useSurfaceState } from '/src/lib/use-surface.ts';
  import { isCloudOrigin } from '/src/lib/cloud-workspace.ts';
  import { openLayers } from '/src/lib/layers.ts';
  import { setSettingsMode, useSettingsMode } from '/src/lib/settings-mode.ts';
  import { applyPreference, watchSystemSkin, applySkin } from '/src/lib/skins.ts';
  import '/src/styles.css';
  applyPreference('auto');
  watchSystemSkin(applySkin);
  function Probe() {
    const { state, dispatch } = useStore();
    const surface = useSurfaceState();
    const mode = useSettingsMode();
    window.__settings = {
      open: (section, anchor) => dispatch({ type: 'toggleAppSettings', open: true, section, anchor }),
      section: () => state.appSettingsSection, mode: setSettingsMode,
      refreshConfig: async () => dispatch({ type: 'configStatus', config: await api('/api/config') }),
      layer: () => ({ desktop: surface.desktop, confirmed: surface.confirmed, cloud: isCloudOrigin(), mode,
        bridge: Boolean(window.muragebox), surface: state.config?.surface, bots: state.bots.length,
        windows: openLayers().map(({ name, kind, container }) => ({ name, kind, attached: Boolean(container) })) }),
    };
    if (!state.bots.length) return React.createElement('output', {}, 'loading');
    const settingsBot = state.settingsOpen ? state.bots.find(each => each.id === state.settingsBotId) : undefined;
    return React.createElement(React.Fragment, {}, React.createElement('output', {}, 'ready'),
      React.createElement(LazyOverlay, { name: 'settings', kind: 'window', covers: 'always', holdFocus: false,
        onRetry: () => {}, onDismiss: () => dispatch({ type: 'toggleAppSettings', open: false }) },
        settingsBot ? React.createElement(BotSettingsDialog, { key: settingsBot.id, bot: settingsBot }) : React.createElement(SettingsModal)));
  }
  createRoot(document.getElementById('root')).render(React.createElement(StoreProvider, {}, React.createElement(Probe)));
`;

export interface BridgeEvidence { failAssembly: boolean; assemblyKey: string; setup: unknown[] }
export type FixtureSurface = "desktop" | "phone" | "cloud-browser";
export type TranscriptionRoute = "flux" | "groq" | "openai" | null | undefined;
export type EvidenceWindow = Window & {
  __settings: { open(section: string, anchor?: string): void; mode(mode: "simple" | "advanced"): void;
    section(): string; refreshConfig(): Promise<void>;
    layer(): { desktop: boolean; confirmed: boolean; cloud: boolean; mode: string; bridge: boolean; surface: string; bots: number;
      windows: Array<{ name: string; kind: string; attached: boolean }> } };
  __settingsBridge: BridgeEvidence;
  __settingsCredential(name: string, value: string): Promise<unknown>;
};

// Document-start bridge installation, matching electron/preload.cjs and the native phone hello contract.
// These are isolated transport fixtures, never IPC calls to the user's desktop.
export async function installBridge(page: Page, surface: FixtureSurface) {
  await page.addInitScript(({ surface }) => {
    const win = window as unknown as EvidenceWindow;
    win.__settingsBridge = { failAssembly: false, assemblyKey: "", setup: [] };
    // A Cloud browser has neither the Electron preload nor the native phone bridge.
    if (surface === "cloud-browser") return;
    if (surface === "phone") {
      Object.assign(window, { murageNative: {
        hello: async () => ({ version: 1, methods: ["pushStatus", "signOut", "ready"] }),
        ready: async () => {}, signOut: async () => {}, on: () => () => {},
        pushStatus: async () => ({ permission: "granted", expiresAt: Date.now() + 86_400_000, enrolled: true }),
      } });
      return;
    }
    const startup = { platform: "darwin", configurable: true, keepRunning: true, canKeepRunning: true,
      effectiveKeepRunning: true, trayAvailable: true, defaultInherited: false,
      login: { supported: true, openAtLogin: false }, quitting: false, suspended: false, automationsPaused: false };
    Object.assign(window, { muragebox: {
      platform: "darwin", arch: "arm64", desktopSurfaceSecret: "fixture-proof",
      setCredential: (name: string, value: string) => win.__settingsCredential(name, value),
      applySkin: async () => {}, openExternal: async () => {},
      transcription: {
        status: async () => ({ configured: Boolean(win.__settingsBridge.assemblyKey) }),
        setKey: async (value: string) => {
          if (win.__settingsBridge.failAssembly) { win.__settingsBridge.failAssembly = false; throw new Error("Could not save AssemblyAI key. Try again."); }
          win.__settingsBridge.assemblyKey = value;
          return { configured: Boolean(value) };
        },
      },
      phoneKey: { save: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      openEngineSetupTerminal: async (input: unknown) => { win.__settingsBridge.setup.push(input); return true; },
      startup: { status: async () => startup, onChange: () => () => {}, update: async (patch: { keepRunning?: boolean; startAtLogin?: boolean }) => {
        if (patch.keepRunning !== undefined) startup.keepRunning = patch.keepRunning;
        if (patch.startAtLogin !== undefined) startup.login.openAtLogin = patch.startAtLogin;
        return startup;
      } },
    } });
  }, { surface });
}
