# v7: Skills at library scale (2,262 skills). Design from settings-skills-study/SKILLS-STUDY.md, redrawn with this set's fixture, patterns and checks.
# Facts: 2,247 library + 4 built in + Yours; no library skill is on by default; a bot's message carries only an index of ITS enabled skills, capped at
# 30 lines and 4,000 bytes (server/skills.ts:137-138), so cost never grows with the library. About 6 library skills fit under the cap.
from core import *
import core, re, fixture as F
K = F.SK
N = F.N
ALLN = f'{K["all"]:,}'
ONBOT = [  # (name, category, source, used by) : the 31 skills that are on at least one bot
 ('Invoice chase', 'Business strategy', 'Library', 'Chief, Dax and Mira'), ('Weekly report', 'Writing', 'Library', 'Chief, Dax and Juno'), ('Chief of staff basics', 'Productivity', 'Built in', 'Chief'),
 ('Inbox triage', 'Productivity', 'Library', 'Chief'), ('Meeting notes', 'Writing', 'Library', 'Chief and Juno'), ('Expense categories', 'Personal finance', 'Library', 'Juno'),
 ('Quote follow-up', 'Business strategy', 'Yours', 'Chief and Mira'), ('Support macro writer', 'Writing', 'Library', 'Sable'), ('Refund policy check', 'Business strategy', 'Yours', 'Sable'),
 ('Calendar tidy', 'Productivity', 'Library', 'Atlas and Chief'), ('Travel planner', 'Home and household', 'Library', 'Atlas'), ('Literature scan', 'Education', 'Library', 'Pepper'),
 ('Source checker', 'Education', 'Library', 'Pepper and Nova'), ('Blog outline', 'Writing', 'Library', 'Otto'), ('Tone match', 'Writing', 'Yours', 'Otto and Chief'),
 ('Month-end close', 'Personal finance', 'Library', 'Juno'), ('Receipt reader', 'Personal finance', 'Library', 'Juno'), ('Lead research', 'Business strategy', 'Library', 'Mira'),
 ('CRM hygiene', 'Business strategy', 'Library', 'Mira'), ('Bug report writer', 'Software engineering', 'Library', 'Kit'), ('Release notes', 'Software engineering', 'Library', 'Kit'),
 ('Code review checklist', 'Software engineering', 'Copied from Claude Code', 'Kit'), ('Pull request summary', 'Software engineering', 'Library', 'Kit'), ('Daily brief', 'Productivity', 'Yours', 'Chief'),
 ('Vendor comparison', 'Business strategy', 'Library', 'Chief'), ('Contract summary', 'Business strategy', 'Library', 'Chief'), ('Follow-up drafter', 'Writing', 'Library', 'Chief'),
 ('Slide outline', 'Design and creative', 'Library', 'Rhea'), ('Survey summary', 'Data analysis', 'Library', 'Finn'), ('Spreadsheet cleanup', 'Data analysis', 'Library', 'Finn'),
 ('Onboarding checklist', 'Business strategy', 'Library', 'Vera'),
]
assert len(ONBOT) == K['on_a_bot']
# v8 (Fable r7 M3): one map, skill -> bots it is on for. Every Skills page, the bot pages and each skill's sheet are drawn from it.
def _names(u): return [x.strip() for x in u.replace(' and ', ', ').split(',') if x.strip()]
SKB = {n: _names(u) for n, _, _, u in ONBOT}
SKINFO = {n: (cat, src, 'Clean') for n, cat, src, _ in ONBOT}
# v8 (Astra r7 H6): every list row, suggestion and result opens the sheet of its own skill. Invoice chase keeps skills-sheet.html.
def slug(n): return re.sub(r'[^a-z0-9]+', '-', n.lower()).strip('-')
def sheet_href(n): return 'skills-sheet.html' if n == 'Invoice chase' else f'skills-sheet-{slug(n)}.html'
SHEETS = {}   # name -> href, filled as rows are drawn; app_pages draws one sheet page for each
def href_for(n): SHEETS[n] = sheet_href(n); return SHEETS[n]
def srow(n, cat, src, used, href=None, cur=False):
    return R(n, f'{cat}. On for {used}.', icon='skills', tg=[(src,)] if src != 'Library' else None, open=href or href_for(n), cls='is-open' if cur else '')
