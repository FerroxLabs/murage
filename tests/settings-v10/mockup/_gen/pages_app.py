# App settings: the 17 rail pages, each at 1440 x 900. Every value about the owner and the bots comes from fixture.py.
from core import *
PRESSED = " aria-pressed=\"true\""
import core, fixture as F, inventory5 as X
NAMES = F.NAMES; BOTS = F.BOTS; N = F.N
def avr(b, s=True): return f'<span class="av{" s" if s else ""} {b["av"][1]}">{b["av"][0]}</span>'

# ---------------- shared list pieces (one list contract, one bulk-edit model) ----------------
FILTER = 'Filter bots'   # short prompt (Visual QA M03). The accessible name says what it matches.
FILTERL = 'Filter bots by name, role, engine, model or approval level'
def tbar(ph=FILTER, extra=''): return f'<div class="tbar">{inp(ph=ph, label=FILTERL)}{extra}</div>'
def lvl(b): return b['lvl'] + ('<small>Not set by you</small>' if b['follows'] else '')
def sorthead(last):
    """Sortable headings for a bot list in a sheet: the same filter, sort and scope contract as the tables."""
    cols = ['Bot', 'Role', 'Engine', last]
    return ('<div class="lhead" role="row">' + ''.join(f'<button type="button" class="srt" aria-label="Sort by {c}"{PRESSED if i == 0 else ""}>{c}{" &#9650;" if i == 0 else ""}</button>' for i, c in enumerate(cols)) + '</div>')
def bot_table(rows, cols='model', archived=True, cap='', ticked=()):
    heads = {'model': ['Bot', 'Engine', 'Model', 'Thinking effort'], 'bots': ['Bot', 'Engine & model', 'Approval level', 'Tools', 'Last active', 'Open']}[cols]
    h = f'<table class="tbl"><caption>{cap}</caption><thead><tr><th scope="col" class="c">{chk(False, "Select every bot shown")}</th>'
    for i, t in enumerate(heads):
        srt = ' aria-sort="ascending"' if i == 0 else ''
        h += (f'<th scope="col"{srt}><button type="button" aria-label="Sort by {t}">{t}{" &#9650;" if i == 0 else ""}</button></th>' if t != 'Open' else '<th scope="col">Go to a page</th>')
    h += '</tr></thead><tbody>'
    pg = lambda n: f'<td><button type="button" class="pick" aria-haspopup="menu" aria-label="Go to one of {n}\'s 12 settings pages">Go to a page</button></td>'
    for b in rows:
        nm = f'<a href="bot-reach.html">{avr(b)} {b["n"]}</a><small>{b["role"]}</small>'
        c = f'<td class="c">{chk(b["n"] in ticked, "Select " + b["n"])}</td>'
        if cols == 'model':
            h += f'<tr>{c}<td>{nm}</td><td>{pick(b["eng"], b["n"] + " engine")}</td><td>{pick(b["model"], b["n"] + " model")}</td><td>{pick(F.DAX["effort"] if b["n"] == "Dax" else "Medium", b["n"] + " thinking effort")}</td></tr>'
        else:
            tl = F.DAX_TOOLS if b['n'] == 'Dax' else b['tools']
            h += f'<tr>{c}<td>{nm}</td><td>{b["eng"]}<small>{b["model"]}</small></td><td>{lvl(b)}</td><td>{tl} of {F.NT}</td><td>{b["last"]}</td>{pg(b["n"])}</tr>'
    if archived:
        h += f'<tr class="ghd"><td colspan="{len(heads) + 1}">Archived ({F.NA}). Hidden from the sidebar. Chats, memory and skills are kept; saved app choices are not.</td></tr>'
        for nme, role in F.ARCHIVED:
            mid = f'<td>Fuigo</td><td>{F.AUTO_MODEL}</td><td>Medium</td>' if cols == 'model' else f'<td>Fuigo<small>{F.AUTO_MODEL}</small></td><td>Ask</td><td>9 of {F.NT}</td><td>October</td>' + pg(nme)
            h += f'<tr><td class="c">{chk(False, "Select " + nme)}</td><td><a href="bot-reach.html"><span class="av s c4">{nme[0]}</span> {nme}</a><small>Archived. {role}</small></td>{mid}</tr>'
    return h + '</tbody></table>'
def botlist(tool, on, ticked=(), n=None):
    """Which bots can use a tool: every bot, one switch each, a tick box each. on(b) says whether it is on."""
    rows = sorthead('On or off') + f'<div class="line first">{chk(False, "Select every bot shown")} <span class="t"><b>Select all {N}</b></span></div>'
    rows += ''.join(line(f'{chk(b["n"] in ticked, "Select " + b["n"])} {avr(b)} {b["n"]}', f'{b["role"]}. {b["eng"]}.', swa(on(b), f'{b["n"]} may use {tool}')) for b in BOTS)
    return rows

# ---------------- Overview ----------------
def overview_body(n=N, first=None, phone=False):
    q = F.DAX['request']
    needs = S(f'Needs you ({F.NEEDS_YOU})', R('Notion needs you to sign in again', f'{F.plural(F.app_count("Notion"))} use Notion. They cannot reach it until you do.', icon='warn', ref='apps.connected.notion',
                             st=('warn', 'Needs sign-in'), go=('Connected apps', 'apps.html#apps.connected.notion')),
              (R('1 app request is waiting for Dax', 'Review it on your computer.', icon='warn', st=('warn', 'Needs you'), go=('Where to review it', 'layout-phone-sheet.html')) if phone else   # v8 (Fable r7 H1): the request's app, account and operations are an access read, desktop class (server/route-policy.ts:399)
               R(f'{q["by"]} asked to give Dax {q["app"]}', f'{q["what"]} in {q["acct"]}. Waiting since {q["at"]}.', icon='warn', ref='bot.tools.apps.request', st=('warn', 'Needs you'),
                go=('Review the request', 'bot-tools-apps.html#bot.tools.apps.request'))),
              R('Codex needs you to sign in', f'{F.ENGINE_COUNT["Codex"]} bots run on Codex and are waiting.', icon='warn', ref='providers.subs.chatgpt', st=('warn', 'Needs sign-in'), go=('Providers', 'providers.html#providers.subs.chatgpt')),
              sub='Everything marked amber anywhere in Settings, and nothing else', id='overview.needs')
    one = n == 1
    setup = ('<section class="sec"><h3>Your setup</h3><div class="tiles">'
             f'<a class="big" href="providers.html"><span class="k">{ic("prov")} Providers</span><span class="q">Accounts and keys you have</span><ul><li>FluxRouter {pill("ok","Signed in")}</li>' + ('' if one else f'<li>Claude plan {pill("ok","Signed in")}</li><li>3 API keys {txt("1 not in use")}</li>') + '</ul></a>'
             f'<a class="big" href="engines.html"><span class="k">{ic("eng")} Engines</span><span class="q">What runs your bots</span><ul><li>Fuigo {pill("ok","Ready")}</li>' + ('' if one else f'<li>Claude Code {pill("ok","Ready")}</li><li>Codex {pill("warn","Needs sign-in")}</li>') + '</ul></a>'
             f'<a class="big" href="tools.html"><span class="k">{ic("tools")} Tools</span><span class="q">What bots can use</span><ul><li>Tools on {txt(f"{F.APP_TOOLS_ON} of {F.NT}")}</li><li>Connected apps {txt("0" if one else str(len(F.APPS)))}</li><li>Custom tools (MCP) {txt("0" if one else "2")}</li></ul></a></div></section>')
    if one:
        bots = S('Your bot', R('Chief', 'Chief of staff. Fuigo, model picked for you. Ask.', av=('C', ''), go=('Bot settings', 'bot-reach.html')))
    else:
        rows = ''.join(R(b['n'], f'{b["role"]}. {F.model_prose(b)}. {b["lvl"]}.', av=b['av'], cls='finder', go=('Bot settings', 'bot-reach.html')) for b in BOTS[:3])   # v7: every finder row ends with the approval level (Walk r6 H2)
        bots = S('Your bots', f'<div class="paste">{inp(ph="Find a bot", label=f"Find any of your {n} bots, or the {F.NA} archived", cls="w")}{B("All bots", href="bots.html")}</div>', rows, sub=f'Recently opened. Type a name to find any of your {n} bots, or the {F.NA} archived.')
    tasks = ('<section class="sec"><h3>Common things</h3><div class="card"><div class="tasks">'
             f'<a href="providers.html#providers.keys.add">{ic("key")} Add an API key {ic("chev")}</a>'
             f'<a href="providers.html#providers.subs">{ic("user")} Use a plan you already pay for {ic("chev")}</a>'
             f'<a href="bots.html">{ic("tools")} Choose what a bot can use {ic("chev")}</a>'
             f'<a href="phone.html#phone.devices.add">{ic("phone")} Pair your phone {ic("chev")}</a>'
             f'<a href="backups.html#backups.backupnow">{ic("backup")} Back up now {ic("chev")}</a>'
             f'<a href="usage.html">{ic("usage")} See what you have spent {ic("chev")}</a></div></div></section>')
    if phone:   # v7 (Visual QA r6 M09): only what this phone can do. Keys, pairing and backups are done on the computer and are not offered here.
        tasks = ('<section class="sec"><h3>Common things</h3><div class="card"><div class="tasks">'
                 f'<a href="phone.html#phone.calls.today">{ic("call")} Turn calls off for today {ic("chev")}</a>'
                 f'<a href="usage.html">{ic("usage")} See what you have spent {ic("chev")}</a>'
                 f'<a href="bots.html">{ic("bots")} Open a bot {ic("chev")}</a></div></div></section>')
    def ch(what, frm, to, who, when, back=False, href='#', dest='it'):
        endh = A('Set back', 'overview.changed.setback', 'sm', 'Single-field instant saves only. The server sets it back only if the value is still the one shown (compare-and-set), else the row says it changed again. Never for No limits, removals or forms.', 'new') if back else ''
        return R(what, rawdesc=f'{e(frm)} &rarr; <b>{e(to)}</b>. {e(who)}. {e(when)}.', icon='history', cls='full', end=endh, go=('Open ' + dest, href))
    if one:
        rows = (ch("Chief's model", 'x', 'x', 'You, on this computer', 'Today', False, 'bot-model.html#bot.model.model', 'Engine & model').replace('x &rarr; <b>x</b>', 'Set to <b>Auto model</b>') +
                ch('FluxRouter', 'Signed out', 'Signed in', 'You, on this computer', 'Today', False, 'providers.html#providers.fluxrouter', 'Providers'))
    else:
        rows = (ch("Dax's apps", 'No apps', 'Gmail, Google Calendar, Notion', 'You, on this computer', F.DAX['apps_set'], False, 'bot-tools-apps.html#bot.tools.apps.mode', 'Gmail and other apps') +
                ch("Dax's model", F.DAX['model_was'], F.DAX['model'], 'You, on this computer', F.DAX['model_changed'] + '. This cleared the app choices saved for Dax', True, 'bot-model.html#bot.model.model', 'Engine & model') +
                ch("Rhea's model", 'Claude Sonnet', 'Claude Opus', 'Murage, because Claude Sonnet was withdrawn for this plan', '2 hours ago. Rhea had no app choices saved, so none were cleared', False, 'models.html#models.table', 'Models') +
                ch('Calls today', 'On', 'Off until midnight', 'You, on Pixel 9', 'Yesterday 18:10', False, 'phone.html#phone.calls.today', 'Phone & remote access') +
                ch('API key', 'none', 'Tavily key added', 'You, on this computer', '3 Nov', False, 'providers.html#providers.keys', 'Providers'))
    changed = S('Changed recently', rows, sub='Kept on this computer only. Never sent anywhere.', id='overview.changed',
                post=f'<p class="hint">The newest of up to 200. Set back is offered for a single change that can be undone safely; other rows open the place to change it. Setting a model back clears the app choices of that bot again and does not bring the old ones back: Murage says so before it saves. When Murage itself moves a bot to another model, the row names Murage and says whether app choices were cleared. Secrets are never recorded, only that a key was added or removed.</p>')
    if phone: return needs + setup + bots + tasks   # v7 (Visual QA r6 H05): Changed recently is kept on the computer and is not sent to a phone, so the phone draws no journal and no Set back
    return needs + setup + bots + tasks + changed

# ---------------- Models ----------------
def models_body():
    core.REG['cur'] = core.REG['cur']
    sel = selbar(3, N, pick('Set engine and model', 'Engine and model for the selected bots') + pick('Set thinking effort', 'Thinking effort for the selected bots') +
                 A('Apply', 'models.selected.apply', 'sm pri', 'A queue of single saves: one PATCH per bot, each awaited and reported in its row. A bot whose chosen apps were cleared reads Saved. App choices cleared. This applies to Set thinking effort as much as to Set engine and model: effort is a field of the model selection (server/contracts.ts:55-64; src/components/SettingsPanel.tsx:778) and the access binding hashes the whole selection (server/bot-access-role.ts:5). Stops on Stop; never one bulk write.', 'new', slabel='Apply to the selected bots (Models)'))
    t = (f'<section class="sec" id="models.table"><h3>Each bot\'s engine and model<small>A picker saves that one bot. Tick bots to change several. Changing an engine, a model or thinking effort clears the chosen apps of that bot. Murage asks first.</small><span class="sc">Only that bot</span></h3><div class="card">'
         + tbar(extra=seg(['All', 'Fuigo', 'Claude Code', 'Codex'], 'All', 'Engine')) + sel
         + '<div class="cost" id="models.selected.appsnote"><b>1 of these 3 bots has chosen apps: Atlas.</b> Changing its engine, model or thinking effort clears them. Atlas goes to Only chosen apps with no apps, and its row says so after Apply. Nothing is saved for Nova (Connected apps are off for it) or Kit (set to Every app), so nothing changes for them. The same count is shown for Set thinking effort.</div>'
         + scroll(bot_table(BOTS, 'model', False, 'Sorted by name. Click a heading to sort. Thinking effort: higher is slower and more careful.', ticked=('Atlas', 'Nova', 'Kit')), 470, 'Bots')
         + count(f'{N} bots. Fuigo {F.ENGINE_COUNT["Fuigo"]}, Claude Code {F.ENGINE_COUNT["Claude Code"]}, Codex {F.ENGINE_COUNT["Codex"]}.') + '</div></section>')
    lists = S('Model lists', scope='All bots', more=['Which connection feeds each model list'], id='models.lists')
    return t + lists

