// Native protocol fixtures, never installed CLIs or paid providers. Run with
// --network none; API adapters use a loopback-only fixture service.
import {shippedEngineSpecs} from './engine-inventory.mjs';
import {fileURLToPath} from 'node:url';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
export function releaseEngines(){
 const cli=name=>fileURLToPath(new URL(`./fakes/${name}`,import.meta.url));
 const native=name=>fileURLToPath(new URL(`../../server/testing/${name}`,import.meta.url));
 return Object.fromEntries(shippedEngineSpecs().map(e=>{
  let path=cli('release-acp.mjs'),model='fake-model',environment={NOLIM_RELEASE_FAKE:'1'},config={};
  if(e.driver==='claudeAgent'){path=cli('claude.mjs');model='sonnet';}
  else if(e.driver==='codex'){path=cli('codex.mjs');model=e.sol?'gpt-sol-fixture':'gpt-5.4';}
  else if(e.driver==='antigravityAgent'){path=native('fake-agy-cli.ts');model='gemini-2.5-pro';environment.FAKE_AGY_RUN_HOOKS='1';}
  else if(e.driver==='piAgent'){path=native('fake-pi-cli.ts');model='ollama-cloud/glm-5.2';}
  else if(e.driver==='museCode'){path=native('fake-muse-cli.ts');model='muse-spark-1.3-contributor';}
  else if(e.driver==='grok'){path=null;model='grok-3-mini';config={url:'GNL_LOOPBACK',apiKeyEnv:'GNL_FIXTURE_KEY'};environment.GNL_FIXTURE_KEY='fixture-key';}
  else if(e.driver==='openai-compat'){path=null;config={url:'GNL_LOOPBACK',model,apiKeyEnv:'GNL_FIXTURE_KEY'};environment.GNL_FIXTURE_KEY='fixture-key';}
  else if(e.driver==='minimax'){path=null;model='MiniMax-M2.7';config={url:'GNL_LOOPBACK'};environment.MINIMAX_API_KEY='fixture-key';}
  else if(e.driver==='boxAgent'){path=null;model='gpt-5.4';config={url:'GNL_LOOPBACK',token:'fixture-key'};}
  if(e.driver==='fuigoAgent')environment.FUIGO_API_KEY='fixture-key';
  if(e.driver==='geminiAgent')environment.GEMINI_API_KEY='fixture-key';
  if(e.driver==='cursorAgent')environment.CURSOR_API_KEY='fixture-key';
  if(e.driver==='grokAgent')environment.GROK_CODE_XAI_API_KEY='fixture-key';
  if(e.driver==='openclawAgent')environment.GNL_FAKE_VERSION='2026.10.5';
  if(e.driver==='qwenAgent')environment.GNL_FAKE_AUTH='qwen';
  return [e.id,{...(path?{cli:path}:{}),...(['claudeAgent','codex'].includes(e.driver)?{model}:{}),config:{...config,...(path?{cli:path}:{})},environment}];
 }));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(!process.argv[2]||resolve(process.argv[2]).startsWith('/dev/'))throw Error('Catalogue output outside /dev required');
 writeFileSync(process.argv[2],JSON.stringify(releaseEngines(),null,2)+'\n',{flag:'wx',mode:0o600});
}
