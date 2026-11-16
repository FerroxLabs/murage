// SPDX-License-Identifier: AGPL-3.0-or-later
// Secondary inventory. The database seam remains the authority for dynamic JSON.
import ts from 'typescript';
export interface Inventory {kinds:Record<string,number>;rawWriter:boolean;credentialCard:boolean}
export function inventory(text:string):Inventory {
 const kinds:Record<string,number>={};let rawWriter=false,credentialCard=false;
 const root=ts.createSourceFile('source.ts',text,ts.ScriptTarget.Latest,true);
 const literal=(expression:ts.Expression):string|undefined=>{
  while(ts.isAsExpression(expression)||ts.isSatisfiesExpression(expression)||ts.isParenthesizedExpression(expression))expression=expression.expression;
  return ts.isStringLiteral(expression)?expression.text:undefined;
 };
 function visit(n:ts.Node){
  if(ts.isPropertyAssignment(n)&&n.name.getText(root)==='kind'){
   const kind=literal(n.initializer);
   if(kind&&['options','secret','mcpSignIn','connector'].includes(kind))kinds[kind]=(kinds[kind]??0)+1;
  }
  if(ts.isStringLiteralLike(n)||ts.isTemplateExpression(n))if(/\b(?:INSERT(?: OR \w+)? INTO|UPDATE)\s+messages\b/i.test(n.getText(root)))rawWriter=true;
  if(ts.isObjectLiteralExpression(n)){
   const props=n.properties.filter(ts.isPropertyAssignment);const kind=props.find(p=>p.name.getText(root)==='kind');
   if(kind&&['secret','mcpSignIn','connector'].includes(literal(kind.initializer)??'')&&props.some(p=>p.name.getText(root)==='card'))credentialCard=true;
  }
  ts.forEachChild(n,visit);
 }
 visit(root);return {kinds,rawWriter,credentialCard};
}
