// SPDX-License-Identifier: AGPL-3.0-or-later
import {mcpSchemaWipeHints} from './no-limits-wipe-mcp.ts';
import {turnSecret} from './turn-credential.ts';
import {NotModelRequest} from '../shared/engine-transport.ts';
/** Complete publication before the engine sees tools/list, so its later
 * permission request can consult the annotations of the schema it received. */
export async function publishMcpWipeTools(server:string,tools:unknown[],replace:boolean,env:NodeJS.ProcessEnv=process.env):Promise<void>{
 if(env.MURAGE_MCP_WIPE_METADATA!=='1')return;
 const harness=env.MURAGE_HARNESS_URL;
 if(!harness||!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(harness)||!/^[a-z][a-z0-9_-]{0,31}$/.test(server))throw Error('Invalid MCP metadata destination');
 const response=await NotModelRequest('Publish MCP tool effect hints; no model inference',fetch(`${harness}/api/internal/mcp-remote/${server}/wipe-metadata`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${turnSecret('MURAGE_MCP_TOKEN',env)}`},body:JSON.stringify({tools:mcpSchemaWipeHints(tools),replace}),signal:AbortSignal.timeout(5000)}));
 await response.body?.cancel();
 if(!response.ok)throw Error('MCP effect hints could not be recorded');
}
