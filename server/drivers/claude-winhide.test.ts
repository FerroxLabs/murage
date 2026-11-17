import {test,expect} from 'vitest';
import {claudeOverlayEnv} from './claude.ts';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
test('Windows Claude settings strip inherited flags but retain exactly the hide preload for stdio MCP',()=>{
 const preload=require.resolve('../../shared/win-hide-child-process.cjs');
 const flag='--require='+JSON.stringify(preload);
 const overlay=claudeOverlayEnv('win32',{kind:'powershell-inherit',reason:'no-git-bash'}, {NODE_OPTIONS:`--inspect --require=/unwanted.cjs ${flag} ${flag} --no-warnings`},[]);
 expect(overlay).not.toHaveProperty('refusal');
 if ('refusal' in overlay) throw new Error(overlay.refusal);
 expect(overlay.env.NODE_OPTIONS).toBe(flag);
});
