export interface TransportSink { file:string; line:number; start:number; end:number; entry:string; kind:string; guarded:boolean; reason?:string }
export function sinkInventory(overrides?:Map<string,string>): { sinks:TransportSink[]; drivers:Record<string,{sinks:number;modelRequest:number;NotModelRequest:number;reasons:{line:number;reason:string}[]}>; errors:string[] };
