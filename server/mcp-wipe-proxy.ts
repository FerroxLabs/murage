// SPDX-License-Identifier: AGPL-3.0-or-later
// Transparent stdio wrapper for the owner's MCP server. It records only
// effect hints from tools/list; all permission decisions stay with Murage.
import {runMcpBridge} from './mcp-bridge.ts';
import {publishMcpWipeTools} from './mcp-wipe-publisher.ts';
const [server,raw]=process.argv.slice(2),descriptor=JSON.parse(raw??'null') as {command:string;args:string[]};
if(!server||!descriptor||typeof descriptor.command!=='string'||!Array.isArray(descriptor.args)||!descriptor.args.every(arg=>typeof arg==='string'))throw Error('Invalid MCP launch descriptor');
const env={...process.env};
for(const name of Object.keys(env))if(name.startsWith('MURAGE_'))delete env[name];
runMcpBridge({command:descriptor.command,args:descriptor.args,label:server,childEnv:env,observeTools:(tools,replace)=>publishMcpWipeTools(server,tools,replace)});
