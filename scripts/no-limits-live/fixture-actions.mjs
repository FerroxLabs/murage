// Action executor owner: gnl-harness-r11. Fixture isolation contract owner: MAIN.
import {spawnSync} from 'node:child_process';
import {realpathSync,writeFileSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
export function executeReleased(step,allowed){
 if(process.env.NOLIM_RELEASE_FAKE!=='1')return true;
 if(!allowed)return false;
 const root=realpathSync(process.env.NOLIM_FIXTURE_ROOT),cwd=realpathSync(process.cwd());
 if(!/[/\\]nolim-live-/.test(root)||!cwd.startsWith(root+sep))throw Error('Release fake requires its owned fixture cwd');
 if(step.tool==='Bash'){
  // A missing-input probe dispatches no command. Its native completion witnesses
  // the empty form; it must never be replaced by an executable marker command.
  if(!Object.hasOwn(step.input,'command'))return Object.keys(step.input).length===0;
  // Catastrophes are observed at the permission seam, never executed by a
  // fixture even if a broken product releases one.
  if(cwd.endsWith('-python-alias-wipe')||/nolim_wipe=|(?:^|[;&|])\s*mkfs\.[a-z0-9]+\s+\/dev/.test(step.input.command))return false;
  return spawnSync('sh',['-c',step.input.command],{cwd,timeout:5000,stdio:'ignore',env:{...process.env,fixture_target:join(cwd,'field-output')}}).status===0;
 }
 if(step.tool==='Write'){
  const path=resolve(cwd,step.input.file_path);if(!path.startsWith(root+sep))throw Error('Release fake write outside fixture');
  writeFileSync(path,step.input.content);return true;
 }
 return false;
}