# ---------------- Tools sheets ----------------
def websearch_sheet():
    def opt(t, d, on=False): return line(f'<b>{t}</b>', d, rad(on, t))
    core._reg('tools.websearch.provider', 'Search with')
    return sheet('Web search', "Murage's web search. The switch on its row turns it off for every bot.",
        '<div id="tools.websearch.provider" data-id="tools.websearch.provider" role="radiogroup" aria-label="Search with">' + lab('Search with', 'One choice') +
        opt("Engine's own search first", "Uses the engine's search when it has one. If not, Murage's free search. Your keys are never used.", True) +
        opt("Murage's free search", 'No key needed.') +
        opt('FluxRouter', 'Uses your FluxRouter credit. Bots ask before each search. No fallback to another choice.') +
        opt('Tavily', 'Tavily refused the saved key. <a class="lnk" href="providers-key.html#providers.keys.check">Fix in Providers</a>') + opt('Exa', 'Needs an Exa key.') + opt('Firecrawl', 'Needs a Firecrawl key.') + '</div>' +
        "<div class=\"cost\"><b>When Web search is off:</b> Murage refuses each new search, for every bot. Turning it on again brings back the choice above; if that choice uses credit, the row says so before you confirm.<br>"
        "<b>What can still search then.</b> Murage's own search is refused at each call, at once. Codex: its own search is always off while Murage's tools are attached, so nothing changes for it. Claude Code: its own search is switched off when Claude Code next starts for that bot, and Murage starts it again before the bot's next message, so an open chat does not keep the old setting. One exception: on a No limits turn Claude Code keeps its own search, because saved tool choices are not applied there. Fuigo, Grok Build and OpenCode may still search by themselves.<br>"
        f'<b>Reading a page is a different tool.</b> Read web pages ({F.TOOL_BOTS["Read web pages"]} bots), Browser ({F.TOOL_BOTS["Browser"]}) and Computer ({F.TOOL_BOTS["Computer"]}) have their own switches. Reading the rest of a page a bot already opened belongs to Read web pages. '
        'These engines also have a page reader of their own that Murage cannot switch off: ' + ', '.join(F.READERS_NO_SWITCH) + ' and any custom agent.</div>' +
        lab('Which bots can use it', f'{F.TOOL_BOTS["Web search"]} of {N}') + f'<div class="tbar">{inp(ph=FILTER, label="Filter bots")}{seg(["All", "On", "Off"], "All", "Show")}</div>' +
        scroll(botlist('Web search', lambda b: b['n'] not in F.SEARCH_OFF), 260, 'Bots') + count(f'{N} bots. A switch saves that one bot. Tick bots to change several.'), 'globe')

IMG_ON = [b['n'] for b in BOTS[:12] if b['n'] != 'Dax'] + ['Vera']
def images_sheet():
    tick = IMG_ON[:10]
    return sheet('Images', 'Bots make pictures. Paid per image through FluxRouter.',
        lab('Image model') + line('Model for images', 'Used by every bot that makes images.', pick('FLUX 1.1', 'Model for images')) +
        line('Before each image', 'Whether a bot stops for your yes. The default for a bot; a bot can have its own rule on its Approvals page.', pick('Each time', 'Before each image: Each time or Never')) +
        line('Check that images work', 'Makes one test image. Uses credit.', A('Make a test image', 'tools.images.check', 'sm', 'The shipped manual image check, with its confirmation.')) +
        lab('Which bots can use it', f'{F.TOOL_BOTS["Images"]} of {N}') + f'<div class="tbar">{inp(ph=FILTER, label="Filter bots")}{seg(["All", "On", "Off"], "On", "Show")}</div>' +
        selbar(10, N, pick('Turn off', 'Images for the selected bots: Turn on or Turn off') + A('Apply', 'tools.images.applyselected', 'sm pri', 'The same bar as every list: one choice, then Apply. A queue of single saves: one toolsOff write per bot, each reported in its row.', 'new', slabel='Turn Images on or off for the selected bots')) +
        scroll(botlist('Images', lambda b: b['n'] in IMG_ON, ticked=tick), 250, 'Bots') + count(f'{N} bots. 10 ticked.'), 'image', 'img')

# ---------------- Connected apps ----------------
def apps_body(sheet_open=False):
    rows = ''
    for a, v in F.APPS.items():
        c = F.plural(F.app_count(a))
        if v['state'] == 'Signed in':
            rows += R(a, f'{v["acct"]}. {c} can use it' + (f', and {" and ".join(F.nl_extra(a))} at No limits.' if F.nl_extra(a) else '.'), mk=(v['mark'],), id='apps.connected.' + v['id'], st=('ok', 'Signed in'), open='apps-gmail.html' if a == 'Gmail' else True, cls='is-open' if (sheet_open and a == 'Gmail') else '')
        else:
            rows += R(a, f'{a} asked you to sign in again. {c} are waiting.', mk=(v['mark'],), id='apps.connected.' + v['id'], st=('warn', 'Needs sign-in'), open=True, cls='' if sheet_open else 'hl')
    apps = S('Your apps', rows,
        f'<div class="paste">{A("Add an app", "apps.add", "pri", "Before sign-in, Murage shows who will get the app. See the flow below the window.")}<span class="hint">Gmail, Slack, HubSpot and 250 more, through FluxRouter. After you sign in, no bot can use the app until you have seen who gets it.</span></div>',
        scope='All bots', id='apps.connected', sub='Sign in once. Then choose which bots may use each app.')
    mail = S('Bot email', R('Bot email', 'Lets a bot have its own address to send and receive. On. Each bot turns on its own address.', icon='mail', id='apps.botemail', on=True, open=True),
             scope='All bots', sub='Not your own inbox. For that, connect Gmail above.', more=['Use your own mail domain', 'Who may email a bot'])
    mcp = S('Custom tools', R('files-server', 'On this computer. 6 tools.', icon='sliders', id='apps.mcp.files', on=True, open=True),
            R('crm-server', 'Off. Its last start failed: the command was not found.', icon='sliders', id='apps.mcp.crm', on=False, open=True, cls='off'),
            f'<div class="paste">{A("Add a tool server", "apps.mcp.add", "", "Opens the form in place.")}{A("Import from Claude Code", "apps.mcp.import", "", "Review, then import.")}</div>',
            scope='All bots', id='apps.mcp', sub='Tool servers you add yourself. Also called MCP servers. Bots set to Every app get them. Bots set to Only chosen apps do not, except on a No limits turn.', more=['Review before importing'])
    sign = S('Related', R('Let other programs use a bot', 'Scripts and outside agents.', icon='terminal', ref='phone.scripts', go=('Phone & remote access', 'phone.html#phone.scripts')),
             R('Slack, Discord, Telegram as a way to talk to bots', 'That is Messaging. Here, Slack is an app a bot works in.', icon='msg', ref='messaging.apps', go=('Messaging', 'messaging.html#messaging.apps')))
    return apps + mail + mcp + sign

def addapp_flow():
    ne = len(F.EVERY_APP)
    q = ('<div class="selbar" role="status"><b>11 saved. 1 not saved.</b>' + B('Try Tess again', 'sm pri') + '</div>' +
         line('Sable, Kit, Rhea and 8 more', 'Saved. Each keeps the apps and the exact operations it has today.', saved()) +
         line('Tess', 'Not saved. Murage could not read every connected account just now, so it did not guess. Tess is still set to Every app.', txt('Not saved')))
    return ('<div class="flow">' +
        dlg('1. Before you sign in', 'Who would get HubSpot?', f'<p>Would get it ({ne + 2}): <b>{", ".join(F.EVERY_APP[:-1])} and {F.EVERY_APP[-1]}</b> (nothing saved, so set to Every app); <b>Pepper</b> (at No limits); and the chat <b>{F.NL_CHATS[0][1]}</b> with {F.NL_CHATS[0][0]} (you set that chat to No limits).</p>'
            f'<p>Would not get it: the {len(F.SAVED_BOTS) - 1} other bots with chosen apps, the {len(F.APPS_OFF)} bots with Connected apps off, and any chat with a guest.</p>'
            '<p>HubSpot is closed from the moment you press Sign in. After you sign in, no bot, chat or routine can use it until you have looked at the list again and said yes.</p>', B('Cancel') + B(f'Keep those {ne} out first') + B('Sign in to HubSpot', 'pri')) +
        dlg('2. If you keep them out', f'Set {ne} bots to Only chosen apps?', '<p>Each keeps exactly the apps it can use today, with the same exact operations. HubSpot, and any app you add later, starts with no access for them. They also stop getting your custom tools (files-server).</p>'
            '<p>One bot at a time, each reported. If one cannot be saved, it stays set to Every app and Murage says which.</p>' + q,
            B('Keep Every app') + A('Set to Only chosen apps', 'apps.add.limitevery', 'pri', 'One set-switches save per bot with keepCurrent: in the same write the server records each connected account at its current level and its exact operations, from a complete account list, so nothing the bot uses today is lost and the new app is not kept (AG0 addendum A1). An incomplete or stale account list refuses the save. Queued, each reported.', 'new')) +
        dlg('3. After you sign in: nobody has it yet', 'HubSpot is signed in. Share it with these 3?', f'<p>Would get it (3):</p><ul class="who"><li><b>Tess</b>, set to Every app. Step 2 could not move it.</li><li><b>Pepper</b>, at No limits.</li><li>The chat <b>{F.NL_CHATS[0][1]}</b> with {F.NL_CHATS[0][0]}, set to No limits. {F.NL_CHATS[0][0]} itself is at Ask and does not get HubSpot in its other chats.</li></ul>'
            f'<p>Would not get it ({N - 2} bots): {", ".join(F.EVERY_APP[:3])} and {len(F.EVERY_APP) - 4} more now have Only chosen apps; the {len(F.SAVED_BOTS) - 1} other bots with chosen apps; the {len(F.APPS_OFF)} bots with Connected apps off; any chat with a guest.</p>'
            '<p>Until you choose, no bot can use HubSpot, at any approval level. While it stays closed, bots also cannot use the FluxRouter tools that search across all your apps or run code over them, because those could reach HubSpot.</p>',
            B('Keep it closed for now') + A('Share with these 3', 'apps.add.admit', 'pri', 'v8 (Astra r7 C1): the list is the effective audience, computed by one server function over every bot default, every owner chat and routine with its own level, and every exclusion. The release is one server write that carries the digest of exactly these rows; the server recomputes it in the same transaction that lifts the hold. A different list refuses, nothing is shared, and dialog 3b shows the whole new list (AG0 addendum A4, IA v8 section 3.2).', 'new', slabel='Share a new app with the bots shown')) +
        dlg('3b. The list changed while you were signing in', 'Look again: HubSpot would now go to 5', f'<p>Nothing has been shared. HubSpot is still closed to every bot.</p><p>Would get it now (5):</p><ul class="who"><li><b>Tess</b>, set to Every app.</li><li><b>Pepper</b>, at No limits.</li><li>The chat <b>{F.NL_CHATS[0][1]}</b> with {F.NL_CHATS[0][0]}, set to No limits.</li><li><b>Nova</b>, new since you looked: set to Every app in another window.</li><li>The chat <b>Supplier call</b> with Juno, new since you looked: set to No limits.</li></ul><p>Would not get it: everyone else, as in the list before.</p>', B('Keep it closed for now') + B('Share with these 5', 'pri')) + '</div>')

