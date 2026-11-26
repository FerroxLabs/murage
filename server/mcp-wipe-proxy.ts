// SPDX-License-Identifier: AGPL-3.0-or-later
// Transparent stdio wrapper for the owner's MCP server. It records only
// effect hints from tools/list; all permission decisions stay with Murage.
import "../shared/win-hide-child-process.mjs";
import {runMcpBridge} from './mcp-bridge.ts';
import {publishMcpWipeTools} from './mcp-wipe-publisher.ts';
const [server,raw]=process.argv.slice(2),descriptor=JSON.parse(raw??'null') as {command:string;args:string[]};
if(!server||!descriptor||typeof descriptor.command!=='string'||!Array.isArray(descriptor.args)||!descriptor.args.every(arg=>typeof arg==='string'))throw Error('Invalid MCP launch descriptor');
// q1022-connparity: a Settings Test with first-run patience (an installer command downloading before it starts) names
// its own window; a chat mount cannot carry this name (the owner's environment may not name MURAGE_*, and the relay's
// child environment is an allowlist), so a chat keeps the bridge's start window.
const patience=Number(process.env.MURAGE_MCP_TEST_START_MS),startMs=Number.isSafeInteger(patience)&&patience>=10_000&&patience<=310_000?patience:undefined;
const env={...process.env};
for(const name of Object.keys(env))if(name.startsWith('MURAGE_'))delete env[name];
runMcpBridge({command:descriptor.command,args:descriptor.args,label:server,childEnv:env,releaseRole:'wipeMcp',startMs,observeTools:(tools,replace)=>publishMcpWipeTools(server,tools,replace)});
