import { scrubSecrets } from "../src/lib/screen-envelope.ts";
import { describe, expect, it } from "vitest";
import { basicSpans, forwardSpans, maskBasicAuth, replaceTracked, type TrackedRule } from "./basic-auth-mask.ts";
const mark=(n:number)=>`«redacted ${n} chars»`;
const mask=(s:string,rules:readonly TrackedRule[]=[])=>maskBasicAuth(s,rules,mark);
const named=[
  ["Authorization: Basic dXNlcjpwYXNz","Authorization: «redacted 12 chars»"],
  ["Authorization: Basic\nAuthorization: Basic real==","Authorization: «redacted 0 chars»\nAuthorization: «redacted 6 chars»"],
  ["Authorization%3A%20Basic%20azph","Authorization%3A%20«redacted 4 chars»"],
  ["Authorization: Basic", "Authorization: Basic"],
  ["Authorization: Basic ==.","Authorization: «redacted 1 chars»"],
] as const;
describe("T38-BASIC",()=>{
  it.each(named)("GRAMMAR/EMPTY %s",(raw,want)=>expect(mask(raw)).toBe(want));
  it.each(["Basic configuration","HTTP Basic authentication is off","WWW-Authenticate: Basic realm=\"x\"","Authorization header is missing. Basic auth is off","Authorization: Basic%X","Authorization: Basic%2X"])("nonheaders and malformed first escape preserve %s",raw=>expect(mask(raw)).toBe(raw));
  it("GRAMMAR agrees with the independent frozen normal expression on bounded cases",()=>{
    const unit=String.raw`(?:%[0-9A-Fa-f]{2}|[^A-Za-z0-9%])`,takes=`authorization${unit}*basic${unit}+`;
    const re=new RegExp(`(authorization${unit}*)((?:basic${unit}+)+)((?:(?!${takes})(?:[^\\n\"'\\\\]|\\\\(?![\"'])|\\n[ \\t]))+)`,"gi");
    const values=["azph","==/v1","==A","==.","admin:s,ecret","admin:s;ecret","user:authorization:s3cret","abc~def&x=1","dXNl\n cjpw","a\\/b","Basic Basic x","authentication failed","eyJabcdefgh.abcdefgh.abcdefgh","glpat.token"];
    for(const prefix of ["","HTTP_","http","x","Proxy-"])for(const gap of [": ","%3A%20","\n","+","\u00a0","\u200b","\v","\f","\" : \""])for(const value of values){
      const raw=`${prefix}Authorization${gap}Basic ${value}`;
      expect(mask(raw),raw).toBe(raw.replace(re,(_m,lead,_scheme,payload)=>lead+mark(payload.length)));
    }
  });
  it("FORWARD freezes payload counts and widens complete intersecting replacements",()=>{
    const rules:TrackedRule[]=[(text,edits)=>replaceTracked(text,/abc/g,()=>"x",edits)];
    expect(mask("Authorization: Basic abc",rules)).toBe("Authorization: «redacted 3 chars»");
    const whole:TrackedRule=(text,edits)=>replaceTracked(text,/BEGIN[\s\S]*END/g,()=>"PEM",edits);
    expect(mask("BEGIN Authorization: Basic abc\nAuthorization: Basic xyz\nEND",[whole])).toBe("«redacted 6 chars»");
  });
  it("FORWARD keeps deletion events and insertion endpoint ownership",()=>{
    const spans=basicSpans("Authorization: Basic abc");expect(spans).toHaveLength(1);
    const s=spans[0]!;
    expect(forwardSpans(spans,[{start:s.start,end:s.end,length:0}])).toMatchObject([{start:s.start,end:s.start}]);
    expect(forwardSpans(spans,[{start:s.start,end:s.start,length:2}])).toMatchObject([{start:s.start,end:s.end+2}]);
    expect(forwardSpans(spans,[{start:s.end,end:s.end,length:2}])).toMatchObject([{start:s.start,end:s.end}]);
  });
  it("LIFECYCLE does not retain rule or matcher state after throw, interleave or reload",()=>{
    const a="Authorization Basic abc",b="HTTP Basic is off";
    expect(()=>mask(a,[()=>{throw new Error("rule");}])).toThrow("rule");
    expect(mask(a)).toBe("Authorization «redacted 3 chars»");expect(mask(b)).toBe(b);expect(mask(a)).toBe(mask(mask(a)));
    for(const [raw] of named)expect(mask(mask(raw))).toBe(mask(raw));
  });
});