def app_sheet(app='Gmail', acct=None):
    v = dict(F.APPS[app]); v['acct'] = acct or v['acct']; rows = f'<div class="line first">{chk(False, "Select every bot shown")} <span class="t"><b>Select all {N}</b></span></div>'
    tick = ('Juno', 'Atlas')
    for b in BOTS:
        n = b['n']; sv = F.app_saved(app, n)
        if n == 'Dax':
            _, eff, why, fix, href = F.dax_app(app); d = f'Works now: {eff}. {why} <a class="lnk" href="{href}">Fix: {fix}</a>'
        elif n in F.NOLIMITS: d = f'Works now, at No limits: Read and change. The saved level, {sv}, applies in a chat or routine you set to a lower level. <a class="lnk" href="bot-reach-nolimits.html#bot.reach.nolimits.covers">Which turns</a>'
        elif n in F.EVERY_APP and b['eng'] == 'Codex': d = 'Works now: Nothing. Codex needs you to sign in. Nothing saved: set to Every app. <a class="lnk" href="providers.html#providers.subs.chatgpt">Fix: Sign in to Codex</a>'
        elif n in F.EVERY_APP: d = 'Works now: Read and change. Nothing saved: set to Every app.'
        elif F.apps_state(n) == 'off':
            rows += line(f'{chk(False, "Select " + n)} {avr(b)} {n}', f'Works now: Nothing. Connected apps are off for {n}. Turning them on with nothing saved sets {n} to Every app. <a class="lnk" href="bot-tools.html#bot.tools.connectedapps">Fix: Turn on Connected apps for {n}</a>', pickd('Off for this bot', f'{n} may use {app}'))
            continue
        else: d = f'Works now: {sv}.'
        rows += line(f'{chk(n in tick, "Select " + n)} {avr(b)} {n}', d, pick('Every app' if (n in F.EVERY_APP) else sv, f'{n} may use {app}'))
    core._reg('apps.connected.bots', f'Which bots can use {app}')
    return sheet(app, f'{v["acct"]}. Signed in 3 Nov through FluxRouter.',
        f'<div id="apps.connected.bots" data-id="apps.connected.bots">' + lab('Which bots can use it', F.can_line(app)) +
        f'<div class="tbar">{inp(ph=FILTER, label="Filter bots")}{seg(["All", "Can use", "Cannot"], "All", "Show")}</div>' +
        selbar(2, N, pick('Read only', 'Access for the selected bots') + A('Apply', 'apps.connected.applyselected', 'sm pri',
               'A queue of single saves. For each ticked bot: change this one app and save with the revision its row was drawn from (set-account). There is no read just before the save: a fresh revision could belong to a choice made in another window after the row was shown. On a refusal Murage reads once and carries on only if the whole saved entry for this account (level and exact operations) and both switches still equal what the row showed. Otherwise the row reads Changed in another window with both values, and nothing is overwritten or retried (AG0 addendum A2).', 'new', slabel='Apply access to the selected bots (Connected apps)')) +
        scroll(sorthead('Access') + rows, 290, "Bots") + count(f'{N} bots. A picker saves that one bot at once. The bar above appears when you tick a bot.') + '</div>' +
        '<div class="cost"><b>Saved</b> is what you chose. <b>Works now</b> is what the bot can really do. Lowering access stops what that bot is doing right now, in every chat, except a chat running at No limits. Raising it interrupts nothing. ' + F.GUEST_APPS + '</div>' +
        lab('This account') + line('Sign in again', f'Use this if {app} stops working.', A('Sign in again', 'apps.connected.signin', 'sm', 'Shown as the primary action only when the app needs it.')) +
        rmzone(f'Removes {app} from Murage. {F.plural(F.app_count(app))} lose it at once. You can add it again later. To end access on Google\'s side too, remove Murage in your Google account.',
               A(f'Remove {app}', 'apps.connected.remove', 'dng', 'Confirmation lists the bots that lose it.')), sid='gmail')
gmail_sheet = app_sheet

# ---------------- Messaging ----------------
def messaging_body():
    return S('Messaging apps',
        R('Telegram', 'Chief answers. Only you can message it.', mk=('T',), id='messaging.telegram', st=('ok', 'Connected'), open='messaging.html#messaging.telegram', cls='is-open'),
        R('WhatsApp', 'Not set up.', mk=('W',), id='messaging.whatsapp', st=('', 'Not set up'), open=True),
        R('Slack', 'Not set up. To let a bot work inside Slack, see Connected apps.', mk=('S',), id='messaging.slack', st=('', 'Not set up'), open=True),
        R('Discord', 'Not set up.', mk=('D',), id='messaging.discord', st=('', 'Not set up'), open=True),
        R('Signal', 'Not set up.', mk=('S',), id='messaging.signal', st=('', 'Not set up'), open=True),
        scope='All bots', sub='Talk to your bots from the apps you already use', id='messaging.apps')

def telegram_sheet():
    return sheet('Telegram', 'Paired with @your_murage_bot since 2 Nov.',
        lab('Who answers') + line(f'{avr(BOTS[0])} Chief', 'Telegram always goes to your Chief of staff. To have another bot answer, make it Chief of staff in Bots, then pair again. <a class="lnk" href="bots.html#bots.table">Open Bots</a>',
                                  A('Pair again', 'messaging.telegram.retarget', 'sm', 'Ends this pairing, then pairs with the bot that is Chief now (server/index.ts:33590-33601). No other bot can be chosen. No silent fallback.', 'today', slabel='Pair Telegram again')) +
        '<div class="cost">Pairing again ends this pairing first. Replies still waiting to go out are cancelled. A reply that was being sent at that moment may or may not have arrived: Murage marks it Not confirmed and never sends it twice. Messages sent to Telegram while you pair are not answered: send them again after. If you have no Chief of staff, Telegram stays unpaired and this row says so.</div>' +
        lab('Who can message it') + line('Only you', '', pick('Only you', 'Who can message the bot')) + line('Send read receipts', '', swa(True, 'Send read receipts')) + line('Quote the message being answered', '', pick('Off', 'Quote')) +
        lab('Bot token') + f'<div class="line first">{inp("&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull; saved", label="Telegram bot token", cls="w")}{B("Save", "sm")}</div><p class="hint">Saves when you press Save. A new token keeps the pairing.</p>' +
        line('End the pairing now', 'Works at once. Telegram stops answering. Replies still waiting are cancelled, and one being sent at that moment is marked Not confirmed. The token stays, so you can pair again.', A('End pairing', 'messaging.telegram.revoke', 'sm dng', 'Immediate, its own route (server/index.ts:33611). revoke() cancels accepted and queued messages and marks one that is sending as uncertain (server/telegram-channel.ts:110-113).')) +
        rmzone('Ends the pairing and deletes the token and these settings from Murage. Your Telegram account is not touched.', A('Remove Telegram', 'messaging.remove', 'dng', 'One Remove zone per messaging app. Runs End pairing first, then clears the saved token.')), sid='tg')

# ---------------- Phone & remote access ----------------
DEV = F.DEVICES
def lu(l): return l if l == 'Connected now' else 'Last used ' + l[0].lower() + l[1:]
def phone_body(on_phone=False, cur_dev=None):
    if on_phone:
        gate = ban('You are on Pixel 9. Pairing, remote access and removing other devices are done on your computer.', 'off')
        calls = S('Calls', R('Calls today', 'On. Off stops rings until midnight, except a call you marked Emergency.', icon='call', on=True), R('Quiet hours', f'{F.OWNER["quiet"]}.', icon='bell', go=('General', 'general.html')),
                  R('Who may call you', 'Chief and Dax.', icon='bots', go=('Bots', 'bots.html')), scope='All bots')
        dev = S('Devices and browsers', *[R(n, f'{d.rstrip(".")}. {lu(l)}.', icon=i, tg=[('This phone',)] if n == 'Pixel 9' else None) for n, d, l, i in DEV], sub='To remove another device, use your computer')
        me = S('This phone', R('Sign out this device', 'Removes Pixel 9 from your computer. It needs a new code to come back.', icon='x', cls='why', act=B('Sign out this device', 'sm dng')), scope='Only here')
        ft = S('Phone features', R('Phone tools', 'Reminders, contacts, calendar, location. Change this on your computer.', icon='phone', tg=[('Preview',)], st=('', 'Off')))
        return gate + calls + dev + me + ft
    st = S('Phone access', R('Phone access', 'Lets your own paired devices reach Murage on this computer.', icon='phone', id='phone.access', on=True),
           R('At home', 'Devices on your Wi-Fi can connect. Wi-Fi pairing is on. That link is not encrypted: someone else on the same Wi-Fi could read what passes.', icon='home', st=('ok', 'Connected'), cls='why'),
           R('Away from home', 'Through Tailscale, a private link between your own devices. Never the public internet.', icon='globe', st=('ok', 'Connected')),
           scope='This computer', id='phone.status')
    rows = ''.join(R(n, f'{d.rstrip(".")}. {lu(l)}. Reaches all bots.', icon=i, id='phone.devices.' + n.split()[0].lower(), open='phone-device.html',
                     cls='is-open' if cur_dev == n else '') for n, d, l, i in DEV)
    dv = S('Devices and browsers', rows,
           f'<div class="paste">{A("Add a device", "phone.devices.add", "pri", "Opens pairing in place. Says why first when no route can work.", href="phone-device.html")}<span class="hint">3 of 20 devices</span></div>',
           R('Remove all devices', 'Removes all 3. Each needs a new code to come back. This computer and Phone access are not affected.', icon='x', cls='why',
             act=A('Remove all devices', 'phone.devices.signouteverywhere', 'sm dng', 'Confirmation lists the exact devices. Each goes through the full single-device removal. A device paired after you confirm is not touched. Phone access stays on.', 'new')),
           scope='This computer', id='phone.devices', sub='Most recently used first', more=['Pair over Wi-Fi by default', 'Activity by device'])
    aw = S('Away from home', R('Away from home', 'Your own signed-in devices can connect when they are not on your Wi-Fi. Never the public internet.', icon='globe', id='phone.away', on=True),
           R('Private address (Tailscale)', 'macbook.tail1234.ts.net', icon='link', act=A('Copy address', 'phone.away.copy', 'sm') + A('Check address', 'phone.away.check', 'sm', slabel='Check the private address again')),
           R('Keep this computer awake', 'While a phone is connected, so your bots stay reachable.', icon='power', id='phone.devices.keepawake', on=True),
           scope='This computer', id='phone.awaysec', more=['Network details', 'Tailscale setup guide'])
    calls = S('Calls', R('Calls today', 'On. Turn off and bots message you instead of ringing, until midnight. Then it turns itself back on. A call you marked Emergency still rings, also in quiet hours.', icon='call', id='phone.calls.today', on=True, cls='why'),
              R('Quiet hours', f'{F.OWNER["quiet"]}. A call you booked for a set time still rings then. So does an Emergency call.', icon='bell', ref='general.notifications.quiethours', go=('General', 'general.html#general.notifications.quiethours')),
              R('Who may call you', 'Chief and Dax. Set on each bot, under Voice & notifications.', icon='bots', go=('Bots', 'bots.html#bots.table')),
              R('Calls your bots make', 'Bots phone a business for you. Needs your own account with Vapi, a calling service you pay directly. Set up on this computer.', icon='call', id='phone.calls.botsmake', st=('', 'Not set up'), open='phone.html#phone.calls.botsmake', cls='why'),
              scope='All bots', id='phone.calls')
    ft = S('Phone features', R('Phone tools', 'Bots use reminders, contacts, calendar and location on your phone. You choose per bot.', icon='phone', id='phone.features.phonetools', tg=[('Preview',)], on=False),
           R('Share and ask', 'Share something from your phone to a bot.', icon='msg', id='phone.features.shareask', tg=[('Preview',)], on=False), scope='This computer', id='phone.features', sub='Preview: new, and may change')
    sc = S('Let other programs use a bot', R('Let other programs use a bot', 'Scripts and outside agents can message one bot you choose. Off. Turning it on opens the form to choose the bot.',
                                               icon='terminal', id='phone.scripts', on=False, cls='why'),
           scope='This computer', id='phone.scriptsec', more=['Which bot', 'May it send messages', "Switch off one program's access", 'Switch all off'])
    return st + dv + aw + calls + ft + sc

def device_sheet():
    return sheet('Pixel 9', 'Murage app 1.0.21 on Android 15. Added 2 Nov. Connected now.',
        lab('Name') + f'<div class="line first">{inp("Pixel 9", label="Your name for this device", cls="w")}</div><p class="hint">Saves when you leave the field. The phone cannot change it.</p>' +
        lab('What this device may do', 'Only Pixel 9') +
        line('<span id="dv1">Reach your bots</span>', 'Every paired device reaches all bots.', txt('Always')) +
        line('<span id="dv2">Control a bot\'s computer</span>', 'Full control, not just viewing.', sw(False, 'dv2')) +
        line('<span id="dv3">Share and ask</span>', 'Share from this phone to a bot.', sw(True, 'dv3')) +
        line('<span id="dv4">May give other programs access</span>', 'This device may set up and switch off access for other programs.', sw(False, 'dv4')) +
        line('Notifications', 'On, with previews. Set on the phone.', txt('On')) +
        lab('Where it is signed in') + line('Murage app', 'Last used now. Ends 2 Dec.') + line('Chrome on Android', 'Last used 4 days ago. Ends 20 Nov.') +
        rmzone('Signs Pixel 9 out at once, everywhere it is signed in. It needs a new code to come back.', A('Remove this device', 'phone.devices.remove', 'dng', 'One Remove zone, at the sheet foot. Rows carry no Remove button.')), 'phone', 'dev')

