import { expect, it } from 'vitest';
import { d } from './fixture.ts';
const benign=["printf '%s\\n' 'mkfs.ext4 /dev/sda'",'echo "rm -rf ~"','# rm -rf /','cat <<EOF\nrm -rf ~\nEOF',`python3 -c "print('shutil.rmtree(\\\"/\\\")')"`,`node -e "const s='rm -rf ~'"`,'git commit -m "remove mkfs notes"',"printf '%s\\n' '$(rm -rf ~)'",'echo \\$(rm -rf ~)',"cat <<'EOF'\n$(rm -rf ~)\nEOF"];
const real=['mkfs.ext4 /dev/sda',"sh -c 'rm -rf ~'",'rm -rf /','bash <<EOF\nrm -rf ~\nEOF',`python3 -c "import shutil;shutil.rmtree('/')"`,`node -e "require('child_process').execSync('rm -rf ~')"`,'dd if=/dev/zero of=/dev/sda','echo "$(rm -rf ~)"','echo `rm -rf ~`','cat <<EOF\n$(rm -rf ~)\nEOF'];
it.each(benign)('R14 A8a M25 M26 M60 M61 executable/data benign %s',command=>{ const a=d.describeAction({tool:'Bash',input:{command}});expect(a.deletes).toHaveLength(0); });
it.each(real)('R15 A8a real twin %s',command=>{expect(d.describeAction({tool:'Bash',input:{command}}).deletes.length).toBeGreaterThan(0);});
it('R1 aliases retain nested Python wipe evidence',()=>{expect(d.describeAction({tool:'python',input:{code:"import os as x; x.system('rm -rf ~')"}}).deletes.length).toBeGreaterThan(0);});
it.each(["import shutil as s; s.rmtree('/')","from shutil import rmtree as r; r('/')","__import__('shutil').rmtree('/')","import subprocess; subprocess.run(['rm','-rf','/'])"] )('R1 Python evidence reaches real decision and sink: %s',async code=>{
 const {fixture,card,baseCard}=await import('./fixture.ts');const f=fixture();const ref=card(d.decide(f.open('py',{code},{tool:'python',toolCall:{name:'python',input:{code}},summary:'Benign label'}),baseCard));await d.presentApproval(ref,{title:'Python',subtitle:'Benign label'});expect(d.readApproval(ref.approvalId)!.why).toBe('wipe');expect(d.readApproval(ref.approvalId)!.evidence[0].class).toBe('root');
});
it('fork bomb executes but its printed documentation is inert',()=>{
 expect(d.describeAction({tool:'Bash',input:{command:':(){ :|:& };:'}}).deletes.length).toBeGreaterThan(0);expect(d.describeAction({tool:'Bash',input:{command:"echo ':(){ :|:& };:'"}}).deletes).toHaveLength(0);
});
it('PowerShell root deletion and nested command are executable evidence',()=>{
 expect(d.describeAction({tool:'powershell',input:{command:'Remove-Item -Recurse -Force C:\\Windows'}}).deletes.length).toBeGreaterThan(0);expect(d.describeAction({tool:'Bash',input:{command:"pwsh -Command 'Remove-Item -Recurse C:\\Windows'"}}).deletes.length).toBeGreaterThan(0);
});
it('engine execute kinds and argv preserve executable arguments',()=>{
 const fake:any={tool:'opaque-command',input:{argv:['sh','-c','rm -rf ~']},event:{toolKind:'execute',toolCall:{name:'opaque-command',input:{argv:['sh','-c','rm -rf ~']}}}};expect(d.describeAction(fake).deletes.length).toBeGreaterThan(0);
 expect(d.describeAction({tool:'exec_command',input:{argv:['echo','rm -rf ~']}}).deletes).toHaveLength(0);
});
it('connected-app multi-execute binds each catalog operation and exact account',()=>{
 const a=d.describeAction({tool:'mcp__murage_connectors__APPS_MULTI_EXECUTE_TOOL',input:{tools:[{tool_slug:'GMAIL_FETCH_EMAILS',account:'read-account',arguments:{}},{tool_slug:'GMAIL_SEND_EMAIL',account:'write-account',arguments:{body:'rm -rf /'}}]}});
 expect(a.targets).toEqual([{kind:'connected-app',toolkit:'gmail',tool:'GMAIL_FETCH_EMAILS',accountId:'read-account',op:'read'},{kind:'connected-app',toolkit:'gmail',tool:'GMAIL_SEND_EMAIL',accountId:'write-account',op:'write'}]);expect(a.deletes).toHaveLength(0);
 expect(d.describeAction({tool:'email_send',input:{tools:[{tool_slug:'GMAIL_SEND_EMAIL'}]}}).targets).toHaveLength(0);
});
