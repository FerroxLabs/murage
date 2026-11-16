// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import * as archives from './no-limits-archives.ts';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
it('Y2b keeps the lane legacy archive classifier verbatim',()=>{
 const source=readFileSync(new URL('./no-limits-archives.ts',import.meta.url),'utf8');
 const legacy=source.slice(source.indexOf('export function legacyArchiveWrites(')).replace('legacyArchiveWrites(', 'archiveWrites(').replace('isLegacyArchiveCommand(name)', 'isArchiveCommand(name)');
 expect(digest(legacy)).toBe('e147ce084dbdf03ed0352b30a3a71575348f7898357e561b781eaee20b43ddad');
 expect((archives as any).legacyArchiveWrites).toBeTypeOf('function');
});
it('Y2b distinguishes the legacy cpio result from owner extraction',()=>{
 const args=['-idm','-D','/etc'];const candidates=args.map(path=>[{kind:'literal' as const,text:path,path}]);
 expect((archives as any).legacyArchiveWrites('cpio',args,candidates,'/w')).toBeUndefined();
 expect(archives.archiveWrites('cpio',args,candidates,'/w')).toEqual(['/etc']);
});
