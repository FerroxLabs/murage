# Build every mockup, then check them. Design only: writes static HTML and CSS, runs no app code.
import os, re, sys, json
from html.parser import HTMLParser
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import core
from core import *
import pages_app, pages_bot, pages_extra, fixture as F, inventory5 as X

pages_app.build(); pages_bot.build(); pages_extra.build(); pages_extra.index()
FILES['settings.css'] = core.CSS
FILES['icons.css'] = icons_css()
bad = []
for f, s in FILES.items():
    p = os.path.join(OUT, f)
    open(p, 'w', encoding='utf-8').write(s)
    n = os.path.getsize(p)
    if n != len(s.encode('utf-8')): bad.append(f'{f}: size {n} != {len(s.encode("utf-8"))}')
print(f'wrote {len(FILES)} files; size mismatches: {len(bad)}', *bad, sep='\n')

# ---- HTML parse check: balanced tags, no duplicate ids per file ----
VOID = {'meta', 'link', 'input', 'br', 'img', 'hr'}
class P(HTMLParser):
    def __init__(s): super().__init__(); s.st = []; s.err = []; s.ids = []; s.hrefs = []; s.refs = []; s.dataids = []; s.labelled = []; s.text = []
    def handle_starttag(s, t, a):
        d = dict(a)
        if 'id' in d: s.ids.append(d['id'])
        if t == 'a' and 'href' in d: s.hrefs.append(d['href'])
        if 'data-ref' in d: s.refs.append(d['data-ref'])
        if 'data-id' in d: s.dataids.append(d['data-id'])
        if 'aria-labelledby' in d: s.labelled.append(d['aria-labelledby'])
        if t in ('button', 'input') and t == 'button' and d.get('role') == 'switch' and not ('aria-labelledby' in d or 'aria-label' in d): s.err.append('switch with no name')
        if t not in VOID: s.st.append(t)
    def handle_endtag(s, t):
        if t in VOID: return
        if not s.st or s.st[-1] != t: s.err.append(f'</{t}> closes <{s.st[-1] if s.st else None}> at line {s.getpos()[0]}')
        else: s.st.pop()
    def handle_data(s, d): s.text.append(d)
MULTI = ('search.html', 'search-more.html', 'states.html', 'first-run.html', 'bots-0-1.html', 'simple-vs-advanced.html', 'layout-narrow.html', 'layout-phone.html', 'deep-link.html', 'patterns.html', 'skills-states.html')
parsed = {}
for f, s in FILES.items():
    if not f.endswith('.html'): continue
    p = P(); p.feed(s); p.close()
    if p.st: p.err.append(f'unclosed: {p.st[-3:]}')
    dup = {i for i in p.ids if p.ids.count(i) > 1}
    multi = f in MULTI
    if dup and not multi: p.err.append(f'duplicate ids: {sorted(dup)[:5]}')
    miss = [l for l in p.labelled if l not in p.ids]
    if miss: p.err.append(f'aria-labelledby with no target: {miss[:4]}')
    parsed[f] = p
errs = {f: p.err for f, p in parsed.items() if p.err}
print(f'HTML parse: {len(parsed)} files, {len(errs)} with errors'); [print(' ', f, e[:3]) for f, e in errs.items()]

# ---- link check: every href resolves to a file, every #anchor to an id in that file ----
broken = []; nlinks = 0
for f, p in parsed.items():
    for h in p.hrefs:
        if h == '#': continue
        nlinks += 1
        file, _, anc = h.partition('#')
        file = file or f
        if file not in parsed: broken.append((f, h)); continue
        if anc and anc not in parsed[file].ids: broken.append((f, h))
dead = sum(1 for p in parsed.values() for h in p.hrefs if h == '#')
print(f'links: {nlinks} checked, {len(broken)} broken, {dead} placeholder "#" (targets outside Settings or not drawn)'); [print(' ', b) for b in broken[:30]]

# ---- one home: every data-id is on exactly one page; every signpost points at a real home ----
homes = {}
canon = [f for f in parsed if f not in MULTI + ('index.html', 'fixture.html', 'help.html')]
for i, lst in REG['ids'].items():
    fs = {x[0] for x in lst}
    homes[i] = fs
two = {i: fs for i, fs in homes.items() if len(fs) > 1 or len(REG['ids'][i]) > 1}
allids = set().union(*[set(parsed[f].ids) for f in canon])
ELSEWHERE = {'today.month.headsup', 'images.library'}   # two places outside Settings
badref = sorted({r for _, r, _ in REG['refs'] if r not in allids and r not in ELSEWHERE})
acts = REG['actions']
print(f'one home: {len(homes)} control and action ids drawn, {len(two)} with more than one home; {len(REG["refs"])} signposts, {len(badref)} unresolved; {len(acts)} actions')
[print('  two homes:', i, fs) for i, fs in list(two.items())[:20]]; print('  unresolved refs:', badref) if badref else None
json.dump(acts, open(os.path.join(OUT, '_gen', 'actions.json'), 'w'), indent=1)

# ---- copy rules ----
copy = []
for f, s in FILES.items():
    if '—' in s or '&mdash;' in s or '–' in s: copy.append((f, 'dash'))
    if re.search(r'Settings\s*(&gt;|>)\s*[A-Z]', re.sub(r'<[^>]+>', ' ', s)): copy.append((f, 'literal "Settings >"'))
    if f.endswith('.html') and re.search(r'style="[^"]*#[0-9a-f]{3,6}', s): copy.append((f, 'inline colour'))
print('copy rules (no em or en dash, no literal "Settings >" path, no inline colours):', copy or 'clean')
print('inline style attributes:', sum(s.count('style="') for f, s in FILES.items() if f.endswith('.html')), '| class .sel uses:', sum(len(re.findall(r'class="[^"]*\bsel\b', s)) for s in FILES.values()))

# ---- contrast, from the tokens ----
def lum(h):
    h = h.lstrip('#'); r, g, b = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    f = lambda c: c / 12.92 if c <= .03928 else ((c + .055) / 1.055) ** 2.4
    return .2126 * f(r) + .7152 * f(g) + .0722 * f(b)
