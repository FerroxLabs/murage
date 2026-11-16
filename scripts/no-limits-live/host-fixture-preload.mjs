// Owned inert host transport. The real descriptor reader, local routing,
// consent checks, MCP proxy and decision/release paths are unchanged.
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fakeHostDescriptorSource} from '../../server/testing/fake-host-descriptor.ts';
const dataDir=process.env.MURAGE_DATA_DIR;
if(fs.existsSync(path.join(dataDir,'gnl-host-fixture.json'))){
 process.env.MURAGE_USER_DATA=dataDir;fs.chmodSync(dataDir,0o700);
 const driverSource=`import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
 for await(const line of createInterface({input:process.stdin})){const rpc=JSON.parse(line);if(rpc.id===undefined)continue;
 let result={};if(rpc.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'Owned inert host',version:'1'}};
 else if(rpc.method==='tools/list')result={tools:[{name:'click',inputSchema:{type:'object',properties:{x:{type:'number'},y:{type:'number'}},required:['x','y']}}]};
 else if(rpc.method==='tools/call'&&rpc.params.name==='click'){appendFileSync(process.env.GNL_HOST_CAPTURE,JSON.stringify({tool:'click',input:rpc.params.arguments})+'\\n');result={content:[{type:'text',text:'Owned inert click completed'}]};}
 else result={isError:true,content:[{type:'text',text:'Unknown fixture host operation'}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result})+'\\n');}`;
 const source=fakeHostDescriptorSource({driverSource,driverEnv:{GNL_HOST_CAPTURE:"path.join(dataDir,'s3-state/host-actions.ndjson')"}});
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 await new AsyncFunction('fs','path','dataDir',source)(fs,path,dataDir);
}
