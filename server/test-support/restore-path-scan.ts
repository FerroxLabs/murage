import ts from "typescript";
import {readFileSync,readdirSync,statSync} from "node:fs";
import {join,relative} from "node:path";
import {spawnSync} from "node:child_process";
export type MoveClass = {kind:"generic"} | {kind:"not-live-db"|"restores-outgoing";reason:string} | {kind:"installs-live-db";drop:string;test:string};
export type MoveSite = {key:string;file:string;fn:string;primitive:string;source:string};
const primitives=new Set(["renameSync","rename","copyFileSync","copyFile","cpSync","linkSync"]);
export function scanMoves(roots: string[], inventory: Record<string,MoveClass>) {
 const sites:MoveSite[]=[],calls:MoveSite[]=[],files=new Map<string,string>(), functions=new Map<string,string>();
 for(const root of roots) {
  const walk=(dir:string):void=>{for(const name of readdirSync(dir)){if(["node_modules","test-support","testing"].includes(name))continue;const p=join(dir,name);if(statSync(p).isDirectory()){walk(p);continue;}if(name.endsWith(".test.ts")||name.includes(".node-test.")||name.endsWith("_test.py"))continue;
   const file=relative(process.cwd(),p),text=readFileSync(p,"utf8");
   if(p.endsWith(".ts")) {
    files.set(file,text);const sf=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);const ord=new Map<string,number>();
    const aliases=new Map<string,string>();
    for(const statement of sf.statements) if(ts.isImportDeclaration(statement) && /^(node:)?fs(\/promises)?$/.test((statement.moduleSpecifier as ts.StringLiteral).text)) {
      const bindings=statement.importClause?.namedBindings;
      if(bindings && ts.isNamedImports(bindings)) for(const item of bindings.elements) aliases.set(item.name.text,item.propertyName?.text??item.name.text);
    }
    const visit=(node:ts.Node,fn:string,body:string):void=>{
     if(ts.isFunctionLike(node) && (node as ts.FunctionLikeDeclaration).body){const named=(node as ts.FunctionDeclaration).name;let label=named?.getText(sf);if(!label && ts.isVariableDeclaration(node.parent))label=node.parent.name.getText(sf);if(!label && ts.isPropertyAssignment(node.parent))label=node.parent.name.getText(sf);if(label){fn=label;body=node.getText(sf);functions.set(`${file}::${fn}`,body);}}
     if(ts.isCallExpression(node)){const e=node.expression;const raw=ts.isIdentifier(e)?e.text:ts.isPropertyAccessExpression(e)?e.name.text:ts.isParenthesizedExpression(e)&&ts.isBinaryExpression(e.expression)&&ts.isIdentifier(e.expression.right)?e.expression.right.text:"";const primitive=aliases.get(raw)??raw;if(primitive){const prefix=`${file}::${fn}::${primitive}`,n=ord.get(prefix)??0;ord.set(prefix,n+1);const site={key:`${prefix}::${n}`,file,fn,primitive,source:body};calls.push(site);if(primitives.has(primitive))sites.push(site);}}
     ts.forEachChild(node,n=>visit(n,fn,body));
    };visit(sf,"<module>",text);
   }else if(text.startsWith("#!/") && /python/.test(text.split("\n")[0])) {
    files.set(file,text);
    const script=`import ast,json,sys\ns=sys.stdin.read();t=ast.parse(s);out=[]\ndef walk(n,fn='<module>',body=s):\n if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)):\n  fn=n.name;body=ast.get_source_segment(s,n)\n if isinstance(n,ast.Call):\n  name=ast.unparse(n.func)\n  if name in ('os.rename','os.replace','shutil.move') or name.startswith('shutil.copy') or (name.startswith('subprocess.') and n.args and isinstance(n.args[0],(ast.List,ast.Tuple)) and n.args[0].elts and isinstance(n.args[0].elts[0],ast.Constant) and n.args[0].elts[0].value in ('mv','cp')):out.append([fn,name,body])\n for c in ast.iter_child_nodes(n):walk(c,fn,body)\nwalk(t)\nprint(json.dumps(out))`;
    const result=spawnSync("python3",["-c",script],{input:text,encoding:"utf8"});if(result.status!==0)throw Error(result.stderr);const ord=new Map<string,number>();for(const [fn,primitive,source] of JSON.parse(result.stdout)){const prefix=`${file}::${fn}::${primitive}`,n=ord.get(prefix)??0;ord.set(prefix,n+1);sites.push({key:`${prefix}::${n}`,file,fn,primitive,source});}
   }
  }};walk(root);
 }
 const seen=new Set(sites.map(s=>s.key));
 for(let i=0;i<sites.length;i++){const site=sites[i];if(inventory[site.key]?.kind!=="generic")continue;for(const call of calls){if(call.primitive===site.fn&&!seen.has(call.key)){seen.add(call.key);sites.push(call);}}}
 return {sites,files,functions,unclassified:sites.filter(s=>!inventory[s.key]).map(s=>s.key).sort(),stale:Object.keys(inventory).filter(k=>!seen.has(k)).sort()};
}