def cr(a, b):
    x, y = sorted([lum(a), lum(b)], reverse=True); return (x + .05) / (y + .05)
PAIRS = [('ink', 'panel', 4.5), ('ink', 'win', 4.5), ('ink', 'side', 4.5), ('mute', 'panel', 4.5), ('mute', 'win', 4.5), ('mute', 'side', 4.5), ('mute', 'offBg', 4.5), ('mute', 'accentSoft', 4.5),
         ('ink', 'accentSoft', 4.5), ('ink', 'helpBg', 4.5), ('ink', 'warnBg', 4.5), ('ink', 'offBg', 4.5),
         ('accent-text', 'panel', 4.5), ('accent-text', 'win', 4.5), ('accent-text', 'side', 4.5), ('accent-text', 'accentSoft', 4.5), ('accent-text', 'helpBg', 4.5),
         ('accent-ink', 'accent-fill', 4.5), ('bad-ink', 'bad-fill', 4.5), ('bad', 'panel', 4.5), ('bad', 'badBg', 4.5), ('ok', 'okBg', 4.5), ('ok', 'panel', 4.5), ('warn', 'warnBg', 4.5), ('warn', 'side', 4.5), ('warn', 'panel', 4.5),
         ('ctl-line', 'panel', 3), ('ctl-line', 'win', 3), ('ctl-line', 'side', 3), ('ctl-line', 'offBg', 3), ('focus', 'panel', 3), ('focus', 'win', 3), ('focus', 'side', 3), ('focus', 'accentSoft', 3),
         ('accent-fill', 'panel', 3), ('panel', 'accent-fill', 3), ('accent', 'panel', 3), ('accent', 'accentSoft', 3), ('bad-fill', 'panel', 3),
         ('#ffffff', 'av-1', 4.5), ('#ffffff', 'av-2', 4.5), ('#ffffff', 'av-3', 4.5), ('#ffffff', 'av-4', 4.5), ('#ffffff', 'av-5', 4.5)]
fails = []; lows = {}
for name, T in (('light', LIGHT), ('dark', DARK)):
    worst = (99, '')
    for a, b, need in PAIRS:
        v = cr(T.get(a, a), T.get(b, b))
        if v < need: fails.append(f'{name} {a} on {b}: {v:.2f} < {need}')
        if v - need < worst[0]: worst = (v - need, f'{a} on {b} {v:.2f} (needs {need})')
    lows[name] = worst[1]
print(f'contrast: {len(PAIRS) * 2} pairs, {len(fails)} fail. Tightest: light {lows["light"]}; dark {lows["dark"]}'); [print(' ', x) for x in fails]

# ================= v5 and v6 checks =================
import collections
vis = {f: re.sub(r'\s+', ' ', html_mod.unescape(re.sub(r'<[^>]+>', ' ', s))) for f, s in FILES.items() if f.endswith('.html')} if False else None
import html as html_mod
vis = {f: re.sub(r'\s+', ' ', html_mod.unescape(re.sub(r'<[^>]+>', ' ', s.split('</div>', 1)[1] if 'class="note"' in s[:900] else s))) for f, s in FILES.items() if f.endswith('.html')}

# ---- Fix links reach the right control: every signpost's link must point at the id it names; every #anchor is a real control id ----
class RP(HTMLParser):
    def __init__(s): super().__init__(); s.bad = []; s.stack = []; s.nofrag = []
    def handle_starttag(s, t, a):
        d = dict(a)
        if t not in VOID: s.stack.append(d.get('data-ref'))
        ref = next((r for r in reversed(s.stack) if r), None)
        if t == 'a' and ref and 'href' in d and '#' in d['href'] and d.get('class', '') in ('ro go', 'lnk'):
            anc = d['href'].split('#', 1)[1]
            ELSEWHERE = {'today.month.headsup', 'images.library'}
            if anc != ref and ref not in ELSEWHERE: s.bad.append((ref, d['href']))   # v6: exact control comparison, no prefix matches (Astra r5 4)
        elif t == 'a' and ref and 'href' in d and '#' not in d['href'] and d.get('class', '') in ('ro go', 'lnk'): s.nofrag.append((ref, d['href']))
    def handle_endtag(s, t):
        if t not in VOID and s.stack: s.stack.pop()
tied = []; unfrag = []
for f in canon:
    rp = RP(); rp.feed(FILES[f]); tied += [(f,) + b for b in rp.bad]; unfrag += [(f,) + b for b in rp.nofrag]
print(f'signposts tied to their target (exact id match): {len(tied)} point somewhere else; {len(unfrag)} signposts with no control anchor'); [print('  ', t) for t in tied[:20]]; [print('   no anchor:', t) for t in unfrag[:20]]
fixlinks = [(f, m.group(1)) for f, s in FILES.items() if f.endswith('.html') for m in re.finditer(r'href="([^"]+)"[^>]*>(?:<span class="golab">)?Fix: ', s)]
nofrag = [x for x in fixlinks if '#' not in x[1]]
print(f'Fix links: {len(fixlinks)}; without an exact control anchor: {len(nofrag)}', nofrag[:5] if nofrag else '')

# ---- labels: no two actions share a search label; no two actions on one page share visible text ----
lab = collections.Counter(a['label'] for a in acts)
duplab = {k: v for k, v in lab.items() if v > 1}
print(f'action labels: {len(acts)} actions, {len(duplab)} duplicate search labels', duplab if duplab else '')

# ---- switches: none is named for turning something off ----
class SW(HTMLParser):
    def __init__(s): super().__init__(); s.ids = {}; s.sw = []; s.cur = None; s.buf = ''
    def handle_starttag(s, t, a):
        d = dict(a)
        if d.get('role') == 'switch': s.sw.append((d.get('aria-labelledby'), d.get('aria-label'), d.get('aria-checked')))
        if 'id' in d and t in ('b', 'span'): s.cur = d['id']; s.buf = ''
    def handle_data(s, d):
        if s.cur: s.buf += d
    def handle_endtag(s, t):
        if s.cur and t in ('b', 'span'): s.ids.setdefault(s.cur, s.buf.strip()); s.cur = None
