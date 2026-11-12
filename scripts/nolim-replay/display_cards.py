"""DISPLAY-FIDELITY admission. Does not reconstruct private input or runtime facts."""
import json
import re
import subprocess
from pathlib import Path

FIELDS = set('schema thread_id id at requestId tool boundedToolInput toolInputTruncated origin cardClass actorKind memberBotId answered dismissed parentId turnId threadNo lineLsn turnLsn memoryLsn footprintId'.split())
FILES = ('cards.jsonl', 'matching.json', 'redaction-report.json')
BASE = '292df98d80a1c55db3e6f232166fc05162b632ab'

def offline():
    if not Path('/.dockerenv').exists() or set(p.name for p in Path('/sys/class/net').iterdir()) != {'lo'}:
        raise ValueError('OFFLINE-CONTAINER')

def validate(rows, count):
    if set(count) != {'schema','total','emitted','limit'} or count['schema'] != 'murage.nolim-cards-count.v2' or count['limit'] != 2000:
        raise ValueError('COUNT')
    if any(type(count[k]) is not int or count[k]<0 for k in ('total','emitted')) or count['emitted'] != min(count['total'],2000) or len(rows)!=count['emitted']:
        raise ValueError('COUNT')
    seen=set()
    for r in rows:
        if not isinstance(r,dict) or set(r)!=FIELDS or r['schema']!='murage.nolim-card.v2': raise ValueError('FIELDS')
        if type(r['at']) is not int or not 1794225600000<=r['at']<1794276900000: raise ValueError('WINDOW')
        for k in ('thread_id','id','requestId','tool'):
            if not isinstance(r[k],str) or not 0<len(r[k])<=200: raise ValueError('TYPE')
        for k in ('origin','actorKind','memberBotId','answered','parentId','turnId'):
            if r[k] is not None and (not isinstance(r[k],str) or len(r[k])>500): raise ValueError('TYPE')
        # Product lineage uses negative positions for pre-upgrade lines and
        # STALE_MEM_LSN = -(2 ** 52). Preserve these signed values verbatim;
        # they are metadata, not authenticated runtime context for the judge.
        for k in ('threadNo','lineLsn','turnLsn','memoryLsn','footprintId'):
            minimum = 0 if k in ('threadNo','footprintId') else -(2 ** 53 - 1)
            if r[k] is not None and (type(r[k]) is not int or not minimum <= r[k] <= 2 ** 53 - 1): raise ValueError('TYPE')
        cc=r['cardClass']
        if not isinstance(cc,dict) or set(cc)!={'origin','unattended','automated'} or cc['origin'] not in (None,'owner','owner-channel','routine','other'): raise ValueError('CLASS')
        for v in (r['toolInputTruncated'],r['dismissed'],cc['unattended'],cc['automated']):
            if v is not None and (type(v) is not int or v not in (0,1)): raise ValueError('BOOLEAN')
        text=r['boundedToolInput']
        if text is not None:
            if not isinstance(text,str) or len(text.encode())>16600: raise ValueError('INPUT')
            try: parsed=json.loads(text)
            except ValueError:
                if r['toolInputTruncated']!=1 or not text.startswith('{"') or not re.search(r'\n\[truncated, \d+ bytes more\]$',text): raise ValueError('INPUT')
            else:
                if not isinstance(parsed,dict): raise ValueError('INPUT')
        identity=(r['thread_id'],r['id'])
        if identity in seen: raise ValueError('DUPLICATE')
        seen.add(identity)
    if rows != sorted(rows,key=lambda r:(r['at'],r['thread_id'],r['id'])): raise ValueError('ORDER')

