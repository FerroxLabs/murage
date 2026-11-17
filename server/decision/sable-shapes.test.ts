import {expect,it} from 'vitest';
import {autoVerdict,type AutoContext} from '../auto-approve.ts';
import {fixture,d} from './fixture.ts';
const bot={id:'b',autoApprove:true,fullAccess:true,noLimits:true};
const commands=["cat <<'EOF' > /tmp/fixture.txt\nfixture body\nEOF",'cat <<EOF > /tmp/fixture.txt\nfixture body\nEOF','printf x > "$DEST"',"printf '%s' 'fixture' >> /tmp/fixture.txt",'cat <<EOF > "$DEST"\nfixture\nEOF','printf x > /tmp/fixture.txt','cat <<"EOF" > /tmp/fixture.txt\nfixture\nEOF','cat > /tmp/fixture.txt <<EOF\nfixture\nEOF'];
const tools=[['Bash',{command:'git status; printf fixture > /tmp/fixture.txt'}],['Write',{file_path:'/tmp/fixture.txt',content:'fixture'}],['mcp__murage__register_artifact',{path:'/tmp/fixture.txt'}],['mcp__tvcontrol__quote_batch',{quotes:['fixture']}],['mcp__browser__open',{url:'https://example.test'}],['mcp__browser__screenshot',{}],['mcp__browser__title',{}],['mcp__thrivecart__lookup',{id:'fixture'}],['mcp__connectors__list',{}]] as const;
it.each(['owner','owner-routine'] as const)('B1 Sable shape replay: %s after web, earlier-turn and cloned-folder reads has zero cards',async actor=>{
 const f=fixture();
 if(actor==='owner-routine')d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>({threadId:'t',botId:'b',generation:'g',principal:'owner',roomOwnerOnly:true,at:1,initiator:{k:'routine-run',form:'run',sourceRunId:'routine',sourceBotId:'b',recipientGeneration:'g',trigger:'schedule'}}),live:()=>({botId:'b',turnId:'turn',providerInstanceId:'p',principal:'owner',owner:true,level:'unlimited',routine:{sourceRunId:'routine',sourceBotId:'b',recipientGeneration:'g',owner:true}})});
 let n=0,witnesses=0,legacyCards=0;
 for(const outside of ['web page','earlier turn','cloned folder'] as const)for(const [tool,input] of [...tools,...commands.map(command=>['Bash',{command}] as const)]){
 const context:AutoContext={fullAccessOrigin:actor==='owner'?'owner':'routine',ownerStarted:actor==='owner',routineLevel:actor==='owner-routine',outsideRead:[outside],commandText:'command'in input?input.command:undefined};
 const base=()=>autoVerdict(bot,tool,'fixture',context);if(base().approve===null)legacyCards++;
 const handle=f.open('shape-'+n++,input,{tool,toolCall:{name:tool,input}});
 expect(d.decide(handle,base).kind,JSON.stringify({outside,tool,input})).toBe('run');await d.deliverRequest(handle);witnesses++;
 }
 expect(witnesses).toBe(51);expect(d.openApprovals()).toHaveLength(0);expect(f.respond).toHaveBeenCalledTimes(witnesses);expect(f.respond.mock.calls.every(c=>c[1].behavior==='allow')).toBe(true);
 console.log(JSON.stringify({actor,shapeRequests:n,allowWitnesses:witnesses,permissionCards:0,legacyBaseCards:legacyCards,producerOwner:'S4 server/index.ts request.opened 9704-10050'}));
});