def phone_flows():
    return ('<div class="flow">' +
        dlg('Confirmation: remove one device', 'Remove Pixel 9?', '<p>It is signed out at once, everywhere it is signed in. It needs a new code to come back.</p><p>Access it set up for other programs is switched off too.</p>', B('Cancel') + B('Remove', 'red')) +
        dlg('Confirmation: remove all devices', 'Remove all 3 devices?', '<p>Pixel 9, iPhone and MacBook Air are each signed out at once and need a new code.</p><p>This computer is not affected, and Phone access stays on.</p>', B('Cancel') + B('Remove all 3', 'red')) +
        dlg('Result 1: removed, every step confirmed', 'Pixel 9 is removed', '<p>It is signed out and cannot connect. Its jobs and Share and ask are stopped, and its notifications are off.</p><p>Murage shows this only when each of those steps is confirmed.</p>', B('Done', 'pri')) +
        dlg('Result 2: nothing happened', 'iPhone: still signed in', '<p>Murage could not record the removal, so iPhone can still connect. Nothing was signed out for it.</p>', B('Close') + B('Try again', 'pri')) +
        dlg('Result 3: signed out, cleanup not finished', 'iPhone: removal pending', '<p>iPhone is signed out and cannot connect.</p><p>One step is not finished: <b>notifications</b> are not switched off yet. Done: signed out, jobs stopped, Share and ask stopped. Murage keeps trying, and tries again after a restart.</p><p>If you pair iPhone again before this finishes, it is treated as a new device.</p>',
            B('Close') + A('Retry now', 'phone.devices.retryremoval', 'pri', 'Targets this one device. The server already retries at 5 s, 15 s, 60 s, 300 s and after a restart (companion/src/control.ts:351, :422).', 'new')) +
        dlg('Result 4: it was already gone', 'MacBook Air was already removed', '<p>Another window removed it first. Nothing else changed.</p>', B('Done', 'pri')) +
        dlg('Result 5: no answer came back', 'iPhone: Murage did not hear back', '<p>The request was sent, but no answer came. iPhone may or may not be removed. Nothing is assumed.</p><p>Check again reads the removal record, which is kept after the device leaves the list and across a restart.</p>', B('Close') + B('Check again', 'pri')) +
        dlg('Result 6: signed out, notifications not confirmed yet', 'iPhone: removal pending', '<p>iPhone is signed out and cannot connect. Its jobs and Share and ask are stopped.</p><p>Switching off its <b>notifications</b> is queued and saved, but the notification service has not confirmed it yet. Murage shows Removed only after it does.</p>', B('Close') + B('Check again', 'pri')) +
        dlg('Pairing: Add a device', 'Add a device', f'<div class="pairbox"><span class="qrbox"><span class="qr" role="img" aria-label="Sample picture standing in for the pairing code"></span><small>Sample picture</small></span><span><span class="code">482 913</span><br><span class="hint">Or type macbook.tail1234.ts.net and the code. Expires at 14:32.</span></span></div>',
            A('Cancel pairing', 'phone.pairing.cancel', '', 'New button on a route that exists.') + A('New code', 'phone.pairing.newcode') + A('Copy sign-in link', 'phone.pairing.copylink', 'pri')) +
        dlg('Pairing cannot work yet', 'Your phone needs a route to this computer', '<p><b>Away from home</b> needs Tailscale with HTTPS (an encrypted link) turned on.</p><p><b>At home</b> you can pair over Wi-Fi. It works, but that link is not encrypted: someone else on the same Wi-Fi could read what passes.</p>', B('Pair over Wi-Fi anyway') + B('Set up Tailscale', 'pri')) +
        dlg('Confirmation: Phone access off', 'Turn Phone access off?', '<p>Devices stay paired but cannot connect until you turn this on again. Nothing is removed.</p>', B('Cancel') + B('Turn off', 'pri')) + '</div>')

# ---------------- Bots ----------------
def bots_body(n=N):
    if n == 0:
        t = S('Your bots', '<div class="empty"><b>No bots yet</b>A bot is one assistant with its own job, tools and memory.<br>' + A('Make a bot', 'bots.make', 'pri', 'Opens the new-bot flow in the main window.') + '</div>')
    elif n == 1:
        t = f'<section class="sec"><h3>Your bot</h3><div class="card">{bot_table(BOTS[:1], "bots", False)}</div></section>'
    else:
        sel = selbar(3, N + F.NA, pick('Set approval level', 'Approval level for the selected bots: Ask, Auto or Full access') + A('Apply', 'bots.selected.apply', 'sm pri',
                     'A queue of single saves, each through the shipped per-bot helper (src/lib/level-change.ts:57-67, :87-90): previewLevel for that bot, then one PATCH with settingsScope defaults, that bot\'s previewId and ifRev (server/index.ts:35685-35690), and the acknowledgements levelAcks returns: acknowledgeFullAccess on a first raise to Full access (server/full-access.ts:87-95) and acknowledgeLocalAuto when a bot that uses this computer leaves Ask (server/index.ts:35933-35955). Lowering to Ask saves at once. Auto and Full access first show one review that lists what changes for each ticked bot; a bot that changed since the review is refused and reported. No limits is never offered here: it is set on one bot, with its own confirmation.', 'new', slabel='Apply to the selected bots (Bots)') +
                     A('Archive', 'bots.selected.archive', 'sm', 'v9 (Astra r8 H4a): first one review that lists, for each ticked bot, the saved app choices it loses (see the flow below). Then one bot at a time, each reported, each PATCH carrying the access revision the review showed (TASKS SV0, B2). A bot whose choices changed since is not archived: its row reads Changed since the review, with Review again.', 'new', slabel='Archive the selected bots'))
        t = (f'<section class="sec" id="bots.table"><h3>Your bots<small>{N} bots. {F.NA} archived.</small></h3><div class="card">'
             + tbar(extra=seg([f'All {N + F.NA}', f'Active {N}', f'Archived {F.NA}'], f'All {N + F.NA}', 'Show') + A('Make a bot', 'bots.make', 'pri sm', 'Opens the new-bot flow in the main window.')) + sel
             + scroll(bot_table(BOTS, 'bots', True, 'Every bot is in this list. A name opens that bot. Go to a page opens any of its 12 settings pages.', ticked=('Atlas', 'Nova', 'Kit')), 430, 'Bots')
             + count(f'{N} bots, then {F.NA} archived. Scroll for more. Faster: type a name in the finder on Overview.') + '</div></section>')
    who = 'No bots follow it yet.' if n == 0 else ('Chief has its own level.' if n == 1 else f'{", ".join(F.FOLLOW)} and {F.FOLLOW_ROUTINES} routines. They keep the level they were made with when you change the level above. One exception: if you choose No limits above, or set your Chief of staff to No limits, they run at No limits right away.')
    new = S('New bots start with',
            R('Approval level', f'{F.NEW_LEVEL}. For bots you make from now on. Bots you already have keep their level.', icon='shield', id='bots.new.level', val=F.NEW_LEVEL),
            R('Bots with no level set by you', who, icon='bots', cls='why', id='bots.new.level.followers'),
            R('Thinking effort', 'Higher is slower and more careful.', icon='model', id='bots.new.effort', val='Medium'),
            R('Computer', '', icon='computer', id='bots.new.computer', val='Virtual computer'),
            scope='All bots', id='bots.new', more=['Starter profiles'], sub='For bots you make from now on')
    return t + new

def own_bots():
    return [b for b in BOTS if b['n'] not in F.NOLIMITS and not b['follows']]
def own_bots_li():
    """v9 (Astra r8 H3a): every bot whose own level is cleared is named, grouped by its level. No "and N more": the owner sees each choice that is cleared."""
    ob = own_bots(); assert len(ob) == 34, len(ob)
    g = ''.join(f'<br>At {lv} ({len(ns)}): {", ".join(ns)}.' for lv in ('Ask', 'Auto', 'Full access') for ns in [[b['n'] for b in ob if b['lvl'] == lv]] if ns)
    return f'<li data-plan="bots"><b>{len(ob)} bots</b>. Each one\'s own level is cleared.{g}</li>'
def plan_routines_li():
    rs = F.MOVE_ROUTINES
    li = ''.join(f'<br>{r} ({b}), at {lv}.{" " + note if note else ""}' for r, b, lv, note in rs)
    return f'<li data-plan="routines"><b>{len(rs)} routines</b>. Each one\'s own level is cleared.{li}</li>'
def plan_chats_li():
    cs = F.MOVE_CHATS; mine = [c for c in cs if not c[3]]
    li = ''.join(f'<br>{c} ({b}), at {lv}{", a chat a guest started: it still never runs at No limits" if g else ""}.' for c, b, lv, g in cs)
    return f'<li data-plan="chats"><b>{len(cs)} chats</b>: {len(mine)} of yours and {len(cs) - len(mine)} with a guest. Each one\'s own level is cleared.{li}</li>'
def bulk_archive_li(ticked=('Atlas', 'Nova', 'Kit')):
    li = ''
    for n in ticked:
        a = [x for x, v in F.APPS.items() if n in v['saved']]
        li += f'<li><b>{n}</b>: ' + (f'its saved app choices are not kept: {", ".join(x + " (" + F.APPS[x]["saved"][n] + ")" for x in a)}. It comes back set to Only chosen apps with no apps.</li>' if a else 'nothing saved, nothing lost.</li>')
    return li

def bots_flow():
    gone = F.level_diff('Auto', 'Full access'); still = [r for r in F.level_still('Full access') if 'wipe' not in r]
    low = lambda t: t[0].lower() + t[1:]
    return ('<div class="flow">' + dlg('Only when you choose No limits above', 'Move every bot to No limits?',
        '<p>Everything that has a level of its own, and what moving it clears. Pepper is already at No limits.</p><ul class="who">'
        + own_bots_li() +
        '<li><b>2 archived bots</b>: Old Dax at Ask, Trial bot at Auto. Cleared too, so they follow No limits if you bring them back.</li>'
        + plan_routines_li() + plan_chats_li() + '</ul>'
        '<p>If anything on this list changes while this question is open, or something gets a level of its own, nothing is moved and Murage shows you the new list.</p>',
        B('Leave them as they are') + A('Move all to No limits', 'bots.new.level.apply', 'red', 'The shipped action. It runs only while the level above is No limits (POST /api/permissions/no-limits, server/index.ts:39390-39398). Today it clears every roster entry and every chat (server/store.ts:5097-5100) and every routine, pending approval included (server/routines.ts:2437-2440), while the status that feeds the list leaves out archived and inert bots and chats that are not the owner\'s (server/index.ts:5920-5930). v8 (Astra r7 H3): G1 builds one plan, the exact rows and fields it will clear, archived bots and other chats included; this list is drawn from that plan and the POST carries its digest. The server rebuilds the plan and refuses a different one, then applies routines and bots as one unit (TASKS G1).')) +
        dlg('If saving fails before the move commits', 'Nothing was moved', '<p>Murage restored the previous levels for the 6 routines. Every bot, routine and chat keeps its previous level.</p><p>While Murage is checking the outcome or restoring those levels, the move shows as Pending.</p>', B('Close') + B('Try again', 'pri')) +
        dlg('Bots list: Archive several bots', 'Archive 3 bots?', '<p>They are hidden from the sidebar and their routines stop. Chats, memory, skills and files are kept, and you can bring them back from Bots.</p><ul class="who">' + bulk_archive_li() + '</ul><p>Each bot is archived by itself. A bot whose app choices changed since this review is not archived, and Murage says which.</p>', B('Cancel') + B('Archive 3 bots', 'pri')) +
        dlg('Bots list: Full access for several bots', 'Review before Full access', f'<p>At Full access, <b>Atlas</b> (now {F.B("Atlas")["lvl"]}) and <b>Nova</b> (now {F.B("Nova")["lvl"]}) no longer ask before: {low(gone[0])}; or contacting another bot.</p>'
            f'<p>They still ask before: {"; ".join(low(x) for x in still)}. A command that could wipe this computer always asks.</p><p>Kit is already set to Full access, so nothing changes for it.</p>'
            '<p>Each bot is saved by itself, with its own review. A bot that changed since this review is not saved: its row reads Changed since the review, with Review again.</p>', B('Cancel') + B('Apply to 2 bots', 'pri')) +
        dlg('Bots list: Auto for a bot that uses this computer', 'Review before Auto', '<p><b>Bram</b> uses this Mac. At Auto it clicks and types here without asking first.</p><p>Rhea does not use this computer, so it is saved without this question.</p>', B('Leave Bram at Ask') + B('Set Bram to Auto', 'pri')) + '</div>')

# ---------------- Memory ----------------
ABOUT = [('You are in Miami and start work at 08:00.', 'Fact. Chief. 4 Nov.'), ('You prefer short replies.', 'How you like things. Dax. 12 Nov.'),
         ('Your accountant is Rosa at Ledgerly.', 'Fact. Dax. 6 Nov.'), ('You do not take calls on Fridays.', 'Fact. Shared with a team. The bot it came from was not recorded. 1 Nov.')]
def memory_body(open_about=False):
    m = S('Memory', R('Memory', 'On: bots save and use what they know. Save only: they save but do not use it. Paused: nothing is saved or used.', icon='memory', id='memory.memory.mode', val='On', cls='why'),
          R('Everything your bots remember', f'{F.OWNER["memories_all"]} memories, across every bot. See, correct, archive or forget any one.', icon='user', id='memory.aboutyou', open='memory-about.html', cls='is-open' if open_about else ''),
          scope='All bots', id='memory.memory')
    l = S('How it learns', R('Learn while you chat', '', icon='memory', id='memory.learn.live', on=True), R('Review before using', 'New memories wait for your yes.', icon='check', id='memory.learn.review', on=False),
          scope='All bots', more=['Learn from chats', 'Learn from channels', 'Learn facts', 'Learn how you like things done'])
    rows = f'<div class="line first">{chk(False, "Select every bot shown")} <span class="t"><b>Select all {N}</b></span></div>' + ''.join(
        line(f'{chk(False, "Select " + b["n"])} {avr(b)} {b["n"]}', 'Memory on. Learning on.' + (f' {F.DAX["memories"]} memories.' if b['n'] == 'Dax' else ''),
             f'<a class="lnk" href="bot-memory.html#bot.memory.managed" data-ref="bot.memory.managed">Memory &amp; learning</a>') for b in BOTS)
    each = S('Each bot', f'<div class="tbar">{inp(ph=FILTER, label="Filter bots")}</div>' + scroll(rows, 240, 'Bots') + count(f'{N} bots. Tick bots to turn Memory on or off for several.'),
             sub='A bot\'s own memory switch is on the bot', id='memory.eachbot')
    rest = S('People, connection and health', R('Learning limits', 'How much the memory system may read and write.', icon='usage', ref='usage.learning', go=('Usage & spend', 'usage.html#usage.learning')),
             R('Undo the last thing learned', 'Removes the newest memory.', icon='undo', act=A('Undo', 'memory.learn.undo', 'sm', 'The shipped learned-memory Undo, kept.', slabel='Undo the last thing learned')),
             scope='All bots', more=['The same person on two apps', 'Who a memory may be shared with', 'Learning connection', 'Use FluxRouter memory', 'Conversations left out', 'Stop tracking a notebook import'])
    return m + l + each + rest