INV = re.compile(r'^(hide|disable|don.t|do not|no |off|mute|block|stop|skip|exclude|pause|never|prevent)\b|\boff for today\b|\bturn off\b', re.I)
switches = collections.OrderedDict()
for f in parsed:
    q = SW(); q.feed(FILES[f])
    for lb, al, on in q.sw:
        name = al or q.ids.get(lb, '')
        name = re.sub(r'(Advanced|Preview|Only here|By Murage|New)$', '', name).strip()
        switches.setdefault(name, on)
inverted = [n for n in switches if INV.search(n)]
print(f'switches: {sum(1 for _ in switches)} distinct labels, {len(inverted)} inverted', inverted)

# ---- fixture consistency: every page shows the same facts ----
fx = []
def must(pattern, expect, what, files=None, flags=0):
    n = 0
    for f, t in vis.items():
        if files and f not in files: continue
        for m in re.finditer(pattern, t, flags):
            n += 1
            got = m.group(1)
            if str(got) != str(expect): fx.append(f'{f}: {what}: shows "{got}", fixture says "{expect}"')
    if n == 0: fx.append(f'{what}: never shown (pattern {pattern})')
    return n
def never(pattern, what):
    for f, t in vis.items():
        m = re.search(pattern, t)
        if m: fx.append(f'{f}: {what}: "{m.group(0)[:70]}"')
counts = {}
counts['Dax tools'] = must(r'Dax can use (\d+) of 21', F.DAX_TOOLS, 'Dax tool count')
counts['app tools'] = must(r'(\d+) of 21 tools are on', F.APP_TOOLS_ON, 'app tool count') + must(r'Tools on (\d+) of 21', F.APP_TOOLS_ON, 'app tool count (Overview)')
counts['web search bots'] = must(r'Web search \((\d+)\)', F.TOOL_BOTS['Web search'], 'web search bot count') + must(r'engine\'s own search first\. (\d+) of 39 bots', F.TOOL_BOTS['Web search'], 'web search bot count (Tools)')
for app in F.APPS: counts[app] = must(rf'{app}: (\d+) bots?\.', F.app_count(app), f'{app} bot count')
counts['reach'] = (must(r'Cannot yet \((\d+)\)', F.RC['blocked'], 'reach: cannot', ['bot-reach.html']) + must(r'Cannot: (\d+)\.', F.RC['blocked'], 'reach: cannot (Profile)') +
                   must(r'Asks first: (\d+)\.', F.RC['asks'], 'reach: asks (Profile)') + must(r'Can: (\d+)\.', F.RC['ok'], 'reach: can (Profile)') + must(r'Can do now \((\d+)\)', F.RC['ok'], 'reach: can', ['bot-reach.html']))
counts['Dax level'] = (must(r'Approval level (Ask|Auto|Full access|No limits)\. ', F.DAX['level'], 'Dax level (Profile)', ['bot-profile.html']) +
                       must(r'Approval level is (Ask|Auto|Full access|No limits)\. Asks', F.DAX['level'], 'Dax level (reach)'))
# the Bots table row for Dax, and the checked radio on Approvals
for f in ('bots.html',):
    m = re.search(r'> Dax</a><small>[^<]*</small></td><td>([^<]*)<small>([^<]*)</small></td><td>([^<]*)</td><td>(\d+) of 21', FILES[f])
    if not m: fx.append('bots.html: Dax row not found')
    else:
        if (m.group(1), m.group(2), m.group(3), int(m.group(4))) != (F.DAX['engine'], F.DAX['model'], F.DAX['level'], F.DAX_TOOLS):
            fx.append(f'bots.html: Dax row shows {m.groups()}, fixture says {(F.DAX["engine"], F.DAX["model"], F.DAX["level"], F.DAX_TOOLS)}')
        counts['Dax bots row'] = 1
m = re.search(r'aria-checked="true" aria-label="(Ask|Auto|Full access|No limits)"', FILES['bot-approvals.html'])
if not m or m.group(1) != F.DAX['level']: fx.append(f'bot-approvals.html: checked level is {m and m.group(1)}, fixture says {F.DAX["level"]}')
g = F.dax_app('Gmail'); c = F.dax_app('Google Calendar')
counts['Dax Gmail works now'] = must(r'Works now: (Read only|Read and change|Nothing|No access)\. Changes in your apps are off for Dax', g[1], 'Dax Gmail/Calendar works now')
never(r'Google Calendar[^.]{0,40}Can[^.]{0,20}Read and change', 'Calendar shown as changeable for Dax')
never(r'Dax is at No limits', 'Dax drawn at No limits')
never(r'Show all \d+', 'a Show all button')
never(r'Showing \d+ of (39|41)', 'a partial bot list')
never(r'PENDING SEAN', 'designer tag in app copy')
never(r'One Save for|Two pickers, both|One state, one fix|Nothing here ever nags|not a bot.s tool|A tool setting\.|One answer for a question|A tool is one row in this list|Asking rules that live with a tool', 'designer text in app copy')
never(r'Calls off for today(?!</mark>|\.? On means|</)', 'the inverted calls switch') if False else None
never(r'\bnotices\b|Automations are', 'notices or automations')
never(r'\b41 bots\b', '41 bots')
counts['39 bots'] = must(r'find any of your (\d+) bots', F.N, 'bot total (Overview)') + must(r'Your bots (\d+) bots\. 2 archived', F.N, 'bot total (Bots)')
counts['Dax model'] = must(r'Engine and model (Claude Code, Claude Sonnet|[A-Z][^.]*)\. ', f'{F.DAX["engine"]}, {F.DAX["model"]}', 'Dax model (Profile)', ['bot-profile.html'])
calls = [f for f, t in vis.items() if re.search(r'Calls off for today', t) and f not in ('search-more.html',)]
if calls: fx.append(f'inverted calls label still drawn in {calls}')
# ---- v6: the claims the v5 check let through (Walk H3), and the truth rules from the four r5 reviews ----
counts['needs-you headline'] = must(r'Your bots are running\. (\w+) things? needs? you\.', F.NEEDS_YOU, 'Needs-you count in a headline')
counts['needs-you list'] = must(r'Needs you \((\d+)\)', F.NEEDS_YOU, 'Needs-you count on a list')
for app in F.APPS:
    if F.nl_extra(app): counts[app + ' can use'] = must(rf'(\d+) of {F.N}, and Pepper at No limits', F.app_count('Gmail'), 'can-use count with the No limits bot', ['apps-gmail.html'])
