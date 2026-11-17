import {requireGatedHandle} from '../gated-handle.mjs';
export async function runFake(gatedHandle){
requireGatedHandle(gatedHandle);
// ACP plus its CLI catalogue/auth probes. No provider is contacted.
const args=process.argv.slice(2);
if(args.includes('--dump-config')&&process.env.GNL_FAKE_KIND==='deepseekAgent'){console.log(JSON.stringify([{name:'@deepseek-ai/dsh-llm-deepseek-api-key',config:{baseURL:'http://127.0.0.1:1/anthropic'}},{name:'@deepseek-ai/dsh-acp',config:{provider:'deepseek-official',model:'deepseek-v4-flash'}}]));process.exit(0);}
if(args.includes('debug')&&args.includes('config')&&process.env.GNL_FAKE_KIND==='opencodeGo'){console.log(JSON.stringify({model:'fixture/fake-model',provider:{fixture:{options:{baseURL:'http://127.0.0.1:1'}}}}));process.exit(0);}
if(args.includes('--version')){console.log(process.env.GNL_FAKE_VERSION??'1.0.62');process.exit(0);}
if(args.includes('status')){console.log(JSON.stringify({authenticated:true,loggedIn:true}));process.exit(0);}
if((args.includes('models')||args.includes('--list-models'))&&process.env.GNL_FAKE_KIND==='opencodeGo'){console.log('fixture/fake-model');process.exit(0);}
if((args.includes('models')||args.includes('--list-models'))&&process.env.GNL_FAKE_KIND==='fuigoAgent'){console.log('Default model: fake-model\nAvailable models:\n  - fake-model');process.exit(0);}
if(args.includes('models')||args.includes('--list-models')){console.log(JSON.stringify({models:[{id:'fake-model',name:'Fixture'}]}));process.exit(0);}
if(args.includes('gateway')){const at=args.indexOf('--params'),params=at>=0?JSON.parse(args[at+1]):{};console.log(JSON.stringify({ok:true,key:params.key,entry:{permissionMode:params.permissionMode}}));process.exit(0);}
const {runFake}=await import('./acp.mjs');await runFake(gatedHandle);

}