def findbar(q='', show='On a bot', adv=False):
    if not adv: core._reg('skills.find', 'Find a skill'); core._reg('skills.show', 'Show skills'); core._reg('skills.category', 'Skill category')
    more = ''
    if adv:
        for i, l, v in (('skills.source', 'Source', 'Any source'), ('skills.usedby', 'Used by', 'Any bot or team'), ('skills.status', 'Status', 'Any status'), ('skills.sort', 'Sort', 'Best match')):
            core._reg(i, l); more += f'<span id="{i}" data-id="{i}">{pick(v, l)}</span>'
    n = (4, 24, 1) if q else (K['on_a_bot'], K['all'], K['yours'])   # v8 (Fable r7 M3): of the 24 matches, 4 are on a bot and 1 is yours
    opts = [f'On a bot {n[0]:,}', f'All {n[1]:,}', f'Yours {n[2]:,}']
    return (f'<div class="bigfind"><span id="skills.find" data-id="skills.find" style="display:contents">{inp(q, ph=f"Search {ALLN} skills", label=f"Search all {ALLN} skills by name or what they do", typ="search")}</span>'
            + (B("Add a skill", "pri") if adv else A("Add a skill", "skills.add", "pri", "Import a file, folder or link, or write one. A new skill starts off for every bot (server/skills.ts:18-20).")) + '</div>'
            f'<div class="tbar"><span id="skills.show" data-id="skills.show">{seg(opts, [o for o in opts if o.startswith(show)][0], "Show")}</span>'
            f'<span id="skills.category" data-id="skills.category">{pick("Any category", "Category")}</span>{more}</div>')
def teach(home=True):
    return S('Teach a skill', R('Show the Teach a skill button', 'Adds a button in chat that turns what you just did into a skill.', icon='pencil', id='skills.teach' if home else None, on=True), scope='All bots')
def skills_body(cur=False):
    rows = ''.join(srow(*r, cur=(cur and r[0] == 'Invoice chase')) for r in ONBOT)
    lst = ('<section class="sec" id="skills.list"><h3>Find a skill<small>Type a word. Results come as you type, best match first.</small><span class="sc">All bots</span></h3><div class="card">' + findbar() +
           scroll(rows, 330, 'Skills that are on a bot') + count(f'{K["on_a_bot"]} skills are on at least one bot. Scroll for more. All shows the whole library.') + '</div></section>')
    chips = ''.join(f'<a class="chip" href="skills-advanced.html">{e(c)} <small>{n}</small></a>' for c, n in F.SK_CATS) + f'<a class="chip more" href="skills-advanced.html">All {K["cats"]} categories</a>'
    br = S('Browse the library', f'<div class="chips" id="skills.browse" data-id="skills.browse">{chips}</div>', scope='All bots', sub=f'{K["library"]:,} skills that come with Murage. None is on until you turn it on for a bot.')
    core._reg('skills.browse', 'Browse the library by category')
    return lst + br + teach()