never(r'[Oo]n your own turns', 'No limits described as owner turns only (Fable N1)')
never(r'not a No limits turn', 'a No limits boundary the code does not have (Fable N1)')
never(r'10 minutes ago', 'the model change newer than the app choices it would have cleared (Fable N2)')
never(r'Showing \d+ of', 'a "Showing N of" line')
never(r'\bCmd K\b', 'Cmd K instead of the key symbol')
never(r'\bResume\b', 'a Resume button that the product does not have')
never(r'or an OpenAI key', 'Codex said to run on an OpenAI key')
never(r'Checks with you before it changes anything|Acts inside its working folder|asks before each change outside its working folder|Outside it, Dax asks|Asks before risky things|checks before any change', 'an approval level described another way')
never(r'Follows new bots|change the moment you change', 'live following of a level below No limits')
never(r'You can keep working', 'an in-app export that does not exist')
never(r'[Tt]he same for every bot|Every bot gets them', 'custom tools said to reach every bot (server/mcp-relay.ts:59-70)')
never(r'Last used: Connected', 'Last used: Connected now')
never(r'when I sign in|as we talk|I already have', 'I, me or we in a label')
for lv_, mean in F.LEVEL_MEANING.items():
    if mean not in vis['bot-approvals.html']: fx.append(f'bot-approvals.html: {lv_} is not described by the fixture sentence')
    counts['level ' + lv_] = 1
if F.LEVEL_MEANING['Ask'] not in vis['bot-reach.html']: fx.append('bot-reach.html: Ask is not described by the fixture sentence')
# every "Name (Level)" or "Name at Level" in any window agrees with the fixture
lvs = 0
for f_, t in vis.items():
    for m in re.finditer(r'\b(' + '|'.join(F.NAMES) + r')(?: \(| at | \(now )(Ask|Auto|Full access|No limits)\b', t):
        lvs += 1
        if F.B(m.group(1))['lvl'] != m.group(2): fx.append(f'{f_}: {m.group(1)} drawn at {m.group(2)}, fixture says {F.B(m.group(1))["lvl"]}')
counts['bot levels named in prose'] = lvs
# file names never appear in app copy (design notes, window captions and the three reference pages are not app copy)
strip = lambda s: re.sub(r'<(div|figcaption) class="(note|winlab|cap)"[^>]*>.*?</\1>', ' ', s, flags=re.S)
for f_ in canon:
    t = re.sub(r'<[^>]+>', ' ', strip(FILES[f_]))
    m = re.search(r'\b[\w-]+\.html\b', t)
    if m: fx.append(f'{f_}: a file name in app copy: "{m.group(0)}"')
# Working is a word for keys only
for f_, s_ in FILES.items():
    if not f_.endswith('.html'): continue
    for m in re.finditer(r'<span class="pill ok">Working</span>', s_):
        row = s_[max(0, s_.rfind('<div class="r', 0, m.start())):m.start()]
        if 'key' not in re.sub(r'<[^>]+>', ' ', row).lower() and f_ not in ('patterns.html',): fx.append(f'{f_}: Working on a row that is not a key')
# ================= v7 checks (the r6 reviews) =================
raw = FILES
# Walk r6 H2: Auto is an approval level only. A model selection is "Auto model" or "model picked for you".
never(r'\b(Fuigo|Claude Code|Codex|Grok Build|OpenCode)[,.:]? Auto\b(?! model)', 'a bare Auto after an engine name (Walk r6 H2)')
never(r'Set to Auto\b(?! model)', 'a model journal value written as a bare Auto (Walk r6 H2)')
for f_, s_ in raw.items():
    if f_.endswith('.html') and re.search(r'<small>Auto</small>|<td>Fuigo</td><td>Auto</td>|model: Auto"', s_): fx.append(f'{f_}: a model cell or picker reads a bare Auto')
fr = re.findall(r'<div class="r finder">.*?(?=<a class="ro go")', raw['overview.html'], re.S)
for row in fr:
    t_ = re.sub(r'<[^>]+>', ' ', row)
    if not re.search(r'\. (Ask|Auto|Full access|No limits)\.\s*$', t_.strip()): fx.append('overview.html: a finder row does not end with the approval level (Walk r6 H2)')
counts['finder rows with a level'] = len(fr)
if not fr: fx.append('overview.html: no finder rows found')
# Walk r6 H3a: the per-bot spend adds up to the total shown.
sec = raw['usage.html'].split('id="usage.by"', 1)[1].split('</section>', 1)[0]
amts = [float(x) for x in re.findall(r'<span class="inh">\$(\d+\.\d\d)</span>', sec)]
if len(amts) != F.N or round(sum(amts) * 100) != round(float(F.SPEND['flux'].lstrip('$')) * 100): fx.append(f'usage.html: {len(amts)} per-bot amounts add up to ${sum(amts):.2f}, the page says {F.SPEND["flux"]}')
counts['spend sum'] = 1
# Walk r6 H3b: nothing saved means Every app. Only a bot with a saved choice may read No access.
for f_ in ('apps-gmail.html',):
    n_na = len(re.findall(r'Works now: No access\.', vis[f_])); want = sum(1 for b in F.SAVED_BOTS if b not in F.NOLIMITS and b != 'Dax' and F.app_saved('Gmail', b) == 'No access')
    if n_na != want: fx.append(f'{f_}: {n_na} rows read No access, but only {want} bots have a saved choice of No access')
    n_off = len(re.findall(r'Connected apps are off for \w+\.', vis[f_])); n_ev = len(re.findall(r'Nothing saved: set to Every app', vis[f_]))
    if (n_off, n_ev) != (len(F.APPS_OFF), len(F.EVERY_APP)): fx.append(f'{f_}: {n_off} off and {n_ev} Every app rows; fixture says {len(F.APPS_OFF)} and {len(F.EVERY_APP)}')
    counts['app states'] = 3
