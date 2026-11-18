// Native protocol fixtures, never installed CLIs or paid providers. Run with
// --network none; API adapters use a loopback-only fixture service.
import {isFluxModel} from '../../server/flux-surface.ts';
import {shippedEngineSpecs} from './engine-inventory.mjs';
import {fileURLToPath} from 'node:url';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
export function releaseEngines(){
 const cli=name=>fileURLToPath(new URL(`./launchers/${name}`,import.meta.url));
 const native=name=>fileURLToPath(new URL(`../../server/testing/${name}`,import.meta.url));
 return Object.fromEntries(shippedEngineSpecs().map(e=>{
  let path=cli('release-acp.mjs'),model='fake-model',environment={NOLIM_RELEASE_FAKE:'1',GNL_FAKE_KIND:e.driver},config={};
  if(e.driver==='claudeAgent'){path=cli('claude.mjs');model='sonnet';}
  else if(e.driver==='codex'){path=cli('codex.mjs');model=e.sol?'gpt-sol-fixture':'gpt-5.4';}
  else if(e.driver==='antigravityAgent'){path=cli('fake-agy-cli.ts');model='gemini-2.5-pro';environment.FAKE_AGY_RUN_HOOKS='1';}
  else if(e.driver==='piAgent'){path=cli('fake-pi-cli.ts');model='ollama-cloud/glm-5.2';}
  else if(e.driver==='museCode'){path=cli('fake-muse-cli.ts');model='muse-wonder-1.0';environment.META_API_KEY='fixture-key';environment.FAKE_MUSE_GRANT='sessionMcp';}
  else if(e.driver==='grok'){path=null;model='grok-3-mini';config={url:'GNL_LOOPBACK',apiKeyEnv:'GNL_FIXTURE_KEY'};environment.GNL_FIXTURE_KEY='fixture-key';}
  else if(e.driver==='openai-compat'){path=null;config={url:'GNL_LOOPBACK',model,apiKeyEnv:'GNL_FIXTURE_KEY'};environment.GNL_FIXTURE_KEY='fixture-key';}
  else if(e.driver==='minimax'){path=null;model='MiniMax-M2.7';config={url:'GNL_LOOPBACK'};environment.MINIMAX_API_KEY='fixture-key';}
  else if(e.driver==='boxAgent'){path=null;model='gpt-5.4';config={pollMs:10};environment.BOX_TOKEN='fixture-key';}
  if(e.driver==='deepseekAgent')environment.DEEPSEEK_API_KEY='fixture-key';
  if(e.driver==='customAcp')environment.OPENAI_BASE_URL='http://127.0.0.1:1/v1';
  if(e.driver==='fuigoAgent')environment.FUIGO_API_KEY='fixture-key';
  if(e.driver==='geminiAgent')environment.GEMINI_API_KEY='fixture-key';
  if(e.driver==='cursorAgent')environment.CURSOR_API_KEY='fixture-key';
  if(e.driver==='clineAgent')environment.CLINE_API_KEY='fixture-key';
  if(e.driver==='grokAgent')environment.GROK_CODE_XAI_API_KEY='fixture-key';
  if(e.driver==='openclawAgent')environment.GNL_FAKE_VERSION='2026.10.5';
  if(e.driver==='qwenAgent')environment.GNL_FAKE_AUTH='qwen';
  if(e.driver==='opencodeGo')model='fixture/fake-model';
  return [e.id,{...(path?{cli:path}:{}),...(['codex','opencodeGo'].includes(e.driver)?{model}:{}),config:{...config,...(path?{cli:path}:{})},environment}];
 }));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(!process.argv[2]||resolve(process.argv[2]).startsWith('/dev/'))throw Error('Catalogue output outside /dev required');
 writeFileSync(process.argv[2],JSON.stringify(releaseEngines(),null,2)+'\n',{flag:'wx',mode:0o600});
}

// Catalogue is the authority: defaults may name Flux even for a native fake.
export function selectFixtureModel(spec,instance){
 const options=(instance?.models?.options??[]).map(o=>typeof o==='string'?o:o.id??o.value).filter(Boolean);
 const native=options.filter(id=>!isFluxModel(id)&&(!spec.sol||/sol/i.test(id)));
 if(spec.requestedModel){
  if(!native.includes(spec.requestedModel))throw Error('Requested fixture model is not an advertised native route');
  return spec.requestedModel;
 }
 const model=native.includes(instance?.models?.default)?instance.models.default:native[0];
 if(!model)throw Error(`No advertised native fixture model for ${spec.id}`);
 return model;
}