RESULTS = [  # (name, category, source, used by, check, ticked)
 ('Invoice chase', 'Business strategy', 'Library', '3 bots', 'Clean', True), ('Invoice reminder emails', 'Writing', 'Library', 'No bot', 'Clean', True), ('Invoice data entry', 'Data analysis', 'Library', 'No bot', 'Clean', True),
 ('College cost analysis', 'Personal finance', 'Library', 'No bot', 'Needs a look', False), ('Quote follow-up', 'Business strategy', 'Yours', '1 bot', 'Clean', False),
 ('Month-end close', 'Personal finance', 'Library', '1 bot', 'Clean', False), ('Late payment policy', 'Business strategy', 'Library', 'No bot', 'Clean', False), ('Receipt reader', 'Personal finance', 'Library', '1 bot', 'Clean', False),
]
def skills_adv_body():
    team, members = K['team']
    h = (f'<table class="tbl"><caption>24 skills match. Best match first. Click a heading to sort.</caption><thead><tr><th scope="col" class="c">{chk(False, "Select the 24 skills loaded")}</th>' +
         ''.join(f'<th scope="col"><button type="button" aria-label="Sort by {t}">{t}</button></th>' for t in ('Skill', 'Source', 'Used by', 'Check')) + '</tr></thead><tbody>')
    for n, cat, src, used, ck, tk in RESULTS:
        ckh = pill('warn', ck) if ck != 'Clean' else txt('Clean')
        h += f'<tr><td class="c">{chk(tk, "Select " + n)}</td><td><a href="{href_for(n)}">{e(n)}</a><small>{cat}</small></td><td>{src}</td><td>{used}</td><td>{ckh}</td></tr>'
    h += '</tbody></table>'
    sel = selbar(3, 24, pick(f'{team} ({len(members)} bots)', 'Turn the selected skills on for a bot or a team') +
                 A('Turn on', 'skills.selected.apply', 'sm pri', 'v8 (Astra r7 H10, Fable r7 H2): one server bulk operation with its own id (TASKS K5). The server expands the team once, records the members it used, and reports every skill and bot pair as turned on, already on, refused (with the reason) or not known yet. A lost reply is read back by the operation id, never retried against a new team. Never sends an acknowledgement: a skill that needs a look is skipped and named; a bot that cannot use skills is skipped and named. A pair that would take a bot past 40 skills on is refused, and nothing is turned on for that bot (a task copies every skill that is on and refuses past 2,000 files or 64 MB, server/procedure-bundles.ts:105-121).', 'new', slabel='Turn the selected skills on for a bot or team') +
                 A('Turn off', 'skills.selected.off', 'sm', 'The same queue, turning off.', 'new', slabel='Turn the selected skills off for a bot or team'), what='skills')
    warn = ('<div class="cost" id="skills.selected.note"><b>Before you turn these on.</b> Invoice chase is already on for Chief and Dax, so it is turned on for Juno only. Chief would have 13 skills on. In a new chat with you each message lists about 6 of them; Chief looks up the rest when a task needs them. Dax and Juno stay under that size. A bot can have at most 40 skills on: a bot that would pass 40 gets none of these, and is named.</div>')
    core._reg('skills.list.adv', 'Skill results')
    lst = ('<section class="sec"><h3>Find a skill<small>24 results for &ldquo;invoice&rdquo;</small><span class="sc">All bots</span></h3><div class="card">' + findbar('invoice', 'All', adv=True) + sel + warn +
           scroll(h, 300, 'Skills') + count(f'24 of {ALLN} skills match. Scroll for more.') + '</div></section>')
    eng = S('Skills from your engines', R('Claude Code', '4 skills copied on 12 Nov. These are copies: changing a skill in Claude Code later does not change it here, and does not turn it off. Copying again adds only skills with new names. A copy you already have stays as it is.', mk=('C',), cls='why',
                                           act=A('Copy from Claude Code', 'skills.engines.import', 'sm', 'The shipped one-time, opt-in copy of the skills in the Claude Code folder (server/claude-code-import.ts:4-11, route :39). Copies land off for every bot.')),
            R('Codex and Grok Build', 'Copying their skills is not in this version of Murage.', mk=('X',), st=('', 'Not yet')), scope='This computer', id='skills.engines',
            sub='Copies. Murage never runs a skill straight from an engine folder')
    chk_ = S('Skill check', R('What the check looks for', f'Every skill is checked before it can be turned on. {K["review"]} library skills need a look: you read the finding, then say yes for one bot at a time.', icon='shield', id='skills.check', open=True, cls='why'), scope='All bots')
    return lst + eng + chk_ + teach(False)
EXTRA = {   # skills drawn in search results that are on no bot: (category, source, check)
 'Invoice reminder emails': ('Writing', 'Library', 'Clean'), 'Invoice data entry': ('Data analysis', 'Library', 'Clean'),
 'College cost analysis': ('Personal finance', 'Library', 'Needs a look'), 'Late payment policy': ('Business strategy', 'Library', 'Clean')}
