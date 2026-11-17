import { expect,it } from 'vitest';
import { mkdirSync,writeFileSync,unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR,loadConfig } from './config.ts';
it('D6 saved 1.0.18 configuration keeps the complete Settings view',()=>{
 mkdirSync(DATA_DIR,{recursive:true});const file=join(DATA_DIR,'config.json');writeFileSync(file,JSON.stringify({profile:{name:'Upgrade fixture'}}));
 expect((loadConfig() as any).settingsDefaultMode).toBe('advanced');
 writeFileSync(file,JSON.stringify({profile:{name:'Upgrade fixture'},settingsDefaultMode:'simple'}));
 expect((loadConfig() as any).settingsDefaultMode).toBe('simple');
 unlinkSync(file);expect((loadConfig() as any).settingsDefaultMode).toBe('simple');
});
it('D6 backup preserves the installation Settings default for a restore on another device',async()=>{
 const {mkdtempSync,readFileSync}=await import('node:fs'),{tmpdir}=await import('node:os');
 const {stageInstallationState}=await import('./installation-state-snapshot.ts'),{removeTempDirSync}=await import('./testing/cleanup.ts');
 const output=mkdtempSync(join(tmpdir(),'murage-settings-backup-'));
 try {
  mkdirSync(DATA_DIR,{recursive:true});writeFileSync(join(DATA_DIR,'config.json'),JSON.stringify({profile:{name:'Settings fixture'},settingsDefaultMode:'simple'}));
  const staged=await stageInstallationState(DATA_DIR,output);
  expect(JSON.parse(readFileSync(join(staged.directory,'state','config.json'),'utf8')).settingsDefaultMode).toBe('simple');
 }finally{removeTempDirSync(output);}
});