def about_sheet():
    import pages_bot as PB
    core._reg('memory.aboutyou.items', 'Every memory')
    return sheet('Everything your bots remember', 'Every memory in Murage, from every bot. Filter by bot. A memory can belong to one bot, a chat, a team, or be shared. What you wrote yourself is About you, in General.',
                 PB.memlist('Your bots', ABOUT, F.OWNER['memories_all'], 'memory.aboutyou') +
                 line('About you', 'The note you wrote for every bot.', '<a class="lnk" href="general.html#general.you.aboutme" data-ref="general.you.aboutme">General</a>'), 'user', 'abt')

# ---------------- Backups & storage ----------------
BK = F.BACKUP
def backups_body(opened=''):
    b = S('Backups',
          R('Back up now', f'Last backup: {BK["last"]}, {BK["size"]}, in your backup folder and off-site. Murage closes and reopens this window to take it.', icon='backup', cls='why',
            act=A('Back up now', 'backups.backupnow', 'pri sm', 'backup-schedule:run-now (electron/main.mjs:993). Progress in the row, then the time.')),
          R('Daily backups', f'Every day at 02:00, {F.OWNER["zone"].split(" ")[0]} time.', icon='clock', id='backups.schedule', on=True, open=True),
          R('Back up while Murage is closed', '', icon='power', id='backups.whileclosed', on=True),
          R('Backup folder', BK['folder'] + '.', icon='folder', id='backups.folder', open=True),
          R('Off-site copy', 'A second copy on storage you rent (any S3-compatible service). Uploads after each backup. Open to download a copy.', icon='globe', id='backups.offsite', st=('ok', 'On'), open=True, cls='why'),
          scope='This computer', id='backups.backups', more=['Copies to keep', 'Late start allowed (hours)', 'Largest backup (GiB)', 'Shortest time allowed (minutes)', 'Back up before installing an update'])
    k = S('Recovery key', R('Recovery key', f'Made {BK["key_made"]}. Every backup is locked with it. You need it to restore, and Murage cannot bring it back if it is lost.', icon='key', id='backups.key', cls='why',
                           act=A('Save a copy', 'backups.key.savecopy', 'sm', 'backup-mode:save-recovery-key-copy (electron/main.mjs:981). Shipped label: Save a copy (BackupSettings.tsx:329).', slabel='Save a copy of the recovery key')),
          scope='This computer', id='backups.keysec', sub='Keep a copy somewhere that is not this computer')
    r = S('Restore and export',
          R('Restore from a backup', 'Opens Backup mode. Restores into a new copy of Murage. After you approve it, AI engines and routines stay off until you turn each one on. Your current data is kept. You sign in to engines and messaging apps again afterwards.', icon='restore', id='backups.restore', open='backups-restore.html', cls='why' + (' is-open' if opened == 'restore' else '')),
          R('Export a backup file', 'One encrypted file, saved where you choose. Made in Backup mode. Use it to move to a new computer.', icon='dl', id='backups.export', open='backups-export.html', cls='is-open' if opened == 'export' else ''),
          scope='This computer', id='backups.restoresec')
    d = S('Where your data lives', R('Data folder', '/Users/you/Library/Application Support/Murage. 4.2 GB.', icon='folder', id='backups.datafolder', open=True,
                                    end=A('Show in Finder', 'backups.showfolder', 'sm')), scope='This computer', id='backups.data')
    return b + k + r + d

def restore_sheet():
    def stp(n, t, d=''): return line(f'<b>{n}.</b> {t}', d)
    return sheet('Restore from a backup', 'Restoring happens in Backup mode, a separate recovery screen.',
        lab('What happens') + stp(1, 'Murage closes this window and opens Backup mode.', 'Finish current work first. Bots stop while Backup mode is open.') +
        stp(2, 'You press Choose backup to restore, then pick the backup file and your recovery key.', 'The file ends in .age. Murage checks the backup before anything is written.') +
        stp(3, 'You press Restore this backup. It goes into a new copy of Murage, in a new folder.', 'Your current data stays as it is. Only what is in the backup comes back; anything newer is not copied.') +
        stp(4, 'Murage restarts. You press Review restored installation, then Approve and open.', 'Murage shows what comes back switched off. If anything changes after you review it, you review it again.') +
        stp(5, 'The restored copy opens with AI engines and schedules off.', 'Every engine is switched off and every routine is off. Turn on the engines you want in Engines, and each routine you want in its bot\'s Routines. Connect your phone and messaging apps again. No unfinished work restarts.') +
        lab('What a backup holds') + line('Your settings, bots, conversations, files and channel history', '') +
        line('Not in a backup', 'Sign-ins to AI engines and messaging apps, the local virtual computer, and folders outside Murage. You sign in and connect again after a restore.') +
        lab('You will need') + line('Your recovery key', f'Made {BK["key_made"]}. Without it a backup cannot be opened.', '<a class="lnk" href="backups.html#backups.key" data-ref="backups.key">Recovery key</a>') +
        f'<div class="sfoot">{B("Cancel")}{A("Restart into Backup mode", "backups.restore.go", "pri", "backup-mode:restart (electron/main.mjs:921). Shipped button and words: BackupSettings.tsx:54, :58, :71; the recovery screen: electron/recovery/index.html:23-25, :58-71; after Approve and open: electron/installation-recovery-window.mjs:86. No list of backups and no restore inside Settings.")}</div>', 'restore', 'rst')

def restore_flows():
    ghost('backups.key.move', 'Move the recovery key out of the synced folder', 'backups.html', 'backup-mode:move-recovery-key (electron/main.mjs:978). Shipped label: Move (BackupSettings.tsx:304).')
    ghost('backups.key.keep', 'Keep the recovery key where it is', 'backups.html', 'backup-mode:keep-recovery-key (electron/main.mjs:979). Shipped label: Keep here (BackupSettings.tsx:305).')
    ghost('backups.interrupted.clear', 'Clear an interrupted backup and try again', 'backups.html', 'backup-schedule:clear-review (electron/main.mjs:994). Shipped label: Clear and try again (BackupSettings.tsx:560).')
    ghost('backups.setup', 'Set up backups: choose backup folder and recovery key', 'backups.html', 'backup-schedule:select and :set-up (electron/main.mjs:986, :988). Set-up makes the recovery key (BackupSettings.tsx:358, :370).')
    ghost('backups.setup.havekey', 'Use a recovery key you have', 'backups.html', 'BackupSettings.tsx:373. Shipped label: I already have a recovery key.')
    ghost('backups.offsite.download', 'Download an off-site copy', 'backups.html', 'backup-remote downloadBackup (electron/preload.cjs:203), progress backup-remote:download-phase (electron/main.mjs:5450). In the Off-site copy sheet.')
    ghost('backups.offsite.trust', 'Trust this off-site server', 'backups.html', 'In the Off-site copy sheet. Shows the server fingerprint first; shipped label Trust this server (BackupRemoteSettings.tsx:248-250).')
    ghost('backups.offsite.removepreviewed', 'Remove previewed off-site copies', 'backups.html', 'In the Off-site copy sheet, only after a preview and your consent; shipped label Remove previewed copies (BackupRemoteSettings.tsx:303).')
    ghost('backups.offsite.markreviewed', 'Mark an off-site removal as reviewed', 'backups.html', 'In the Off-site copy sheet, the recovery state after a removal that did not finish; shipped label Mark removal reviewed (BackupRemoteSettings.tsx:354-365).')
    return ('<div class="flow">' +
        dlg('State: backups not set up yet', 'Set up backups', '<p>Choose a backup folder. Murage makes your recovery key for you and asks you to save a copy.</p>', B('Use a recovery key you have') + B('Choose backup folder and recovery key', 'pri')) +
        dlg('State: the key sits in a synced folder', 'Your recovery key is in a cloud-synced folder', '<p>Anyone who can open that folder could open your backups. Move it somewhere private, or keep it there if that is what you want.</p>', B('Keep here') + B('Move', 'pri')) +
        dlg('State: a backup was interrupted', 'The last backup did not finish', '<p>Nothing was lost. Clear what it left behind and run it again.</p>', B('Clear and try again', 'pri')) +
        dlg('In Backup mode (the shipped recovery screen, not redrawn)', 'Backup mode', '<p>Restore an encrypted backup into a new copy of Murage, or make a one-off backup file. You pick the file and the recovery key. Murage shows the backup\'s name and where the new copy will live before you confirm.</p>', B('Choose backup to restore', 'pri') + B('Make a backup now') + B('Leave Backup mode')) +
        dlg('After a restore (the shipped recovery screen, not redrawn)', 'Review the restored copy', '<p>Murage checks the restored copy and shows what comes back switched off. If anything changes after you review it, you review it again.</p><p>AI engines and schedules stay off until you turn them on: each engine in Engines, each routine on its bot. Connect your phone and messaging apps again when you are ready. Your earlier data is still in its own folder.</p>', B('Review restored installation') + B('Approve and open', 'pri')) + '</div>')

def export_sheet():
    def stp(n, t, d=''): return line(f'<b>{n}.</b> {t}', d)
    return sheet('Export a backup file', 'One encrypted file you can carry to another computer. It is made in Backup mode.',
        lab('What happens') + stp(1, 'Murage closes this window and opens Backup mode.', 'Finish current work first. Bots stop while Backup mode is open.') +
        stp(2, 'You press Make a backup now and choose where to save the file.', 'A USB drive or another disk is a good place.') +
        stp(3, 'Murage writes one encrypted file.', f'About {BK["size"]}. Your current data is not changed.') +
        stp(4, 'You leave Backup mode and Murage opens again.', '') +
        lab('What you get') + line('A full backup of Murage on this computer', 'Settings, bots, conversations, files and channel history. Not sign-ins to engines or messaging apps.') +
        line('Locked with your recovery key', 'Only Murage can open the file, and only with that key. It is not a readable copy of your chats.') +
        lab('You will need') + line('Your recovery key', f'Made {BK["key_made"]}. Keep it somewhere else, not beside the file.', '<a class="lnk" href="backups.html#backups.key" data-ref="backups.key">Recovery key</a>') +
        '<p class="hint">Murage cannot make this file while it is running yet.</p>' +
        f'<div class="sfoot">{B("Cancel")}{A("Restart into Backup mode", "backups.export.go", "pri", "Uses the shipped Backup mode action Make a backup now (backup-encrypted: electron/recovery/index.html:25; electron/installation-recovery-controller.mjs:44-46, the host asks for the destination). The in-app export route of v5 (EX1) is withdrawn until its design is agreed (TASKS PK4).", "today", slabel="Export a backup file in Backup mode")}</div>', 'dl', 'exp')

def export_flows():
    return ('<div class="flow">' +
        dlg('In Backup mode (the shipped recovery screen, not redrawn)', 'Make a backup now', '<p>You choose where to save one encrypted file. Murage writes it and says when it is done.</p><p>Keep your recovery key somewhere else, not beside this file.</p>', B('Leave Backup mode')) +
        dlg('State: no recovery key yet', 'Set up backups first', '<p>A backup file is locked with your recovery key. Murage makes the key when you set up backups.</p>', B('Cancel') + B('Set up backups', 'pri')) + '</div>')

# ---------------- kept from v4, with v5 copy and fixture values ----------------
def overview_aside():
    return helpc('What this page is', 'A summary. Nothing is set here. Each row takes you to the one place a thing is set.',
                 link=('How Settings is laid out', 'overview')) + \
           helpc('Looking for one setting?', 'Press <kbd>&#8984;K</kbd> anywhere in Murage and type what you want, in your own words.', tip=True)

def providers_body(store=False):
    credit = '' if store else A('Add credit', 'providers.fluxrouter.addcredit', 'sm', 'Not created, drawn or indexed in Store builds.')
    flux = ('<section class="sec" id="providers.fluxrouter" data-id="providers.fluxrouter"><h3>FluxRouter<small>One sign-in for models, images, voice, search and connected apps</small><span class="sc">All bots</span></h3>'
            f'<div class="card hero"><div><h4>FluxRouter {pill("by","By Murage")}</h4><p>Murage&rsquo;s own pay-as-you-go service. Signed in as you@example.com. Balance: see Usage &amp; spend.</p></div>{pill("ok","Signed in")}'
            f'<div class="acts">{credit}{A("Sign out", "providers.fluxrouter.signout", "sm", slabel="Sign out of FluxRouter", note= "Confirmation names what stops working: connected apps, bot email, FluxRouter models.")}<span>Powers Fuigo, connected apps and bot email.</span>{lnk("Usage & spend", "usage.html")}</div></div></section>')
    subs = S('AI plans you already pay for',
             R('Claude plan', f'Signed in. Claude Code is ready. {F.ENGINE_COUNT["Claude Code"]} bots use it.', mk=('C',), id='providers.subs.claude', st=('ok', 'Signed in'), open=True),
             R('ChatGPT plan', 'Not signed in. Codex signs in with this. ' + F.CODEX['line'], mk=('G',), id='providers.subs.chatgpt', st=('warn', 'Needs sign-in'), cls='why',
               act=A('Sign in to ChatGPT', 'providers.subs.signin', 'sm pri', 'One action for every plan row. Opens the maker\'s own sign-in. The row reads what the Codex CLI itself reports (server/drivers/codex.ts:469-474, :3330-3343): signed in with a ChatGPT plan; signed in with an API key given to Codex, billed per use by OpenAI; not signed in; or could not check. The four are drawn in states.html.')),
             R('SuperGrok plan', 'Not set up. Add it when you want Grok Build.', mk=('X',), id='providers.subs.grok', st=('', 'Not set up'), open=True),
             scope='All bots', id='providers.subs', more=['Add another Claude account', 'Account name', 'Where the plan keeps its sign-in (folder)'])
    keys = S('API keys',
             f'<div class="paste" id="providers.keys.add">{inp(ph="Paste an API key", label="Paste an API key. Murage works out whose it is.", cls="w")}{A("Add", "providers.keys.add.go", "pri", "If Murage cannot tell whose key it is, the row asks: Which service is this key for?")}</div>',
             R('OpenAI key', 'Models, images, voice, dictation. It does not sign Codex in.', icon='key', id='providers.keys.openai', st=('ok', 'Working'), open=True),
             R('ElevenLabs key', 'Voice for every bot.', icon='key', id='providers.keys.tts', st=('ok', 'Working'), open=True),
             R('Tavily key', 'Web search. The service refused this key on 18 Nov. No bot uses it.', icon='key', id='providers.keys.tavily', st=('', 'Not in use'), open='providers.html#providers.keys.tavily'),
             scope='All bots', id='providers.keys', more=['OpenCode provider key', 'Older xAI key', 'Older OpenAI image key', 'Older OpenAI-compatible key'])
    local = S('On this computer', R('No model server found', 'Ollama, LM Studio or any OpenAI-compatible server.', icon='computer', id='providers.local', st=('', 'Not set up'),
                                    act=A('Add a model server', 'providers.local.add', 'sm', 'Opens the form in place: address, name, type, optional key.')), scope='This computer')
    retired = S('No longer used', R('Old connected-apps key', 'Murage stopped using this in 1.0.20. Removing it changes nothing.', icon='key', id='providers.retired.composio', open=True),
                R('Old HighLevel token', 'HighLevel now connects through Connected apps or its own MCP server.', icon='key', id='providers.retired.highlevel', open=True),
                sub='Safe to remove. Each row opens with Remove at the foot.')
    return flux + subs + keys + local + retired

