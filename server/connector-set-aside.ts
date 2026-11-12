// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { lstatSync,opendirSync } from 'node:fs';
import { z } from 'zod';
import { ParkFs, equalManifest, refuse, type ParkFsOptions } from './channels/signal/park-fs.ts';
import { componentSchema } from './channels/signal/park-control.ts';
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const healthTemp = new RegExp(`^connector-health\\.json\\.[1-9][0-9]*\\.${uuid}\\.tmp$`);
export const connectorSourceName = (name: string) => ['connector-health.json','connector-health.json.journal','connector-notice-receipts.json'].includes(name)
  || healthTemp.test(name) || /^connector-notice-receipts\.json\.[1-9][0-9]*\.tmp$/.test(name);
const journalSchema = z.strictObject({ version:z.literal(1),id:z.uuid(),state:z.enum(['moving','moved']),
  sources:z.array(z.strictObject({ name:z.string().refine(connectorSourceName),manifest:componentSchema,dev:z.number().int().nonnegative(),ino:z.number().int().nonnegative() })).max(1024),
}).refine(j=>new Set(j.sources.map(s=>s.name)).size===j.sources.length && j.sources.every(s=>s.manifest.present));
type Journal = z.infer<typeof journalSchema>;
export function setAsideConnectors(root: string, options: ParkFsOptions = {}) {
  let namespacePresent=false;try{lstatSync(join(root,'recovery-quarantine/connector-set-aside'));namespacePresent=true;}catch(error){if((error as NodeJS.ErrnoException)?.code!=='ENOENT')throw error;}
  if(!namespacePresent){const dir=opendirSync(root);let source=false,count=0;try{for(;;){const entry=dir.readSync();if(!entry)break;if(++count>200_000||Date.now()>(options.deadline??Infinity))refuse('bound');if(connectorSourceName(entry.name)){source=true;break;}}}finally{dir.closeSync();}if(!source)return{durabilityLimited:false};}
  const io = new ParkFs(root,options), namespace = join(root,'recovery-quarantine/connector-set-aside');
  // A previous mkdir may have committed before its parent barrier. Reconfirm
  // the entire destination ancestry before reserving or moving anything.
  for (const parent of [root,join(root,'recovery-quarantine'),namespace]) {
    if (io.checked(parent)) io.barrier(parent);
  }
  const dirs = io.list(namespace,64); let sourceCount = 0;
  const save = (dir:string,journal:Journal) => io.write(join(dir,'set-aside.json'),journalSchema.parse(journal));
  const resume = (dir:string,journal:Journal) => {
    io.barrier(dir); io.barrier(root);
    const allowed = new Set(['set-aside.json',...journal.sources.map(s=>s.name)]);
    for (const name of io.list(dir,2048)) {
      if (!allowed.has(name) && !new RegExp(`^set-aside\\.json\\.[1-9][0-9]*\\.${uuid}\\.tmp$`).test(name)) refuse('conflict');
      const st = io.checked(join(dir,name),true); if (!st?.isFile()) refuse('unsafe');
      if (name.startsWith('set-aside.json.') && st.size > 64*1024) refuse('bound');
    }
    for (const source of journal.sources) {
      if (++sourceCount > 1024) refuse('bound');
      const from = join(root,source.name), to = join(dir,source.name), a=io.checked(from,true),b=io.checked(to,true);
      if (journal.state === 'moved') {
        // A new source after completion belongs to a new transaction.
        if (!b || b.dev!==source.dev || b.ino!==source.ino || !equalManifest(io.fingerprint(to),source.manifest)) refuse('changed');
        continue;
      }
      if (!!a === !!b) refuse('conflict');
      const here = a ? from:to, stat = (a ?? b)!;
      if (stat.dev!==source.dev || stat.ino!==source.ino || !equalManifest(io.fingerprint(here),source.manifest)) refuse('changed');
      if (a) io.move(from,to,source.manifest);
    }
    if (journal.state !== 'moved') { journal.state='moved'; save(dir,journal); }
  };
  for (const name of dirs) {
    if (!z.uuid().safeParse(name).success) refuse('unsafe');
    const dir=join(namespace,name); if (!io.checked(dir)?.isDirectory()) refuse('unsafe');
    if (!io.checked(join(dir,'set-aside.json'))) {
      // Empty/temps-only reservation has no authority to move a source.
      for (const child of io.list(dir,1024)) {
        if (!new RegExp(`^set-aside\\.json\\.[1-9][0-9]*\\.${uuid}\\.tmp$`).test(child)) refuse('conflict');
        const st=io.checked(join(dir,child),true); if (!st?.isFile() || st.size>64*1024) refuse('unsafe');
      }
      continue;
    }
    const journal=journalSchema.parse(JSON.parse(io.read(join(dir,'set-aside.json')).toString('utf8')));
    if (journal.id!==name) refuse('unsafe'); resume(dir,journal);
  }
  const names=io.list(root,200_000).filter(connectorSourceName);
  if (sourceCount+names.length>1024) refuse('bound');
  if (!names.length) return { durabilityLimited: io.durabilityLimited };
  if (dirs.length>=64) refuse('bound');
  const sources=names.map(name=>{ const stat=io.checked(join(root,name),true); if(!stat?.isFile()) refuse('unsafe'); return { name,manifest:io.fingerprint(join(root,name)),dev:stat.dev,ino:stat.ino }; });
  let id:string|undefined;
  for(let attempt=0;attempt<16;attempt++){ const candidate=randomUUID(); if(!io.checked(join(namespace,candidate))){ id=candidate;break; } }
  if(!id) refuse('bound');
  const dir=join(namespace,id); io.mkdir(dir);
  const journal:Journal={ version:1,id,state:'moving',sources };save(dir,journal);resume(dir,journal);
  return { durabilityLimited: io.durabilityLimited };
}