# Walk r6 H1: the shipped level table is drawn on Approvals; Help uses the four sentences word for word.
for r_, c_ in F.LEVEL_TABLE:
    if html_mod.escape(r_, quote=False) not in raw['bot-approvals.html'] and r_ not in vis['bot-approvals.html']: fx.append(f'bot-approvals.html: level table row missing: {r_}')
if raw['bot-approvals.html'].count('<td class="a">Asks</td>') != sum(c.count('A') for _, c in F.LEVEL_TABLE): fx.append('bot-approvals.html: level table cells differ from the fixture')
for lv_, mean in F.LEVEL_MEANING.items():
    if mean not in vis['help.html']: fx.append(f'help.html: {lv_} is not described by the fixture sentence')
counts['level table'] = len(F.LEVEL_TABLE)
# Fable r6 F1, Astra r6 9: effort is a reset trigger and is said to be one; sidebar visibility is not.
never(r'[Tt]hinking effort never clears', 'thinking effort said to be safe (Fable r6 F1)')
never(r'or Show in the sidebar clears', 'sidebar visibility said to clear app choices (Astra r6 9)')
never(r'Everything is kept', 'archive said to keep app choices (Astra r6 9)')
for f_, pat in (('bot-model.html', r'engine, model or thinking effort clears'), ('models.html', r'engine, model or thinking effort clears'), ('models.html', r'an engine, a model or thinking effort clears'), ('bot-profile.html', r'So does archiving Dax')):
    if not re.search(pat, vis[f_]): fx.append(f'{f_}: the reset disclosure is missing ({pat})')
m = re.search(r'aria-label="Dax thinking effort: (\w+)"', raw['models.html']); m2 = re.search(r'aria-checked="true" tabindex="0">(Low|Medium|High)<', raw['bot-model.html'])
if not m or not m2 or m.group(1) != F.DAX['effort'] or m2.group(1) != F.DAX['effort']: fx.append('Dax thinking effort differs between Models, Engine & model and the fixture')
counts['Dax effort'] = 2
# Astra r6 1, Fable r6 M1, M2: the guest and lower-level boundaries.
never(r'applies only in a chat with a guest', 'saved app choices said to apply in a guest chat (Fable r6 M1)')
never(r'the app choices saved for Pepper apply(?! there)', 'saved app choices said to apply in a guest chat (Fable r6 M1)')
for f_ in ('bot-reach-nolimits.html', 'apps-gmail.html', 'help.html'):
    if not re.search(r'[Ii]n a chat with a guest, bots cannot use your connected apps', vis[f_]): fx.append(f'{f_}: does not say that a guest chat has no connected apps')
    if not re.search(r'chat or routine you set to a lower level', vis[f_]): fx.append(f'{f_}: does not name the lower-level chat or routine')
counts['guest and lower-level boundary'] = 6
# Walk r6 M1 to M3, L2, L3, L5: one meaning per word.
never(r'\bAsk Chief\b', 'Ask used for a help button (Walk r6 M1)')
never(r'\bAsk someone\b', 'Ask used for a search heading (Walk r6 M1)')
never(r'Ask before each image', 'Ask used for a setting label (Walk r6 M1)')
never(r'Not No limits', 'a double negative pill (Walk r6 L2)')
never(r'\bdraft[- ]only\b', 'an undefined term (Walk r6 L3)')
never(r'Nothing yet', 'a paid sign-in labelled Nothing yet (Walk r6 M3)')
never(r'This setting moved', 'an unknown link said to have moved (Walk r6 L5)')
never(r'stays paused until you review it', 'restore said to end its pause at the review (Walk r6 M4)')
never(r'Codex needs this|does not run Codex on this computer|Needs your ChatGPT plan', 'Codex equated with a ChatGPT plan (Astra r6 14)')
# Astra r6 12: the two drawn arrivals reach the right state.
ch = re.findall(r'<a class="chip" href="([^"]+)" data-account="([^"]+)"', raw['search-more.html'])
if len(ch) != 2 or ch[0][0] == ch[1][0]: fx.append('search-more.html: the two accounts do not open two different places')
for href, acct in ch:
    if acct not in vis.get(href.split('#')[0], ''): fx.append(f'search-more.html: {acct} lands on a sheet that does not name it')
m = re.search(r'Off since the restore on 18 Nov.*?role="switch" aria-checked="(\w+)"', raw['states.html'], re.S)
if not m or m.group(1) != 'false': fx.append('states.html: the restored routine is not drawn Off')
if 'Fix: Turn on Morning inbox sort' not in vis['states.html'] or 'bot-routines-restored.html#bot.routines.morning' not in raw['states.html']: fx.append('states.html: the restored routine does not link to its own control')
# v8 (Astra r7 H5): the Fix's destination draws the same routine in the same state: Off, with the restore named
for href in re.findall(r'href="([^"#]+)#bot\.routines\.morning"', raw['states.html']):
    d = raw.get(href, ''); i = d.find('id="bot.routines.morning"'); m2 = re.search(r'aria-checked="(true|false)"', d[i:]) if i >= 0 else None
    if not m2 or m2.group(1) != 'false' or 'Off since the restore' not in d[i:i + 1500]: fx.append(f'states.html: the restored-routine Fix lands on {href}, where the routine is not drawn Off since the restore')
    counts['fix-destination-state'] = counts.get('fix-destination-state', 0) + 1
counts['arrivals'] = 4
# v9 (Astra r8 H5): the Fix's destination is drawn for the bot the Fix names, not another bot.
for m_ in re.finditer(r'routines (\w+) has are off since the restore.{0,400}?href="([^"#]+)#bot\.routines\.morning"', raw['states.html'], re.S):
    bot_, href = m_.groups(); bc = re.search(r'<div class="botcard"><span class="av">[^<]*</span><span><b>([^<]+)</b>', raw.get(href, ''))
    if not bc or bc.group(1) != bot_: fx.append(f'states.html: the Fix for {bot_}\'s routine lands on {href}, drawn for {bc.group(1) if bc else None}')
    counts['fix-destination-bot'] = counts.get('fix-destination-bot', 0) + 1
