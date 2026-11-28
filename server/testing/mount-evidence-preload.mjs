// Producer owner: sc-safety (relay metadata observation). Consumer owner: new3-g2 (fake engines).
// Original fixture owner: tri3-g2. Native relay owner: tri3-g1.
// Fixture-only observation of the admitted server side of a CLI relay.
// The model still receives the real shim configuration. This sidecar lives
// beside its disposable credentials and is removed with that fixture process.
import { isMainThread } from 'node:worker_threads';
import { registerHooks } from 'node:module';
if (isMainThread) registerHooks({ load(url, context, next) {
  const loaded = next(url, context);
  if (!url.endsWith('/server/drivers/cli-mount-relay.ts')) return loaded;
  const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString('utf8');
  const anchor = 'for (const [name, entry] of entries) relay.#entries.set(name, entry);';
  if (source.split(anchor).length !== 2) throw new Error('Fixture mount evidence anchor must match exactly once');
  const closeAnchor = '  close(): void {';
  if (source.split(closeAnchor).length !== 2) throw new Error('Fixture mount evidence close anchor must match exactly once');
  return { ...loaded, source: source.replace(closeAnchor, closeAnchor + `
    try { unlinkSync(this.socketPath + '.fixture-metadata.json'); } catch {}
  `).replace(anchor, anchor + `
      const fixtureMetadataFields = ['MURAGE_EMAIL', 'MURAGE_VENUE_POST', 'MURAGE_PROJECT_ROLE'];
      const fixtureMetadata = Object.fromEntries([...entries].map(([name, entry]) => [name, Object.fromEntries(fixtureMetadataFields.flatMap(key => typeof entry.env?.[key] === 'string' ? [[key, entry.env[key]]] : []))]));
      // Windows relay addresses are named pipes, not filesystem sidecar paths.
      if (process.platform !== 'win32') (await import('node:fs')).writeFileSync(relay.socketPath + '.fixture-metadata.json', JSON.stringify({mounts: fixtureMetadata}), {mode:0o600});
      if (cred) (await import('node:fs')).writeFileSync(cred.path + '.fixture-mounts.json', JSON.stringify(Object.fromEntries(entries)), {mode:0o600});
      else if (process.platform !== 'win32') {
        const fs = await import('node:fs'), evidence = relay.socketPath + '.fixture-mounts.json';
        fs.writeFileSync(evidence, JSON.stringify(Object.fromEntries(entries)), {mode:0o600});
        const remove = () => { try { fs.unlinkSync(evidence); } catch {} };
        void relay.stopped.then(remove, remove);
      }
  `) };
} });
