// SPDX-License-Identifier: AGPL-3.0-or-later
import {known,opaque,type Value,type MaySet} from './types.ts';
/** Enumeration budget for products of alternatives, per command. */
export const BUDGET=4096;
/**
 * The cap for unions that grow by branching (variables, working directories, function variants): the original, the
 * newest, two others and every value the caller's classifier protects. A protected value is never dropped.
 */
export function capProduct(values:readonly string[],original:string|undefined,protect:(s:string)=>boolean=()=>false):string[] {
 const unique=[...new Set(values)];if(unique.length<=4)return unique;
 const keep=new Set<string>(unique.filter(value=>{try{return protect(value);}catch{return true;}}));
 keep.add(unique.at(-1)!);if(original!==undefined)keep.add(original);
 let others=0;for(const value of unique){if(others>=2)break;if(!keep.has(value)){keep.add(value);others++;}}
 return [...(original!==undefined&&!unique.includes(original)?[original]:[]),...unique.filter(value=>keep.has(value))];
}
/** One cap policy for variables, cwd and function alternatives. */
export function maySet(values:readonly string[],fault=false,original=values[0],protect:(s:string)=>boolean=()=>false):MaySet {
 const unique=[...new Set(values)],shape=unique.length?known(unique[0]!):opaque('may-value');if(unique.length<=4)return {...shape,values:unique,opaque:fault,original,...(unique.length>1?{candidates:unique}:{})};
 const selected=capProduct(unique,original,protect);
 return {...known(selected[0]!),values:selected,opaque:true,original,candidates:selected};
}
/** A list written out in the command (loop words, array items, lines read, pipeline values) is never capped: its size is bounded by the text. */
export function literalSet(values:readonly string[],fault=false,original=values[0]):MaySet {
 const unique=[...new Set(values)],shape=unique.length?known(unique[0]!):opaque('may-value');
 return {...shape,values:unique,opaque:fault,original,...(unique.length>1?{candidates:unique}:{})};
}
/** Every pair while the product fits the budget. Past it each alternative on either side is still read once, beside the other side's first. */
export function pairs<A,B>(left:readonly A[],right:readonly B[]):[A,B][] {
 if(left.length*right.length<=BUDGET)return left.flatMap(a=>right.map((b):[A,B]=>[a,b]));
 return [...right.map((b):[A,B]=>[left[0]!,b]),...left.slice(1).map((a):[A,B]=>[a,right[0]!])];
}
export const fromValue=(v:Value):MaySet=>v.k==='known'?literalSet(v.candidates??[v.s],v.mayOpaque===true||(v as Partial<MaySet>).opaque===true,(v as Partial<MaySet>).original??v.s):maySet([],true);
export const asValue=(v:MaySet):MaySet=>v.values.length?{...known(v.values[0]!),values:v.values,opaque:v.opaque,original:v.original,...(v.values.length>1?{candidates:v.values}:{}),mayOpaque:v.opaque}:{...opaque('may-value'),original:v.original};