TEXT = {
 'Invoice chase': ('Chases an unpaid invoice: finds it, drafts a polite reminder, and notes the reply.', 'Use this when an invoice is past its due date.\n1. Find the invoice and the last message about it.\n2. Draft a short, polite reminder with the amount and the date.\n3. Show the draft before sending.', 'invoice, reminder, payment, accounts receivable'),
 'Weekly report': ('Writes the week\'s report from what the bot did: done, waiting, next.', 'Use this on Fridays or when asked for a weekly update.\n1. List what was finished this week.\n2. List what is waiting and on whom.\n3. Say what comes next. Keep it to one page.', 'weekly, report, status, update'),
 'College cost analysis': ('Compares the full cost of colleges from their published pages.', 'Use this when someone compares colleges by cost.\n1. Open each college\'s cost page.\n2. Follow the links on that page to fees and aid.\n3. Put the totals side by side.', 'college, tuition, cost, aid'),
}
def skill_sheet(name='Invoice chase'):
    """v8 (Astra r7 H6): one sheet per skill. The title, the check, every switch label and every per-bot target name this skill."""
    team, members = K['team']
    cat, src, ck = SKINFO.get(name) or EXTRA[name]
    users = SKB.get(name, [])
    sub, says, topics = TEXT.get(name, (f'{cat}. {"From the library that comes with Murage" if src == "Library" else src}.', None, None))
    flagged = ck != 'Clean'
    builtin = src == 'Built in'
    over = {'Chief'} if name in [n for n, _, x in CHIEF[1:] if x is False] else set()
    def state(n):
        if n not in users: return 'Off.'
        return 'On. In a new chat with you: ' + ('looked up when needed. Chief has 11 skills on and each message lists 6.' if n in over else 'in every message.')
    core._reg('skills.sheet.bots', 'Which bots use this skill')
    on_team = sum(1 for m in members if m in users)
    if flagged:
        rows = line(f'{ic("team")} <b>{team}</b>', f'{", ".join(members[:-1])} and {members[-1]}. On for none. A skill that needs a look is turned on one bot at a time, after you read the finding.', '')
    elif builtin:
        rows = ''
    else:
        rows = line(f'{ic("team")} <b>{team}</b>', f'{", ".join(members[:-1])} and {members[-1]}. On for {on_team} of {len(members)}.',
                    A(f'Turn on for all {len(members)}', 'skills.sheet.teamon', 'sm', 'One save per member bot, each reported. A member that already has it is left alone.', 'new', slabel='Turn a skill on for every bot in a team') if on_team < len(members) else txt('On for all'))
    for b in F.BOTS:
        n = b['n']
        if flagged: end = B(f'Look first, for {n}', 'sm')
        elif builtin and n != 'Chief': end = txt('Chief only')
        else: end = swa(n in users, f'{n} uses {name}')
        rows += line(f'<span class="av s {b["av"][1]}">{b["av"][0]}</span> {n}', f'{b["role"]}. {"Only your Chief of staff uses this guide." if builtin and n != "Chief" else state(n)}', end)
    head = (f'<p class="hint">{pill("warn", "Needs a look") if flagged else pill("ok", "Checked: clean")} {tag(src)} {tag(cat)} {tag("Version 1.0.0")}</p>')
    if flagged:
        head += ('<div class="notsaved" role="alert">' + ic('warn') + '<span>The check found: <b>asks the bot to open links from the page it is reading</b>. Read it, then turn it on for one bot at a time. If the skill changes later, it turns off again and asks you again.</span></div>')
    body = (head + f'<div id="skills.sheet.bots" data-id="skills.sheet.bots">' + lab('Which bots use it', f'On for {len(users)} of {N}') +
        f'<div class="tbar">{inp(ph="Filter bots", label="Filter bots by name or role")}{seg([f"All {N}", f"On {len(users)}", f"Off {N - len(users)}"], f"All {N}", "Show")}</div>' +
        scroll(rows, 250, 'Bots') + count(f'{N} bots. A switch saves that one bot at once. The bot uses the skill from its next message, with its usual approval level. A task that is already running keeps the skills it started with.') + '</div>' +
        lab('What it costs a bot') + line('One line in each message', f'About 610 bytes, in every message of a bot it is on, while it fits under that bot\'s list size. The list is measured for a new chat with you; in a chat with someone else, skills you made yourself are left out, so the list can differ. The whole skill is read only when a task needs it.') +
        line('Nothing for other bots', f'The library can hold {ALLN} skills or ten times that. A skill that is off for a bot adds nothing to its messages.'))
    if says:
        body += lab('What it says') + f'<div class="pre">{e(says)}</div>' + f'<p class="hint">{A("Read all of it", "skills.sheet.read", "sm", "Opens the full text and its files beside the page.")}</p>'
    body += '<div class="advh">Advanced</div>' + line('Source', ('From the library that comes with Murage. It changes only when Murage updates. library:' + slug(name) + '@1.0.0') if src == 'Library' else
                                                    ('A copy made from Claude Code. Changing the original there does not change this copy.' if src.startswith('Copied') else src + '.'))
    if topics: body += line('Topics', topics)
    if not builtin: body += line('Make your own version', 'Copies it to Yours, where you can change it. The copy starts off for every bot.', A('Copy to Yours', 'skills.sheet.copy', 'sm', 'The existing collection copy.'))
    return sheet(name, sub, body, 'skills', 'skl')