if not counts.get('fix-destination-bot'): fx.append('states.html: the restored-routine Fix row was not found (fix-destination-bot)')
# v9 (Astra r8 C1a, C1b): every list of who would get a new app names every recipient (no "and N more"), and no recipient is a bot
# whose Connected apps are off, hidden or staged. Dialog 1 is compared with the audience the fixture implies.
import pages_app as PA_
APPS_OFF_ = set(F.APPS_OFF); ARCH_ = {a for a, _ in F.ARCHIVED}
d1 = re.search(r'Would get it \((\d+)\): (.*?)Would not get it', vis['apps.html'], re.S)
if not d1: fx.append('apps.html: dialog 1 recipient list not found')
else:
    names_ = set(re.findall(r'\b(' + '|'.join(F.NAMES) + r')\b', d1.group(2))) - {c for c, _ in F.NL_CHATS}
    want_ = set(F.EVERY_APP) | set(F.NOLIMITS)
    if names_ != want_: fx.append(f'apps.html: dialog 1 names {len(names_)} bots, the audience is {len(want_)}: missing {sorted(want_ - names_)[:4]}, extra {sorted(names_ - want_)[:4]}')
    if int(d1.group(1)) != len(want_) + len(F.NL_CHATS): fx.append(f'apps.html: dialog 1 says {d1.group(1)}, the audience is {len(want_) + len(F.NL_CHATS)}')
    counts['recipients dialog 1'] = len(want_) + len(F.NL_CHATS)
for blk in re.findall(r'Would get it(?: now)? \(\d+\):.*?(?=Would not get it|</section>|$)', vis['apps.html'], re.S):
    if re.search(r'and \d+ more', blk): fx.append('apps.html: a recipient list hides recipients behind "and N more"')
    blk_ = re.sub(r'\b\w+ ?, new since you looked: set to Every app', '', blk)   # a bot whose Connected apps were turned on in another window is legitimately new
    off_ = (set(re.findall(r'\b(' + '|'.join(F.NAMES) + r')\b', blk_)) & (APPS_OFF_ | ARCH_)) - {c for c, _ in F.NL_CHATS}
    if off_: fx.append(f'apps.html: {sorted(off_)} listed as getting the app, but Connected apps are off for it')
    counts['recipient lists'] = counts.get('recipient lists', 0) + 1
# v9 (Astra r8 H3a): the Move all list names every bot whose own level it clears, under that bot's level.
mv = re.search(r'<li data-plan="bots">(.*?)</li>', raw['bots.html'], re.S)
if not mv: fx.append('bots.html: the Move all bot list was not found')
else:
    got_ = {}
    for lv, ns in re.findall(r'At (Ask|Auto|Full access) \(\d+\): ([^.<]+)\.', mv.group(1)):
        for n_ in ns.split(', '): got_[n_] = lv
    want_ = {b['n']: b['lvl'] for b in PA_.own_bots()}
    if got_ != want_: fx.append(f'bots.html: Move all lists {len(got_)} bots, the plan clears {len(want_)}; differ: {sorted(set(got_.items()) ^ set(want_.items()))[:4]}')
    if re.search(r'and \d+ more', mv.group(1)): fx.append('bots.html: Move all hides bots behind "and N more"')
    counts['move-all plan rows'] = len(want_)
# v9 (Astra r8 H4a, H4b): every Archive review names, for each bot it lists, exactly the saved app choices that bot loses.
for f_, pat in (('bots.html', r'<li><b>(\w+)</b>: (?:its saved app choices are not kept: ([^<]*?)\. It comes|nothing saved)'), ('bot-teams.html', r'<li><b>(\w+)</b>: ([^<]*)\.</li>')):
    rows_ = re.findall(pat, raw[f_])
    if not rows_: fx.append(f'{f_}: the Archive review rows were not found')
    for n_, apps_ in rows_:
        want_ = sorted(a for a, v in F.APPS.items() if n_ in v['saved']); got_ = sorted(re.sub(r' \([^)]*\)', '', x) for x in apps_.split(', ')) if apps_ and not (f_ == 'bot-teams.html' and apps_ == 'nothing saved, nothing lost') else []
        if got_ != want_: fx.append(f'{f_}: the Archive review says {n_} loses {got_}, the fixture says {want_}')
        counts['archive review rows'] = counts.get('archive review rows', 0) + 1
# v10 (Astra r9 H3a): Move all names every routine and chat whose own level it clears, by name, bot and level, from the plan rows.
for key_, want_rows in (('routines', [(r, b, lv) for r, b, lv, _ in F.MOVE_ROUTINES]), ('chats', [(c, b, lv) for c, b, lv, _ in F.MOVE_CHATS])):
    blk = re.search(r'<li data-plan="' + key_ + r'"><b>(\d+) ' + key_ + r'</b>(.*?)</li>', raw['bots.html'], re.S)
    if not blk: fx.append(f'bots.html: the Move all {key_} list was not found'); continue
    got_rows = re.findall(r'<br>([^<(]+?) \((\w+)\), at (Ask|Auto|Full access|No limits)[.:,]', blk.group(2))
    if sorted(got_rows) != sorted(want_rows): fx.append(f'bots.html: Move all names {len(got_rows)} {key_}, the plan clears {len(want_rows)}; differ: {sorted(set(got_rows) ^ set(want_rows))[:3]}')
    if int(blk.group(1)) != len(want_rows): fx.append(f'bots.html: Move all says {blk.group(1)} {key_}, the plan clears {len(want_rows)}')
    if re.search(r'and \d+ more', blk.group(2)): fx.append(f'bots.html: Move all hides {key_} behind "and N more"')
    counts[f'move-all plan {key_}'] = len(want_rows)