def recheck(rows, api):
    # Production structure + content masking is checked again; any change is a
    # refusal, never an invitation to unmask or silently alter display evidence.
    for row in rows:
        text=row['boundedToolInput']
        if text is not None:
            try: api.strict(text)
            except api.PrivacyError:
                if not re.search(r'\n\[truncated, \d+ bytes more\]$',text): raise
        if b'CANARY_PRIVATE_SECRET' in api.encoded(row): raise ValueError('REDACTION')
    result=subprocess.run(['node','--experimental-strip-types',str(Path(__file__).with_name('check-card-redaction.ts'))],input=api.encoded(rows),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
    if result.returncode or result.stdout!=b'{"pass":true}\n': raise ValueError('REDACTION')

def ingest(local_input, output, api, census_minutes=None):
    offline()
    data=api.read_private(local_input)[0]
    if not data.endswith(b'\n'): raise ValueError('PARTIAL')
    records=[api.strict(line) for line in data.splitlines()]
    if not records: raise ValueError('COUNT')
    count,*rows=records
    validate(rows,count); recheck(rows,api)
    # Optional minute-only census index; it contains no purported exact join.
    matches=[]
    if census_minutes:
        seen=set()
        for line in api.read_private(census_minutes)[0].splitlines():
            d=api.strict(line)
            if set(d)!={'diagnosticId','tool','minute'} or not re.fullmatch(r'd\d{4}',d['diagnosticId']) or d['diagnosticId'] in seen or not isinstance(d['tool'],str) or type(d['minute']) is not int or d['minute']%60000 or not 1794225600000<=d['minute']<1794276900000: raise ValueError('CENSUS-MINUTE')
            seen.add(d['diagnosticId'])
            candidates=[i for i,r in enumerate(rows) if r['tool']==d['tool'] and r['at']//60000*60000==d['minute']]
            matches.append({'diagnosticId':d['diagnosticId'],'cardOrdinals':candidates,'correlation':'APPROXIMATE'})
            if len(matches)>120: raise ValueError('CENSUS-COUNT')
    blobs={'cards.jsonl':b''.join(api.encoded(r) for r in rows),
      'matching.json':api.encoded({'correlation':'APPROXIMATE','minuteSourceAvailable':census_minutes is not None,'rows':matches}),
      'redaction-report.json':api.encoded({'pass':True,'checkedRows':len(rows),'method':'production-structure-and-text-recheck','changed':0,'releaseEligible':False})}
    manifest={'schema':'murage.nolim-display.v2','fidelity':'DISPLAY-FIDELITY','source':'stored-masked-card',
      'baseSha':BASE,'rows':len(rows),'count':count,'inputSha256':api.digest(data),
      'files':{n:{'size':len(b),'sha256':api.digest(b)} for n,b in blobs.items()},
      'runtimeContext':'unavailable','originalArguments':'unavailable','correlation':'APPROXIMATE',
      'completeWindow':count['total']==len(rows),'releaseEligible':False}
    api.private_dir(output)
    for n,b in blobs.items(): api.write(output/n,b)
    api.write(output/'manifest.json',api.encoded(manifest))
    return {'status':'DISPLAY-FIDELITY','rows':len(rows),'total':count['total'],'missingInput':sum(r['boundedToolInput'] is None for r in rows),'truncated':sum(r['toolInputTruncated']==1 for r in rows),'approximateMatches':sum(bool(m['cardOrdinals']) for m in matches),'releaseEligible':False}

def load(path, api):
    offline(); path=api.no_links(path)
    if set(p.name for p in path.iterdir())!=set(FILES)|{'manifest.json'}: raise ValueError('FILES')
    return load_bytes(api.read_private(path/'manifest.json')[0], {n:api.read_private(path/n)[0] for n in FILES}, api)

def load_bytes(manifest_bytes, blobs, api):
    """Same sealed admission for stdin transport; never persist private inputs."""
    offline()
    manifest=api.strict(manifest_bytes)
    if manifest['schema']!='murage.nolim-display.v2' or manifest['fidelity']!='DISPLAY-FIDELITY' or manifest['releaseEligible'] is not False or manifest['baseSha']!=BASE or set(manifest['files'])!=set(FILES): raise ValueError('MANIFEST')
    if set(blobs)!=set(FILES): raise ValueError('FILES')
    for n,b in blobs.items():
        if manifest['files'][n]!={'size':len(b),'sha256':api.digest(b)}: raise ValueError('DIGEST')
    rows=[api.strict(line) for line in blobs['cards.jsonl'].splitlines()]
    if len(rows)!=manifest['rows']: raise ValueError('COUNT')
    validate(rows,manifest['count']); recheck(rows,api)
    return manifest,rows