def review_dialogs():
    # v8 (Astra r7 H10, Fable r7 H2): every pair is reported as turned on, already on, refused or not known yet; Undo covers only what this run turned on.
    return ('<div class="flow">' +
        dlg('A skill that needs a look has no switch', 'College cost analysis: look before you turn it on', '<p>The check found: <b>asks the bot to open links from the page it is reading</b>.</p><p>Turn it on for Juno only if that is what you want. If the skill changes later, it turns off again and asks you again.</p>', B('Cancel') + B('Turn on for Juno', 'pri')) +
        dlg('Result: turned on for a team, one skipped', 'Turned on 7 pairs for Front office', '<p>Now on, from their next message: Invoice reminder emails and Invoice data entry for Chief, Dax and Juno; Invoice chase for Juno.</p><p>Already on, left alone: Invoice chase for Chief and Dax.</p><p><b>College cost analysis needs a look first.</b> It was not turned on.</p><p>Undo turns off only the pairs this turned on. A pair you changed since is left as it is, and named.</p>', B('Undo') + B('Look at it') + B('Done', 'pri')) +
        dlg('Result: a lost answer', '6 turned on, 1 not known yet', '<p>Murage did not hear back about <b>Invoice data entry for Juno</b>. It may have been saved. Murage is reading what your computer has before it says more, and does not try it again until then.</p><p>The other 6 stand.</p>', B('Close') + B('Check again', 'pri')) +
        dlg('Result: a refusal on record', 'Invoice data entry for Juno was not saved', '<p>Your computer recorded that it refused this one: Juno\'s skills were being changed in another window at that moment. Try again turns it on for Juno only, whoever is in Front office now.</p>', B('Close') + B('Try Juno again', 'pri')) +
        dlg('Result: after a restart, nothing on record', 'Invoice data entry for Juno: could not check', '<p>Murage stopped before it heard back about this one, and there is no record that it was saved or refused. Murage does not guess from whether the skill is on now.</p><p>Try again sends just this pair: Invoice data entry for Juno.</p>', B('Close') + B('Try Juno again', 'pri')) +
        dlg('Result: a bot at the most skills it can use', 'Nothing turned on for Chief', f'<p>You ticked the 60 skills loaded. Chief would have 71 skills on, and a bot can have at most 40: past that, a task cannot start, because each task copies every skill that is on. Nothing was turned on for Chief.</p><p>Dax would have 62 and Juno 65: the same. Nothing was turned on for them.</p>', B('Close', 'pri')) + '</div>')
def skills_states():
    def sk(n): return ''.join(f'<div class="r" aria-busy="true"><span class="mk"></span><span class="tx"><span class="skel t"></span><span class="skel"></span></span></div>' for _ in range(n))
    ready = ('<section class="sec"><h3>Find a skill<span class="sc">All bots</span></h3><div class="card">' +
             f'<div class="bigfind">{inp(ph="Search your " + str(K["yours"]) + " skills", label="Search your own skills while the library is getting ready", typ="search")}</div>' +
             ban(f'<b>Getting the library of {K["library"]:,} skills ready.</b> Your own skills and the ones on your bots work now.', 'off') + sk(3) + '</div></section>')
    nomatch = ('<section class="sec"><h3>Find a skill<span class="sc">All bots</span></h3><div class="card">' + f'<div class="bigfind">{inp("tax return", label="Search skills", typ="search")}</div>' +   # v8 (Astra r7 H9): the default view widens to the library and says so
               f'<div class="empty"><b>No skill on a bot matches &ldquo;tax return&rdquo;</b>You are looking at On a bot ({K["on_a_bot"]}). The whole library has 3 that match.<br>{B("Show the 3 in All", "pri")}</div></div></section>')
    err = ('<section class="sec"><h3>Find a skill<span class="sc">All bots</span></h3><div class="card">' + f'<div class="bigfind">{inp("invoice", label="Search skills", typ="search")}</div>' +
           '<div class="notsaved" role="alert">' + ic('warn') + 'Could not search the library. Skills already on your bots still work. <button type="button" class="lnk">Try again</button></div></div></section>')
    none = (S('On for Otto (0)', '<div class="empty"><b>Otto has no skills on</b>Bots work without skills. A skill is know-how for a job it does often.</div>', scope='Only Otto') +
            S('Suggested for a writing bot', R('Blog outline', 'Writing. From the library.', icon='skills', act=B('Turn on', 'sm')), R('Tone match', 'Writing. Yours.', icon='skills', act=B('Turn on', 'sm')), scope='Only Otto'))
    cant = S('Skills for Zed', R('Zed cannot use skills', 'Zed runs on the Grok API, which has no way to read a skill. Move Zed to another engine to use skills.', icon='x', cls='why', st=('', 'Cannot'),
                                 go=('Fix: Choose another engine for Zed', 'bot-model.html#bot.model.engine')), scope='Only Zed')
    return ready, nomatch, err, none, cant