# v10 (Fable v9 H1, Astra r9 H4b): deleting a team clears every member's saved app choices on both choices (server/team-lifecycle.ts:81, :98;
# server/bot-access-role.ts:5, :12). The review lists every member, empty choices included, and nothing on the page says keeping the bots is lossless.
team_name, team_members = F.SK['team']
tm = re.search(r'<div class="dlg" role="alertdialog" aria-label="Delete ' + re.escape(team_name) + r'\?">(.*?)</div></div>', raw['bot-teams.html'], re.S)
tm = tm.group(1) if tm else ''
rows_t = re.findall(r'<li><b>(\w+)</b>: (?:[^<]*?\.|nothing saved, nothing lost\.)</li>', tm)
if sorted(rows_t) != sorted(team_members): fx.append(f'bot-teams.html: the team-delete review lists {sorted(rows_t)}, the team is {sorted(team_members)}')
for bad_ in ('keep the bots as they are', 'delete only the team', 'delete the team only', 'archive is reversible'):
    if bad_ in tm.lower(): fx.append(f'bot-teams.html: false promise in team-delete review: "{bad_}"')
if 'Both choices clear these saved app choices' not in tm: fx.append('bot-teams.html: the team-delete review does not say keep and archive both clear app choices')
for id_, label_ in (('bot.teams.deletekeep', 'Delete team and keep bots'), ('bot.teams.deletearchive', 'Delete team and archive bots')):
    if not re.search(r'<button\b[^>]*data-id="' + re.escape(id_) + r'"[^>]*>' + label_ + r'</button>', tm):
        fx.append(f'bot-teams.html: "{label_}" is not drawn in the team-delete review')
counts['team delete review'] = len(rows_t)
# v8 (Astra r7 H6): every link to a skill sheet, from a list row (aria-label "Open X") or a table cell (<a>X</a>), lands on a sheet whose title is X,
# whose switches all name X, and whose "On for N" equals the switches drawn on.
import html as _html
sk_links = 0
for f_, d in raw.items():
    if not f_.endswith('.html'): continue
    pairs = [(h, n) for h, n in re.findall(r'href="(skills-sheet[^"#]*\.html)"[^>]*aria-label="Open ([^"]+)"', d)] + [(h, n) for h, n in re.findall(r'<a href="(skills-sheet[^"#]*\.html)">([^<]+)</a>', d)]
    for h, n in pairs:
        n = _html.unescape(n); sk_links += 1
        t = raw.get(h, ''); m = re.search(r'<h4 id="skl-h">(?:<span[^>]*></span>)?([^<]+)<', t)
        if not m or _html.unescape(m.group(1)) != n: fx.append(f'{f_}: the row "{n}" opens {h}, whose sheet is "{m.group(1) if m else None}"')
for h in [f_ for f_ in raw if f_.startswith('skills-sheet')]:
    t = raw[h]; m = re.search(r'<h4 id="skl-h">(?:<span[^>]*></span>)?([^<]+)<', t); n = _html.unescape(m.group(1))
    sheet_ = t[t.find('<section class="sheet"'):]
    sw = re.findall(r'role="switch" aria-checked="(true|false)" aria-label="([^"]+)"', sheet_) or [(c, l) for l, c in re.findall(r'aria-label="([^"]+)"[^>]*role="switch"[^>]*aria-checked="(true|false)"', sheet_)]
    bad_ = [l for c, l in sw if not _html.unescape(l).endswith(' uses ' + n)]
    if bad_: fx.append(f'{h}: a switch on the sheet for {n} names another skill: {bad_[0]}')
    on_ = re.search(r'On for (\d+) of \d+', sheet_)
    if sw and on_ and int(on_.group(1)) != sum(1 for c, _ in sw if c == 'true'): fx.append(f'{h}: says On for {on_.group(1)} but draws {sum(1 for c, _ in sw if c == "true")} switches on')
    counts['skill sheets'] = counts.get('skill sheets', 0) + 1
counts['skill sheet links'] = sk_links
# Astra r6 13, Visual QA r6 H05, M09: what a phone is never shown.
for f_ in ('layout-phone.html', 'layout-phone-sheet.html'):
    for bad_ in ('bot.tools.apps.writes', 'Approve and replace', 'Set back', 'Kept on this computer only', 'Add an API key', 'Pair your phone'):
        if bad_ in raw[f_]: fx.append(f'{f_}: a phone screen shows "{bad_}"')
counts['phone surface'] = 6
# v8 (Fable r7 H1): a paired phone renders no switch and no sheet opener for a desktop-class route. Every figure on the phone board is
# checked; the only switches a phone may draw are the ones X1 lists as companion class (screen 4: Phone & remote access on the phone itself).
PHONE_OK = ('4. Phone &amp; remote access',)
for fig in re.findall(r'<figure>(.*?)</figure>', raw['layout-phone.html'], re.S):
    cap = re.search(r'<figcaption>(.*?)</figcaption>', fig, re.S).group(1)
    if cap.startswith('<b>') and any(cap[3:].startswith(k) for k in PHONE_OK): continue
    for bad_, why in (('role="switch"', 'a switch'), ('bot-tools-apps.html', 'the app access sheet'), ('saved: ', 'the saved app access')):
        if bad_ in fig: fx.append(f'layout-phone.html: {re.sub("<[^>]+>", "", cap)[:40]} draws {why}, which is desktop class (server/route-policy.ts:398-399)')
    counts['phone desktop-class'] = counts.get('phone desktop-class', 0) + 1
# Visual QA r6 H02: on the two modal specimen pages every focusable element is inside the dialog.
class FO(HTMLParser):
    def __init__(s): super().__init__(); s.st = []; s.out = []
    def handle_starttag(s, t, a):
        d = dict(a); inert = 'inert' in d or (s.st and s.st[-1][1]); dia = d.get('role') == 'dialog' or (s.st and s.st[-1][2])
        if t in ('a', 'button', 'input', 'textarea', 'select') or d.get('tabindex') == '0':
            if not inert and not dia and d.get('tabindex') != '-1': s.out.append(t)
        if t not in VOID: s.st.append((t, bool(inert), bool(dia)))
    def handle_endtag(s, t):
        if t not in VOID and s.st: s.st.pop()
