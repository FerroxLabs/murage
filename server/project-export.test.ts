// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, renameSync, existsSync, mkdirSync, chmodSync, unlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { initializeProjectTables } from './project-tables.ts';
import { channelToProjectRows } from './project-settings.ts';
import { canonicalProjectRoots } from './project-work-profile.ts';
import { exportProjectBrief } from './project-export.ts';
import { projectLifecycleFailure } from './project-close.ts';
it('exports only inside the selected unchanged root, without overwriting', () => {
  const root=mkdtempSync(join(tmpdir(),'project-export-'));const db=new DatabaseSync(':memory:');initializeProjectTables(db);
  try {
    channelToProjectRows(db,{groupId:'g',bulletin:'Keep this brief.',leadBotId:null,now:1});
    const roots=canonicalProjectRoots([{path:root}],{dataDir:join(tmpdir(),'separate-project-test-data')});
    db.prepare('UPDATE project_settings SET work_roots=?').run(JSON.stringify(roots));
    try { exportProjectBrief(db,'g',1); throw new Error('Expected refusal'); }
    catch (error) { expect(projectLifecycleFailure(error)).toEqual({status:400,body:{error:'Choose a project work folder.'}}); }
    const first=exportProjectBrief(db,'g',0);expect(readFileSync(first,'utf8')).toContain('Keep this brief.');
    expect(()=>exportProjectBrief(db,'g',0)).toThrow();
    rmSync(first);symlinkSync(join(root,'outside'),first);
    expect(()=>exportProjectBrief(db,'g',0)).toThrow();
  } finally {db.close();rmSync(root,{recursive:true,force:true});}
});

it('R2 refuses and removes a file when the parent is swapped just before open', () => {
  const root=mkdtempSync(join(tmpdir(),'project-export-race-'));const db=new DatabaseSync(':memory:');initializeProjectTables(db);
  const selected=join(root,'selected'),other=join(root,'other');mkdirSync(selected);mkdirSync(other);
  try {
    channelToProjectRows(db,{groupId:'g',bulletin:'Private brief',leadBotId:null,now:1});
    const roots=canonicalProjectRoots([{path:selected}],{dataDir:join(root,'data')});db.prepare('UPDATE project_settings SET work_roots=?').run(JSON.stringify(roots));
    expect(()=>exportProjectBrief(db,'g',0,{beforeOpen:()=>{renameSync(selected,join(root,'moved'));symlinkSync(other,selected);}})).toThrow('The work folder changed. Choose it again.');
    expect(existsSync(join(other,'project-brief-g-v1.md'))).toBe(false);
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

function raceFixture(name: string) {
  const root=mkdtempSync(join(tmpdir(),name));const db=new DatabaseSync(':memory:');initializeProjectTables(db);
  const selected=join(root,'selected'),other=join(root,'other');mkdirSync(selected);mkdirSync(other);
  channelToProjectRows(db,{groupId:'g',bulletin:'Private brief',leadBotId:null,now:1});
  const roots=canonicalProjectRoots([{path:selected}],{dataDir:join(root,'data')});db.prepare('UPDATE project_settings SET work_roots=?').run(JSON.stringify(roots));
  return {root,db,selected,other,done:()=>{db.close();chmodSync(selected,0o700);rmSync(root,{recursive:true,force:true});}};
}
it('R2 refuses a parent swapped away for the open and swapped back before the check, and writes nothing', () => {
  const {root,db,selected,other,done}=raceFixture('project-export-swapback-');
  try {
    expect(()=>exportProjectBrief(db,'g',0,{
      beforeOpen:()=>{renameSync(selected,join(root,'moved'));symlinkSync(other,selected);},
      afterOpen:()=>{unlinkSync(selected);renameSync(join(root,'moved'),selected);},
    })).toThrow('The work folder changed. Choose it again.');
    expect(readdirSync(selected)).toEqual([]);
    // The descriptor opened in the other folder never received the brief.
    expect(readFileSync(join(other,'project-brief-g-v1.md'),'utf8')).toBe('');
  } finally { done(); }
});
// Root ignores the folder mode, so this case needs an ordinary user (the build container runs as one).
it.skipIf(process.getuid?.() === 0)('R1 an unexpected open failure is not reported as a refusal', () => {
  const {db,selected,done}=raceFixture('project-export-eacces-');
  try {
    let caught: unknown;
    try { exportProjectBrief(db,'g',0,{beforeOpen:()=>chmodSync(selected,0o500)}); } catch (error) { caught=error; }
    expect(caught).toBeInstanceOf(Error);expect((caught as NodeJS.ErrnoException).code).toBe('EACCES');
    expect(projectLifecycleFailure(caught)).toEqual({status:500,body:{error:'The project action could not finish.'}});
  } finally { done(); }
});
it('R1 a folder removed just before the open is the changed-folder refusal, not a failure', () => {
  const {db,root,selected,done}=raceFixture('project-export-gone-');
  try {
    let caught: unknown;
    try { exportProjectBrief(db,'g',0,{beforeOpen:()=>renameSync(selected,join(root,'gone'))}); } catch (error) { caught=error; }
    expect(projectLifecycleFailure(caught)).toEqual({status:409,body:{error:'not_allowed',reason:'The work folder changed. Choose it again.'}});
  } finally { mkdirSync(selected,{recursive:true}); done(); }
});
