// SPDX-License-Identifier: AGPL-3.0-or-later
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const directory='evidence/nlsym-A2/C4-mutants';mkdirSync(directory,{recursive:true});
const file='server/no-limits-taint.ts',original=readFileSync(file,'utf8');
const mutants=[
 ['M-NL-taint-removed','if(!hazards.length)continue;','continue;'],
 ['M-NL-prefix-match-dropped','if(!unknown&&prefix===undefined)continue;','if(!unknown)continue;'],
 ['M-NL-unknown-not-tainting','const hazards=operations.flatMap(operation=>producerHazards(operation.id,operation.operands,roots,{...context,windows:operation.windows??context.windows}));',"const hazards=operations.flatMap(operation=>producerHazards(operation.id,operation.operands,roots,{...context,windows:operation.windows??context.windows})).filter(h=>h.cause!=='unknown-expansion');"],
 ['M-NL-only-trigger-destinations','operations.flatMap(operation=>operation.destinationPrefixes)','operations.filter(operation=>hazards.some(h=>h.operationId===operation.id)).flatMap(operation=>operation.destinationPrefixes)'],
 ['M-NL-eval-legacy-null','const first=inspect(gather()),envelope=gather(first.operations),all=inspect(envelope);','const first=inspect(gather()),envelope=gather(first.operations),all=inspect({...envelope,commands:envelope.commands.filter(c=>!c.syntaxId.includes("/eval"))});'],
 ['M-NL-procsub-parent-separated','const first=inspect(gather()),envelope=gather(first.operations),all=inspect(envelope);','const first=inspect(gather()),envelope=gather(first.operations),all=inspect({...envelope,commands:envelope.commands.filter(c=>!c.syntaxId.includes("/part")),writes:envelope.writes.filter(c=>!c.syntaxId.includes("/part"))});'],
];
function run(name){const r=spawnSync('node_modules/.bin/vitest',['run','server/no-limits-taint.test.ts'],{encoding:'utf8',timeout:120000});const log=(r.stdout??'')+(r.stderr??'');writeFileSync(`${directory}/${name}.log`,log);return {status:r.status,assertion:/AssertionError/.test(log),invalid:/Transform failed|SyntaxError|Failed to resolve/.test(log)};}
if(run('baseline').status!==0)throw new Error('baseline failed');
const matrix=[];
try{for(const [name,from,to]of mutants){if(original.split(from).length!==2)throw new Error('nonunique '+name);writeFileSync(file,original.replace(from,to));writeFileSync(`${directory}/${name}.before`,original);writeFileSync(`${directory}/${name}.patch`,spawnSync('diff',['-u',`${directory}/${name}.before`,file],{encoding:'utf8'}).stdout);const r=run(name);matrix.push({name,...r,killed:r.status===1&&r.assertion&&!r.invalid});writeFileSync(file,original);}}finally{writeFileSync(file,original);}
writeFileSync(`${directory}/matrix.json`,JSON.stringify(matrix,null,2)+'\n');
if(matrix.some(m=>!m.killed))process.exitCode=1;
