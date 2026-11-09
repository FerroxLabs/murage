// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Mounted by the fixture transform INSIDE actual Settings' slot context.
import { useEffect, useState } from 'react';
import { ModelPicker } from '../components/ModelPicker';
import { RevokeDeviceConfirm } from '../components/CompanionSection';
import { useStore } from '../state/store';
export function PullbackControls() {
  const { state } = useStore();
  const [kind, setKind] = useState('');
  useEffect(() => {
    const show = (event: Event) => setKind((event as CustomEvent<string>).detail);
    window.addEventListener('pullback:control', show);
    return () => window.removeEventListener('pullback:control', show);
  }, []);
  if (!kind) return null;
  return <div data-pullback-controls style={{ position: 'absolute', inset: '80px 24px auto', zIndex: 1, background: 'var(--color-card)' }}>
    {kind === 'model' && <ModelPicker bot={state.bots[0]} contained />}
    {kind === 'revoke' && <RevokeDeviceConfirm name="Fixture device" busy={false} onConfirm={() => { throw Error('Unexpected revoke'); }} onCancel={() => setKind('')} />}
  </div>;
}
