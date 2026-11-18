// Box protocol producer owner: MAIN. Inert transport/consumer owner: gnl-harness-r11.
import {spawn} from 'node:child_process';
import {sealGatedHandle} from './gated-handle.mjs';
import {boxFixture as fixture} from './fakes/box-service.mjs';
export const boxFixture=root=>fixture(root,sealGatedHandle({executeBoxAction:(command,cwd)=>new Promise((resolve,reject)=>{const child=spawn('sh',['-c',command],{cwd,stdio:'ignore'});child.once('error',reject);child.once('close',resolve);})}));
