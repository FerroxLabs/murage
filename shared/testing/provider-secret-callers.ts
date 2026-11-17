import * as basic from '../basic-auth-mask.ts';
import * as r from '../../server/redact.ts';
import * as p from '../../src/lib/screen-envelope.ts';
import * as f from '../../server/feedback-relay.ts';
import * as o from '../../cloudflare/control-plane/src/owner-feedback.ts';
import * as h from '../../cloudflare/control-plane/src/self-service.ts';
import * as l from '../../server/memory/prospect-text.ts';
import * as g from '../../server/model-gateway.ts';
import {scanSecretText} from '../md-secret-label.mjs';
// Namespace lookup permits fail-first tests to run against the original lane head.
const base=(module:object,name:string)=>(module as Record<string,(s:string)=>string>)[name];
export const callers = [
  {id:'chat', mask:r.redactSecretsInText, base:base(r,'baseSecretsInText')},
  {id:'sink', mask:r.redactSecretsForSink, base:base(r,'baseSecretsForSink')},
  {id:'diagnostic', mask:r.redactEngineDiagnosticCredentials, base:base(r,'baseDiagnosticCredentials')},
  {id:'preview', mask:p.scrubSecrets, base:base(p,'baseScrubSecrets')},
  {id:'relay', mask:f.scrubFeedbackText, base:base(f,'baseScrubFeedbackText')},
  {id:'owner', mask:o.scrubSecrets, base:base(o,'baseScrubSecrets')},
  {id:'home', mask:h.redact, base:base(h,'baseRedact')},
  {id:'learning', mask:l.redactLearningText, base:base(l,'baseLearningText')},
  {id:'gateway', mask:(s:string)=>g.redact(s,['literal']), base:(s:string)=>(g as any).baseRedact(s,['literal'])},
  {id:'shared', mask:(s:string)=>scanSecretText(s,{mode:'turn'}).text, base:(s:string)=>scanSecretText(s,{mode:'turn',vendor:false} as any).text},
  {id:'turn', mask:(s:string)=>r.scanTurnText(s).text, base:(s:string)=>r.scanTurnText(s,{vendor:false} as any).text},
  {id:'shared-default', mask:(s:string)=>scanSecretText(s).text, base:(s:string)=>scanSecretText(s,{vendor:false} as any).text},
];
export const walks = [r.redactSecrets,r.redactSecretsForSinkWalk];
export const scanners = [
  {id:'shared', scan:(s:string,options:object={})=>scanSecretText(s,{mode:'turn',...options})},
  {id:'turn', scan:r.scanTurnText},
  {id:'shared-default', scan:(s:string,options:object={})=>scanSecretText(s,{...options,mode:'user'})},
];

const stageSets = [(r as any).TEXT_SECRET_STAGES,(r as any).SINK_SECRET_STAGES,(r as any).DIAGNOSTIC_SECRET_STAGES,
  (p as any).FEEDBACK_SECRET_STAGES,(f as any).FEEDBACK_RELAY_STAGES,(o as any).OWNER_SECRET_STAGES,
  (h as any).HOME_SECRET_STAGES,(l as any).LEARNING_SECRET_STAGES];
export const collectedBase=(index:number,text:string)=>{
  const stages=index===8?(g as any).gatewaySecretStages(['literal']):stageSets[index];
  return (basic as any).runStages(text,stages,(basic as any).vendorCarry(text));
};
