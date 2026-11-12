#!/usr/bin/env node
// ACP plus its CLI catalogue/auth probes. No provider is contacted.
const args=process.argv.slice(2);
if(args.includes('--version')){console.log(process.env.GNL_FAKE_VERSION??'1.0.62');process.exit(0);}
if(args.includes('status')){console.log(JSON.stringify({authenticated:true,loggedIn:true}));process.exit(0);}
if(args.includes('models')||args.includes('--list-models')){console.log(JSON.stringify({models:[{id:'fake-model',name:'Fixture'}]}));process.exit(0);}
if(args.includes('gateway')){const at=args.indexOf('--params'),params=at>=0?JSON.parse(args[at+1]):{};console.log(JSON.stringify({ok:true,key:params.key,entry:{permissionMode:params.permissionMode}}));process.exit(0);}
await import('./acp.mjs');