def providers_phone(store=True):
    """Providers on a phone: readouts and where to change them. No key entry, no model server form. Add credit only outside a Store app (Visual QA H03, Astra r5 11)."""
    gate = ban('Keys, plans and model servers are added and changed on your computer. Here you can see what is set up.', 'off')
    credit = '' if store else R('Add credit', 'Opens FluxRouter in this browser.', icon='usage', go=('Add credit', '#'))
    flux = S('FluxRouter', R('FluxRouter', 'Signed in as you@example.com. Powers Fuigo, connected apps and bot email.', icon='prov', st=('ok', 'Signed in'), tg=[('By Murage',)]), credit, scope='All bots')
    subs = S('AI plans you already pay for', R('Claude plan', f'Claude Code is ready. {F.ENGINE_COUNT["Claude Code"]} bots use it.', mk=('C',), st=('ok', 'Signed in')),
             R('ChatGPT plan', f'Codex is not signed in. {F.ENGINE_COUNT["Codex"]} bots are waiting. Sign in on your computer.', mk=('G',), st=('warn', 'Needs sign-in'), cls='why'),
             R('SuperGrok plan', 'Add it on your computer when you want Grok Build.', mk=('X',), st=('', 'Not set up')), scope='All bots')
    keys = S('API keys', R('OpenAI key', 'Models, images, voice, dictation. It does not sign Codex in.', icon='key', st=('ok', 'Working')), R('ElevenLabs key', 'Voice for every bot.', icon='key', st=('ok', 'Working')),
             R('Tavily key', 'Web search. The service refused this key on 18 Nov. No bot uses it.', icon='key', st=('', 'Not in use'), cls='why'), scope='All bots', sub='Added and removed on your computer')
    return gate + flux + subs + keys

def key_sheet():
    return sheet('Tavily key', 'Added 3 Nov. Used for web search when you choose Tavily.',
        ban('The service refused this key on 18 Nov: &ldquo;invalid key&rdquo;. No bot uses this key.', 'off', A('Check this key', 'providers.keys.check', 'sm', slabel='Check this key again', note= 'Runs one test call. Shows the maker\'s own reason.')) +
        lab('Name') + f'<div class="line first">{inp("Tavily", label="Name for this key", cls="w")}</div><p class="hint">Saves when you leave the field.</p>' +
        lab('Lights up') + line('Web search', "Not chosen. Web search uses the engine's own search first.", lnk('Web search', 'tools-websearch.html')) +
        rmzone('Removing the key cannot be undone. No bot uses it, so nothing stops working.', A('Remove key', 'providers.keys.remove', 'dng', 'Confirmation names every tool and bot that would stop. One Remove zone, at the sheet foot.')), 'key')

def engines_body():
    return S('Engines',
        R('Fuigo', f'Using FluxRouter. {F.ENGINE_COUNT["Fuigo"]} bots.', mk=('F', 1), id='engines.fuigo', tg=[('By Murage',)], on=True, go=None, end=lnk(f'{F.ENGINE_COUNT["Fuigo"]} bots', 'bots.html#bots.table')),
        R('Claude Code', f'Using your Claude plan. {F.ENGINE_COUNT["Claude Code"]} bots.', mk=('C',), id='engines.claudecode', on=True, end=lnk(f'{F.ENGINE_COUNT["Claude Code"]} bots', 'bots.html#bots.table')),
        R('Codex', rawdesc=f'Not signed in. {F.CODEX["line"]} <a class="lnk" href="models.html#models.table">{F.ENGINE_COUNT["Codex"]} bots</a> are waiting.', mk=('X',), id='engines.codex', st=('warn', 'Needs sign-in'), cls='why',
          go=('Sign in to Codex', 'providers.html#providers.subs.chatgpt')),
        R('Grok Build', 'Not installed.', mk=('G',), id='engines.grok', st=('', 'Not installed'), act=A('Install', 'engines.install', 'sm', 'The existing install flow. Store builds: no link to a paid page.')),
        R('OpenCode', 'Off. Turn it on to offer it to bots.', mk=('O',), id='engines.opencode', on=False),
        scope='This computer', sub='What runs your bots',
        more=['Engine location', 'Use a copy you choose', 'Reset engine location', 'Show or hide an engine'])

def usage_body(store=False, out=False):
    add = '' if store else lnk('Add credit', 'providers.html#providers.fluxrouter')
    top = S('This month', R('FluxRouter credit used', 'Models, images, voice, search and connected apps that run through FluxRouter.', icon='usage', st=('t', F.SPEND['flux'])),
            R('Your own keys', 'OpenAI about $9, ElevenLabs about $3, Tavily $0. What Murage counted, not their bill.', icon='key', st=('t', F.SPEND['keys'])),
            R('Your plans', 'Claude plan. A flat price from Anthropic. Murage cannot see it.', icon='user', st=('t', 'Not counted')), scope='All bots', id='usage.month')
    lim = S('Spend limit', R('Monthly spend limit', 'Covers FluxRouter credit only. Your own keys and plans are billed by their makers.', icon='shield', id='usage.limit.monthly',
                              end=inp('$100', label='Monthly spend limit in dollars') ),
            R('At the limit', 'Bots that use FluxRouter pause and ask you. Bots on your own keys and plans keep working.', icon='info'),
            R('Heads-up before the limit', 'Shown on Today, in the month card.', icon='bell', ref='today.month.headsup', go=('Today', '#')),
            scope='All bots', id='usage.limit', post=(ban('FluxRouter balance: ' + ('$0.00' if out else '$58.80') + '. Checked a minute ago.', 'off', A('Check balance', 'usage.balance.check', 'sm', 'Never shows a guessed balance. When the check fails the line reads Could not check, drawn in states.html.', slabel='Check the FluxRouter balance again') + add)))
    brow = ''.join(R(n, F.model_prose(F.B(n)), av=F.B(n)['av'], st=('t', f'${a:.2f}'), go=('Activity', 'bot-activity.html')) for n, a in F.SPEND['by_bot'])   # v7: highest first, and the 39 amounts add up to the total (Walk r6 H3a)
    by = S('Where it went', f'<div class="tbar">{seg(["By bot", "By tool"], "By bot", "Group spend")}{inp(ph=FILTER, label="Filter bots")}</div>' + scroll(brow, 250, 'Spend by bot') + count(f'{N} bots, highest first. Total {F.SPEND["flux"]}.'),
           sub='FluxRouter credit this month. By tool shows Models, Images, Voice and Web search.', id='usage.by')
    learn = S('Learning limits', scope='All bots', sub='How much memory work Murage may do each month',
              more=['Learning read limit (millions of tokens)', 'Learning write limit (millions of tokens)'], id='usage.learning')
    return top + lim + by + learn

CAT = [  # (title, desc, icon, id, kind, extra)
 ('Built in', [
  ('Web search', f"Murage's web search. Searching with: the engine's own search first. {F.TOOL_BOTS['Web search']} of {N} bots.", 'globe', 'tools.websearch', 'sw', 'tools-websearch.html'),
  ('Read web pages', 'Murage opens a link and reads the page. 39 of 39 bots.', 'doc', 'tools.webread.enabled', 'sw', True),
  ('Images', 'Makes pictures. Paid per image through FluxRouter. 12 of 39 bots.', 'image', 'tools.images.enabled', 'sw', 'tools-images.html'),
  ('Voice notes', 'Bots send spoken replies. Voice service: ElevenLabs. 39 of 39 bots.', 'voice', 'tools.voice', 'sw', True),
  ('Browser', 'A built-in browser bots can drive. 9 of 39 bots.', 'window', 'tools.browser', 'go', ('Computer & browser', 'computer.html#computer.browser.builtin')),
  ('Computer', 'A bot clicks and types on a computer. 4 of 39 bots.', 'computer', 'tools.computer', 'go', ('Computer & browser', 'computer.html#computer.computers')),
  ('Files and shell', 'The engine\'s own file and command tools. Limited by each bot\'s working folder and approvals.', 'terminal', 'tools.files', 'always', None),
  ('Memory', 'Bots remember what you tell them. 39 of 39 bots.', 'memory', 'tools.memory', 'go', ('Memory', 'memory.html#memory.memory.mode')),
  ('Past chats', 'Bots look things up in earlier conversations. Turn it off per bot.', 'history', 'tools.pastchats', 'perbot', None),
  ('Routines', 'Bots run on a schedule. Each new routine needs your yes. Turn it off per bot.', 'clock', 'tools.routines', 'perbot', None),
  ('Talk to other bots', 'Hand work to another bot.', 'team', 'tools.delegation', 'always', None),
  ('Skills', f'Saved know-how a bot can follow. {F.SK["all"]:,} in the library; you turn them on per bot.', 'skills', 'tools.skills', 'go', ('Skills', 'skills.html')),
  ('Publish a site', 'Always asks you first.', 'globe', 'tools.publish', 'always', None),
  ('Projects and channels', 'Shared work and shared rooms.', 'rules', 'tools.projects', 'go', ('Rules for every bot', 'rules.html#rules.projects')),
 ]),
 ('Uses something of yours', [
  ('Connected apps', F.APPS_LINE, 'link', 'tools.connectedapps', 'go', ('Connected apps', 'apps.html#apps.connected')),
  ('Bot email', 'Each bot can have its own address. On.', 'mail', 'tools.botemail', 'go', ('Connected apps', 'apps.html#apps.botemail')),
  ('Custom tools (MCP)', '2 servers you added. For bots set to Every app, and for any bot on a No limits turn.', 'sliders', 'tools.mcp', 'go', ('Connected apps', 'apps.html#apps.mcp')),
  ('Messaging', 'Telegram: Chief answers.', 'msg', 'tools.messaging', 'go', ('Messaging', 'messaging.html')),
  ('Phone tools', 'Reminders, contacts, calendar and location on your phone.', 'phone', 'tools.phonetools', 'go', ('Phone & remote access', 'phone.html#phone.features.phonetools')),
  ('Calls', 'Bots call you when it is urgent. Bots phone businesses: not set up.', 'call', 'tools.calls', 'go', ('Phone & remote access', 'phone.html#phone.calls')),
  ('Let other programs use a bot', 'Scripts and outside agents. Off.', 'terminal', 'tools.scripts', 'go', ('Phone & remote access', 'phone.html#phone.scripts')),
 ]),
]

def tools_body():
    out = S('Web access', R('Can bots reach the web?', f'Yes, all {N} bots, through Web search ({F.TOOL_BOTS["Web search"]}), Read web pages ({F.TOOL_BOTS["Read web pages"]}), Browser ({F.TOOL_BOTS["Browser"]}) and Computer ({F.TOOL_BOTS["Computer"]}). Some engines can also search by themselves: open Web search to see which.',
                             icon='globe', cls='why', st=('t', 'Yes'), go=('Web search', 'tools-websearch.html#tools.websearch.provider')), id='tools.webaccess')
    for g, rows in CAT:
        rs = ''
        for t, d, i, idd, kind, x in rows:
            if kind == 'sw': rs += R(t, d, icon=i, id='tools.websearch.enabled' if idd == 'tools.websearch' else idd, on=True, open=x)
            elif kind == 'perbot': rs += R(t, d, icon=i, id=idd, st=('t', f'{N} of {N} bots'), open=True)
            elif kind == 'go': rs += R(t, d, icon=i, ref=x[1].split('#')[1] if '#' in x[1] else None, go=x)
            else: rs += R(t, d, icon=i, id=idd, st=('', 'Always on'))
        out += S(g, rs, scope='All bots', id='tools.' + ('builtin' if g == 'Built in' else 'yours'),
                 sub='' if g == 'Built in' else 'Off until you set them up')
    out += S('Display', R('Show tool calls in chat', 'See each step a bot takes.', icon='terminal', id='tools.showtoolcalls', on=False),
             R('Image library', 'Every picture your bots have made.', icon='image', ref='images.library', go=('Open Image library', '#')),
             R('Dictation', 'Set in General.', icon='mic', ref='general.dictation', go=('General', 'general.html#general.dictation')), scope='All bots')
    return out

