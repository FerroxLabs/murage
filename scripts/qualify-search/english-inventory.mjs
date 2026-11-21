// SPDX-License-Identifier: AGPL-3.0-or-later
// Read-only inventory of all English literals introduced by this harness lane.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import ts from 'typescript';
// Every file in this directory was introduced after the lane parent 102c9a79f.
// Scanning the directory also works in git-archive test containers.
const paths=readdirSync('scripts/qualify-search').map(x=>'scripts/qualify-search/'+x).filter(x=>!/\.test\.[cm]?ts$|\.json$|\.md$/.test(x)).sort();
const sql=/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|PRAGMA|BEGIN|COMMIT|ROLLBACK|ATTACH|DETACH|EXPLAIN)\b/i;
const entries=[];
for(const file of paths){
  const source=readFileSync(file,'utf8');
  const add=(literal,line)=>{
    if(!(/\s/.test(literal)||/^\[[^\]]+\]/.test(literal))||sql.test(literal)||!/[A-Za-z]{2}/.test(literal))return;
    entries.push({file,line,literal,class:/throw\b|Error\(|expect\(/.test(source.split('\n')[line-1])?'internal-error':'diagnostic',change:'NEW'});
  };
  if(/\.[cm]?ts$|\.mjs$/.test(file)){
    const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
    const visit=node=>{
      if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)||ts.isTemplateExpression(node)){
        const literal=ts.isTemplateExpression(node)?source.slice(node.getStart(ast)+1,node.end-1):node.text;
        add(literal,ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1);
      } else ts.forEachChild(node,visit);
    };visit(ast);
  }else{
    // Shell, Python, PowerShell and YAML: quote tokens plus unquoted YAML
    // names/descriptions. Include command strings as operator diagnostics.
    const pattern=/'([^'\n]*)'|"([^"\n]*)"/g;
    for(const match of source.matchAll(pattern))add(match[1]??match[2],source.slice(0,match.index).split('\n').length);
    source.split('\n').forEach((line,i)=>{const match=line.match(/^\s*(?:name|description):\s*([^'"].*)$/);if(match)add(match[1],i+1);});
  }
}
entries.sort((a,b)=>a.file.localeCompare(b.file)||a.line-b.line||a.literal.localeCompare(b.literal));
writeFileSync(process.argv[2]??'docs/verification/search-qualification-english.json',JSON.stringify(entries,null,2)+'\n');