# ---------------- one bot ----------------
def bot_skills_body():
    D = F.DAX
    rows = ''.join(R(n, 'From the library. In every message.', icon='skills', id='bot.skills.' + n.split()[0].lower(), on=on, open=href_for(n)) for n, on in D['skills'])
    onl = S(f'On for Dax ({D["skills_on"]})', rows, scope='Only Dax', id='bot.skills.list', sub='A switch saves at once. Dax uses the change from its next message. In every message is measured for a new chat with you')
    core._reg('bot.skills.add', 'Add a skill for Dax'); core._reg('bot.skills.add.turnon', 'Turn on a suggested skill for Dax', 'action', 'One save for this bot and skill. A skill that needs a look opens its finding first.', 'today')
    sug = [('Inbox triage', 'Productivity. From the library.'), ('Follow-up drafter', 'Writing. From the library.'), ('Meeting notes', 'Writing. From the library.')]
    add = S('Add a skill', f'<div class="bigfind" id="bot.skills.add" data-id="bot.skills.add">{inp(ph=f"Search {ALLN} skills", label=f"Search all {ALLN} skills to add one for Dax", typ="search")}{pick("Any category", "Category")}</div>' +
            '<div class="advh">Suggested for an inbox assistant</div>' + ''.join(R(n, d, icon='skills', act=B('Turn on', 'sm'), open=href_for(n)) for n, d in sug) +
            R('The whole library', f'{ALLN} skills, with filters and several bots at once.', icon='skills', go=('Skills', 'skills.html')), scope='Only Dax', sub='Two clicks: find it, turn it on')
    auto = S('Added by Murage when needed', R('Making images', 'Built in. Murage adds it to a message that asks for a picture.', icon='image', st=('', 'Automatic')),
             R('Using your phone', 'Built in. Added when a message is about your phone, while Phone tools is on.', icon='phone', st=('', 'Automatic')),
             scope='All bots', sub='These have no switch. They are not in the list above and do not count against it', id='bot.skills.auto')
    return onl + add + auto
# v8 (Fable r7 M4): the index keeps the leading lines and stops at the first that does not fit (server/skills.ts:1997-2003), so the 6 in every message are the first 6 in list order
CHIEF = [('Chief of staff basics', 'Built in. Always part of Chief.', None), ('Inbox triage', 'From the library.', True), ('Daily brief', 'Yours.', True), ('Weekly report', 'From the library.', True),
         ('Meeting notes', 'From the library.', True), ('Tone match', 'Yours.', True), ('Follow-up drafter', 'From the library.', True), ('Invoice chase', 'From the library.', False),
         ('Vendor comparison', 'From the library.', False), ('Contract summary', 'From the library.', False), ('Quote follow-up', 'Yours.', False), ('Calendar tidy', 'From the library.', False)]
def chief_skills_body():
    assert sum(1 for _, _, x in CHIEF if x) == K['chief_listed'] and sum(1 for _, _, x in CHIEF if x is not None) == K['chief_on']
    rows = R(CHIEF[0][0], CHIEF[0][1] + ' It does not count against the list below.', icon='skills', on=True, tg=[('By Murage',)])
    assert [n for n, _, x in CHIEF[1:]] == [n for n, _, x in CHIEF[1:] if x] + [n for n, _, x in CHIEF[1:] if x is False]   # leading lines only
    assert all('Chief' in SKB[n] for n, _, _ in CHIEF)   # one map (Fable r7 M3)
    rows += ''.join(R(n, d + (' In every message.' if x else ' Looked up when needed.'), icon='skills', on=True, open=href_for(n)) for n, d, x in CHIEF[1:])
    wait = R('Supplier onboarding', 'Chief wrote this from a chat on 19 Nov. It is not used until you have read it.', icon='skills', cls='why', st=('warn', 'Needs you'), act=B('Review', 'sm'))
    return (S(f'On for Chief ({K["chief_on"]})', rows, scope='Only Chief', sub=f'In a new chat with you: the first {K["chief_listed"]} in every message, the other {K["chief_on"] - K["chief_listed"]} looked up when needed') +
            S('Waiting for you (1)', wait, scope='Only Chief', sub='It has no switch until you have looked'))
