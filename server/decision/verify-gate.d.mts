export const GATE_FILES:readonly string[];
export function gateResult(report:{success:boolean;testResults:{name:string;status:string;assertionResults:{status:string}[]}[]}):{complete:boolean;rows:{file:string;passed:number;failed:number;complete:boolean}[]};
export function runGate():void;
