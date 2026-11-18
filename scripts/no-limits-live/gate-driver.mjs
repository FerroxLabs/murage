// Gated action producer owner: gnl-harness-r11. In-process fake consumer owner: gnl-harness-r11.
import {execFileSync} from 'node:child_process';
import {sealGatedHandle} from './gated-handle.mjs';
import {createGateDriver} from './fakes/gate-driver.mjs';
export const gateDriver=createGateDriver(sealGatedHandle({executeOrigin:(command,cwd)=>execFileSync('/bin/sh',['-c',command],{cwd})}));
