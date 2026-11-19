// Pure config producer owner: gnl-harness-r11. Fake protocol consumer owner: gnl-harness-r11.
import {readFileSync} from 'node:fs';
export function codexMounts(args){
 const mounts={};
 for(const arg of args){
  const m=/^mcp_servers\.([^.=]+)\.(command|args|env_vars|env\.([\w]+))=(.*)$/.exec(arg);if(!m)continue;
  const server=mounts[m[1]]??={},value=JSON.parse(m[4]);
  if(m[2]==='env_vars')server.env={...server.env,...Object.fromEntries(value.map(k=>[k,process.env[k]]))};
  else if(m[2].startsWith('env.'))(server.env??={})[m[3]]=value;
  else server[m[2]]=value;
 }
 return mounts;
}
export function environmentMounts(){return JSON.parse(readFileSync(process.env.MURAGE_MCP_CONFIG,'utf8')).mcpServers;}
// Copilot receives the turn's MCP catalogue in its launch file, rather than session/new.
export function acpLaunchMounts(args,read=readFileSync){
 const at=args.indexOf('--additional-mcp-config');if(at<0)return [];
 const path=args[at+1];if(typeof path!=='string'||!path.startsWith('@'))throw Error('Release ACP launch configuration is missing');
 const config=JSON.parse(read(path.slice(1),'utf8'));
 if(!config.mcpServers||typeof config.mcpServers!=='object')throw Error('Release ACP launch catalogue is missing');
 return config.mcpServers;
}
