// SPDX-License-Identifier: AGPL-3.0-or-later
// Secondary inventory. The database seam remains the authority for dynamic JSON.
import ts from 'typescript';
export interface Inventory {kinds:Record<string,number>;rawWriter:boolean;credentialCard:boolean}
export function inventory(text:string):Inventory {
 const kinds:Record<string,number>={};let rawWriter=false,credentialCard=false;
 const root=ts.createSourceFile('source.ts',text,ts.ScriptTarget.Latest,true);
 function visit(n:ts.Node){
  if(ts.isPropertyAssignment(n)&&n.name.getText(root)==='kind'&&ts.isStringLiteral(n.initializer)&&['options','secret','mcpSignIn','connector'].includes(n.initializer.text))kinds[n.initializer.text]=(kinds[n.initializer.text]??0)+1;
  if(ts.isStringLiteralLike(n)||ts.isTemplateExpression(n))if(/\b(?:INSERT(?: OR \w+)? INTO|UPDATE)\s+messages\b/i.test(n.getText(root)))rawWriter=true;
  if(ts.isObjectLiteralExpression(n)){
   const props=n.properties.filter(ts.isPropertyAssignment);const kind=props.find(p=>p.name.getText(root)==='kind');
   if(kind&&ts.isStringLiteral(kind.initializer)&&['secret','mcpSignIn','connector'].includes(kind.initializer.text)&&props.some(p=>p.name.getText(root)==='card'))credentialCard=true;
  }
  ts.forEachChild(n,visit);
 }
 visit(root);return {kinds,rawWriter,credentialCard};
}
