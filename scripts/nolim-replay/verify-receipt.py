#!/usr/bin/env python3
"""Offline, value-free verification. A COMPLETE file is never sufficient by itself."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat

RECEIPT_TYPES={'candidate','baseline-characterization','baseline-candidate-failure','infrastructure-failure','mutant-assertion-failure'}
FILES=('run-manifest.json','admission.json','baseline-comparison.json','cases.jsonl','observer.jsonl','cards.jsonl','audit-counts.json','coverage.json','mutants.json','result.json','SUMMARY.md')
ROOT=Path('/root/fuigo-builds/orph/_ev/nolim-replay/1019')
class InvalidReceipt(Exception):pass

def need(ok,code):
 if not ok:raise InvalidReceipt(code)

def strict(raw):
 def pairs(items):
  result={}
  for k,v in items:
   need(k not in result and k not in ('__proto__','constructor','prototype'),'JSON-KEY');result[k]=v
  return result
 try:return json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda _:(_ for _ in ()).throw(InvalidReceipt('JSON-NUMBER')))
 except (ValueError,TypeError,RecursionError):raise InvalidReceipt('JSON') from None

def read(path):
 need(not path.is_symlink() and path.is_file(),'FILE')
 with path.open('rb') as stream:
  raw=stream.read(64*1024*1024+1)
 need(len(raw)<=64*1024*1024,'SIZE');return raw

def image_digest(image):
 need(bool(re.fullmatch(r'[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}',image)),'IMAGE-PIN');return image

def allocated_path(value,kind):
 p=Path(value)
 need(p.is_absolute() and '..' not in p.parts,'MOUNT')
 base=ROOT/('runs' if kind=='result' else 'corpus')
 need(p.is_relative_to(base) and p!=base,'MOUNT')
 for parent in [p,*p.parents]:need(not parent.is_symlink(),'MOUNT-LINK')
 return p

def verify(directory,sha,corpus,policy):
 need(bool(re.fullmatch('[a-f0-9]{40}',sha)) and all(re.fullmatch('[a-f0-9]{64}',v) for v in (corpus,policy)),'EXPECTED-DIGEST')
 root=Path(directory)
 for p in [root,*root.parents]:need(not p.is_symlink(),'LINK')
 complete=strict(read(root/'COMPLETE.json'));need(isinstance(complete,dict),'COMPLETE')
 need(complete.get('schema')=='murage.nolim-complete.v1','SCHEMA')
 need(complete.get('sourceSha')==sha and complete.get('corpusDigest')==corpus and complete.get('policyDigest')==policy,'BINDING')
 need(set(complete.get('files',{}))==set(FILES),'ARTIFACTS')
 artifacts={}
 for name in FILES:
  raw=read(root/name);meta=complete['files'][name]
  need(meta=={'size':len(raw),'sha256':hashlib.sha256(raw).hexdigest()},'ARTIFACT-DIGEST')
  artifacts[name]=raw
 need(set(p.name for p in root.iterdir())==set(FILES)|{'COMPLETE.json'},'UNEXPECTED-ARTIFACT')
 result=strict(artifacts['result.json']);manifest=strict(artifacts['run-manifest.json']);admission=strict(artifacts['admission.json'])
 need(all(isinstance(x,dict) for x in (result,manifest,admission)),'REPORT')
 for record in (complete,result,manifest):
  need(all(record.get(k)==v for k,v in [('sourceSha',sha),('corpusDigest',corpus),('policyDigest',policy)]),'REPORT-BINDING')
 need(result.get('status')=='PASS' and result.get('receiptType')=='candidate' and result.get('kind')=='real-redacted','REAL-CANDIDATE')
 need(result.get('policyConflict') is False and result.get('unexpected')==0 and result.get('skipped')==0 and result.get('tripwires')==0,'INCOMPLETE')
 need(result.get('exitCodes')==[0,0,0],'EXIT-CODES')
 n=result.get('expectedCases');need(type(n) is int and n>0 and n<=10000,'EMPTY')
 need(all(result.get(k)==n for k in ('judgeCases','wiringCases','completedCases')),'COUNTS')
 need(all(complete.get(k)==result.get(k) for k in ('expectedCases','judgeCases','wiringCases','completedCases','exitCodes')),'SENTINEL-COUNTS')
 need(set(result.get('reviews',{}))=={'MAIN','Astra','Fable','INT19e'} and all(isinstance(v,str) and re.fullmatch('[a-zA-Z0-9._:-]{1,160}',v) for v in result['reviews'].values()),'REVIEWS')
 need(admission.get('kind')=='real-redacted' and admission.get('status')=='PASS' and admission.get('digest')==corpus and admission.get('cases')==n,'ADMISSION')
 cases=[strict(line) for line in artifacts['cases.jsonl'].splitlines()]
 need(len(cases)==n and len({x.get('id') for x in cases})==n,'CASE-IDS')
 need(all(x.get('status')=='PASS' and x.get('judge')=='PASS' and x.get('wiring')=='PASS' for x in cases),'CASE-FAILURE')
 events=[strict(line) for line in artifacts['observer.jsonl'].splitlines()]
 need(events and all(isinstance(e,dict) and e.get('caseId') in {c['id'] for c in cases} for e in events),'OBSERVER-IDS')
 card_rows=[strict(line) for line in artifacts['cards.jsonl'].splitlines()]
 need(len(card_rows)==sum(e.get('kind')=='card' for e in events),'CARD-LEDGER')
 fields={'request','allow','deny','ack','card','notify','audit','conversion-audit','answer-attempt','cleanup','terminal','barrier'}
 for case in cases:
  expected=case.get('expectedCounts',{});need(set(expected)==fields and all(type(x) is int and x>=0 for x in expected.values()),'EXPECTED-COUNTS')
  own=[e for e in events if e['caseId']==case['id']]
  actual={kind:sum(e.get('kind')==kind for e in own) for kind in fields}
  need(actual==expected and actual['request']==actual['terminal']==actual['barrier']==1,'CONSERVATION')
  need(own[-1].get('kind')=='barrier' and all(e.get('kind') in fields for e in own),'COMPLETION-BARRIER')
  if case.get('primary')=='ordinary-owner':need(actual['allow']==actual['ack']==1 and actual['deny']==actual['card']==actual['notify']==actual['cleanup']==0 and actual['audit']==1,'OWNER-ZERO-CARDS')
  else:need(case.get('primary') in {'wipe-list','other-person-control','unproven-control','non-permission-control'} and case.get('exceptionProof'),'KEPT-STOP-PROOF')
  need(case.get('terminal')=='completed' if case.get('primary')=='ordinary-owner' else case.get('terminal') in {'completed','denied'},'TERMINAL')
 coverage=strict(artifacts['coverage.json']);need(coverage.get('missing')==[] and coverage.get('required')==coverage.get('observed') and bool(coverage.get('required')),'COVERAGE')
 need(coverage.get('drivers')==['acp','antigravity','claude','codex','muse','openai-chat','pi'],'DRIVER-COVERAGE')
 baseline=strict(artifacts['baseline-comparison.json']);need(baseline.get('shippedArtifactMappingVerified') is True,'SHIPPED-MAPPING')
 for kind in ('integration','shipped'):
  rows=baseline.get(kind,[]);need(any(x.get('receiptType')=='baseline-candidate-failure' and x.get('assertion') and x.get('corpusDigest')==corpus and x.get('policyDigest')==policy for x in rows),'BASELINE-RED')
 mutants=strict(artifacts['mutants.json']);need(isinstance(mutants,list) and len(mutants)>=8,'MUTANTS')
 need(len({x.get('name') for x in mutants})==len(mutants) and all(x.get('receiptType')=='mutant-assertion-failure' and x.get('assertion') and x.get('exitCode')==1 and x.get('corpusDigest')==corpus for x in mutants),'MUTANT-ASSERTION')
 return result

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('directory');parser.add_argument('--sha',required=True);parser.add_argument('--corpus',required=True);parser.add_argument('--policy',required=True)
 args=parser.parse_args()
 try:
  verify(args.directory,args.sha,args.corpus,args.policy);print('PASS: receipt verified')
 except (InvalidReceipt,OSError,KeyError,TypeError,AttributeError):
  print('BLOCKED: invalid or incomplete replay receipt');raise SystemExit(2)
