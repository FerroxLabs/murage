import importlib.util
import json
import hashlib
from pathlib import Path
import tempfile
import unittest
SPEC=importlib.util.spec_from_file_location('verify',Path(__file__).with_name('verify-receipt.py'))
mod=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(mod)
INSPECT=importlib.util.spec_from_file_location('inspect_replay',Path(__file__).with_name('inspect-replay.py'))
admission=importlib.util.module_from_spec(INSPECT);INSPECT.loader.exec_module(admission)
def fabricated_receipt(root,change=None):
 binding={'sourceSha':'a'*40,'corpusDigest':'b'*64,'policyDigest':'c'*64}
 result={**binding,'status':'PASS','receiptType':'candidate','kind':'real-redacted','policyConflict':False,'unexpected':0,'skipped':0,'tripwires':0,'expectedCases':1,'judgeCases':1,'wiringCases':1,'completedCases':1,'exitCodes':[0,0,0],'reviews':{x:'review-'+x for x in ['MAIN','Astra','Fable','INT19e']},**(change or {})}
 baseline={'shippedArtifactMappingVerified':True,**{k:[{'receiptType':'baseline-candidate-failure','assertion':'ordinary-owner zero cards','corpusDigest':'b'*64,'policyDigest':'c'*64}] for k in ['integration','shipped']}}
 artifacts={'run-manifest.json':binding,'admission.json':{'kind':'real-redacted','status':'PASS','digest':'b'*64,'cases':1},'result.json':result,'baseline-comparison.json':baseline,'coverage.json':{'missing':[],'required':['owner'],'observed':['owner'],'drivers':['acp','antigravity','claude','codex','muse','openai-chat','pi']},'audit-counts.json':{},'mutants.json':[{'name':'mutant-'+str(i),'receiptType':'mutant-assertion-failure','assertion':'named assertion','exitCode':1,'corpusDigest':'b'*64} for i in range(8)]}
 for name,value in artifacts.items():(root/name).write_text(json.dumps(value))
 counts={k:0 for k in ['request','allow','deny','ack','card','notify','audit','conversion-audit','answer-attempt','cleanup','terminal','barrier']}
 for k in ['request','allow','ack','audit','answer-attempt','terminal','barrier']:counts[k]=1
 (root/'cases.jsonl').write_text(json.dumps({'id':'c1','status':'PASS','judge':'PASS','wiring':'PASS','primary':'ordinary-owner','terminal':'completed','expectedCounts':counts})+'\n')
 (root/'observer.jsonl').write_text(''.join(json.dumps({'caseId':'c1','kind':k})+'\n' for k,n in counts.items() if n));(root/'cards.jsonl').write_text('');(root/'SUMMARY.md').write_text('PASS: fabricated test only\n')
 complete={**binding,'schema':'murage.nolim-complete.v1',**{k:result[k] for k in ['expectedCases','judgeCases','wiringCases','completedCases','exitCodes']},'files':{name:{'size':len((root/name).read_bytes()),'sha256':hashlib.sha256((root/name).read_bytes()).hexdigest()} for name in mod.FILES}}
 (root/'COMPLETE.json').write_text(json.dumps(complete))

class RunnerTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(prefix='nolim-runner-');self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
 def test_missing_stale_partial_or_synthetic_receipt_refused(self):
  for sentinel in [None,{}, {'status':'PASS','kind':'synthetic'}, {'status':'PASS','files':{'COMPLETE.json':{'sha256':'a'*64,'size':1}}}]:
   if sentinel is not None:(self.root/'COMPLETE.json').write_text(json.dumps(sentinel))
   with self.assertRaises(mod.InvalidReceipt):mod.verify(self.root,'a'*40,'b'*64,'c'*64)
 def test_reject_unsafe_mounts_and_unpinned_images(self):
  for path in ['/','/root','/home/user','.','/tmp','/root/.murage']:
   with self.assertRaises(mod.InvalidReceipt):mod.allocated_path(path,'corpus')
  for image in ['node:latest','node@sha256:bad','--privileged']:
   with self.assertRaises(mod.InvalidReceipt):mod.image_digest(image)
 def test_distinct_receipt_types(self):
  self.assertEqual(mod.RECEIPT_TYPES,{'candidate','baseline-characterization','baseline-candidate-failure','infrastructure-failure','mutant-assertion-failure'})
 def test_empty_corpus_never_reports_zero_cards_or_baseline_red(self):
  result=admission.comparison({'blockers':['MISSING-REQUEST-ENVELOPES'],'requestEnvelopes':0}, {'version':'1.0.18','sourceSha':'a'*40}, {'version':'1.0.19','sourceSha':'b'*40})
  for key in ['baseline','product']:
   self.assertIsNone(result[key]['ownerTurnCards'])
   self.assertIsNone(result[key]['ownerTurnCardsByReason'])
   self.assertFalse(result[key]['behaviouralRedEstablished'])
   self.assertEqual(result[key]['executedRequests'],0)
  self.assertFalse(result['releaseEligible'])
 def test_admission_is_not_replay_even_without_blockers(self):
  result=admission.comparison({'blockers':[],'requestEnvelopes':1}, {'version':'1.0.18'}, {'version':'1.0.19'})
  self.assertEqual(result['product']['reason'],'REPLAY-EXECUTION-REQUIRED')
  self.assertIsNone(result['product']['ownerTurnCards'])
 def test_baseline_version_must_be_1018(self):
  with self.assertRaises(ValueError):admission.comparison({'blockers':[]}, {'version':'1.0.19'}, {'version':'1.0.19'})
 def test_diagnostic_bundle_admission_and_tamper(self):
  raw=self.root/'raw';raw.mkdir(mode=0o700)
  (raw/'approvals-diag.txt').write_text('[2026-11-09T13:00:00Z] approvals: asked bot=fake tool=Bash reason=unreadable origin=owner unattended=0 cmd=shell level=no-limits owner=1 suppressed=0\n')
  policy=json.loads(Path(__file__).with_name('export-policy-v1.json').read_text())
  corpus=self.root/'corpus';admission.export.extract(raw,corpus,policy)
  report=admission.inspect(corpus)
  self.assertEqual((report['diagnostics'],report['requestEnvelopes']),(1,0))
  self.assertIn('MISSING-REQUEST-ENVELOPES',report['blockers'])
  self.assertNotIn('POLICY-CONFLICT',report['blockers'])
  (corpus/'requests.jsonl').write_text('{}\n')
  with self.assertRaises(admission.export.PrivacyError):admission.inspect(corpus)
 def test_positive_and_tamper(self):
  fabricated_receipt(self.root)
  self.assertEqual(mod.verify(self.root,'a'*40,'b'*64,'c'*64)['status'],'PASS')
  (self.root/'cases.jsonl').write_text('{}\n')
  with self.assertRaises(mod.InvalidReceipt):mod.verify(self.root,'a'*40,'b'*64,'c'*64)
 def test_skipped_case_timeout_unreviewed_and_wrong_digest(self):
  for change in [{'skipped':1},{'exitCodes':[124]},{'sourceSha':'d'*40},{'kind':'synthetic'},{'policyConflict':True},{'reviews':{}},{'expectedCases':2},{'wiringCases':0},{'tripwires':1}]:
   sub=self.root/str(len(list(self.root.iterdir())));sub.mkdir();fabricated_receipt(sub,change)
   with self.assertRaises(mod.InvalidReceipt):mod.verify(sub,'a'*40,'b'*64,'c'*64)
if __name__=='__main__':unittest.main()
