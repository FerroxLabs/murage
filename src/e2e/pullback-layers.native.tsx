// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Actual independently owned native children, including loaded crash/retry.
import { StrictMode, useLayoutEffect, useState, type ComponentType } from 'react';
import { LazyOverlay, type LoadedLayerProps } from '../components/LazyOverlay';
import { retryableLazy } from '../components/LazyBoundary';
import type { LocalEngineLoginBridge } from '../lib/local-engine-login';
export type NativeCase = 'export' | 'shortcuts' | 'close-project' | 'end-project' | 'bundle' | 'whats-new' | 'engine-link' | 'engine-signin';
type Props = { lifecycle: LoadedLayerProps; crash: boolean };
const bridge: LocalEngineLoginBridge = {
  preview: async () => ({ ok: true, kind: 'none', label: 'Fixture engine', accountRoot: 'Fixture only' }),
  start: async () => { throw Error('Unexpected engine start'); },
  openTerminal: async () => { throw Error('Unexpected terminal start'); },
  stop: async () => ({ ok: true }), onData: () => () => {}, onClosed: () => () => {},
};
export async function loadNative(name: NativeCase): Promise<ComponentType<Props>> {
  let Body: ComponentType<{ lifecycle: LoadedLayerProps }>;
  switch (name) {
    case 'export': { const { TeamExportDialog } = await import('../components/TeamExportDialog'); Body = ({ lifecycle }) => <TeamExportDialog layerLifecycle={lifecycle} onClose={lifecycle.dismiss} onExported={() => {}} />; break; }
    case 'shortcuts': { const { KeyboardShortcutsDialog } = await import('../components/KeyboardShortcutsDialog'); Body = ({ lifecycle }) => <KeyboardShortcutsDialog layerLifecycle={lifecycle} open onClose={lifecycle.dismiss} />; break; }
    case 'close-project': { const { default: Dialog } = await import('../components/CloseProjectDialog'); Body = ({ lifecycle }) => <Dialog layerLifecycle={lifecycle} groupId="fixture-project" onClose={lifecycle.dismiss} />; break; }
    case 'end-project': { const { default: Dialog } = await import('../components/EndProjectDialog'); Body = ({ lifecycle }) => <Dialog layerLifecycle={lifecycle} groupId="fixture-project" onClose={lifecycle.dismiss} />; break; }
    case 'bundle': { const { BundleImportDialog } = await import('../components/BundleImportDialog'); Body = ({ lifecycle }) => <BundleImportDialog layerLifecycle={lifecycle} archivePath="fixture.zip" fileName="fixture.zip" onClose={lifecycle.dismiss} onImported={() => {}} />; break; }
    case 'whats-new': { const { WhatsNewDialog } = await import('../components/WhatsNewDialog'); Body = ({ lifecycle }) => <WhatsNewDialog layerLifecycle={lifecycle} open version="1.0.17" releaseNotesUrl="" onClose={lifecycle.dismiss} onAction={() => {}} />; break; }
    case 'engine-link': { const { EngineChatLinkDialog } = await import('../components/EngineChatLinkDialog'); Body = ({ lifecycle }) => <EngineChatLinkDialog layerLifecycle={lifecycle} show="signed-in" bridge={bridge} instance={{ instanceId: 'fixture', displayName: 'Fixture', driverKind: 'fixture', snapshot: { state: 'available' }, models: { default: 'fixture', options: [] } }} onClose={lifecycle.dismiss} />; break; }
    case 'engine-signin': { const { EngineSignInDialog } = await import('../components/EngineSignInDialog'); Body = ({ lifecycle }) => <EngineSignInDialog layerLifecycle={lifecycle} bridge={bridge} instanceId="fixture" name="Fixture" onClose={lifecycle.dismiss} />; break; }
  }
  return function Crashable({ lifecycle, crash }: Props) {
    if (crash) throw Error('Fixture loaded native crash');
    return <Body lifecycle={lifecycle} />;
  };
}
declare global { interface Window { pullbackNativeCrash: (value: boolean) => void; } }
function NativeOwner({ name, loaded, onClose }: { name: NativeCase; loaded?: ComponentType<Props>; onClose: () => void }) {
  const [crash, setCrash] = useState(false);
  const [chunk] = useState(() => retryableLazy(async () => ({ default: await loadNative(name) })));
  useLayoutEffect(() => { window.pullbackNativeCrash = setCrash; }, []);
  const Child = loaded ?? chunk.Component;
  return <LazyOverlay name="native-fixture-load" kind="dialog" covers="while-loading" fallback={null} onDismiss={onClose} onRetry={chunk.retry}>
    {lifecycle => <Child lifecycle={lifecycle} crash={crash} />}
  </LazyOverlay>;
}
export function NativeFixture(props: { name: NativeCase; loaded?: ComponentType<Props>; strict: boolean; onClose: () => void }) {
  return props.strict ? <StrictMode><NativeOwner {...props} /></StrictMode> : <NativeOwner {...props} />;
}
