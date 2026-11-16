// Real cmd.exe launch inside the packaged MCP child. Deliberately omit windowsHide:
// the package's inherited preload must implement the customer's quiet behavior.
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {windowsHideHookInstalled} from './native-launcher.mjs';
if(process.platform!=='win32')throw new Error('Windows fixture only');
const result=spawnSync(process.env.COMSPEC,['/d','/c','echo winbox-shell-proof & ver'],{encoding:'utf8'});
writeFileSync(process.argv[4],JSON.stringify({status:result.status,stdout:result.stdout,stderr:result.stderr,error:result.error?.message,hookInstalled:windowsHideHookInstalled()}));
if(result.status!==0)throw new Error('Shell proof failed');
await import('./echo-mcp.mjs');
