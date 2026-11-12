// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { validBoot, dataDirIdentity, dataDirLeasePaths } from '../../../electron/data-dir-lease.mjs';
import { ParkFs, refuse, isAtomicTemp } from './park-fs.ts';
import { parseSignalConnectionRecord, type SignalConnectionRecord } from './connection-record.ts';
const num = z.number().int().safe().nonnegative(), digest = z.string().regex(/^[a-f0-9]{64}$/);
export const idSchema = z.string().regex(/^[a-zA-Z0-9-]{1,100}$/);
export const bundleNameSchema = z.string().regex(/^[a-zA-Z0-9-]{1,100}\.g(?:0|[1-9][0-9]*)(?:\.(?:[2-9]|[1-5][0-9]|6[0-4]))?$/);
const rootSchema = z.strictObject({ identity: digest, dev: num, ino: num });
const connectionSchema = z.strictObject({ connectionId: idSchema, generation: num, bindingDigest: digest.nullable(), revoking: z.boolean(), restoring: z.boolean(), problem: z.string().max(100).nullable() });
export const componentSchema = z.strictObject({ present: z.boolean(), fp: digest.nullable(), entries: num.max(200_000), bytes: num.max(8 * 1024 ** 3) })
  .refine(x => x.present ? x.fp !== null && x.entries > 0 : x.fp === null && x.entries === 0 && x.bytes === 0);
const heldSchema = z.strictObject({ reason: z.enum(['superseded', 'moved', 'unreadable', 'conflict']), at: num, by: z.string().max(200) });
export const parkSchema = z.strictObject({ version: z.literal(3), runId: z.uuid(), bundleName: bundleNameSchema, seq: num,
  state: z.enum(['parking', 'parked', 'restoring', 'restored', 'held']), next: z.strictObject({ component: z.enum(['auth', 'channel']), direction: z.enum(['park', 'restore']) }).nullable(),
  held: heldSchema.optional(), root: rootSchema, installId: z.uuid(), connection: connectionSchema.nullable(),
  components: z.strictObject({ auth: componentSchema, channel: componentSchema }), parkedBy: z.string().min(1).max(100), parkedAt: num,
}).superRefine((j, ctx) => {
  const id = j.connection?.connectionId ?? j.bundleName.split('.g')[0]!, generation = j.connection?.generation ?? 0;
  const base = `${id}.g${generation}`;
  if (j.bundleName !== base && !new RegExp(`^${base.replace(/[.]/g, '\\.')}\\.(?:[2-9]|[1-5][0-9]|6[0-4])$`).test(j.bundleName)) ctx.addIssue({ code: 'custom', message: 'Bundle binding' });
  if ((!j.connection && j.state !== 'held') || (j.state === 'held' && !j.held) || (j.state !== 'held' && j.held)) ctx.addIssue({ code: 'custom', message: 'Terminal binding' });
});
export type ParkJournal = z.infer<typeof parkSchema>;
const childSchema = z.strictObject({ token: z.uuid(), epoch: z.uuid(), host: z.string().min(1).max(255), boot: z.string().refine(validBoot).nullable(), uptime: num.nullable(),
  generation: num, state: z.enum(['spawning', 'running', 'exited']), pid: z.number().int().positive().max(0x7fffffff).nullable(), start: z.string().regex(/^[0-9]{1,20}$/).nullable(),
});
const replacementSchema = z.strictObject({ id: z.uuid(), phase: z.enum(['intent', 'excluded', 'revoked', 'moving', 'ready']),
  oldBundles: z.array(bundleNameSchema).max(64), connectionIds: z.array(idSchema).max(4096), runIds: z.array(z.string().min(1).max(200)).max(20_000),
  freshId: z.uuid(), live: parkSchema.nullable(),
});
export type Replacement = z.infer<typeof replacementSchema>;
const decisionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('held'), reason: heldSchema.shape.reason, runId: z.uuid().optional() }),
  z.strictObject({ kind: z.literal('cleanup'), manifest: parkSchema.refine(j=>j.state==='restored') }),
]);
export const controlSchema = z.strictObject({ version: z.literal(1), seq: num,
  decisions: z.record(bundleNameSchema, decisionSchema).refine(d => Object.keys(d).length <= 4096),
  replacements: z.array(replacementSchema).max(64), child: childSchema.nullable(),
});
export type ParkControl = z.infer<typeof controlSchema>;
export const pathsFor = (root: string) => ({ signal: join(root, 'signal'), channel: join(root, 'channels/signal'),
  bundles: join(root, 'recovery-quarantine/signal-parked'), control: join(root, 'recovery-quarantine/signal-park-control/control.json') });
