"""All sources in this suite are fabricated. No personal paths are opened."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("nolim_extract", Path(__file__).with_name("extract.py"))
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)
LINE = '[2026-11-09T13:00:00.000Z] approvals: asked bot=fake tool=Bash reason=outside-turn origin=owner unattended=0 cmd=shell level=no-limits owner=0 suppressed=3\n'

class ExtractTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="nolim-fake-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.src = self.root / "raw-diag"
        self.src.mkdir(mode=0o700)
        self.policy = json.loads(Path(__file__).with_name("export-policy-v1.json").read_text())
    def extract(self, text=LINE, **kwargs):
        (self.src / "server.log").write_bytes(text.encode() if isinstance(text, str) else text)
        return mod.extract(self.src, self.root / "review", self.policy, **kwargs)
    def test_diagnostics_are_never_real_replay(self):
        result = self.extract()
        self.assertFalse(result["releaseEligible"])
        self.assertEqual(result["accepted"], 1)
        report = json.loads((self.root / "review" / "coverage.json").read_text())
        self.assertEqual(report["suppressionTail"], "unknown")
        self.assertEqual(report["missingRequestEnvelopes"], 1)
        self.assertFalse(report["chunkContextAvailable"])
    def test_main_grep_file_and_non_asked_census(self):
        (self.src/'approvals-diag.txt').write_text(LINE+'[2026-11-09T13:00:01Z] approvals: resolved request=CANARY_PRIVATE_SECRET\n')
        (self.src/'RECEIVED-AT.txt').write_text('CANARY_PRIVATE_SECRET')
        result=mod.extract(self.src,self.root/'review',self.policy)
        self.assertEqual(result['accepted'],1)
        coverage=mod.strict((self.root/'review/coverage.json').read_bytes())
        self.assertEqual(coverage['nonAskedLines'],1)
        self.assertEqual(coverage['candidates'],2)
        self.assertEqual(coverage['sourceAvailability'],['log-current'])
        for blob in mod.bundle_bytes(self.root/'review').values(): self.assertNotIn(b'CANARY',blob)
    def test_main_grep_cannot_mix_sources(self):
        (self.src/'approvals-diag.txt').write_text(LINE)
        with self.assertRaises(mod.PrivacyError): self.extract()
    def test_annex_count_only_includes_accepted_rows(self):
        result=self.extract(LINE.replace('13:00:00.000','02:01:00.000').replace('2026-11-09','2026-11-10').replace('outside-turn','CANARY_PRIVATE_SECRET'))
        coverage=mod.strict((self.root/'review/coverage.json').read_bytes())
        self.assertEqual((result['accepted'],coverage['incident'],coverage['annex']),(0,0,0))
    def test_diagnostic_seal_is_not_a_release_seal(self):
        self.extract(); review=self.root/'review'; data=mod.bundle_bytes(review); m=mod.strict(data['manifest.json'])
        out=self.root/'sealed'
        approval={'digest':mod.bundle_digest(data),'authorization':'sean-bld2-decision-1','destination':str(mod.RAW_DIAG.parent/'corpus/r1')+'/', 'retentionDays':30,'scope':'diagnostic-only','policyDigest':m['policy']['digest']}
        self.assertFalse(mod.seal_diagnostics(review,approval,out)['releaseEligible'])
        self.assertEqual(mod.bundle_bytes(out),data)
        with self.assertRaises(mod.PrivacyError): mod.seal(review,approval,self.root/'release')
        self.assertFalse((self.root/'release').exists())
    def test_diagnostic_seal_rejects_changed_digest(self):
        self.extract(); review=self.root/'review'; data=mod.bundle_bytes(review); m=mod.strict(data['manifest.json']); out=self.root/'sealed'
        approval={'digest':'a'*64,'authorization':'sean-bld2-decision-1','destination':str(mod.RAW_DIAG.parent/'corpus/r1')+'/', 'retentionDays':30,'scope':'diagnostic-only','policyDigest':m['policy']['digest']}
        with self.assertRaises(mod.PrivacyError):mod.seal_diagnostics(review,approval,out)
        self.assertFalse(out.exists())
    def test_duplicates_are_not_dropped(self):
        self.assertEqual(self.extract(LINE + LINE)["accepted"], 2)
    def test_same_chunk_second_ask_has_no_timestamp(self):
        second = LINE.split('] ', 1)[1]
        result = self.extract(LINE + second)
        self.assertEqual(result["quarantined"], 1)
        self.assertEqual(result["status"], "INCOMPLETE")
    def test_split_marker_is_not_guessed(self):
        result = self.extract(LINE.replace('approvals: asked', 'approvals: as\nked'))
        self.assertEqual(result["status"], "INCOMPLETE")
    def test_interleaved_stream_or_multiple_marker_is_ambiguous(self):
        self.assertEqual(self.extract(LINE.rstrip() + LINE)["quarantined"], 1)
    def test_boundary_chunk_has_no_precise_event_time(self):
        result = self.extract(LINE.replace('13:00:00.000', '12:00:00.000'))
        self.assertEqual(result["status"], "INCOMPLETE")
    def test_no_timestamp(self):
        self.assertEqual(self.extract(LINE.split('] ', 1)[1])["quarantined"], 1)
    def test_unknown_tool_mapping(self):
        self.assertEqual(self.extract(LINE.replace('tool=Bash', 'tool=PrivateCustomer'))["quarantined"], 1)
    def test_private_unknown_enum_and_multiline_split_escaped_canaries_do_not_export(self):
        secret = "CANARY_PRIVATE_SECRET"
        for text in [LINE.replace('outside-turn', secret), LINE + secret + '\n', LINE.replace('outside-turn', 'CANARY\\u005fPRIVATE_SECRET'), LINE + 'CANARY_PRIVATE_\nSECRET\n']:
            with self.subTest(text=text):
                out = self.root / f"review-{len(list(self.root.iterdir()))}"
                (self.src / 'server.log').write_text(text)
                mod.extract(self.src, out, self.policy)
                for path in out.iterdir():
                    if path.is_file(): self.assertNotIn('CANARY', path.read_text())
    def test_duplicate_unknown_keys_utf8_long_and_partial_lines(self):
        for data in [LINE.replace('cmd=shell', 'cmd=shell cmd=shell'), LINE.replace('cmd=shell', 'banana=secret'), b'\xff\n', 'x'*65537+'\n', LINE.rstrip()]:
            out = self.root / f"review-{len(list(self.root.iterdir()))}"
            (self.src / 'server.log').write_bytes(data.encode() if isinstance(data,str) else data)
            self.assertEqual(mod.extract(self.src, out, self.policy)["status"], 'INCOMPLETE')
    def test_symlink_and_existing_output_refused(self):
        target = self.root / 'fake'; target.write_text(LINE)
        (self.src / 'server.log').symlink_to(target)
        with self.assertRaises(mod.PrivacyError): mod.extract(self.src, self.root/'review', self.policy)
        (self.src/'server.log').unlink()
        self.extract()
        with self.assertRaises(mod.PrivacyError): mod.extract(self.src, self.root/'review', self.policy)
    def test_rotation_and_prefix_change(self):
        def mutate(path): path.write_text('rotated\n')
        self.assertEqual(self.extract(after_read=mutate)["status"], 'INCOMPLETE')
    def test_append_does_not_expand_captured_prefix(self):
        def append(path):
            with path.open('a') as f: f.write(LINE)
        self.assertEqual(self.extract(after_read=append)["accepted"], 1)
    def test_cutoff_cannot_shift(self):
        self.policy['window']['untilExclusive'] = '2026-11-10T03:00:00Z'
        with self.assertRaises(mod.PrivacyError): self.extract()
    def test_changed_quoting_truncation_or_origin_is_not_faithful(self):
        for before, after in [("rm -rf ~", "printf fixture"), ("cat 'a b'", 'cat a b'), ('abcdef', 'abc')]:
            with self.assertRaises(mod.PrivacyError): mod.check_replacement(before, after)
    def test_scan_decodes_escapes_and_joins_split_secret(self):
        for text in ['{"x":"CANARY_PRIVATE_SECRET"}', '{"x":"CANARY\\u005fPRIVATE_SECRET"}', '{"x":["CANARY_PRIVATE_","SECRET"]}']:
            with self.assertRaises(mod.PrivacyError): mod.scan(text.encode(), ['CANARY_PRIVATE_SECRET'])
    def test_seal_requires_exact_approval_and_unchanged_bytes(self):
        self.extract()
        with self.assertRaises(mod.PrivacyError): mod.seal(self.root/'review', {}, self.root/'approved')
        self.assertFalse((self.root/'approved').exists())
    def test_manifest_does_not_hash_itself(self):
        self.extract()
        manifest = json.loads((self.root/'review'/'manifest.json').read_text())
        self.assertNotIn('manifest.json', manifest['files'])
        self.assertEqual(len(manifest['files']), 5)
    def test_modes_are_private(self):
        self.extract()
        self.assertEqual((self.root/'review').stat().st_mode & 0o777, 0o700)
        self.assertTrue(all(p.stat().st_mode & 0o777 == 0o600 for p in (self.root/'review').iterdir() if p.is_file()))

    def reviewed_bundle(self):
        self.extract()
        review=self.root/'review';data=mod.bundle_bytes(review);m=mod.strict(data['manifest.json'])
        fixture=Path(__file__).with_name('fixtures')/'seal-example.json'
        case=json.loads(fixture.read_text().splitlines()[0]);case['kind']='real-redacted';case['diagnosticIds']=[mod.strict(data['diagnostics.jsonl'].splitlines()[0])['id']];case['provenance']['correlation']='recorded-id'
        data['requests.jsonl']=mod.encoded(case)
        data['mapping.json']=mod.encoded([{'diagnosticId':case['diagnosticIds'][0],'requestIds':[case['id']],'fidelity':'verified'}])
        m.update(cases=1,missing=0,quarantines=0,fidelity=True,originComplete=True)
        m['policy']['hookDecision']='superseded'
        m['review']={k:'review-'+k for k in m['review']}
        m['files']={n:{'size':len(data[n]),'sha256':mod.digest(data[n])} for n in mod.FILES[1:]};data['manifest.json']=mod.encoded(m)
        for name,blob in data.items():(review/name).write_bytes(blob)
        approval={'digest':mod.bundle_digest(data),'authorization':'main-reviewed','destination':'/root/fuigo-builds/orph/_ev/nolim-replay/1019/corpus/r1/','retentionDays':30,'reviewRefs':{k:'review-'+k for k in ['main','astra','fable']},'policyDigest':m['policy']['digest']}
        return review,data,approval
    def test_positive_seal_preserves_all_six_reviewed_bytes(self):
        review,data,approval=self.reviewed_bundle()
        out=self.root/'sealed';self.assertEqual(mod.seal(review,approval,out)['status'],'SEALED')
        self.assertEqual(mod.bundle_bytes(out),data)
    def test_seal_byte_change_after_approval_refused(self):
        review,data,approval=self.reviewed_bundle()
        def change():(review/'coverage.json').write_bytes(b'{}\n')
        with self.assertRaises(mod.PrivacyError):mod.seal(review,approval,self.root/'sealed',after_review=change)
        self.assertFalse((self.root/'sealed').exists())
    def test_raw_cleanup_is_exact_and_receipted_after_seal(self):
        review,data,approval=self.reviewed_bundle();out=self.root/'sealed';mod.seal(review,approval,out)
        original=mod.RAW_DIAG;mod.RAW_DIAG=self.src
        try:
            receipt=self.root/'deletion.json';mod.erase_raw(self.src,out,receipt,approval['digest'])
            self.assertFalse(self.src.exists());record=json.loads(receipt.read_text());self.assertTrue(record['rawDirectoryRemoved'])
            self.assertEqual(record['files'][0]['sha256'],mod.digest(LINE.encode()))
            self.assertIn('deletedAt',record)
        finally:mod.RAW_DIAG=original
    def test_existing_deletion_receipt_preserves_raw(self):
        review,data,approval=self.reviewed_bundle();out=self.root/'sealed';mod.seal(review,approval,out)
        original=mod.RAW_DIAG;mod.RAW_DIAG=self.src
        try:
            receipt=self.root/'deletion.json';receipt.write_text('existing')
            with self.assertRaises(FileExistsError):mod.erase_raw(self.src,out,receipt,approval['digest'])
            self.assertTrue((self.src/'server.log').exists())
        finally:mod.RAW_DIAG=original
    def test_main_raw_files_both_hashed_and_deleted(self):
        review,data,approval=self.reviewed_bundle();out=self.root/'sealed';mod.seal(review,approval,out)
        (self.src/'server.log').rename(self.src/'approvals-diag.txt')
        (self.src/'RECEIVED-AT.txt').write_text('fake-received-at')
        original=mod.RAW_DIAG;mod.RAW_DIAG=self.src
        try:
            receipt=self.root/'deletion.json';mod.erase_raw(self.src,out,receipt,approval['digest'])
            record=json.loads(receipt.read_text())
            self.assertEqual(record['deletedFiles'],2)
            self.assertEqual({f['name']:f['sha256'] for f in record['files']},{'approvals-diag.txt':mod.digest(LINE.encode()),'RECEIVED-AT.txt':mod.digest(b'fake-received-at')})
            self.assertFalse(self.src.exists())
        finally:mod.RAW_DIAG=original
    def test_unknown_raw_file_prevents_any_deletion(self):
        review,data,approval=self.reviewed_bundle();out=self.root/'sealed';mod.seal(review,approval,out)
        (self.src/'unexpected').write_text('fake')
        original=mod.RAW_DIAG;mod.RAW_DIAG=self.src
        try:
            with self.assertRaises(mod.PrivacyError):mod.erase_raw(self.src,out,self.root/'deletion.json',approval['digest'])
            self.assertTrue((self.src/'server.log').exists())
        finally:mod.RAW_DIAG=original


class StoreSelectTests(unittest.TestCase):
    """All database content and all 120 join keys are fabricated."""
    def setUp(self):
        ExtractTests.setUp(self)
        import sqlite3
        self.db=sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.keys=[{'diagnosticId':f'd{i:04d}','threadId':f't{i}', 'messageId':f'm{i}',
                    'requestId':f'r{i}','botId':'fake','tool':'Bash','at':1794229200000} for i in range(1,121)]
        self.db.create_function('readfile',1,lambda path: json.dumps(self.keys).encode() if path=='accepted-keys.json' else None)
        self.db.executescript('CREATE TABLE messages(thread_id TEXT,id TEXT,at INTEGER,kind TEXT,json TEXT,PRIMARY KEY(thread_id,id)); CREATE TABLE memory_thread_no(thread_id TEXT PRIMARY KEY,no INTEGER); CREATE TABLE memory_line_lineage(thread_no INTEGER,message_id TEXT,lsn INTEGER,turn_lsn INTEGER,mem_lsn INTEGER,footprint INTEGER,UNIQUE(thread_no,message_id));')
        self.message={'text':'CANARY_PRIVATE_SECRET','card':{'tool':'Bash','requestId':'r1','subtitle':'CANARY_PRIVATE_SECRET','cardClass':{'origin':'owner','unattended':False,'automated':False}},'parentId':'p1','turnId':'turn1'}
        self.db.execute('INSERT INTO messages VALUES(?,?,?,?,?)',('t1','m1',1794229200000,'options',json.dumps(self.message)))
        self.sql=Path(__file__).with_name('mac-select.sql').read_text()
    extract = ExtractTests.extract
    def selected(self):
        return [json.loads(row[0]) for row in self.db.execute(self.sql)]
    def test_fixed_select_never_exports_display_text(self):
        rows=self.selected(); self.assertEqual(len(rows),1)
        self.assertEqual(set(rows[0]),mod.STORE_FIELDS)
        self.assertNotIn('CANARY',json.dumps(rows)); self.assertIsNone(rows[0]['arguments'])
        self.assertIsNone(rows[0]['ownerStarted']); self.assertIsNone(rows[0]['outsideRead'])
    def test_select_excludes_wrong_keys_time_tool_and_extra_rows(self):
        for key,value in [('requestId','wrong'),('threadId','wrong'),('messageId','wrong'),('at',1794229200001),('tool','Read')]:
            original=self.keys[0][key]; self.keys[0][key]=value
            self.assertEqual(self.selected(),[]); self.keys[0][key]=original
        self.db.execute('INSERT INTO messages VALUES(?,?,?,?,?)',('elsewhere','secret',1794229200000,'options',json.dumps(self.message)))
        self.assertEqual(len(self.selected()),1)
    def test_select_rejects_missing_duplicate_or_oversize_key_sets(self):
        original=list(self.keys)
        for keys in [[],original[:-1],original+[original[0]],original[:-1]+[original[0]]]:
            self.keys=keys; self.assertEqual(self.selected(),[])
    def review_store(self,rows):
        source=self.root/'select.jsonl'; source.write_bytes(b''.join(mod.encoded(r) for r in rows))
        review={'records':[{'originalSha256':mod.digest(mod.encoded(r)),'sanitized':r,'replacements':[], 'censusBotAlias':'b0001','joinReceipt':'reviewed-fixture-join'} for r in rows], 'forbidden':['CANARY_PRIVATE_SECRET'], 'reviews':{'main':'fixture-main','astra':'fixture-astra','fable':'fixture-fable'}}
        path=self.root/'store-review.json'; path.write_bytes(mod.encoded(review)); return source,path
    def test_store_ingestion_keeps_six_file_seal_incomplete(self):
        self.extract(); source,review=self.review_store(self.selected())
        result=mod.ingest_store(self.root/'review',source,review,self.root/'store-out')
        self.assertEqual(result['requestEnvelopes'],0); self.assertFalse(result['releaseEligible'])
        data=mod.bundle_bytes(self.root/'store-out'); self.assertFalse(mod.strict(data['manifest.json'])['fidelity'])
        self.assertEqual(data['requests.jsonl'].strip(),b'')
        self.assertEqual((self.root/'store-out-local-only/store-rows.jsonl').stat().st_mode & 0o777,0o600)
    def test_redaction_cannot_change_unknown_context_into_authority(self):
        self.extract(); rows=self.selected(); source,review_path=self.review_store(rows)
        review=mod.strict(review_path.read_bytes()); record=review['records'][0]
        record['replacements']=[{'from':'null','to':'true'}]
        record['sanitized']=mod.strict(json.dumps(rows[0],separators=(',',':')).replace('null','true'))
        review_path.write_bytes(mod.encoded(review))
        with self.assertRaises(mod.PrivacyError): mod.ingest_store(self.root/'review',source,review_path,self.root/'bad-out')
        self.assertFalse((self.root/'bad-out').exists())
    def test_store_ingestion_rejects_invented_arguments_and_duplicate_joins(self):
        self.extract()
        for variant in ('arguments','ownerStarted','outsideRead','duplicate','extra','wrong-diagnostic','wrong-tool'):
            rows=self.selected()
            if variant=='duplicate': rows*=2
            elif variant=='extra': rows[0]['body']='CANARY_PRIVATE_SECRET'
            elif variant=='wrong-diagnostic': rows[0]['diagnosticId']='d9999'
            elif variant=='wrong-tool': rows[0]['tool']='Read'
            else: rows[0][variant]='invented'
            source,review=self.review_store(rows)
            with self.assertRaises(mod.PrivacyError): mod.ingest_store(self.root/'review',source,review,self.root/'bad-out')
            self.assertFalse((self.root/'bad-out').exists())

if __name__ == '__main__': unittest.main()
