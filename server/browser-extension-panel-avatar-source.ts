// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PanelAvatarProbe, PanelAvatarRead, Token } from './browser-extension-panel-avatar.ts';
export function panelAvatarSource(deps: {
  removalState(name: string): Promise<'removed' | 'present' | 'error'>;
  probeServedImage(name: string): Promise<{ ok: true; id: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint } } | { ok: false; reason: string }>;
  readAttachment(name: string): Promise<{ ok: true; bytes: Buffer; version: string } | { ok: false; reason: string }>;
}) {
  return {
    async probe(url: string, token?: Token): Promise<PanelAvatarProbe> {
      if (token?.expired) return { state: 'error' };
      const name = url.slice('/api/attachments/'.length);
      const state = await deps.removalState(name);
      if (token?.expired) return { state: 'error' };
      if (state !== 'present') return { state };
      const seen = await deps.probeServedImage(name);
      if (token?.expired) return { state: 'error' };
      if (seen.ok) return { state: 'ok', stamp: `${seen.id.dev}:${seen.id.ino}:${seen.id.size}:${seen.id.mtimeNs}:${seen.id.ctimeNs}` };
      return { state: seen.reason === 'io' || seen.reason === 'busy' ? 'error' : 'removed' };
    },
    async read(url: string, token?: Token): Promise<PanelAvatarRead> {
      if (token?.expired) return { state: 'error' };
      const name = url.slice('/api/attachments/'.length);
      const state = await deps.removalState(name);
      if (token?.expired) return { state: 'error' };
      if (state !== 'present') return { state: state === 'removed' ? 'gone' : 'error' };
      const read = await deps.readAttachment(name);
      if (token?.expired) return { state: 'error' };
      if (read.ok) return { state: 'ok', bytes: read.bytes, version: read.version };
      return { state: read.reason === 'io' || read.reason === 'busy' ? 'error' : 'gone' };
    },
  };
}