export function readControl(io: ParkFs): ParkControl {
  const file = pathsFor(io.root).control, dir = join(io.root, 'recovery-quarantine/signal-park-control');
  for (const name of io.list(dir, 4096)) {
    if (name !== 'control.json' && !isAtomicTemp(name,'control.json')) refuse('unsafe');
    if (!io.checked(join(dir, name), true)?.isFile()) refuse('unsafe');
    if (io.checked(join(dir, name), true)!.size > 1024 * 1024) refuse('bound');
  }
  if (!io.checked(file)) return { version: 1, seq: 0, decisions: {}, replacements: [], child: null };
  return controlSchema.parse(JSON.parse(io.read(file, 1024 * 1024).toString('utf8')));
}
export function writeControl(io: ParkFs, control: ParkControl, required = false) {
  if(readControl(io).seq!==control.seq)refuse('conflict');
  const next = controlSchema.parse({ ...control, seq: control.seq + 1 });
  io.write(pathsFor(io.root).control, next, 1024 * 1024, required); Object.assign(control, next);
}
export function installationBinding(io: ParkFs) {
  const install = z.strictObject({ installId: z.uuid() }).parse(JSON.parse(io.read(join(io.root, 'install-id.json')).toString('utf8')));
  const canonical = dataDirLeasePaths(io.root).canonicalDataDir;
  return { root: { identity: dataDirIdentity(canonical), dev: io.rootStat.dev, ino: io.rootStat.ino }, installId: install.installId };
}
export function sameRoot(io: ParkFs, journal: Pick<ParkJournal, 'root' | 'installId'>) {
  const current = installationBinding(io); return JSON.stringify(current) === JSON.stringify({ root: journal.root, installId: journal.installId });
}
export function connectionSnapshot(record: SignalConnectionRecord): NonNullable<ParkJournal['connection']> {
  return { connectionId: record.connectionId, generation: record.generation,
    bindingDigest: record.binding ? createHash('sha256').update(JSON.stringify(record.binding)).digest('hex') : null,
    revoking: record.revoking, restoring: record.restoring ?? false, problem: record.problem ?? null };
}
export function readConnection(io: ParkFs, channel: string): SignalConnectionRecord {
  const names = io.list(channel, 200_000);
  if (!names.includes('connection.json')) refuse('conflict');
  for (const name of names) {
    if (name === 'connection.json' || isAtomicTemp(name,'connection.json')) {
      if (!io.checked(join(channel, name), true)?.isFile()) refuse('unsafe');
    } else if (!idSchema.safeParse(name).success || !io.checked(join(channel, name))?.isDirectory()) refuse('unsafe');
  }
  return parseSignalConnectionRecord(JSON.parse(io.read(join(channel, 'connection.json')).toString('utf8')));
}
export function excludeBundle(io: ParkFs, control: ParkControl, name: string, reason: z.infer<typeof heldSchema>['reason'], journal?: ParkJournal, required = true) {
  bundleNameSchema.parse(name);
  if (control.decisions[name]) { if (required) io.barrier(join(io.root, 'recovery-quarantine/signal-park-control'), true); return; }
  control.decisions[name] = { kind: 'held', reason, ...(journal ? { runId: journal.runId } : {}) };
  writeControl(io, control, required);
  if (journal && journal.state !== 'held') {
    journal.state = 'held'; journal.next = null; journal.held = { reason, at: Date.now(), by: 'murage' }; journal.seq++;
    io.write(join(pathsFor(io.root).bundles, name, 'park.json'), parkSchema.parse(journal));
  }
}