it("T38-BASIC feedback masks the original header before other shapes destroy it",()=>{
  expect(scrubSecrets("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: [removed]");
  expect(scrubSecrets("Authorization Basic sk-abcdefghijklmnopqrstuv")).toBe("Authorization [removed]");
});

function random(seed=0x101940){let state=seed;return(n:number)=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state%n;};}
it("T38-BASIC-FORWARD: 20,000 seeded multi-rule edits versus independent reverse-edit interpreter",()=>{
  const next=random();
  type Span={start:number;end:number;origins:{id:number;length:number}[]};
  const reference=(input:readonly Span[],edits:readonly {start:number;end:number;length:number}[]):Span[]=>{
    const spans=input.map(s=>({...s,origins:s.origins.map(o=>({...o}))}));
    for(const s of spans)for(const e of [...edits].reverse()){
      const shift=e.length-e.end+e.start;
      if(e.end<=s.start && !(e.start===e.end&&e.start===s.start)){s.start+=shift;s.end+=shift;}
      else if(e.start<s.end || (s.start===s.end&&e.start===s.start)){
        s.start=Math.min(s.start,e.start);s.end=Math.max(e.start+e.length,s.end+shift);
      }
    }
    const out:Span[]=[];
    for(const s of spans){const last=out.at(-1);if(last&&s.start<=last.end){last.end=Math.max(last.end,s.end);for(const o of s.origins)if(!last.origins.some(x=>x.id===o.id))last.origins.push(o);}else out.push(s);}
    return out;
  };
  for(let run=0;run<20000;run++){
    let actual:Span[]=[{start:2,end:6,origins:[{id:0,length:3}]},{start:10,end:14,origins:[{id:1,length:4}]},{start:20,end:25,origins:[{id:2,length:2}]}],expected=actual,length=40;
    for(let rule=0;rule<3;rule++){
      const edits:{start:number;end:number;length:number}[]=[];
      for(let at=next(4);at<length;){const end=Math.min(length,at+next(5));edits.push({start:at,end,length:next(7)});at=end+1+next(6);}
      actual=forwardSpans(actual,edits).map(s=>({...s,origins:s.origins.map(o=>({...o}))}));expected=reference(expected,edits);
      expect(actual,{run,rule,edits}.toString()).toEqual(expected);length+=edits.reduce((sum,e)=>sum+e.length-e.end+e.start,0);
    }
  }
},30000);
it("T38-FEEDBACK-JWT: 30,000 seeded original-expression differential and five pinned edge cases",()=>{
  const next=random(3105),tokens=["e","y","J","eyJ","a","abcdefgh",".","-","_"," ","x","1","\n"];
  const old=/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
  const cases=["eyJ-eyJabcdefgh.abcdefghij.abcdefghij","-eyJabcdefgh.abcdefghij.abcdefghij-x","_eyJabcdefgh.abcdefghij.abcdefghij","eyJ1234567.eyJabcdefgh.abcdefgh.abcdefgh","eyJabcdefgh.abcdefgh.abcdefg-"];
  for(let run=0;run<30000;run++){let raw="";for(let count=5+next(30);count>0;count--)raw+=tokens[next(tokens.length)];if(run%3===0)raw+="eyJabcdefgh.abcdefgh.abcdefgh";cases.push(raw);}
  for(const raw of cases)expect(scrubSecrets(raw),raw).toBe(raw.replace(old,"[removed]"));
});

it("T38-BASIC-COST: matcher and complete feedback caller CPU budgets, best of three",()=>{
  const shapes=["Authorization"+" ".repeat(256),"Authorization"+"%20".repeat(64),"Authorization"+"%2".repeat(64),"Authorization"+"-".repeat(64),"Authorization Basic"+" ".repeat(64),"Authorization ","Authorization Basic ","Authorization Basic Basic ","Authorization Basic authorization authorization- ","Authorization Basic a\n ","Authorization Basic "+"\\".repeat(64),"Bearer Authorization: ","Authorization: Basic x\n","Authorization: Basic\nAuthorization: Basic x\n","eyJ-".repeat(64)];
  const cpu=(run:()=>unknown)=>{let best=Infinity;for(let i=0;i<3;i++){const before=process.cpuUsage();run();const used=process.cpuUsage(before);best=Math.min(best,(used.user+used.system)/1000);}return best;};
  for(const [size,limit] of [[65536,40],[131072,60],[1048576,500]])for(const shape of shapes){
    const raw=shape.repeat(Math.ceil(size!/shape.length)).slice(0,size);
    const matcher=cpu(()=>basicSpans(raw)),feedback=cpu(()=>scrubSecrets(raw));
    const scrubbed=scrubSecrets(raw);expect(scrubSecrets(scrubbed)).toBe(scrubbed);
    expect(matcher,`matcher ${size}/${shape.slice(0,32)}: ${matcher}ms`).toBeLessThan(limit!);
    expect(feedback,`feedback ${size}/${shape.slice(0,32)}: ${feedback}ms`).toBeLessThan(limit!);
  }
},120000);
it("T38-BASIC-LINEAR: 8/16/32 MiB many-short-line visits, allocations and output stay linear",()=>{
  const shape="Authorization Basic x\n";let previous:{visits:number;allocations:number}|undefined;
  for(const size of [8,16,32].map(mib=>mib*1048576)){
    const raw=shape.repeat(Math.floor(size/shape.length)),work={visits:0,allocations:0};
    const spans=basicSpans(raw,work);expect(spans).toHaveLength(raw.length/shape.length);
    expect(work.visits).toBeLessThan(6*raw.length);expect(work.allocations).toBeLessThan(6*raw.length);
    if(previous){expect(work.visits/previous.visits).toBeLessThan(2.2);expect(work.allocations/previous.allocations).toBeLessThan(2.2);}previous=work;
    const output=mask(raw);expect(output.length).toBeLessThan(raw.length*2);expect(output).not.toContain("Basic x");
  }
},120000);

it("T38-BASIC-LIFECYCLE masks every available byte before error truncation",()=>{
  expect(mask("Authorization: Basic dXNlcjpw")).toBe("Authorization: «redacted 8 chars»");
  expect(scrubSecrets("Authorization: Basic dXNlcjpw")).toBe("Authorization: [removed]");
});