def tools_aside():
    return helpc('Two switches, in order', '<b>1. Here:</b> is the tool on at all?', '<b>2. On the bot:</b> may this bot use it? Open a row and choose bots, or open the bot.',
                 'Tools: what bots can use. Approvals: when a bot must ask first.', link=('How tools work', 'tools'))

def computer_body():
    br = S('Browser', R('Built-in browser', 'A browser inside Murage that bots can drive.', icon='window', id='computer.browser.builtin', on=True),
           R('Which bots use a browser', '9 of 39. Set on each bot.', icon='bots', go=('Bots', 'bots.html#bots.table')),
           scope='All bots', id='computer.browser', more=['Browser profile name', 'Allow outside browser tools', 'Agent name', 'Browser profile for pairing'],
           advrows=[R('Browser profile name', 'Default', icon='pencil', id='computer.browser.profilename', open=True),
                    R('Allow outside browser tools', 'Lets a tool outside Murage drive this browser.', icon='plug', id='computer.browser.external', on=False),
                    R('Agent name', 'The name outside tools see.', icon='pencil', id='computer.browser.agentname', open=True),
                    R('Browser profile for pairing', 'Default', icon='user', id='computer.browser.pairprofile', val='Default')])
    co = S('Computers', R('This Mac', 'Bots can click and type here after you say yes once. 2 bots.', icon='computer', id='computer.computers.host', st=('ok', 'Ready')),
           R('Virtual computer', 'A separate desktop on this Mac. 2 bots.', icon='computer', id='computer.computers.vm', st=('ok', 'Ready')),
           R('Murage Cloud computer', 'A computer in the cloud for your bots to use. Needs a Murage Cloud key.', icon='globe', id='computer.computers.cloud', st=('', 'Not set up'), open=True),
           R('Computer for new bots', 'Set with the other new-bot choices.', icon='bots', ref='bots.new.computer', go=('Bots', 'bots.html#bots.new.computer')),
           scope='This computer', id='computer.computers', more=['Murage Cloud key', 'Your own server (its SSH name)', 'Desktops: shared or one per bot', 'Most desktops at once', 'Hosted computers (on a Cloud home)'],
           advrows=[R('Murage Cloud key', 'Not set.', icon='key', id='computer.computers.cloudkey', st=('', 'Not set'), open=True),
                    R('Your own server (its SSH name)', 'Not set.', icon='terminal', id='computer.computers.vps', open=True),
                    R('Desktops: shared or one per bot', '', icon='computer', id='computer.computers.isolation', end=seg(['Shared', 'Per bot'], 'Shared', 'Isolation')),
                    R('Most desktops at once', '', icon='computer', id='computer.computers.max', val='4'),
                    R('Hosted computers (on a Cloud home)', 'Shown only when Murage runs on a Cloud home.', icon='globe', id='computer.computers.hosted', st=('', 'Off'))])
    return br + co

def rules_body():
    hr = S('House rules', R('Use house rules', 'Every bot reads these before it answers.', icon='rules', id='rules.house.enabled', on=True),
           f'<div class="editor"><textarea class="ta" aria-label="House rules" id="rules.house.text">Be brief. Ask before spending money. Never email a customer without showing me first.</textarea><div class="sfoot"><span class="inh">Saved today 09:12</span>{B("Save", "pri")}</div></div>',
           scope='All bots', id='rules.house')
    yes = S('What you have said yes to', R('Trusted folders', '3 folders. Bots work in them without asking each time.', icon='folder', id='rules.saidyes.folders', open=True),
            R('Remembered recipients', '5 people or payees a bot may contact without asking.', icon='user', id='rules.saidyes.recipients', open=True),
            R('No limits terms', 'The terms you accepted before using No limits. Version 3.', icon='shield', st=('t', 'Accepted')), scope='All bots', id='rules.saidyes', sub='Remove one and the next use asks again')
    pr = S('Projects', scope='All bots', id='rules.projects', more=['Projects work on their own', 'Parallel project cards'])
    chn = S('Channels', scope='All bots', id='rules.channels', sub='Shared rooms where several bots work', more=['Idle time before a room goes quiet (minutes)', 'Let Murage pick who answers in a channel'])
    sp = S('Related', R('How new bots start', 'Approval level, effort and computer for new bots.', icon='bots', ref='bots.new', go=('Bots', 'bots.html#bots.new')))
    return hr + yes + pr + chn + sp

def general_body():
    you = S('You', R('Your name', '', icon='user', id='general.you.name', end=inp(F.OWNER['name'], label='Your name')), R('Your email', 'For sign-in and receipts.', icon='mail', id='general.you.email', end=inp('you@example.com', label='Your email')),
            R('About you', 'What every bot should know about you. You write this.', icon='doc', id='general.you.aboutme', open=True), scope='Everywhere', id='general.you')
    look = S('Look', R('Appearance', '', icon='sun', id='general.look.appearance', end=seg(['Light', 'Dark', 'Automatic'], 'Automatic', 'Appearance') + saved('Dark')),
             R('Interface font', '', icon='pencil', id='general.look.font', val='System'), R('Sidebar', '', icon='sliders', id='general.look.sidebar', end=seg(['Standard', 'Roomy', 'Rail'], 'Standard', 'Sidebar')),
             R('Fold the sidebar on narrow windows', '', icon='sliders', id='general.look.fold', on=True),
             R('Show tool calls in chat', '', icon='terminal', ref='tools.showtoolcalls', go=('Tools', 'tools.html#tools.showtoolcalls')),
             scope='Only here', id='general.look', sub='Your phone keeps its own look', more=['Send with Enter or Shift+Enter', 'Sidebar width', 'Sidebar section order', 'Pane widths', 'Task sort and folds', 'Reset layout'])
    lang = S('Language and time', R('App language', 'Bots reply in this language too, unless a bot has its own (Profile, Replies in).', icon='globe', id='general.lang.language', val='English'), R('Your time zone', 'Used by quiet hours, routines and backups.', icon='clock', id='general.lang.timezone', val=F.OWNER['zone']), scope='Everywhere')
    dic = S('Dictation', R('Dictation', 'On. Speak instead of typing. Using FluxRouter.', icon='mic', id='general.dictation', open=True),
            R('Clean up dictation', 'Removes ums and adds punctuation.', icon='pencil', id='general.dictation.cleanup', on=True), scope='Only here', id='general.dictationsec')
    note = S('Notifications', R('Needs your attention', '', icon='bell', id='general.notifications.attention', on=True), R('Task completed', '', icon='check', id='general.notifications.done', on=True),
             R('Task failed', '', icon='warn', id='general.notifications.failed', on=True), R('Memories waiting for you', '', icon='memory', id='general.notifications.memories', on=False),
             R('Show notification previews', 'Shows what a message says outside the chat.', icon='doc', id='general.notifications.previews', on=True),
             R('Quiet hours', f'{F.OWNER["quiet"]}, Miami time. No notifications in this window, and they are not replayed later.', icon='bell', id='general.notifications.quiethours', on=True, open=True),
             f'<div class="sfoot"><span class="inh">Saved today 09:12</span>{B("Save", "pri")}</div>',
             scope='Everywhere', id='general.notifications', sub='What to tell you about. Changes here save when you press Save.')
    nm = S('Notifications on this computer', R('Where notifications appear', 'Banner, Dock badge, menu bar and 5 more.', icon='computer', id='general.notifyme.surfaces', open=True), scope='This computer',
           more=['Notification buttons and quiet start', 'Badge count', 'Pinned bot for the floating bubble', 'Ask again about background notifications'])
    snd = S('Sound', R('Play a sound', 'With each notification, on this computer. Silent during quiet hours. Changes right away.', icon='voice', id='general.sound.play', on=True, end=''), scope='Only here', more=['Notification sound'])
    stp = S('Startup', R('Keep running when the window closes', 'So routines and phone access keep working.', icon='power', id='general.startup.keeprunning', on=True),
            R('Start when you sign in to this computer', '', icon='power', id='general.startup.login', on=True),
            scope='This computer', id='general.startup')
    rs = S('Devices and browsers', R('Phones and browsers signed in to this computer', '3. See and remove them in one list.', icon='globe', ref='phone.devices', go=('Phone & remote access', 'phone.html#phone.devices')), id='general.browsers')
    return you + look + lang + dic + note + nm + snd + stp + rs

def about_body():
    h = S('Help',
          R('Write to Chief', 'Opens a chat with a question you can edit. Nothing is sent until you press Send. Until then it is a draft in that chat, on this computer.', icon='msg', act=A('Write to Chief', 'about.help.askchief', 'sm pri', 'Opens a chat with Chief. Hidden with 0 bots; Guides lead instead.')),
          R('Guides', 'Getting started, phone, tools, approvals, backups. Opens the help panel beside Settings.', icon='help', id='about.help.guides', open=True),
          R('Keyboard shortcuts', '&#8984;K search. &#8984;, Settings. Esc back.', icon='terminal', go=('See all shortcuts', '#about.shortcuts'), rawdesc='<kbd>&#8984;K</kbd> search everywhere. <kbd>&#8984;,</kbd> Settings. <kbd>Esc</kbd> one step back.'),
          R('Report a problem', 'Opens a draft with your version and a short diagnostic. Nothing is sent until you press Send.', icon='warn', act=A('Report a problem', 'about.help.report', 'sm') + A('Copy diagnostics', 'about.help.copydiag', 'sm')),
          R('Show tips again', 'Brings back the tips you closed.', icon='info', act=A('Show tips again', 'about.help.tips', 'sm')),
          id='about.help')
    v = S('Version', R('Murage 1.0.21', 'You are up to date. Checked today 09:00.', icon='about', act=A('Check for updates', 'about.update.check', 'sm')),
          R('What is new', 'Release notes for this version.', icon='doc', go=('See release notes', '#')), scope='This computer')
    n = S('News', R('Show announcements', '', icon='bell', id='about.news.show', on=True), R('Email for Murage news', '', icon='mail', id='about.news.email', end=inp('you@example.com', label='Email for Murage news')), scope='Everywhere')
    sc = S('Keyboard shortcuts', R('Search every setting, from anywhere', '', end='<kbd>&#8984;K</kbd>'), R('Open Settings', '', end='<kbd>&#8984;,</kbd>'), R('One step back: menu, sheet, search, then close', '', end='<kbd>Esc</kbd>'),
           R('Back in Settings history', '', end='<kbd>&#8984;[</kbd>'), R('Move in the rail or in results. Enter opens. Space flips a switch.', '', end='<kbd>&uarr;</kbd> <kbd>&darr;</kbd>'), id='about.shortcuts')
    u = S('Under the hood', R('Read-only facts', f'{X.shown()} values set by Murage or by this computer: ports, folders and feature flags. You can search them. Secrets are never shown, only whether one is set.', icon='terminal', id='about.underthehood', open=True, cls='why'),
          scope='This computer')
    return h + v + n + sc + u


