#!/usr/bin/env python3
"""Offline build-host-only extractor. Never run this (or any repo code) on the Mac.
Only explicitly supplied, authorized copies are read. Raw content never reaches
stdout/stderr. A grep-only census cannot prove chunk context or faithful calls.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
from datetime import datetime, timezone

FILES = ('manifest.json', 'diagnostics.jsonl', 'requests.jsonl', 'mapping.json', 'coverage.json', 'redaction-report.json')
WINDOW = {'since': '2026-11-09T12:00:00Z', 'untilExclusive': '2026-11-10T02:00:00Z', 'annexUntilExclusive': '2026-11-10T02:15:00Z'}
MAX_BYTES = 128 * 1024 * 1024
class PrivacyError(Exception): pass

def digest(data): return hashlib.sha256(data).hexdigest()
def encoded(value): return (json.dumps(value, ensure_ascii=True, separators=(',', ':')) + '\n').encode()
def pairs(items):
    out = {}
    for key, value in items:
        if key in out or key in ('__proto__', 'prototype', 'constructor'): raise PrivacyError('KEY')
        out[key] = value
    return out

def strict(data):
    if len(data) > MAX_BYTES: raise PrivacyError('SIZE')
    try:
        value = json.loads(data, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(PrivacyError('NUMBER')))
        def walk(v, depth=0):
            if depth > 128: raise PrivacyError('DEPTH')
            if isinstance(v, float) and (v == float('inf') or v == float('-inf')): raise PrivacyError('NUMBER')
            for child in (v.values() if isinstance(v, dict) else v if isinstance(v, list) else []): walk(child, depth+1)
        walk(value)
        return value
    except (ValueError, UnicodeError, RecursionError): raise PrivacyError('JSON') from None

def no_links(path):
    path = Path(path).absolute()
    for part in [path, *path.parents]:
        if part.is_symlink(): raise PrivacyError('LINK')
    return path

def read_private(path):
    path = no_links(path)
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(fd, 'rb') as handle:
        before = os.fstat(handle.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_BYTES: raise PrivacyError('FILE')
        data = handle.read(before.st_size)
        if len(data) != before.st_size: raise PrivacyError('ROTATION')
    return data, before

def private_dir(path):
    path = no_links(path)
    if path.exists(): raise PrivacyError('EXISTS')
    path.mkdir(mode=0o700)
    return path

def write(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as handle: handle.write(data); handle.flush(); os.fsync(handle.fileno())

def bundle_bytes(path):
    path = no_links(path)
    if set(p.name for p in path.iterdir()) != set(FILES): raise PrivacyError('FILES')
    data = {name: read_private(path/name)[0] for name in FILES}
    if sum(map(len, data.values())) > MAX_BYTES: raise PrivacyError('SIZE')
    manifest = strict(data['manifest.json'])
    if set(manifest.get('files', {})) != set(FILES[1:]): raise PrivacyError('HASH-SET')
    for name in FILES[1:]:
        if manifest['files'][name] != {'size':len(data[name]), 'sha256':digest(data[name])}: raise PrivacyError('DIGEST')
    return data

def bundle_digest(data):
    return digest(''.join(f'{name}\t{len(data[name])}\t{digest(data[name])}\n' for name in FILES).encode())

def scan(data, forbidden=()):
    """Independent byte + recursively decoded scalar scanner; no match text escapes."""
    try: text = data.decode('utf-8', errors='strict')
    except UnicodeError: raise PrivacyError('UTF8') from None
    decoded = []
    def scalars(value):
        if isinstance(value, str): decoded.append(value)
        elif isinstance(value, list):
            for v in value: scalars(v)
        elif isinstance(value, dict):
            for k,v in value.items(): decoded.append(k); scalars(v)
    for line in text.splitlines():
        try: scalars(strict(line))
        except PrivacyError: pass
    candidates = [text, ''.join(decoded), re.sub(r'\s+', '', text), re.sub(r'\s+', '', ''.join(decoded))]
    patterns = [r'CANARY_PRIVATE_SECRET', r'-----BEGIN .*PRIVATE KEY', r'\b(?:gh[pousr]_|github_pat_|xox[baprs]-|sk-proj-)[A-Za-z0-9_-]{16,}', r'/Users/(?!fixture(?:/|\b))', r'/home/(?!fixture(?:/|\b))', r'(?i)authorization\s*[:=]', r'\b\d{1,3}(?:\.\d{1,3}){3}\b']
    for candidate in candidates:
        if any(token and token in candidate for token in forbidden) or any(re.search(p, candidate) for p in patterns): raise PrivacyError('EXPORT-SCAN')

def extract(source, output, policy, after_read=None):
    source = no_links(source); output = no_links(output)
    if policy.get('window') != WINDOW or source == output or source in output.parents: raise PrivacyError('WINDOW-OR-PATH')
    if output.exists(): raise PrivacyError('EXISTS')
    # Validate all sources before making an output directory.
    inputs = []
    sources = [('server.log.1', 'log-previous'), ('server.log', 'log-current')]
    # MAIN's completed grep used one literal file, from server.log only.
    if (source/'approvals-diag.txt').exists() or (source/'approvals-diag.txt').is_symlink():
        if not set(p.name for p in source.iterdir()).issubset({'approvals-diag.txt','RECEIVED-AT.txt'}): raise PrivacyError('SOURCE-AMBIGUOUS')
        sources = [('approvals-diag.txt', 'log-current')]
    for name, alias in sources:
        path = source/name
        if not path.exists() and not path.is_symlink():
            if name in ('server.log', 'approvals-diag.txt'): raise PrivacyError('MISSING')
            continue
        data, st = read_private(path); inputs.append((path, alias, data, st))
    rows, errors, exclusions, aliases, local_receipts = [], [], 0, {}, []
    seen_previous = set()
    salt = secrets.token_hex(32)
    total = 0
    non_asked = 0
    since = datetime.fromisoformat(WINDOW['since'].replace('Z','+00:00'))
    until = datetime.fromisoformat(WINDOW['untilExclusive'].replace('Z','+00:00'))
    annex = datetime.fromisoformat(WINDOW['annexUntilExclusive'].replace('Z','+00:00'))
    annex_count = 0
    for path, alias, data, st in inputs:
        local_receipts.append({'source':alias,'device':st.st_dev,'inode':st.st_ino,'size':st.st_size,'prefixSha256':digest(data)})
        for line_no, raw in enumerate(data.splitlines(keepends=True), 1):
            total += 1
            def error(code): errors.append({'ordinal':total,'code':code})
            if len(raw) > policy['maxLineBytes']: error('LINE-SIZE'); continue
            if not raw.endswith(b'\n'): error('PARTIAL-LINE'); continue
            try: line = raw.decode('utf-8', errors='strict').rstrip('\r\n')
            except UnicodeError: error('UTF8'); continue
            # The new fixed grep pattern is "approvals:", not just asked.
            # Count other events without exporting their fields or inferring cards.
            if 'approvals:' in line and 'approvals: asked ' not in line:
                non_asked += 1; continue
            # grep has destroyed surrounding chunk context. Never borrow the preceding timestamp.
            if line.count('approvals: asked ') != 1: error('CHUNK-OR-STREAM'); continue
            match = re.fullmatch(r'\[(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z)\] (?:[^\r\n]*? )?approvals: asked (.*)', line)
            if not match: error('TIMESTAMP-OR-SPLIT'); continue
            try: at = datetime.fromisoformat(match[1].replace('Z','+00:00'))
            except ValueError: error('TIMESTAMP'); continue
            if at in (since, until, annex): error('BOUNDARY-AMBIGUOUS'); continue
            if at < since or at >= annex: exclusions += 1; continue
            try:
                fields = {}
                for token in match[2].split(' '):
                    if token.count('=') != 1: raise PrivacyError('FIELD')
                    key, value = token.split('=')
                    if key in fields: raise PrivacyError('DUPLICATE-KEY')
                    if key == 'bot':
                        if not re.fullmatch(r'[\w-]{1,128}', value, flags=re.ASCII): raise PrivacyError('BOT')
                    elif key == 'tool':
                        if value not in policy['tools']: raise PrivacyError('TOOL-MAPPING')
                    elif key == 'suppressed':
                        if not re.fullmatch(r'0|[1-9]\d{0,8}', value): raise PrivacyError('COUNT')
                    elif key not in policy['enums'] or value not in policy['enums'][key]: raise PrivacyError('ENUM-OR-KEY')
                    fields[key] = value
                if not set(policy['required']) <= set(fields): raise PrivacyError('MISSING-FIELD')
            except PrivacyError as exc: error(str(exc)); continue
            if alias == 'log-current' and raw in seen_previous: error('UNKNOWN-OVERLAP'); continue
            if alias == 'log-previous': seen_previous.add(raw)
            key = digest((salt + fields.pop('bot')).encode())
            if key not in aliases: aliases[key] = f'b{len(aliases)+1:04d}'
            tool = fields.pop('tool'); suppressed = int(fields.pop('suppressed'))
            fields['reportedOrigin'] = fields.pop('origin')
            rows.append({'id':f'd{len(rows)+1:04d}','sourceAlias':alias,'line':line_no,'elapsedMs':None,'bot':aliases[key],'tool':tool,'fields':fields,'suppressedPreviousWindow':suppressed})
            if at >= until: annex_count += 1
        if after_read: after_read(path)  # test-only injection; CLI never exposes callbacks
        try:
            current, newst = read_private(path)
            if (st.st_dev,st.st_ino) != (newst.st_dev,newst.st_ino) or current[:st.st_size] != data: errors.append({'ordinal':total,'code':'ROTATION'})
        except (OSError, PrivacyError): errors.append({'ordinal':total,'code':'ROTATION'})
    output = private_dir(output)
    # Alias salts and raw hashes never enter the six-file directory.
    local = private_dir(output.with_name(output.name + '-local-only'))
    write(local/'source-receipt.json', encoded(local_receipts))
    write(local/'aliases.json', encoded({'salt':salt,'aliases':aliases}))
    coverage = {'candidates':total,'accepted':len(rows),'quarantined':len(errors),'boundaryExclusions':exclusions,'incident':len(rows)-annex_count,'annex':annex_count,'suppressedPreviousWindows':sum(r['suppressedPreviousWindow'] for r in rows),'suppressionTail':'unknown','missingRequestEnvelopes':len(rows),'missingContext':len(rows),'missingLineage':len(rows),'missingCorrelation':len(rows),'chunkContextAvailable':False,'sourceLineNumbersAvailable':False,'sourceAvailability':[x[1] for x in inputs], 'reasonCounts':{r:sum(x['fields']['reason']==r for x in rows) for r in sorted({x['fields']['reason'] for x in rows})}}
    coverage['nonAskedLines'] = non_asked
    payload = {'diagnostics.jsonl':b''.join(encoded(r) for r in rows) or b'\n','requests.jsonl':b'\n','mapping.json':encoded([]),'coverage.json':encoded(coverage),'redaction-report.json':encoded({'pass':True,'errors':errors,'releaseEligible':False,'chunkContext':'unavailable-grep-only','lineMeaning':'extract-ordinal-not-original-source'})}
    manifest = {'schema':'murage.nolim-replay.v1','kind':'real-redacted','exporter':'nolim-export-v1','window':WINDOW,'files':{n:{'size':len(b),'sha256':digest(b)} for n,b in payload.items()},'cases':0,'diagnostics':len(rows),'quarantines':len(errors),'missing':len(rows),'suppressedPreviousWindows':coverage['suppressedPreviousWindows'],'tailSuppression':'unknown','preciseEventTimes':False,'sourceAvailability':coverage['sourceAvailability'],'fidelity':False,'originComplete':False,'redactionPass':True,'policy':{'id':'two-exceptions-v1','digest':digest(encoded(policy)),'hookDecision':'unresolved'},'review':{'main':None,'astra':None,'fable':None,'approval':None},'shippedSha':'6e4dda8afd788c113f348a29033ead128ac103c1','integrationSha':'c12aaad9341e8f87126a193f35b5c2768f0aa66f','ownerDenyStore':'absent','inventories':{'levels':[], 'reasons':[], 'engines':[]}}
    if policy.get('hookDecision') == 'superseded': manifest['policy']['hookDecision'] = 'superseded'
    payload['manifest.json'] = encoded(manifest)
    for name in FILES: scan(payload[name]); write(output/name, payload[name])
    # Even valid grep rows cannot establish completeness of chunks omitted on Mac.
    return {'status':'INCOMPLETE','accepted':len(rows),'quarantined':len(errors),'releaseEligible':False}

def check_replacement(before, after):
    # Conservative: byte-length and all syntax must remain identical. A reviewed
    # mapping may replace equal-length literal data only. No quoting/cut repair.
    if len(before.encode()) != len(after.encode()): raise PrivacyError('FIDELITY-LENGTH')
    syntax = r"[^A-Za-z0-9_\u0080-\uffff]"
    if re.findall(syntax, before) != re.findall(syntax, after): raise PrivacyError('FIDELITY-SYNTAX')

def schema_check(value, schema, root=None, depth=0):
    root = root or schema
    if depth > 128: raise PrivacyError('DEPTH')
    if '$ref' in schema:
        target = root
        for part in schema['$ref'].removeprefix('#/').split('/'): target = target[part]
        return schema_check(value, target, root, depth+1)
    if 'anyOf' in schema:
        for option in schema['anyOf']:
            try: schema_check(value, option, root, depth+1); return
            except PrivacyError: pass
        raise PrivacyError('SCHEMA')
    typ = schema.get('type')
    valid = {'object':isinstance(value,dict),'array':isinstance(value,list),'string':isinstance(value,str),'number':type(value) in (int,float),'integer':type(value) is int,'boolean':type(value) is bool,'null':value is None}
    if typ and not any(valid.get(t,False) for t in (typ if isinstance(typ,list) else [typ])): raise PrivacyError('TYPE')
    if 'const' in schema and value != schema['const']: raise PrivacyError('CONST')
    if 'enum' in schema and value not in schema['enum']: raise PrivacyError('ENUM')
    if isinstance(value,dict):
        props = schema.get('properties',{})
        if not set(schema.get('required',[])) <= set(value): raise PrivacyError('REQUIRED')
        if schema.get('additionalProperties') is False and set(value)-set(props): raise PrivacyError('FIELDS')
        for key,item in value.items():
            child = props.get(key,schema.get('additionalProperties',{}))
            if isinstance(child,dict): schema_check(item,child,root,depth+1)
    if isinstance(value,list):
        if len(value)<schema.get('minItems',0) or len(value)>schema.get('maxItems',100000): raise PrivacyError('COUNT')
        for item in value: schema_check(item,schema.get('items',{}),root,depth+1)
    if isinstance(value,str):
        if len(value)<schema.get('minLength',0) or len(value)>schema.get('maxLength',8*1024*1024): raise PrivacyError('SIZE')
        if 'pattern' in schema and not re.search(schema['pattern'],value): raise PrivacyError('PATTERN')
    if type(value) in (int,float) and (value<schema.get('minimum',-float('inf')) or value>schema.get('maximum',float('inf'))): raise PrivacyError('RANGE')

STORE_FIELDS = {'schema','diagnosticId','threadId','messageId','requestId','censusBotId',
    'storedMemberBotId','at','tool','arguments','argumentsAvailable','storedOrigin',
    'cardOrigin','actorKind','unattended','automated','inputTruncated','ownerStarted',
    'outsideRead','parentId','turnId','threadNo','lineLsn','turnLsn','memoryLsn','footprintId'}

def ingest_store(diagnostics, local_input, local_map, output):
    """Ingest the fixed SELECT, without pretending stored display cards are frames.

    The redacted projection stays local-only. The six-file census remains
    incomplete and cannot pass seal-export or release admission.
    """
    data = bundle_bytes(diagnostics)
    ds = {d['id']: d for d in (strict(line) for line in data['diagnostics.jsonl'].splitlines() if line.strip())}
    originals = [strict(line) for line in read_private(local_input)[0].splitlines() if line.strip()]
    review = strict(read_private(local_map)[0])
    if set(review) != {'records','forbidden','reviews'} or not review['forbidden'] or not all(review['reviews'].get(k) for k in ('main','astra','fable')): raise PrivacyError('REVIEW')
    if not originals or len(originals)>120 or len(originals)!=len(review['records']): raise PrivacyError('COUNT')
    rows, seen, identities = [], set(), set()
    for original, receipt in zip(originals,review['records']):
        if not isinstance(original,dict) or set(original)!=STORE_FIELDS or original['schema']!='murage.nolim-store-row.v1': raise PrivacyError('STORE-FIELDS')
        # This schema version explicitly cannot supply arguments or runtime marks.
        if original['arguments'] is not None or original['argumentsAvailable'] is not False or original['ownerStarted'] is not None or original['outsideRead'] is not None: raise PrivacyError('STORE-INVENTED')
        at=original['at']
        if type(at) is not int or not 1794225600000 < at < 1794276900000 or at==1794276000000: raise PrivacyError('STORE-WINDOW')
        for key in ('diagnosticId','threadId','messageId','requestId','censusBotId','tool'):
            if not isinstance(original[key],str) or not 0<len(original[key])<=200: raise PrivacyError('STORE-TYPE')
        for key in ('threadNo','lineLsn','turnLsn','memoryLsn','footprintId'):
            if original[key] is not None and (type(original[key]) is not int or original[key]<0): raise PrivacyError('STORE-TYPE')
        for key in ('unattended','automated','inputTruncated'):
            if original[key] is not None and (type(original[key]) is not int or original[key] not in (0,1)): raise PrivacyError('STORE-TYPE')
        for key in ('storedMemberBotId','storedOrigin','cardOrigin','actorKind','parentId','turnId'):
            if original[key] is not None and (not isinstance(original[key],str) or len(original[key])>200): raise PrivacyError('STORE-TYPE')
        did=original['diagnosticId']; identity=(original['threadId'],original['messageId'])
        if did not in ds or did in seen or identity in identities or original['tool']!=ds[did]['tool']: raise PrivacyError('STORE-JOIN')
        if set(receipt)!={'originalSha256','sanitized','replacements','censusBotAlias','joinReceipt'} or receipt['originalSha256']!=digest(encoded(original)) or not receipt['joinReceipt'] or receipt['censusBotAlias']!=ds[did]['bot']: raise PrivacyError('STORE-CORRELATION')
        transformed=json.dumps(original,ensure_ascii=False,separators=(',',':'))
        for replacement in receipt['replacements']:
            if set(replacement)!={'from','to'}: raise PrivacyError('MAPPING')
            check_replacement(replacement['from'],replacement['to'])
            transformed=transformed.replace(replacement['from'],replacement['to'])
        sanitized=strict(transformed)
        if sanitized!=receipt['sanitized'] or sanitized['diagnosticId']!=did: raise PrivacyError('FIDELITY')
        immutable=STORE_FIELDS-{'threadId','messageId','requestId','censusBotId','storedMemberBotId','parentId','turnId'}
        if any(sanitized[key]!=original[key] or type(sanitized[key]) is not type(original[key]) for key in immutable): raise PrivacyError('STORE-REDACTION-FACTS')
        scan(encoded(sanitized),review['forbidden'])
        seen.add(did); identities.add(identity); rows.append(sanitized)
    # Never alter request completeness or erase existing quarantine counts.
    projection=b''.join(encoded(row) for row in rows)
    coverage=strict(data['coverage.json'])
    coverage['storeProjection']={'rows':len(rows),'sha256':digest(projection),'missingArguments':len(rows),'missingRuntimeContext':len(rows),'releaseEligible':False}
    data['coverage.json']=encoded(coverage)
    manifest=strict(data['manifest.json'])
    manifest['files']={n:{'size':len(data[n]),'sha256':digest(data[n])} for n in FILES[1:]}
    data['manifest.json']=encoded(manifest)
    for blob in data.values(): scan(blob,review['forbidden'])
    receipt_bytes=encoded({'rows':len(rows),'reviews':review['reviews'],'sha256':digest(projection)})
    scan(receipt_bytes,review['forbidden'])
    output=no_links(output); local=output.with_name(output.name+'-local-only')
    if output.exists() or local.exists(): raise PrivacyError('EXISTS')
    output=private_dir(output); local=private_dir(local)
    write(local/'store-rows.jsonl',projection)
    write(local/'store-receipt.json',receipt_bytes)
    for name in FILES: write(output/name,data[name])
    return {'status':'INCOMPLETE','storeRows':len(rows),'requestEnvelopes':0,'releaseEligible':False}

def prepare_requests(diagnostics, local_input, local_map, output):
    data = bundle_bytes(diagnostics)
    mapping = strict(read_private(local_map)[0])
    if set(mapping) != {'records','forbidden','reviews','policyDecision','coverageReceipt'} or not mapping['forbidden'] or not all(mapping['reviews'].get(k) for k in ('main','astra','fable')) or mapping['policyDecision'] != 'superseded' or not mapping['coverageReceipt']: raise PrivacyError('REVIEW')
    originals = [strict(line) for line in read_private(local_input)[0].splitlines() if line]
    if not originals or len(originals)>10000 or len(originals)!=len(mapping['records']): raise PrivacyError('COUNT')
    schema = strict(read_private(Path(__file__).with_name('fixtures')/'schema-v1.json')[0])
    cases, joins = [], []
    for original, row in zip(originals,mapping['records']):
        if set(row) != {'originalSha256','sanitized','replacements','diagnosticIds','fidelityReceipt'} or row['originalSha256'] != digest(encoded(original)) or not row['fidelityReceipt']: raise PrivacyError('CORRELATION')
        # Apply only literal, structurally checked replacements; no fields may disappear.
        transformed = json.dumps(original,ensure_ascii=False,separators=(',',':'))
        for replacement in row['replacements']:
            if set(replacement) != {'from','to'}: raise PrivacyError('MAPPING')
            check_replacement(replacement['from'],replacement['to'])
            transformed = transformed.replace(replacement['from'],replacement['to'])
        sanitized = strict(transformed)
        if sanitized != row['sanitized']: raise PrivacyError('FIDELITY')
        schema_check(sanitized,schema)
        if sanitized['kind'] != 'real-redacted' or sanitized['provenance']['correlation']=='fabricated' or sanitized['diagnosticIds']!=row['diagnosticIds']: raise PrivacyError('PROVENANCE')
        scan(encoded(sanitized),mapping['forbidden']); cases.append(sanitized)
        for diag in row['diagnosticIds']:
            existing = next((r for r in joins if r['diagnosticId']==diag),None)
            if existing: existing['requestIds'].append(sanitized['id'])
            else: joins.append({'diagnosticId':diag,'requestIds':[sanitized['id']],'fidelity':'verified'})
    diag_ids = [strict(line)['id'] for line in data['diagnostics.jsonl'].splitlines() if line]
    if sorted(diag_ids)!=sorted(r['diagnosticId'] for r in joins) or len(set(c['id'] for c in cases))!=len(cases): raise PrivacyError('MAPPING')
    manifest = strict(data['manifest.json'])
    if manifest['quarantines']: raise PrivacyError('QUARANTINE')
    manifest.update(cases=len(cases),missing=0,fidelity=True,originComplete=True)
    manifest['review'].update(mapping['reviews']); manifest['policy']['hookDecision']='superseded'
    data['requests.jsonl']=b''.join(encoded(c) for c in cases); data['mapping.json']=encoded(joins)
    coverage = strict(data['coverage.json']); coverage['mappingReceipt']=mapping['coverageReceipt']; data['coverage.json']=encoded(coverage)
    manifest['files']={n:{'size':len(data[n]),'sha256':digest(data[n])} for n in FILES[1:]}; data['manifest.json']=encoded(manifest)
    for blob in data.values(): scan(blob,mapping['forbidden'])
    output=private_dir(output)
    for name in FILES: write(output/name,data[name])
    return {'status':'REVIEW','cases':len(cases)}

def seal(review, approval, output, after_review=None):
    data = bundle_bytes(review); manifest = strict(data['manifest.json'])
    required = {'digest','authorization','destination','retentionDays','reviewRefs','policyDigest'}
    if set(approval)!=required or approval['digest']!=bundle_digest(data) or not approval['authorization'] or approval['retentionDays']!=30 or approval['destination']!='/root/fuigo-builds/orph/_ev/nolim-replay/1019/corpus/r1/' or approval['policyDigest']!=manifest['policy']['digest'] or not all(approval['reviewRefs'].get(k) for k in ('main','astra','fable')): raise PrivacyError('APPROVAL')
    if not manifest['cases'] or manifest['missing'] or manifest['quarantines'] or not manifest['fidelity'] or not manifest['originComplete'] or not manifest['redactionPass'] or manifest['policy']['hookDecision']!='superseded': raise PrivacyError('CORPUS-INCOMPLETE')
    schema = strict(read_private(Path(__file__).with_name('fixtures')/'schema-v1.json')[0])
    cases=[strict(line) for line in data['requests.jsonl'].splitlines()]
    diagnostics=[strict(line) for line in data['diagnostics.jsonl'].splitlines()]
    joins=strict(data['mapping.json'])
    if len(cases)!=manifest['cases'] or len({c['id'] for c in cases})!=len(cases) or len(diagnostics)!=manifest['diagnostics'] or not diagnostics: raise PrivacyError('COUNTS')
    if not isinstance(joins,list) or len(joins)!=len(diagnostics) or len({j['diagnosticId'] for j in joins})!=len(joins): raise PrivacyError('MAPPING')
    if any(manifest['review'].get(k)!=approval['reviewRefs'].get(k) for k in ('main','astra','fable')): raise PrivacyError('REVIEW-BINDING')
    for c in cases:
        schema_check(c,schema)
        if c['kind']!='real-redacted' or not c['diagnosticIds'] or c['provenance']['correlation']=='fabricated' or c['trigger']['initiator'] in ('missing','conflicting'): raise PrivacyError('FIDELITY')
        if any(not any(j['diagnosticId']==d and c['id'] in j['requestIds'] and j['fidelity']=='verified' for j in joins) for d in c['diagnosticIds']): raise PrivacyError('MAPPING')
    for d in diagnostics:
        matches=[j for j in joins if j['diagnosticId']==d['id']]
        if len(matches)!=1 or not matches[0]['requestIds'] or any(not any(c['id']==r and d['id'] in c['diagnosticIds'] for c in cases) for r in matches[0]['requestIds']): raise PrivacyError('MAPPING')
    for blob in data.values(): scan(blob)
    if after_review: after_review()
    if bundle_bytes(review)!=data: raise PrivacyError('BYTES-CHANGED')
    output=private_dir(output)
    # All approved bytes copied verbatim; approval remains external.
    for name in FILES: write(output/name,data[name])
    if bundle_bytes(output)!=data: raise PrivacyError('COPY')
    return {'status':'SEALED','files':6}

RAW_DIAG = Path('/root/fuigo-builds/orph/_ev/nolim-replay/1019/raw-diag')
def seal_diagnostics(review, approval, output):
    """Seal an authorized census for retention, never certify replay fidelity.

    Separate from seal-export: incomplete evidence stays inadmissible to release.
    Sean's bld2 decision #1 authorizes these six redacted files at corpus/r1.
    """
    data = bundle_bytes(review); manifest = strict(data['manifest.json'])
    required = {'digest','authorization','destination','retentionDays','scope','policyDigest'}
    if set(approval) != required or approval['scope'] != 'diagnostic-only' or approval['digest'] != bundle_digest(data) or not approval['authorization'] or approval['destination'] != str(RAW_DIAG.parent/'corpus/r1')+'/' or approval['retentionDays'] != 30 or approval['policyDigest'] != manifest['policy']['digest']: raise PrivacyError('APPROVAL')
    if manifest['cases'] != 0 or manifest['fidelity'] or manifest['originComplete'] or not manifest['redactionPass'] or manifest['policy']['hookDecision'] != 'superseded' or data['requests.jsonl'].strip() or strict(data['mapping.json']) != []: raise PrivacyError('DIAGNOSTIC-ONLY')
    if strict(data['redaction-report.json']).get('releaseEligible') is not False: raise PrivacyError('DIAGNOSTIC-ONLY')
    for blob in data.values(): scan(blob)
    output = private_dir(output)
    for name in FILES: write(output/name,data[name])
    if bundle_bytes(output) != data: raise PrivacyError('COPY')
    return {'status':'SEALED-DIAGNOSTICS','files':6,'releaseEligible':False}

def erase_raw(raw, sealed, receipt, expected_digest):
    # Only MAIN's allocated diagnostic copies, never the Mac or application data.
    raw=Path(raw); receipt=no_links(receipt)
    if raw != RAW_DIAG or receipt.is_relative_to(raw): raise PrivacyError('RAW-ALLOCATION')
    no_links(raw)
    if bundle_digest(bundle_bytes(sealed)) != expected_digest: raise PrivacyError('RAW-SEAL')
    names={p.name for p in raw.iterdir()}
    if not names or not names.issubset({'server.log','server.log.1','approvals-diag.txt','RECEIVED-AT.txt'}): raise PrivacyError('RAW-FILES')
    files = [{'name':name,'size':len(data),'sha256':digest(data)} for name in sorted(names) for data,_ in [read_private(raw/name)]]
    record = {'schema':'murage.nolim-raw-deletion.v1','sealedDigest':expected_digest,'rawPath':str(raw),'files':files,'deletedFiles':0,'rawDirectoryRemoved':False,'preparedAt':datetime.now(timezone.utc).isoformat()}
    # Reserve a private receipt BEFORE deletion; existing/unwritable receipt fails
    # without destroying input. On interruption it remains a prepared receipt.
    write(receipt,encoded(record))
    for name in names: (raw/name).unlink()
    raw.rmdir()
    record.update(deletedFiles=len(names),rawDirectoryRemoved=True,deletedAt=datetime.now(timezone.utc).isoformat())
    with receipt.open('wb') as handle: handle.write(encoded(record)); handle.flush(); os.fsync(handle.fileno())

class PrivateParser(argparse.ArgumentParser):
    def error(self,message): raise PrivacyError('ARGUMENTS')

def main():
    parser=PrivateParser(add_help=False)
    parser.add_argument('mode',nargs='?',default='extract',choices=['extract','ingest-store','ingest-cards','prepare-requests','seal-export','seal-diagnostics'])
    for name in ['source','out','policy','diagnostics','local-input','local-map','review','approval','raw-diag','deletion-receipt','census-minutes']: parser.add_argument('--'+name)
    try:
        args=parser.parse_args()
        if args.mode=='extract': result=extract(Path(args.source),Path(args.out),strict(read_private(args.policy)[0]))
        elif args.mode=='ingest-cards':
            from display_cards import ingest
            result=ingest(Path(args.local_input),Path(args.out),sys.modules[__name__],Path(args.census_minutes) if args.census_minutes else None)
        elif args.mode=='ingest-store': result=ingest_store(Path(args.diagnostics),Path(args.local_input),Path(args.local_map),Path(args.out))
        elif args.mode=='prepare-requests': result=prepare_requests(Path(args.diagnostics),Path(args.local_input),Path(args.local_map),Path(args.out))
        else:
            if not args.raw_diag or not args.deletion_receipt: raise PrivacyError('RAW-CLEANUP-REQUIRED')
            approval=strict(read_private(args.approval)[0])
            out=Path(args.out)
            if args.mode=='seal-diagnostics' and out != RAW_DIAG.parent/'corpus/r1': raise PrivacyError('DESTINATION')
            result=(seal_diagnostics if args.mode=='seal-diagnostics' else seal)(Path(args.review),approval,out)
            erase_raw(Path(args.raw_diag),Path(args.out),Path(args.deletion_receipt),approval['digest'])
        print(json.dumps(result)); return 2 if result['status']=='INCOMPLETE' else 0
    except BaseException:
        # Deliberately no traceback, paths, raw tokens or argparse error details.
        print('{"status":"INCOMPLETE","errors":1}'); return 3
if __name__=='__main__': sys.exit(main())