def chief_banner():
    return ban(f'<b>Chief sees {K["chief_listed"]} of its {K["chief_on"]} skills in every message.</b> It looks up the other {K["chief_on"] - K["chief_listed"]} when a task needs them. Each message has room for a short list, and that room does not grow with the library. Fewer skills on means each one is more likely to be used. Measured for a new chat with you: a chat with someone else leaves out the skills you made yourself, and a running task keeps the list it started with.', 'note')

def app_pages(page, PAGES, G, SF):
    page('skills.html', G, 'app', 'skills', 'Skills', f'{ALLN} skills. {K["on_a_bot"]} are on at least one bot. A library skill does nothing until you turn it on for a bot.', skills_body, learn=('How skills work', 'skills'),
         aside=lambda: helpc('Three clicks', 'Skills, the skill, then that bot\'s switch.', 'From a bot: its Skills page, then the switch.') + helpc('Does a big library slow bots down?', 'No. A bot\'s messages carry a short list of its own skills only. Skills that are off for it add nothing.', tip=True),
         note=f'v7, from the skills study. Search is the page: the box is first and focused on open. Show opens on On a bot. Counts come from the index, never from text (the README and two comments are stale). {K["library"]:,} library, {K["builtin"]} built in, {K["yours"]} yours. All 31 on-a-bot rows are drawn in the scrolling list. Advanced is skills-advanced.html; states are skills-states.html.')
    page('skills-advanced.html', SF, 'app', 'skills', 'Skills', f'{ALLN} skills. {K["on_a_bot"]} are on at least one bot.', skills_adv_body, view='advanced', extra=review_dialogs, learn=('How skills work', 'skills'),
         note='Advanced adds Source, Used by, Status and Sort, the tick column, Source and Check columns, and the one bulk bar: turn the ticked skills on for a bot or a team. Same rows and names as Simple. Below: the look-first confirmation and two bulk results. Category needs the manifest to carry it (TASKS K1); Status values Update ready and New need K2 and K3.')
    PAGES['skills-advanced.html'] = ('Skills: Advanced, a search, three ticked for a team', SF, 'Filters with counts, bulk bar, results')
    page('skills-sheet.html', SF, 'app', 'skills', 'Skills', f'{ALLN} skills. {K["on_a_bot"]} are on at least one bot.', lambda: skills_body(True), sh=skill_sheet, crumbs=[('Skills', 'skills.html')], last='Invoice chase', rebody=True,
         note='One sheet per skill, from either Skills page. Team rows first, then every bot with a switch. In every message or Looked up when needed comes from the same function that builds the bot\'s message (TASKS K4), never from an estimate.')
    PAGES['skills-sheet.html'] = ('Skills: a skill\'s sheet (Invoice chase)', SF, 'Which bots, team, cost, text')
    # v8 (Astra r7 H6): every other skill a row links to gets its own sheet, drawn as a state of the same page (its ids have their home on skills-sheet.html)
    for n, h in sorted(SHEETS.items()):
        if h == 'skills-sheet.html': continue
        page(h, SF, 'app', 'skills', 'Skills', f'{ALLN} skills. {K["on_a_bot"]} are on at least one bot.', lambda: skills_body(), sh=(lambda n=n: skill_sheet(n)), crumbs=[('Skills', 'skills.html')], last=n, state=True,
             note=f'The sheet for {e(n)}: its own title, check, switches and per-bot targets. Every row that names {e(n)} on any Skills page opens this file (L1 checks the name at both ends).')
        if n in ('Weekly report', 'College cost analysis', 'Chief of staff basics'): PAGES[h] = (f'Skills: the sheet for {n}', SF, {'Weekly report': 'A second clean skill', 'College cost analysis': 'A skill that needs a look: no switches', 'Chief of staff basics': 'The Chief-only built-in'}[n])
        else: PAGES.pop(h, None)
