import { expect, it } from "vitest";
import { DIAGNOSTIC_FAILURE_KINDS, DIAGNOSTIC_RPC_METHODS, parseRuntimeErrorDiagnostic, RUNTIME_ERROR_DIAGNOSTIC_MAX_BYTES } from "./error-diagnostic.ts";
const base={version:1,diagnosticId:"ev-m00001-a",turnId:"11111111-1111-4111-8111-111111111111"};
it("preserves bounded diagnostic correlation and distinct terminal/observed categories",()=>{
 const input={...base,processGeneration:"22222222-2222-4222-8222-222222222222",rpcId:3,method:"session/prompt",rpcCode:-32603,httpStatus:402,terminalKind:"http",observedKind:"api"};
 expect(parseRuntimeErrorDiagnostic(input)).toEqual(input);expect(parseRuntimeErrorDiagnostic(base)).toEqual(base);
 expect(new TextEncoder().encode(JSON.stringify(parseRuntimeErrorDiagnostic(input))).byteLength).toBeLessThanOrEqual(RUNTIME_ERROR_DIAGNOSTIC_MAX_BYTES);
 for(const terminalKind of DIAGNOSTIC_FAILURE_KINDS)expect(parseRuntimeErrorDiagnostic({...base,terminalKind})?.terminalKind).toBe(terminalKind);
 for(const method of DIAGNOSTIC_RPC_METHODS)expect(parseRuntimeErrorDiagnostic({...base,method})?.method).toBe(method);
});
it("refuses unknown private fields, malformed IDs and oversized values without retaining raw data",()=>{
 for(const value of [undefined,null,[],{},"private-canary",{...base,version:2},{...base,turnId:"private-session-canary"},{...base,diagnosticId:"https://private.invalid/key"},{...base,diagnosticId:"ev-"+"a".repeat(1000)+"-0"},{...base,processGeneration:"account-private"},{...base,method:"session/prompt\nprivate-canary"},{...base,terminalKind:"private-canary"},{...base,observedKind:"api\nprivate-canary"},{...base,message:"private-canary"},{...base,data:{apiKey:"private-canary"}},{...base,body:"private-canary".repeat(10000)}])expect(parseRuntimeErrorDiagnostic(value)).toBeUndefined();
});
it("accepts only actual bounded integer facts, never coerced strings or infinities",()=>{
 for(const [field,values] of Object.entries({httpStatus:["402",99,600,402.1,NaN,Infinity,null],rpcCode:["-32603",1.2,NaN,Infinity,Number.MAX_SAFE_INTEGER+1],rpcId:["1",-1,1.5,Infinity,Number.MAX_SAFE_INTEGER+1]}))for(const value of values)expect(parseRuntimeErrorDiagnostic({...base,[field]:value})).toBeUndefined();
 expect(parseRuntimeErrorDiagnostic({...base,rpcId:0,rpcCode:Number.MIN_SAFE_INTEGER,httpStatus:100})).toBeDefined();
});
