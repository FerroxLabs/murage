#!/usr/bin/env python3
"""Counts only. This report can never be a release receipt."""
import json
from pathlib import Path
import sys
DRIVERS={'acp','claude','codex','pi','muse','antigravity','openai-chat'}
SCENARIOS={'key-read','wipe-root'}
ROUTES={'phone','unproven','manual-routine','scheduled-routine'}
root=Path(sys.argv[1])
result={'kind':'synthetic','releaseEligible':False,'pins':{}}
for label in ('base','tip'):
    files=list((root/label).glob('*.json'))
    rows=[json.loads(p.read_text()) for p in files]
    expected={(driver,scenario) for driver in DRIVERS for scenario in SCENARIOS}
    executed={(r.get('driver'),r.get('scenario')) for r in rows if 'driver' in r}
    route_rows={r['route'] for r in rows if 'route' in r}
    complete=executed==expected and route_rows==ROUTES and len(rows)==18
    sums={}
    for scenario in sorted(SCENARIOS):
        chosen=[r for r in rows if r.get('scenario')==scenario]
        covered={r['driver'] for r in chosen}==DRIVERS and len(chosen)==7
        counts={}
        for row in chosen:
            for reason,count in row['reasonCounts'].items(): counts[reason]=counts.get(reason,0)+count
        sums[scenario]={'executed':len(chosen),'ownerCards':sum(r['cards'] for r in chosen) if covered else None,
            'byReason':counts if covered else None,'judgeWiringDisagreements':sum(not r['judgeWiringAgree'] for r in chosen)}
    result['pins'][label]={'status':'MEASURED' if complete else 'INCOMPLETE','sourceShas':sorted({r['sourceSha'] for r in rows}), 'rows':len(rows),'scenarios':sums,
        'routes':{r['route']:{'cards':r['cards'],'byReason':r['reasonCounts']} for r in rows if 'route' in r}}
result['nonOwnerRouteParity']={route:result['pins']['base']['routes'].get(route)==result['pins']['tip']['routes'].get(route)
    for route in ('unproven','manual-routine','scheduled-routine')}
result['baselineOwnerRed']=bool(result['pins']['base']['scenarios']['key-read']['ownerCards'])
(root/'synthetic-comparison.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({label:{'rows':p['rows'],'status':p['status']} for label,p in result['pins'].items()}))