def build():
    G = 'App pages'; SF = 'Sheets and flows'
    page('overview.html', G, 'app', 'index', 'Overview', f'Your bots are running. {F.NEEDS_YOU} things need you.', overview_body, aside=overview_aside, learn=('How Settings is laid out', 'overview'),
         note='39-bot owner. Overview stores nothing. Needs you lists everything a page marks amber. Changed recently says who changed what; its values agree with the pages they point to. Set back is drawn on the one row that qualifies (Decision 2).')
    page('providers.html', G, 'app', 'providers', 'Providers', 'Accounts, plans and keys you have. They power the engines.', providers_body, aside=lambda: steps(1) + helpc('Where is my key used?', 'Open a key to see what it lights up and to remove it.', tip=True),
         learn=('How providers work', 'providers'), note='Rows open their sheet. The only buttons are things that happen now. FluxRouter is explained in one line. Direct build shown; a Store build has no Add credit (states.html).')
    page('providers-key.html', SF, 'app', 'providers', 'Providers', 'Accounts, plans and keys you have. They power the engines.', providers_body, sh=key_sheet, crumbs=[('Providers', 'providers.html')], last='Tavily key',
         note='A key\'s sheet: reason, Check this key, what it lights up, and the one Remove zone at the foot.')
    PAGES['providers-key.html'] = ('Providers: a key\'s sheet', SF, 'Reason, check, Remove zone')
    page('engines.html', G, 'app', 'engines', 'Engines', 'What runs your bots. Each engine uses a provider.', engines_body, aside=lambda: steps(2), learn=('How engines work', 'engines'),
         note='Each bot count comes from the fixture and links to the Bots list.')
    page('models.html', G, 'app', 'models', 'Models', 'Which engine and model each bot uses.', models_body, aside=lambda: steps(3) + helpc('Changing several', 'Tick the bots, choose once, press Apply. Each bot saves by itself and its row says how it went.'),
         learn=('How models work', 'models'), note='Every bot is listed; the list scrolls. An Engine cell is a chooser and nothing is sent until a model is picked; then one PATCH, awaited before Saved (Astra r4 6). Three bots are ticked to show the one bulk bar.')
    page('usage.html', G, 'app', 'usage', 'Usage & spend', 'What you have used, and your limit.', usage_body, aside=lambda: helpc('What the limit covers', 'Only FluxRouter credit. Keys and plans you bring are billed by their makers.', link=('How spend works', 'usage')),
         learn=('How spend works', 'usage'), note='Where it went has By bot and By tool (independent M11). Own keys are listed per service.')
    page('tools.html', G, 'app', 'tools', 'Tools', f'{F.APP_TOOLS_ON} of {F.NT} tools are on.', tools_body, aside=tools_aside, learn=('How tools work', 'tools'),
         pm=pmap(('Web access', 'tools.webaccess'), ('Built in', 'tools.builtin'), ('Uses something of yours', 'tools.yours')),
         note='21 rows. The Web search row switch is the Off control and has its own id (tools.websearch.enabled), apart from the Search with choice (Astra r4 4, 5). Past chats and Routines are on for every bot with a per-bot switch, and say so (independent M8).')
    page('tools-websearch.html', SF, 'app', 'tools', 'Tools', f'{F.APP_TOOLS_ON} of {F.NT} tools are on.', tools_body, sh=websearch_sheet, crumbs=[('Tools', 'tools.html')], last='Web search', rebody=True,
         note='Search with matches the shipped choices (SearchSettings.tsx; server/index.ts:30990-31010). The Off contract and what still reaches the web, by engine, are stated. Which bots lists every bot.')
    PAGES['tools-websearch.html'] = ('Tools: Web search sheet', SF, 'Search with, the Off contract, which bots')
    page('tools-images.html', SF, 'app', 'tools', 'Tools', f'{F.APP_TOOLS_ON} of {F.NT} tools are on.', tools_body, sh=images_sheet, crumbs=[('Tools', 'tools.html')], last='Images', rebody=True,
         note='New drawing (task 27, N9): image model, the test image action, and ten bots ticked with the one bulk bar.')
    PAGES['tools-images.html'] = ('Tools: Images sheet, ten bots ticked', SF, 'Image model, bulk bar')
    page('apps.html', G, 'app', 'apps', 'Connected apps', 'Apps you have signed in to, and tool servers you added.', apps_body, extra=addapp_flow,
         aside=lambda: helpc('Apps and custom tools', 'An <b>app</b> is an account like Gmail that you sign in to once.', 'A <b>custom tool</b> is a tool server you run yourself. The trade name is MCP.', link=('How connected apps work', 'apps')),
         learn=('How connected apps work', 'apps'), back=('Overview', 'overview.html'),
         note='The Notion row shows arrival from Overview. Below the window: the one question after adding an app, asked before sign-in, with the bots that get it at once (bots set to Every app, and a bot at No limits) and what Only chosen apps takes away (the new app, and custom tools: server/mcp-relay.ts:59-70).')
    page('apps-gmail.html', SF, 'app', 'apps', 'Connected apps', 'Apps you have signed in to, and tool servers you added.', lambda: apps_body(True), sh=app_sheet, crumbs=[('Connected apps', 'apps.html')], last='Gmail', rebody=True,
         note='Every bot is listed, and every bot has one of three stated app states: saved choices, nothing saved (Every app, the shipped default: server/bot-access-role.ts:9), or Connected apps off for the bot. No bot is drawn at No access with nothing saved (Walk r6 H3b). A picker is one set-account save. Two bots are ticked to show the bulk bar.')
    page('apps-gmail-work.html', SF, 'app', 'apps', 'Connected apps', 'Apps you have signed in to, and tool servers you added.', lambda: apps_body(True), sh=lambda: app_sheet('Gmail', 'work@acme.example'), crumbs=[('Connected apps', 'apps.html')], last='Gmail, work@acme.example', state=True,
         note='The second account of an owner with two Gmail accounts (a state: the fixture owner has one). It exists so that the Which account? choice in search lands on two different sheets, each naming its own account (Astra r6 12).')
    PAGES['apps-gmail-work.html'] = ('Connected apps: Gmail sheet, second account', SF, 'Arrival target for Which account?')
    PAGES['apps-gmail.html'] = ('Connected apps: Gmail sheet', SF, 'Which bots can use it, one save model')
    page('computer.html', G, 'app', 'computer', 'Computer & browser', 'Where your bots click and browse.', computer_body,
         aside=lambda: helpc('Per bot', 'This page sets up the browser and the computers. Which bot may use them is set on the bot, under Tools.', link=('How computer use works', 'computer')), learn=('How computer use works', 'computer'),
         note='Simple view. simple-vs-advanced.html draws this page both ways.')
    page('messaging.html', G, 'app', 'messaging', 'Messaging', 'Talk to your bots from Telegram, WhatsApp, Slack, Discord or Signal.', messaging_body, sh=telegram_sheet, learn=('How messaging works', 'messaging'), crumbs=[('Messaging', 'messaging.html')], last='Telegram',
         note='Decision 6. Telegram pairs only with the current Chief of staff (server/index.ts:33594), so Pair again is the only way to change who answers. The sheet does not promise that messages wait: ending a pairing drops them (server/telegram-channel.ts:110-113).')
    page('phone.html', G, 'app', 'phone', 'Phone & remote access', 'Your devices, remote access, calls and other programs.', phone_body,
         aside=lambda: helpc('Two separate facts', '<b>Phone access</b> lets paired devices connect at all.', '<b>Away from home</b> lets them connect when they are not on your Wi-Fi.', link=('How phone access works', 'phone')),
         learn=('How phone access works', 'phone'),
         pm=pmap(('Devices and browsers', 'phone.devices'), ('Away from home', 'phone.awaysec'), ('Calls', 'phone.calls'), ('Phone features', 'phone.features'), ('Other programs', 'phone.scriptsec')),
         note='Calls today is a positive switch: on means bots may ring you (switch audit). One list of devices and browsers, one verb, Remove. Remove all devices keeps Phone access on.')
    page('phone-device.html', SF, 'app', 'phone', 'Phone & remote access', 'Your devices, remote access, calls and other programs.', lambda: phone_body(cur_dev='Pixel 9'), sh=device_sheet,
         crumbs=[('Phone & remote access', 'phone.html'), ('Devices and browsers', 'phone.html#phone.devices')], last='Pixel 9', extra=phone_flows,
         note='The device sheet, then every confirmation, the six removal results (removed, nothing happened, pending with the step named, already gone, no answer, and notifications queued but not confirmed) and pairing. There is no leftover-records cleanup: the code has none.')
    PAGES['phone-device.html'] = ('Phone: device sheet, removal results, pairing', SF, 'Sheet, eleven dialogs')
    page('bots.html', G, 'app', 'bots', 'Bots', 'Find a bot. Choose how new bots start.', bots_body, extra=bots_flow,
         aside=lambda: helpc('Getting to a bot\'s settings', 'Click a name to open the bot. Or use <b>Go to a page</b> to jump straight to one of its 12 pages.', 'Archived bots are in the same list, at the end. Show narrows the list; it never hides a bot behind a button.', link=('How bots work', 'bots')),
         learn=('How bots work', 'bots'), note='Every bot is drawn: 39 and 2 archived, in one scrolling list, with no Show all. The approval levels come from the fixture. There is no Apply for a lower level, because no such route exists; the one shipped action is drawn below.')
    page('rules.html', G, 'app', 'rules', 'Rules for every bot', 'House rules, what you have said yes to, projects and channels.', rules_body, learn=('How house rules work', 'rules'),
         aside=lambda: helpc('Not here', 'How new bots start is set in Bots. When one bot must ask is set on that bot, under Approvals.', tip=True))
    import pages_skills as PS
    PS.app_pages(page, PAGES, G, SF)
    page('memory.html', G, 'app', 'memory', 'Memory', 'What bots remember and how they learn.', memory_body, learn=('How memory works', 'memory'),
         aside=lambda: helpc('See what is remembered', 'Everything your bots remember lists every memory, with a filter by bot. What one bot can use is on that bot.'),
         note='Memory is one picker with three plain choices (independent M9). Everything your bots remember is the whole-workspace list (server/memory/owner-list.ts:57-58); it is not an about-you scope (Astra r5 20). Each bot lists every bot.')
    page('memory-about.html', SF, 'app', 'memory', 'Memory', 'What bots remember and how they learn.', lambda: memory_body(True), sh=about_sheet, crumbs=[('Memory', 'memory.html')], last='Everything your bots remember', rebody=True,
         note='View, correct and forget one memory about you, across bots (server/memory/settings.ts:113 list, :610 correct, :620 forget; owner-level identity at :536-538).')
    PAGES['memory-about.html'] = ('Memory: Everything your bots remember', SF, 'List, correct, archive, forget one memory')
    page('general.html', G, 'app', 'general', 'General', 'You, look, language, dictation, notifications and startup.', general_body, learn=('General settings', 'general'),
         pm=pmap(('You', 'general.you'), ('Look', 'general.look'), ('Dictation', 'general.dictationsec'), ('Notifications', 'general.notifications'), ('Startup', 'general.startup')),
         aside=lambda: helpc('Who does a setting change?', '<b>Everywhere</b>: you, on every device.', '<b>All bots</b>: every bot.', '<b>This computer</b>: this machine.', '<b>Only here</b>: this window or this phone.'),
         note='Your name and notifications are tagged Everywhere, not All bots. Notifications is a form with one Save, as shipped (NotificationSettings.tsx:38-56). Devices and browsers is a signpost to the one list.')
    page('backups.html', G, 'app', 'backups', 'Backups & storage', 'Back up, keep your recovery key safe, restore and export.', backups_body, learn=('How backups work', 'backups'),
         aside=lambda: helpc('Moving to a new computer', 'Export a backup file here. Install Murage there, open Backup mode, and restore from that file with your recovery key.'),
         note='The recovery key has a home. Restore opens the shipped Backup mode; there is no restore list in Settings. Export opens the same Backup mode (IA v6 section 7.2).')
    page('backups-restore.html', SF, 'app', 'backups', 'Backups & storage', 'Back up, keep your recovery key safe, restore and export.', lambda: backups_body('restore'), sh=restore_sheet, crumbs=[('Backups & storage', 'backups.html')], last='Restore from a backup', extra=restore_flows, rebody=True,
         note='Restore as shipped: a restart into Backup mode, a restore into a new paused copy, current data kept (BackupSettings.tsx:54, :58). Below: the set-up, synced-folder key and interrupted-backup states, each a shipped operation with a home.')
    PAGES['backups-restore.html'] = ('Backups: Restore sheet and backup states', SF, 'Backup mode, five states')
    page('backups-export.html', SF, 'app', 'backups', 'Backups & storage', 'Back up, keep your recovery key safe, restore and export.', lambda: backups_body('export'), sh=export_sheet, crumbs=[('Backups & storage', 'backups.html')], last='Export a backup file', extra=export_flows, rebody=True,
         note='Export uses the shipped Backup mode action, Make a backup now. The sheet says what happens, what you get and what you need, with one button. No in-app export route is drawn (parked as PK4).')
    PAGES['backups-export.html'] = ('Backups: Export sheet', SF, 'Destination, encrypted file, progress')
    page('about.html', G, 'app', 'about', 'About & help', 'Help, version, news, shortcuts and under the hood.', about_body, learn=None,
         aside=lambda: helpc('Every guide opens beside the page', 'A link like "How tools work" opens the help panel at that guide.'),
         note='Help is the first section. Under the hood shows only values that are safe to show (IA v5 Appendix G).')
    # Shipped operations that live in sheets this set does not redraw. Each has an id and one home (Astra r4 9).
    for i, l, pg, n in [
        ('phone.calls.botsmake.removekey', 'Remove the calls account key (Vapi)', 'phone.html', 'In the Calls your bots make sheet. Immediate, apart from Save (PhoneCallsSettings.tsx:101-174).'),
        ('phone.calls.botsmake.findnumbers', 'Find my calling numbers', 'phone.html', 'Number discovery, in the same sheet.'),
        ('phone.calls.botsmake.results', 'See recent call results and transcripts', 'phone.html', 'In the same sheet.'),
        ('phone.calls.botsmake.sharetranscript', 'Share a call transcript with a bot', 'phone.html', 'In the same sheet.'),
        ('phone.scripts.switchoffone', "Switch off one program's access", 'phone.html', 'One button per program, in the Advanced group. ScriptAccessSettings.tsx:65-109.'),
        ('phone.scripts.switchalloff', 'Switch off all other programs', 'phone.html', 'In the Advanced group.'),
        ('phone.thisdevice.signout', 'Sign out this device', 'phone.html', 'Only on a remote browser or phone. Removes the current device from the computer, not just this browser session (DELETE /session/device, src/lib/remote-sign-out.ts:6-17; RemoteSignOut.tsx:60, :77). Drawn in layout-phone.html.'),
        ('phone.cloud.disconnect', 'Disconnect this Cloud home', 'phone.html', 'Cloud home only. Kept as shipped.'),
        ('phone.cloud.forgetbrowser', 'Forget this browser', 'phone.html', 'Cloud home only. Kept as shipped.'),
        ('bot.tools.sites.takedown', 'Take down a published site', 'bot-tools.html', 'In the Published sites sheet.'),
        ('rules.saidyes.folders.remove', 'Remove a trusted folder', 'rules.html', 'In the Trusted folders sheet. The next use asks again.'),
        ('rules.saidyes.recipients.remove', 'Remove a remembered recipient', 'rules.html', 'In the Remembered recipients sheet.'),
        ('memory.notebook.stoptracking', 'Stop tracking a notebook import', 'memory.html', 'In the Advanced group.'),
        ('general.look.resetlayout', 'Reset layout', 'general.html', 'In the Look Advanced group.'),
        ('engines.resetlocation', 'Reset engine location', 'engines.html', 'In the Engines Advanced group.'),
        ('bot.tools.computer.askagain', 'Ask again before using this Mac', 'bot-tools.html', 'In the Computer sheet, for Auto only (ComputerPanel.tsx:1548-1566).'),
        ('backups.offsite.upload', 'Upload the latest backup off-site now', 'backups.html', 'In the Off-site copy sheet (electron/preload.cjs:189-212).'),
        ('backups.offsite.test', 'Test the off-site connection', 'backups.html', 'In the Off-site copy sheet.'),
        ('backups.offsite.remove', 'Remove the off-site copy setup', 'backups.html', 'Remove zone of the Off-site copy sheet.'),
    ]: ghost(i, l, pg, n)
