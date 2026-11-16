// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect,it } from 'vitest';
import { RootClassifier } from './roots.ts';
import { known } from './types.ts';
import { botWorkspacePath,taskWorkspacePath } from '../workspace.ts';
import { partitionRoots } from '../execution-audience.ts';
import { DATA_DIR } from '../config.ts';
it('structural project matcher follows real workspace and audience constructors',()=>{
 const classifier=new RootClassifier({dataDir:DATA_DIR,home:'/home/u',pathPort:{realpath:p=>p,isBlockDevice:()=>null}},{contains:()=>false});
 const bot={id:'fixture',partitionedAt:1,sharedWith:{mode:'all'}} as any;
 const paths=[botWorkspacePath(DATA_DIR,bot.id),taskWorkspacePath(DATA_DIR,bot.id,'task'),...partitionRoots(bot,{kind:'team',teamId:'fixture-team'}),...partitionRoots(bot,{kind:'project',groupId:'fixture-project'}),...partitionRoots(bot,{kind:'isolated',threadId:'fixture-room'})];
 for(const path of paths){expect(classifier.classify(known(path)),path).toBe('project-root');expect(classifier.classify(known(path+'/out')),path).toBeUndefined();}
});