for f_ in ('layout-narrow-sheet.html', 'layout-phone-sheet.html'):
    q = FO(); q.feed(raw[f_])
    if q.out: fx.append(f'{f_}: {len(q.out)} focusable elements outside the dialog')
    if 'aria-modal="true"' not in raw[f_] or raw[f_].count('class="backto insheet"') != 1: fx.append(f'{f_}: the dialog is not modal or does not have exactly one Back')
counts['modal focus scope'] = 2
# Astra r6 4: the page-reader list is the routing table at the tip.
for n_ in F.READERS_NO_SWITCH:
    if n_ not in vis['tools-websearch.html']: fx.append(f'tools-websearch.html: page reader missing: {n_}')
counts['page readers'] = len(F.READERS_NO_SWITCH)
# Skills at library scale.
counts['skills total'] = must(r'Search ([\d,]+) skills', f'{F.SK["all"]:,}', 'skill total in a search box', flags=0) if False else 0
for f_ in ('skills.html', 'skills-advanced.html', 'skills-sheet.html', 'bot-skills.html'):
    for m in re.finditer(r'placeholder="Search ([\d,]+) skills"', raw[f_]):
        counts['skills total'] += 1
        if m.group(1) != f'{F.SK["all"]:,}': fx.append(f'{f_}: search box says {m.group(1)} skills, fixture says {F.SK["all"]:,}')
counts['skills on a bot'] = must(r'(\d+) skills are on at least one bot', F.SK['on_a_bot'], 'skills on a bot') + must(r'[\d,]+ skills\. (\d+) are on at least one bot', F.SK['on_a_bot'], 'skills on a bot (page line)')
counts['chief skills'] = must(r'Chief sees (\d+) of its \d+ skills', F.SK['chief_listed'], 'Chief skills in every message') + must(r'Chief sees \d+ of its (\d+) skills', F.SK['chief_on'], 'Chief skills on')
if raw['skills.html'].count('aria-label="Open ') < F.SK['on_a_bot']: fx.append('skills.html: fewer rows drawn than skills on a bot')
if re.search(r'Chief of staff basics', vis['bot-skills.html']): fx.append('bot-skills.html: the Chief-only built-in is drawn on Dax')
print(f'fixture consistency: {sum(counts.values())} claims checked across {len(vis)} pages, {len(fx)} mismatches'); [print('  ', x) for x in fx]
rowsdrawn = FILES['bots.html'].count('aria-label="Select ') - 1
print(f'bots.html draws {rowsdrawn} bot rows (fixture: {F.N} + {F.NA} archived)')
print(f'Appendix G: {len(X.XROWS)} no-control rows: {len(X.klass("V"))} value shown, {len(X.klass("P"))} presence only, {len(X.klass("N"))} not indexed')

# ---- help: every named link has a written topic ----
used = set(re.findall(r'data-help="([^"]+)"', ''.join(FILES.values())))
topics = {k for k, _, _ in X.HELP}
print(f'help: {len(topics)} topics written; links use {len(used)}; links with no topic: {sorted(used - topics)}; topics with no link: {sorted(topics - used)}')

# ---- generated appendices for IA-PROPOSAL-v6.md (one source, no retyping) ----
G_ = os.path.join(OUT, '_gen')
def md(name, text): open(os.path.join(G_, name), 'w', encoding='utf-8').write(text)
md('appx-fixture.md', '| Fact | Value | Shown on |\n|---|---|---|\n' + ''.join(f'| {a} | {b} | {c} |\n' for a, b, c in F.table()))
esc = lambda t: html_mod.unescape(str(t)).replace('|', '/')
md('appx-actions.md', '| # | Action (search label) | Id | Home | Status | Note |\n|---|---|---|---|---|---|\n' + ''.join(
    f'| E-{i} | {esc(a["label"])} | `{a["id"]}` | {esc(PAGES.get(a["page"], (a["page"],))[0])} (`{a["page"]}`){"" if a.get("drawn", True) else ", in a sheet or state not redrawn"} | {a["status"]} | {esc(a["note"])} |\n' for i, a in enumerate(acts, 1)))
md('appx-help.md', ''.join(f'**{t}** (`{k}`). {p}\n\n' for k, t, p in X.HELP))
md('appx-xrows.md', '| Row | Key | Class | Surface | What may be shown |\n|---|---|---|---|---|\n' + ''.join(f'| {a} | `{b}` | {dict(V="value", P="presence only", N="not indexed")[c]} | {d} | {x} |\n' for a, b, c, d, x in X.XROWS))
md('appx-aliases.md', '| Old name | Kind | Now | Lands on |\n|---|---|---|---|\n' + ''.join(f'| {a} | {b} | {c} | `{d}` |\n' for a, b, c, d in X.ALIASES))
md('appx-nouns.md', '| Use | Never | Where |\n|---|---|---|\n' + ''.join(f'| {a} | {b} | {c} |\n' for a, b, c in X.NOUNS))
md('appx-answers.md', '| Typed | Answer title | Answer | Links to |\n|---|---|---|---|\n' + ''.join(f'| {a} | {b} | {c} | `{d}` |\n' for a, b, c, d in X.ANSWERS))
md('appx-switches.md', '| Switch | Drawn | On means |\n|---|---|---|\n' + ''.join(f'| {n} | {"On" if v == "true" else "Off"} | it happens |\n' for n, v in switches.items() if n))
alias_bad = [a for a in X.ALIASES if (a[3].split('#')[0] not in parsed) or ('#' in a[3] and a[3].split('#')[1] not in parsed[a[3].split('#')[0]].ids)]
ans_bad = [a for a in X.ANSWERS if (a[3].split('#')[0] not in parsed) or ('#' in a[3] and a[3].split('#')[1] not in parsed[a[3].split('#')[0]].ids)]
print(f'aliases: {len(X.ALIASES)}, {len(alias_bad)} do not land; curated answers: {len(X.ANSWERS)}, {len(ans_bad)} do not land', alias_bad, ans_bad)
