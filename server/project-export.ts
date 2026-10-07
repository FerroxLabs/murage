// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { ProjectLifecycleError } from "./project-close.ts";
import { projectIsClosing } from "./project-records.ts";
import { constants, openSync, closeSync, writeFileSync, fstatSync, lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { currentProjectBrief, projectSettingsFor } from './project-records.ts';
import { directory } from './project-folder-leases.ts';
export function exportProjectBrief(db:DatabaseSync, groupId:string, workRootIndex:number, hooks: {beforeOpen?():void; afterOpen?():void} = {}): string {
  const settings=projectSettingsFor(db,groupId);
  if (!settings) throw new ProjectLifecycleError('not_allowed','Not a project.');
  if (settings.endedAt !== null) throw new ProjectLifecycleError('not_allowed','This is a channel now.');
  if (settings.closedAt !== null) throw new ProjectLifecycleError('not_allowed','This project is closed.');
  if (projectIsClosing(db,groupId)) throw new ProjectLifecycleError('not_allowed','This project is closing.');
  const root=Number.isInteger(workRootIndex) && workRootIndex>=0 ? settings.workRoots[workRootIndex] : undefined;
  if (!root) throw new ProjectLifecycleError('invalid','Choose a project work folder.');
  let held: ReturnType<typeof directory>;
  try { held=directory(root.path); }
  catch { throw new ProjectLifecycleError('not_allowed','The work folder changed. Choose it again.'); }
  if (held.canonicalPath!==root.path || held.dev!==root.dev || held.ino!==root.ino) throw new ProjectLifecycleError('not_allowed','The work folder changed. Choose it again.');
  const brief=currentProjectBrief(db,groupId);
  if (!brief) throw new ProjectLifecycleError('not_allowed','No project brief yet.');
  const path=join(root.path,`project-brief-${groupId}-v${brief.version}.md`);
  hooks.beforeOpen?.();
  let fd: number;
  try {fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}
  catch (error) {
    const code=(error as NodeJS.ErrnoException).code;
    // An existing file or link is the owner's to keep; anything else is an unexpected failure.
    if (code==='EEXIST' || code==='ELOOP') throw new ProjectLifecycleError('not_allowed','The brief could not be exported. An existing file will not be overwritten.');
    // The folder went away or became a file after it was checked: the same answer as a changed folder.
    if (code==='ENOENT' || code==='ENOTDIR') throw new ProjectLifecycleError('not_allowed','The work folder changed. Choose it again.');
    throw error;
  }
  hooks.afterOpen?.();
  const file = fstatSync(fd,{bigint:true});
  const same = (path_: string) => { try { const at=lstatSync(path_,{bigint:true}); return at.isFile() && at.dev===file.dev && at.ino===file.ino; } catch { return false; } };
  let contained = false;
  try {
    const parent = lstatSync(dirname(path),{bigint:true});
    // The parent is still the chosen folder AND the name in it is the file we opened,
    // so a parent swapped away for the open and swapped back is refused too.
    contained = file.isFile() && parent.isDirectory() && parent.dev.toString()===held.dev && parent.ino.toString()===held.ino
      && realpathSync(dirname(path))===held.canonicalPath && same(path);
  } catch { /* A missing or replaced parent also refuses the write. */ }
  if (!contained) {
    closeSync(fd);
    // Remove only the empty file this call created, and only where it is still ours.
    if (same(path)) { try { unlinkSync(path); } catch { /* already gone */ } }
    throw new ProjectLifecycleError('not_allowed','The work folder changed. Choose it again.');
  }
  try {
    writeFileSync(fd,[`# ${brief.summary}`,'','## Done means',brief.doneMeans,'','## Rules',brief.rules,'','## Where the work is',...brief.whereWorkIs.map(note=>note.text),''].join('\n'));}
  finally {closeSync(fd);}
  return path;
}
