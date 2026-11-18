#!/usr/bin/env python3
"""Fabricated SQLite/card tests. Run only in the prescribed offline container."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from display_cards import ingest, load, load_bytes, offline, validate, FILES
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('extract',HERE/'extract.py');api=importlib.util.module_from_spec(spec);spec.loader.exec_module(api)
spec=importlib.util.spec_from_file_location('replay',HERE/'replay-display.py');replay=importlib.util.module_from_spec(spec);spec.loader.exec_module(replay)
START=1794225600000

def database():
    db=sqlite3.connect(':memory:')
    db.executescript('CREATE TABLE messages(thread_id TEXT,id TEXT,at INTEGER,kind TEXT,json TEXT); CREATE TABLE memory_thread_no(thread_id TEXT PRIMARY KEY,no INTEGER); CREATE TABLE memory_line_lineage(thread_no INTEGER,message_id TEXT,lsn INTEGER,turn_lsn INTEGER,mem_lsn INTEGER,footprint INTEGER,UNIQUE(thread_no,message_id));')
    return db

def add(db,i,*,origin='owner',unattended=0,automated=0,command='printf fixture',at=None,kind='options',subtitle=None,cut=None,summary='fixture summary',tool='Bash'):
    card={'requestId':f'fixture-r{i}','tool':tool,'subtitle':subtitle if subtitle is not None else json.dumps({'command':command}),'summary':summary,'toolInputTruncated':cut,'cardClass':{'origin':origin,'unattended':unattended,'automated':automated},'answered':'Allow','dismissed':0,'why':'FORBIDDEN_PROSE'}
    message={'text':'FORBIDDEN_CHAT','attachments':['FORBIDDEN_ATTACHMENT'],'card':card,'origin':'desktop','actorKind':'bot','memberBotId':'fixture-bot','parentId':None,'turnId':None}
    db.execute('INSERT INTO messages VALUES(?,?,?,?,?)',('fixture-thread',f'fixture-m{i}',START+i if at is None else at,kind,json.dumps(message)))

def select(db): return [api.strict(r[0]) for r in db.execute((HERE/'mac-select-v2.sql').read_text())]
def emit(records,path): path.write_bytes(b''.join(api.encoded(r) for r in records))

def fabricated(path):
    db=database()
    add(db,1,command='cat ~/.ssh/id_rsa')
    add(db,2,command='printf fixture')
    add(db,3,command='rm -rf /')
    add(db,4,origin='routine',automated=1,command='cat ~/.ssh/id_rsa')
    add(db,5,origin='routine',automated=1,unattended=1,command='cat ~/.ssh/id_rsa')
    add(db,6,origin='other',unattended=1,command='cat ~/.ssh/id_rsa')
    add(db,7,origin=None,unattended=1,automated=None,command='cat ~/.ssh/id_rsa')
    add(db,8,subtitle='fallback prose')
    add(db,9,subtitle='{"command":"printf '+('x'*16360)+'\n[truncated, 22 bytes more]',cut=1)
    add(db,10,subtitle=json.dumps({'command':'printf fixture','password':'«redacted 12 chars»'}))
    emit(select(db),path);db.close()

class DisplayTests(unittest.TestCase):
    def setUp(self):
        offline();self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.db=database()
    def tearDown(self): self.db.close();self.tmp.cleanup()
    def input(self,records):
        p=self.root/'input.jsonl';emit(records,p);return p
    def test_stdin_admission_preserves_seal_and_rejects_changed_bytes(self):
        add(self.db,1)
        out=self.root/'sealed';ingest(self.input(select(self.db)),out,api)
        manifest=(out/'manifest.json').read_bytes()
        blobs={n:(out/n).read_bytes() for n in FILES}
        self.assertEqual(load_bytes(manifest,blobs,api),load(out,api))
        with self.assertRaises(ValueError):load_bytes(manifest,{**blobs,'cards.jsonl':blobs['cards.jsonl'].replace(b'{',b'{ ',1)},api)
        with self.assertRaises(ValueError):load_bytes(manifest,{**blobs,'unexpected':b''},api)
    def test_projection_window_prose_and_lineage(self):
        add(self.db,1,at=START);add(self.db,2,at=1794276000000);add(self.db,3,at=1794276900000);add(self.db,4,at=START-1)
        add(self.db,5,kind='text');add(self.db,6,subtitle='fallback prose');add(self.db,7,tool=None)
        self.db.execute('INSERT INTO memory_thread_no VALUES(?,?)',('fixture-thread',3))
        self.db.execute('INSERT INTO memory_line_lineage VALUES(?,?,?,?,?,?)',(3,'fixture-m1',7,6,5,4))
        records=select(self.db);self.assertEqual(records[0]['total'],3)
        self.assertNotIn('FORBIDDEN',json.dumps(records));self.assertNotIn('fallback prose',json.dumps(records))
        self.assertEqual(records[1]['lineLsn'],7);self.assertIsNone(records[2]['boundedToolInput'])
        self.assertEqual(records[-1]['at'],1794276000000)
    def test_cap_and_count(self):
        for i in range(2002): add(self.db,i)
        records=select(self.db);self.assertEqual((records[0]['total'],records[0]['emitted'],len(records)),(2002,2000,2001));validate(records[1:],records[0])
    def test_signed_product_lineage_survives_seal(self):
        add(self.db,1)
        self.db.execute('INSERT INTO memory_thread_no VALUES(?,?)',('fixture-thread',3))
        self.db.execute('INSERT INTO memory_line_lineage VALUES(?,?,?,?,?,?)',(3,'fixture-m1',-3,-4,-(2**52),0))
        out=self.root/'out';ingest(self.input(select(self.db)),out,api)
        row=load(out,api)[1][0]
        self.assertEqual((row['lineLsn'],row['turnLsn'],row['memoryLsn']),(-3,-4,-(2**52)))
    def test_lineage_types_and_safe_integer_bounds(self):
        add(self.db,1);original=select(self.db)
        for key in ('threadNo','lineLsn','turnLsn','memoryLsn','footprintId'):
            for value in (True,'-1',1.5,2**53,-(2**53)):
                records=json.loads(json.dumps(original));records[1][key]=value
                with self.assertRaises(ValueError):validate(records[1:],records[0])
        for key in ('threadNo','footprintId'):
            records=json.loads(json.dumps(original));records[1][key]=-1
            with self.assertRaises(ValueError):validate(records[1:],records[0])
    def test_empty_has_count_and_seals_as_incomplete_window_evidence(self):
        records=select(self.db);out=self.root/'out';r=ingest(self.input(records),out,api);self.assertEqual(r['rows'],0);self.assertFalse(load(out,api)[0]['releaseEligible'])
    def test_synthetic_roundtrip_and_approximate_collisions(self):
        p=self.root/'fabricated.jsonl';fabricated(p)
        minutes=self.root/'minutes.jsonl';emit([{'diagnosticId':'d0001','tool':'Bash','minute':START}],minutes)
        out=self.root/'out';result=ingest(p,out,api,minutes)
        self.assertEqual((result['rows'],result['missingInput'],result['truncated']),(10,1,1))
        manifest,rows=load(out,api);self.assertFalse(manifest['releaseEligible']);self.assertEqual(rows[0]['boundedToolInput'],json.loads(p.read_text().splitlines()[1])['boundedToolInput'])
        matching=json.loads((out/'matching.json').read_text());self.assertEqual(len(matching['rows'][0]['cardOrdinals']),10);self.assertEqual(matching['correlation'],'APPROXIMATE')
        self.assertEqual((out/'cards.jsonl').stat().st_mode&0o777,0o600)
    def test_secrets_refused_before_output(self):
        for text in ('{"password":"fixture-sensitive-value"}','{"command":"CANARY_PRIVATE_SECRET"}'):
            self.db.execute('DELETE FROM messages');add(self.db,1,subtitle=text)
            out=self.root/'out'
            with self.assertRaises(ValueError): ingest(self.input(select(self.db)),out,api)
            self.assertFalse(out.exists())
    def test_count_duplicate_unknown_fields_and_window_fail_closed(self):
        add(self.db,1);original=select(self.db)
        mutations=[lambda x:x[0].update(total=2),lambda x:x[1].update(text='forbidden'),lambda x:x[1].update(at=1794276900000),lambda x:x[1]['cardClass'].update(unattended='false'),lambda x:x.append(x[1])]
        for change in mutations:
            rows=json.loads(json.dumps(original));change(rows)
            with self.assertRaises(ValueError): validate(rows[1:],rows[0])
    def test_missing_input_not_guessed_from_summary_json(self):
        add(self.db,1,subtitle='{"command":"printf fixture"}',summary=None)
        self.assertIsNone(select(self.db)[1]['boundedToolInput'])
    def test_tamper_seal_rejected(self):
        add(self.db,1);out=self.root/'out';ingest(self.input(select(self.db)),out,api)
        with (out/'cards.jsonl').open('ab') as f:f.write(b'\n')
        with self.assertRaises(ValueError):load(out,api)
    def test_missing_minutes_never_invents_census_join(self):
        add(self.db,1);out=self.root/'out';ingest(self.input(select(self.db)),out,api)
        self.assertEqual(json.loads((out/'matching.json').read_text())['rows'],[])
    def test_parity_detects_same_count_different_verdict(self):
        row={'ordinal':0,'cohort':'non-owner','status':'judged','cards':1,'reason':'sensitive-guard','parityDigest':'a'}
        result=replay.compare([row],[{**row,'parityDigest':'b'}]);self.assertEqual(result['non-owner']['parity'],'FAIL')
        result=replay.compare([row],[row]);self.assertEqual(result['non-owner']['parity'],'PASS');self.assertEqual(result['routine']['parity'],'NOT-REQUIRED')
    def test_truncated_not_completed_or_executed(self):
        add(self.db,1,subtitle='{"command":"printf fixture\n[truncated, 99 bytes more]',cut=1)
        records=select(self.db);self.assertIsNotNone(records[1]['boundedToolInput']);out=self.root/'out';ingest(self.input(records),out,api)
        self.assertEqual(load(out,api)[1][0]['toolInputTruncated'],1)
    def test_owner_holds_need_exception_evidence_and_complete_input(self):
        row={'ordinal':0,'cohort':'owner','status':'judged','cards':1,'reason':'always-ask','rule':'unreadable','parityDigest':'a'}
        cohorts=replay.compare([row],[row])
        self.assertEqual(cohorts['owner']['tip']['cardsWithoutExceptionEvidence'],1)
        self.assertEqual(cohorts['owner']['tip']['byRule'],{'unreadable':1})
        self.assertEqual(replay.owner_target(cohorts),'NOT-ESTABLISHED')
        allowed={**row,'exceptionEvidence':'wipe-list','rule':'delete-root'}
        self.assertEqual(replay.owner_target(replay.compare([allowed],[allowed])),'MET-FOR-JUDGED-DISPLAY-ONLY')
        for evidence in ('deny-rule','stored-permission-rule','not-established'):
            denied={**row,'exceptionEvidence':evidence,'rule':'browser-never'}
            self.assertEqual(replay.owner_target(replay.compare([denied],[denied])),'NOT-ESTABLISHED')
        refused={**row,'cards':0,'refusals':1}
        self.assertEqual(replay.owner_target(replay.compare([refused],[refused])),'NOT-ESTABLISHED')
        cut={'ordinal':1,'cohort':'owner','status':'truncated-input'}
        cohorts=replay.compare([allowed,cut],[allowed,cut])
        self.assertEqual(cohorts['owner']['unavailableByReason'],{'truncated-input':1})
        self.assertEqual(replay.owner_target(cohorts),'NOT-ESTABLISHED')
        self.assertEqual(replay.owner_target(replay.compare([],[])),'NOT-ESTABLISHED')
    def test_judge_emits_fixed_policy_evidence_without_display_text(self):
        p=self.root/'fabricated.jsonl';fabricated(p)
        rows=[api.strict(line) for line in p.read_bytes().splitlines()][1:]
        out=self.root/'judged.json'
        result=subprocess.run(['node','--experimental-strip-types',str(HERE/'display-judge.ts'),str(out)],input=api.encoded(rows),capture_output=True,timeout=60)
        self.assertEqual(result.returncode,0);self.assertEqual(result.stdout,b'')
        data=out.read_bytes();self.assertNotIn(b'printf',data);self.assertNotIn(b'password',data)
        judged=api.strict(data)
        self.assertEqual((judged[2]['cards'],judged[2]['rule'],judged[2]['exceptionEvidence']),(1,'delete-root','wipe-list'))
        self.assertEqual(judged[1]['cards'],0)
        self.assertEqual(judged[8]['status'],'truncated-input')
    def test_cut_secret_member_and_escaped_secret_key_refused(self):
        for text in ('{"password":"tiny","command":"printf fixture\\n[truncated, 99 bytes more]', '{"pass\\u0077ord":"tiny","command":"printf fixture\\n[truncated, 99 bytes more]', '{"password":"incomplete\\n[truncated, 99 bytes more]'):
            text=text.replace('\\n','\n')
            self.db.execute('DELETE FROM messages');add(self.db,1,subtitle=text,cut=1)
            with self.assertRaises(ValueError):ingest(self.input(select(self.db)),self.root/'out',api)
    def test_shell_tail_survives_per_value_limit(self):
        command='printf '+('x'*3000)+' fixture-tail'
        add(self.db,1,command=command)
        out=self.root/'out';ingest(self.input(select(self.db)),out,api)
        self.assertEqual(json.loads(load(out,api)[1][0]['boundedToolInput'])['command'],command)
    def test_partial_line_and_symlink_refused(self):
        add(self.db,1);p=self.input(select(self.db));p.write_bytes(p.read_bytes().rstrip(b'\n'))
        with self.assertRaises(ValueError):ingest(p,self.root/'out',api)
        link=self.root/'link';link.symlink_to(p)
        with self.assertRaises(api.PrivacyError):ingest(link,self.root/'out',api)

if __name__=='__main__':
    if len(sys.argv)==3 and sys.argv[1]=='--fabricate':
        offline();fabricated(Path(sys.argv[2]));print('{"fabricatedRows":10}')
    else: unittest.main()
