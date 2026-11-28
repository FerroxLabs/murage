# Search, states, first run, 0/1/39 bots, deep-link arrival, Simple against Advanced, narrow and phone layouts, patterns, index.
from core import *
import core, fixture as F, inventory5 as X
import pages_app as PA, pages_bot as PB

def res(title, path, what='', scope='', val='', href='#', best=False, grey=False, adv=False, inline=None, icon='general', picker='', act='Open'):
    tags = (tag(scope) if scope else '') + (tag('Advanced') if adv else '')
    v = txt('Now: ' + val) if val else ''
    ctl = inline if inline else ''
    ro = '' if grey else f'<a class="ro" href="{href}">{act} {ic("go")}</a>'
    return (f'<div class="res{" best" if best else ""}{" grey" if grey else ""}"><span class="ic">{ic(icon)}</span><span><b>{title}</b>{tags}<span class="what">{what}</span>'
            f'<span class="path">{path}</span></span><span class="end">{v}{ctl}{ro}</span>{picker}</div>')
def rgroup(title, *rows, more=''):
    m = f'<div class="tfoot">{more}</div>' if more else ''
    return f'<section class="sec"><h3>{title}</h3><div class="card">{"".join(rows)}{m}</div></section>'

def search_email():
    wd = rgroup('Which did you mean?',
        res('Gmail', 'Connected apps &rsaquo; Your apps &rsaquo; Gmail', f'Your own inbox, as an app bots can use. {F.plural(F.app_count("Gmail"))}.', 'All bots', 'Signed in', 'apps-gmail.html', icon='plug'),
        res('Bot <mark>email</mark>', 'Connected apps &rsaquo; Bot email', 'Gives each bot its own address.', 'All bots', 'On', 'apps.html#apps.botemail', icon='mail'),
        res('Its own <mark>email</mark> address', 'Bot &rsaquo; Tools', 'One bot\'s address and when it asks before sending. Choose the bot to open it.', 'Per bot', '', 'bot-tools.html#bot.tools.email', icon='mail', grey=True,
            picker='<div class="pickrow"><span class="inh">For which bot?</span>' + ''.join(f'<a class="chip" href="{"bot-tools.html#bot.tools.email" if b["n"] == "Dax" else "#"}" data-bot="{b["n"].lower()}" data-setting-ref="bot.tools.email" aria-label="Its own email address, for {b["n"]}">{PA.avr(b)} {b["n"]}</a>' for b in PA.BOTS[:4]) + '<button type="button" class="chip more">Type a name: 35 more</button></div>'),
        res('Your <mark>email</mark>', 'General &rsaquo; You', 'For sign-in and receipts.', 'Everywhere', 'you@example.com', 'general.html#general.you.email', icon='user'),
        res('<mark>Email</mark> for Murage news', 'About &amp; help &rsaquo; News', '', 'Everywhere', 'you@example.com', 'about.html#about.news.email', icon='about'))
    more = rgroup('Also matches',
        res('Why Dax cannot send <mark>email</mark>', 'Dax &rsaquo; What it can reach', 'Its own email address is off for Dax.', 'Only Dax', 'Cannot', 'bot-reach.html', icon='check'),
        res('Your own mail server', 'Not a setting yet', 'Murage sends mail through Bot email or Gmail.', '', '', 'apps.html#apps.botemail', icon='info'),
        more='Every home for this word is listed above, in this order every time.')
    return wd + more

def search_dark():
    return (rgroup('Best match', res('Appearance', 'General &rsaquo; Look', 'Light, Dark or Automatic. Typed: <mark>drak mode</mark>. Showing results for <b>dark mode</b>.', 'Only here', '', 'general.html#general.look.appearance', best=True, icon='sun',
                                     inline=seg(['Light', 'Dark', 'Automatic'], 'Dark', 'Appearance') + saved('Automatic'))) +
            rgroup('General', res('Interface font', 'General &rsaquo; Look', '', 'Only here', 'System', 'general.html#general.look.font', icon='pencil'),
                   res('Show notification previews', 'General &rsaquo; Notifications', 'Part of a form with its own Save, so it opens there.', 'Everywhere', 'On', 'general.html#general.notifications.previews', icon='bell')))

def search_port(phone=False):
    if phone:   # desktop-only values are never sent to a phone: no number is drawn, and none is in the page (Astra r5 18)
        ro = rgroup('Only on your computer', res('Murage <mark>port</mark>', 'About &amp; help &rsaquo; Under the hood', 'Shown on your computer only.', 'This computer', '', grey=True, icon='terminal'),
                    res('Webhook <mark>port</mark>', 'About &amp; help &rsaquo; Under the hood', 'Shown on your computer only.', 'This computer', '', grey=True, icon='terminal'),
                    res('Im<mark>port</mark> from Claude Code', 'Connected apps &rsaquo; Custom tools', 'Change this on your computer.', 'All bots', '', grey=True, icon='sliders'),
                    res('Ex<mark>port</mark> a backup file', 'Backups &amp; storage &rsaquo; Restore and export', 'Done on your computer, in Backup mode.', 'This computer', '', grey=True, icon='dl'))
        return ro
    return (rgroup('Read only', res('Murage <mark>port</mark>', 'About &amp; help &rsaquo; Under the hood', 'Set by this computer. It cannot be changed here.', 'This computer', '4747', 'about.html#about.underthehood', icon='terminal'),
                   res('Webhook <mark>port</mark>', 'About &amp; help &rsaquo; Under the hood', 'Set by this computer. It cannot be changed here.', 'This computer', '4748', 'about.html#about.underthehood', icon='terminal')) +
            rgroup('Actions', res('Ex<mark>port</mark> a backup file', 'Backups &amp; storage &rsaquo; Restore and export', 'One encrypted file, made in Backup mode.', 'This computer', '', 'backups.html#backups.export', icon='dl')) +
            rgroup('Only on your computer', res('Im<mark>port</mark> from Claude Code', 'Connected apps &rsaquo; Custom tools', 'Change this on your computer.', 'All bots', '', grey=True, icon='sliders')))

def search_none():
    return ('<section class="sec"><div class="card"><div class="empty"><b>Nothing matches &ldquo;qzwx billing portal&rdquo;</b>Murage did not log or send what you typed.</div></div></section>' +
            rgroup('Did you mean', res('Monthly spend limit', 'Usage &amp; spend &rsaquo; Spend limit', 'Closest match for <mark>billing</mark>.', 'All bots', '$100', 'usage.html#usage.limit', icon='usage')) +
            rgroup('Get an answer', res('Write to Chief', 'Opens a chat with Chief and this question typed in: Where do I set &ldquo;qzwx billing portal&rdquo;?', 'You can edit it first. Nothing is sent until you press Send. Until then your words are kept as a draft in that chat, on this computer; clear the box to remove them.', '', '', 'about.html#about.help', icon='msg', act='Write to Chief'),
                   res('Guides', 'About &amp; help &rsaquo; Help', 'Getting started, phone, tools, approvals, backups.', '', '', 'about.html#about.help.guides', icon='help')))

def search_empty():
    return (rgroup('Changed recently', res('Dax\'s model', 'Dax &rsaquo; Engine &amp; model', f'{F.DAX["model_was"]} &rarr; {F.DAX["model"]}. You, on this computer. ' + F.DAX['model_changed'] + '.', 'Only Dax', '', 'bot-model.html#bot.model.model', icon='history'),
                   res('Rhea\'s model', 'Models', 'Claude Sonnet &rarr; Claude Opus. Murage, because Claude Sonnet was withdrawn for this plan. 2 hours ago.', 'Only Rhea', '', 'models.html#models.table', icon='history')) +
            rgroup('Common things', res('Add an API key', 'Providers &rsaquo; API keys', '', 'All bots', '', 'providers.html#providers.keys.add', icon='key'),
                   res('Pair your phone', 'Phone &amp; remote access &rsaquo; Devices and browsers', '', 'This computer', '', 'phone.html#phone.devices', icon='phone'),
                   res('Back up now', 'Backups &amp; storage &rsaquo; Backups', '', 'This computer', '', 'backups.html#backups.backups', icon='backup')))

def search_inbot():
    return (rgroup('In Dax', res('<mark>Model</mark>', 'Dax &rsaquo; Engine &amp; model', 'Which model Dax uses.', 'Only Dax', F.DAX['model'], 'bot-model.html#bot.model.model', best=True, icon='model'),
                   res('Engine', 'Dax &rsaquo; Engine &amp; model', 'What runs Dax.', 'Only Dax', 'Claude Code', 'bot-model.html#bot.model.engine', icon='eng')) +
            rgroup('In the whole app', res('<mark>Models</mark>', 'Settings &rsaquo; Models', 'Each bot\'s engine and model, in one table.', 'All bots', '', 'models.html', icon='model'),
                   res('<mark>Model</mark> lists', 'Settings &rsaquo; Models', '', 'All bots', '', 'models.html#models.lists', icon='model', adv=True)))

def search_alias():
    return (rgroup('Best match', res('Voice &amp; notifications', 'Dax &rsaquo; Voice &amp; notifications', 'This page used to be called <mark>Voice &amp; alerts</mark>.', 'Only Dax', '', 'bot-voice.html', best=True, icon='voice')) +
            rgroup('Also renamed', res('Calls today', 'Phone &amp; remote access &rsaquo; Calls', 'Used to be <mark>Calls off for today</mark>. On means bots may ring you.', 'All bots', 'On', 'phone.html#phone.calls.today', icon='call')))
def search_two_accounts():
    return rgroup('Which account?', res('<mark>Gmail</mark>', 'Connected apps &rsaquo; Your apps &rsaquo; Gmail', 'Gmail is connected twice. Choose the account to open its bots. Nothing is chosen for you.', 'All bots', '', 'apps-gmail.html', icon='plug', grey=True,
        picker='<div class="pickrow"><span class="inh">Which account?</span><a class="chip" href="apps-gmail.html#apps.connected.bots" data-account="you@example.com">you@example.com</a><a class="chip" href="apps-gmail-work.html#apps.connected.bots" data-account="work@acme.example">work@acme.example</a></div>'))
def search_answer(k, act):
    a = X.ANSWERS[k]
    return rgroup('An answer, not a setting', res(a[1], 'Murage does not have this yet', a[2], '', '', a[3], icon='info', act=act))
def search_absent():
    a = X.ANSWERS[2]
    return (rgroup('An answer, not a setting', res(a[1], 'Murage does not have this yet', a[2], '', '', a[3], icon='info', act='Open Messaging')) +
            rgroup('Close to what you typed', res('Teams', 'Bot &rsaquo; Teams', 'Groups of bots that work together. Not a way to add a person. Choose the bot to open it.', 'Per bot', '', 'bot-teams.html', icon='team', grey=True,
                       picker='<div class="pickrow"><span class="inh">For which bot?</span>' + ''.join(f'<a class="chip" href="{"bot-teams.html" if b["n"] == "Dax" else "#"}" data-bot="{b["n"].lower()}" aria-label="Teams, for {b["n"]}">{PA.avr(b)} {b["n"]}</a>' for b in PA.BOTS[:4]) + '<button type="button" class="chip more">Type a name: 35 more</button></div>'),
                   res('Let other programs use a bot', 'Phone &amp; remote access', 'For scripts and outside agents, not for people.', 'This computer', 'Off', 'phone.html#phone.scripts', icon='terminal')))

def palette():
    return ('<div class="palette" role="dialog" aria-label="Search Murage"><div class="pin">' + ic('search') + '<input type="search" aria-label="Search Murage" value="dark mode"><kbd>Esc</kbd></div>'
            '<div class="cap">Settings</div>' + res('Appearance', 'Settings &rsaquo; General &rsaquo; Look', '', 'Only here', 'Automatic', 'general.html#general.look.appearance', best=True, icon='sun',
                                                    inline=seg(['Light', 'Dark', 'Automatic'], 'Automatic', 'Appearance')) +
            res('Interface font', 'Settings &rsaquo; General &rsaquo; Look', '', 'Only here', 'System', 'general.html#general.look.font', icon='pencil') +
            '<div class="cap">Chats</div>' + res('Dark mode screenshots for the site', 'Chat with Pepper, 12 Nov', '', '', '', '#', icon='msg') +
            '<div class="cap">Commands</div>' + res('New chat', '', '', '', '', '#', icon='plus') + '</div>')

def W(space, cur, title, sub, body, **kw): return win(space, cur, title, sub, body, **kw)
def lab_(t, s=''): return f'<div class="winlab">{t}<small>{s}</small></div>'
def nc(f):
    def g(*a, **k):
        REG['canon'] = False
        try: return f(*a, **k)
        finally: REG['canon'] = True
    return g

@nc
def build():
    REG['cur'] = 'extra'
    XG = 'Search'
    # --- search
    doc('search.html', 'Search', lab_('1. A word with several homes', 'Typed: email') +
        W('app', '', 'Results for "email"', '7 results. <span role="status" aria-live="polite">Which did you mean?</span>', search_email(), query='email', crumbs=[]) +
        lab_('2. A typo, an inline change', 'Typed: drak mode') + W('app', '', 'Results for "dark mode"', '3 results.', search_dark(), query='drak mode') +
        lab_('3. Read-only settings, actions, and a result this surface cannot change', 'Typed: port') + W('app', '', 'Results for "port"', '4 results.', search_port(), query='port'),
        note='Ruling 7. Ambiguous words get a Which did you mean block with every home. Per-bot settings are one row with a bot picker. A per-bot row has no Open of its own: the bot choices are its first stops (Visual QA M09). Safe switches change in the result (Saved, with Change back); a control that belongs to a form with Save opens there instead. Settings with no control are indexed as read-only rows when their value is safe to show (Appendix G). Actions are indexed. What you type in the search box is never logged or saved. Write to Chief is the one exception, and its row says so: it puts your words in a draft message to Chief on this computer.')
    PAGES['search.html'] = ('Search: results', XG, 'Which did you mean, typo, inline switch, read-only rows, actions')
    doc('search-more.html', 'Search states', lab_('1. Empty box', '&#8984;K with nothing typed') + W('app', '', 'Search', 'Type what you want, in your own words.', search_empty(), query=' ') +
        lab_('2. No results', 'Offers the nearest setting, Write to Chief and help') + W('app', '', 'Results for "qzwx billing portal"', 'No results.', search_none(), query='qzwx billing portal') +
        lab_('3. Inside a bot', 'That bot first, then the whole app') + W('bot', '', 'Results for "model"', '4 results.', search_inbot(), query='model') +
        lab_('4. An old name still lands', 'Typed: voice & alerts') + W('bot', '', 'Results for "voice & alerts"', '2 results.', search_alias(), query='voice & alerts') +
        lab_('5. Something Murage does not have', 'Typed: share with a teammate. An honest answer, never an empty page.') + W('app', '', 'Results for "share with a teammate"', '1 answer, 2 near matches.', search_absent(), query='share with a teammate') +
        lab_('6. Move to Cloud', 'Typed: move to cloud. An honest answer with the by-hand path.') + W('app', '', 'Results for "move to cloud"', '1 answer.', search_answer(1, 'Open Backups &amp; storage'), query='move to cloud') +
        lab_('7. A lock for Settings', 'Typed: lock. An honest answer. No setting does this, so the one link opens Guides.') + W('app', '', 'Results for "lock"', '1 answer.', search_answer(3, 'Open Guides'), query='lock') +
        lab_('8. An app that is connected twice', 'State drawn for an owner with two Gmail accounts. The fixture owner has one. No account is preselected; choosing one is one more click.') + W('app', '', 'Results for "gmail"', '1 result.', search_two_accounts(), query='gmail') +
        lab_('9. The command palette in the main window', '&#8984;K anywhere. Same index, same links.') + palette(),
        note='&#8984;K (Ctrl K on Windows) is search everywhere. In Settings it puts the cursor in the rail box. In the main window it opens the command palette, which shows settings first, from the same index. Cmd , opens Settings.')
    PAGES['search-more.html'] = ('Search: empty, no results, inside a bot, old names, honest answers, two accounts, palette', XG, 'Nine states')

    # --- states
    S_ = 'States'
    def prov_loading():
        sk = ''.join(f'<div class="r" aria-busy="true"><span class="mk"></span><span class="tx"><span class="skel t"></span><span class="skel"></span></span><span class="end">{pill("", "Checking")}</span></div>' for _ in range(3))
        return (f'<section class="sec"><h3>FluxRouter<span class="sc">All bots</span></h3><div class="card">{sk[:sk.index("</div>")+6]}</div></section>'
                f'<section class="sec"><h3>AI plans you already pay for<span class="sc">All bots</span></h3><div class="card">{sk}</div></section>'
                f'<section class="sec"><h3>API keys<span class="sc">All bots</span></h3><div class="card">{sk}</div></section>')
    def prov_states():
        return (S('AI plans you already pay for',
                  R('Claude plan', 'Murage could not reach Anthropic to check. Last known: signed in.', mk=('C',), st=('', 'Could not check'), act=B('Check again', 'sm')),
                  R('ChatGPT plan', 'Signing in needs the internet.', mk=('G',), st=('warn', 'Needs sign-in'), act='<button type="button" class="btn sm" aria-disabled="true">Sign in to ChatGPT</button>'), scope='All bots') +
                S('Engines', R('Fuigo', 'Using FluxRouter.', mk=('F', 1), on=True, end=saved()), R('OpenCode', 'Off.', mk=('O',), on=False),
                  '<div class="notsaved" role="alert">' + ic('warn') + 'Not saved. Murage could not reach your computer. OpenCode is still off. <button type="button" class="lnk">Try again</button></div>',
                  R('Codex', 'Not signed in.', mk=('X',), on=False, dis=True), scope='This computer', sub='Saved, a failed save, and a switch that is paused while offline') +
                S('Devices', R('Could not check your devices', 'The phone service on this computer did not answer. Murage does not show an empty list, and does not clean anything up, until it can read the list.', icon='warn', cls='why',
                               st=('', 'Could not check'), act=B('Check again', 'sm')), scope='This computer') +
                S('Look', R('Appearance', '', icon='sun', end=seg(['Light', 'Dark', 'Automatic'], 'Dark', 'Appearance') + saved('Automatic')), scope='Only here', sub='Still works offline: it is stored in this window'))
    def bulk_states():
        def row(n, d, end): b = F.B(n); return line(f'{PA.avr(b)} {n}', d, end)
        run = S('While it runs', selbar(39, F.N, prog(31, 'Saving 12 of 39. Each bot is saved by itself.') + B('Stop after this one', 'sm')),
                row('Chief', 'Saved.', saved()), row('Dax', 'Saved.', saved()), row('Pepper', 'Saving.', pill('', 'Checking')), row('Sable', 'Waiting.', txt('Next')), scope='Only those bots')
        assert F.app_saved('Google Calendar', 'Chief') == 'Read and change' and F.app_saved('Google Calendar', 'Juno') == 'Read only' and F.app_saved('Google Calendar', 'Mira') == 'Read only'
        done = S('When it ends', '<div class="selbar" role="status"><b>36 saved. 2 already set. 1 not saved.</b>' + B('Review Atlas', 'sm pri') + '<button type="button" class="lnk">Done</button></div>',
                 row('Chief', 'Saved. Read only.', saved('Read and change')), row('Juno', 'Already set to Read only. Nothing changed.', txt('No change')),
                 row('Atlas', 'Changed in another window while this ran: now No access. You chose Read only. Murage did not overwrite it.', B('Keep No access', 'sm') + B('Set Read only', 'sm')),
                 '<div class="notsaved" role="alert">' + ic('warn') + 'Atlas was not saved. Its access to Google Calendar was changed in another window a moment ago. Choose which to keep. The other 38 stand.</div>', scope='Only those bots')
        return run + done
    def paused_states():
        return (S('Engines', R('Engines are off since the restore', 'Every engine was switched off by the restore on 18 Nov, and stays off until you turn it on. Sign in to each one again first. Connect your phone and messaging apps again too.', icon='warn', cls='why', st=('warn', 'Needs you'), go=('Engines', 'engines.html#engines.claudecode')), scope='This computer') +
                S('Every bot', R('Connected apps, computer and browser are off since the restore', 'The restore switched these off for every bot, and each bot starts at Ask. Turn them on again in each bot\'s Tools.', icon='warn', cls='why', st=('warn', 'Needs you'), go=('Dax: Tools', 'bot-tools.html#bot.tools.builtin')), scope='All bots') +
                S('Dax: Routines', R('Morning inbox sort', 'Every weekday at 07:00. Off since the restore on 18 Nov. It does not run again until you turn it on here.', icon='clock', cls='why', on=False), scope='Only Dax', sub='Each routine has its own switch') +
                S('Dax: What it can reach', R('Run routines', 'Both of the routines Dax has are off since the restore.', icon='x', cls='why', st=('', 'Cannot'), go=('Fix: Turn on Morning inbox sort', 'bot-routines-restored.html#bot.routines.morning')), scope='Only Dax'))
    def codex_states():
        return S('Codex sign-in: the four things the Codex program can report', R('Codex', 'Signed in with your ChatGPT plan. Covered by the plan.', mk=('X',), st=('ok', 'Ready')),
                 R('Codex', 'Signed in with an API key that was given to Codex itself. OpenAI bills that key for each use. This is not the OpenAI key saved in Murage.', mk=('X',), st=('ok', 'Ready'), cls='why'),
                 R('Codex', 'Not signed in. ' + F.CODEX['line'], mk=('X',), st=('warn', 'Needs sign-in'), cls='why'),
                 R('Codex', 'Murage could not read the sign-in from Codex. Last known: signed in.', mk=('X',), st=('', 'Could not check'), act=B('Check again', 'sm')), scope='This computer', sub='Read from Codex, never guessed')
    doc('states.html', 'States', lab_('1. Loading', 'Skeleton rows and Checking. Never a guessed state.') + W('app', 'providers', 'Providers', 'Accounts, plans and keys you have.', prov_loading(), aside=steps(1)) +
        lab_('2. Offline, Could not check, Saved, Not saved', 'One window, real rows') +
        W('app', 'engines', 'Offline and save states', 'A sampler of real rows from Providers, Engines, Phone and General.', prov_states() + codex_states(),
          banner=ban('<b>Offline.</b> Changes that need your computer are paused. Settings stored in this window still work.', 'off', B('Try again', 'sm')),
          aside=helpc('The rules', '<b>Saved.</b> appears beside the control after the write is confirmed, for 2 seconds. With one old value it adds Was X and Change back while the page is open.',
                      '<b>Not saved.</b> sits under the row in red, read out at once. Typed text is kept.', '<b>Could not check</b> is grey with Check again. It is never shown as broken.')) +
        lab_('3. Store build', 'No price, no purchase link. The fact and the next step only.') +
        W('app', 'usage', 'Usage & spend', 'What you have used, and your limit.', PA.usage_body(store=True, out=True), needs={'index': '4 need you', 'engines': 'Needs you', 'apps': 'Needs you', 'usage': 'Needs you'},
          banner=ban('<b>FluxRouter credit has run out.</b> Bots that use FluxRouter are paused. Bots on your own keys and plans keep working.', '', lnk('Providers', 'providers.html')),
          aside=helpc('Store build', 'Add credit is not created, not drawn and not in search. API key entry follows its own rule: this computer only.')) +
        lab_('4. Changing several bots: the Apply queue', 'One bulk model on every list. Each bot is one save, and each is reported.') +
        W('app', 'apps', 'Connected apps: Google Calendar, 39 bots ticked', 'Apply was pressed with Read only chosen.', bulk_states()) +
        lab_('5. After a restore: engines and routines are off', 'Each place names its own switch: an engine in Engines, a routine on its bot. The rail counts it.') + W('app', 'engines', 'Off since the restore', 'One cause, named everywhere it bites.', paused_states(), needs={'index': '4 need you', 'engines': 'Needs you', 'apps': 'Needs you'}),
        note='Saved is a line of text, never a pill. A device read that fails shows Could not check, never an empty list. The Apply queue is the same component in every list (IA v5 section 6): running, result, and the changed-in-another-window row that is never overwritten or retried. The rail of each specimen is drawn from the needs-you set of that specimen (Visual QA M08). After a restore the shipped words are that engines and schedules stay off until the owner turns them on (electron/installation-recovery-window.mjs:86); no Resume button is drawn. What lifts the hold is the switch of each engine and of each routine: a restore leaves every engine and every routine disabled (server/installation-activation.ts:55-57, :71-75), and a routine is turned on by its own control (src/components/RoutineCalendarPage.tsx:1512). The restored routine is therefore drawn Off, and its Fix lands on that routine, not on Engines (Astra r6 12). The Store specimen shows a zero balance with its out-of-credit banner (Visual QA r6 M07). Codex sign-in is read from the Codex program (server/drivers/codex.ts:469-474).')
    PAGES['states.html'] = ('States: loading, offline, Saved, Not saved, Store build, Apply queue, after a restore', S_, 'Five windows')

    def first_run():
        return ('<section class="sec"><h3>What do you have?<small>Pick one. You can add the others later.</small></h3><div class="q4">'
                f'<a class="rec" href="providers.html#providers.fluxrouter"><span class="mk">{ic("prov")}</span><span><b>Sign in to FluxRouter {pill("by","Recommended")}</b><span class="d">For when you have nothing yet. Murage&rsquo;s own pay-as-you-go service. One sign-in runs everything. You add credit when you need it.</span></span></a>'
                f'<a href="providers.html#providers.subs"><span class="mk">{ic("user")}</span><span><b>A Claude or ChatGPT plan</b><span class="d">Sign in and use what you already pay for.</span></span></a>'
                f'<a href="providers.html#providers.keys.add"><span class="mk">{ic("key")}</span><span><b>An API key</b><span class="d">Paste it. Murage works out whose it is.</span></span></a>'
                f'<a href="providers.html#providers.local"><span class="mk">{ic("computer")}</span><span><b>A model on this computer</b><span class="d">Ollama, LM Studio or similar.</span></span></a></div></section>')
    def zero_ready():
        return (S('Next', '<div class="empty"><b>You are set up. Make your first bot.</b>A bot is one assistant with its own job, tools and memory.<br>' + B('Make a bot', 'pri') + '</div>') +
                S('Your setup', R('FluxRouter', 'Signed in.', mk=('F', 1), st=('ok', 'Signed in'), go=('Providers', 'providers.html')), R('Fuigo', 'Ready.', mk=('F', 1), st=('ok', 'Ready'), go=('Engines', 'engines.html'))))
    doc('first-run.html', 'First run and 0, 1 bots', lab_('1. First run', '0 bots, nothing set up. One question.') +
        W('app', 'index', 'Overview', 'Welcome. One thing to do first.', first_run(), empty=True, aside=helpc('Not sure?', 'Sign in to FluxRouter. You can add a plan or a key at any time.', link=('Getting started', 'start'))) +
        lab_('2. 0 bots, a provider ready') + W('app', 'index', 'Overview', 'You are set up.', zero_ready(), empty=True) +
        lab_('3. 1 bot', 'No finder, one row') + W('app', 'index', 'Overview', 'Your bot is running. Nothing needs you.', PA.overview_body(1).split('</section>', 1)[1], empty=True),
        note='Ruling 2: first run and 0, 1 bots on Overview. 39 bots is overview.html. The first-run start is the main empty window, not a chat (Astra r3 4). In a Store build the first answer reads Sign in to FluxRouter, with no price and no word about credit. The 1-bot window shows only Chief and what a new owner has.')
    PAGES['first-run.html'] = ('Overview: first run, 0 bots, 1 bot', S_, 'Three windows')
    doc('bots-0-1.html', 'Bots at 0 and 1', lab_('1. 0 bots') + W('app', 'bots', 'Bots', 'Find a bot. Choose how new bots start.', PA.bots_body(0), empty=True) +
        lab_('2. 1 bot', 'No filter box, no archive group') + W('app', 'bots', 'Bots', 'Find a bot. Choose how new bots start.', PA.bots_body(1), empty=True),
        note='39 bots is bots.html. Per-bot rows in tool and app sheets follow the same three shapes: No bots yet; one row with no filter; a filter above the full list.')
    PAGES['bots-0-1.html'] = ('Bots: 0 bots and 1 bot', S_, 'Two windows')

    # --- deep link arrival
    chat = ('<div class="chathead" role="group" aria-label="Chat with Dax"><span class="av">D</span><b>Dax</b>' + '<a class="btn sm" href="bot-reach.html" aria-label="Bot settings for Dax. Opens What it can reach">' + ic('general') + ' Bot settings</a></div>'
            '<div class="chat"><div class="msg me">Send the invoice reminder to Acme.</div>'
            f'<div class="errcard" role="group" aria-label="Dax could not finish">{ic("warn")}<div><b>Dax could not send the email.</b><small>Its own email address is off for Dax.</small></div>'
            f'<a class="btn pri sm" href="bot-tools.html#bot.tools.email" data-setting-ref="bot.tools.email" data-bot="dax">Fix in Settings: Its own email address</a></div>'
            '<div class="msg">I could not send it. Turn on its own email address for Dax in Settings and I will try again.</div>'
            f'<div class="errcard" role="group" aria-label="Dax could not finish">{ic("warn")}<div><b>Dax could not reach example.com.</b><small>The site did not answer. No setting is in the way.</small></div>'
            f'<a class="btn sm" href="bot-reach.html">See what Dax can reach</a></div></div>')
    def arrive():
        b = PB.bot_tools_body()
        i = b.index('<section class="sec" id="bot.tools.yours"'); b = b[i:] + b[:i]   # the specimen opens at the target, as arrival does (Visual QA M08)
        return b.replace('class="r off" id="bot.tools.email"', 'class="r off hl" id="bot.tools.email"')
    fb = ('<div class="flow">' +
          dlg('Fallback: not on this surface', 'Tools', '<div class="fallback">' + ic('info') + 'Change this on your computer: Tools &rsaquo; Web search.</div>', B('Go to Tools', 'pri')) +
          dlg('Fallback: the bot is gone', 'Bots', '<div class="fallback">' + ic('info') + 'That bot was removed. Here are your bots.</div>', B('See your bots', 'pri')) +
          dlg('Fallback: unknown link', 'Search', '<div class="fallback">' + ic('info') + 'This link did not match a setting. Here is what matches &ldquo;its own email address&rdquo;.</div>', B('See what matches', 'pri')) +
          dlg('Arrival on a phone: a control the phone may not change', 'Phone &amp; remote access', '<div class="fallback">' + ic('info') + 'Phone tools is shown, greyed, with: Change this on your computer. The link only shows the row. It switches nothing.</div>', B('Close', 'pri')) +
          dlg('Arrival from an old link: a page name plus an inner anchor', 'Voice &amp; notifications', '<div class="fallback">' + ic('info') + 'This link is from an older Murage. It now opens Dax &rsaquo; Voice &amp; notifications, at Calls.</div>', B('Go there', 'pri')) +
          dlg('Arrival: an app that is connected twice', 'Gmail', '<div class="fallback">' + ic('info') + 'A link that names the account opens that account. A link with no account opens Gmail at Which account? and chooses nothing for you.</div>', B('Choose an account', 'pri')) + '</div>')
    doc('deep-link.html', 'Why can\'t it: error card to setting', lab_('1. In chat', 'The Bot settings button in the chat header opens that bot at What it can reach (Decision 7). An error a setting causes names that setting and links to it. An error no setting causes links to What it can reach.') + chat +
        lab_('2. Arrival', 'murage://settings/bot.tools.email?bot=dax') +
        W('bot', 'btools', 'Tools', PB.TOOLS_SUB, arrive(), back=('the chat', '#')) + lab_('3. When the target is missing', 'One line, never a dead end') + fb,
        note='Rulings 5 and 6. The manifest id is the link. Arrival: the page opens, the sheet or Advanced group opens, the row is in the top third, focus moves to it, accent ring and tint for 2.5 s, then a left bar until the next click. A link only navigates; it never changes a value.')
    PAGES['deep-link.html'] = ('Why can\'t it: chat error card, arrival, fallbacks', S_, 'Deep link story')

    # --- simple vs advanced
    REG['view'] = 'simple'; a = W('app', 'computer', 'Computer & browser', 'Where your bots click and browse.', PA.computer_body(), view='simple')
    a = a.replace('<button type="button" class="nmore"', R('Allow outside browser tools', 'You changed this from its default, so it is shown in Simple too.', icon='plug', on=True, tg=[('Advanced',)]) + '<button type="button" class="nmore"', 1)
    REG['view'] = 'advanced'; b = W('app', 'computer', 'Computer & browser', 'Where your bots click and browse.', PA.computer_body(), view='advanced'); REG['view'] = 'simple'
    doc('simple-vs-advanced.html', 'Simple and Advanced', lab_('Simple', 'Each section ends with one line that names every Advanced control') + a + lab_('Advanced', 'Same page, same order. The same controls under the same divider.') + b,
        note='One Advanced pattern (visual H6): a sub-group at the foot of its section. Simple shows it as the line with Show. Advanced shows the rows under an Advanced divider. A sheet always shows it open under the same divider. No per-row tags, except a changed Advanced control shown in Simple (rule S7): Allow outside browser tools is drawn that way in the first window.')
    PAGES['simple-vs-advanced.html'] = ('Simple and Advanced', S_, 'One page, both views')

    # --- narrow
    L = 'Narrow and phone layouts'
    nw = lambda *a, **k: W(*a, frame='f-narrow', **k)
    doc('layout-narrow.html', 'Narrow window', lab_('Overview', '900 x 700') + nw('app', 'index', 'Overview', f'Your bots are running. {F.NEEDS_YOU} things need you.', PA.overview_body(), aside=PA.overview_aside()) +
        lab_('Providers') + nw('app', 'providers', 'Providers', 'Accounts, plans and keys you have.', PA.providers_body(), aside=steps(1)) +
        lab_('Phone & remote access') + nw('app', 'phone', 'Phone & remote access', 'Your devices, remote access, calls and other programs.', PA.phone_body()) +
        lab_('Bot: Tools, with a sheet open', 'Drawn alone on its own page, layout-narrow-sheet.html, so that the dialog holds every Tab stop.') +
        lab_('Search') + nw('app', '', 'Results for "email"', '7 results. Which did you mean?', search_email(), query='email'),
        note='Layout 2, 760 to 1023 px wide, drawn at 900 x 700. The rail narrows to 220 px and scrolls, with search pinned on top and the view switch pinned at the foot. One column; help folds under the content. A sheet covers the content area: there it is a modal dialog; the page, the rail and the Back and breadcrumb bar behind it are all inert; Tab and Shift+Tab stay inside it; and Esc or Close returns focus to the row that opened it. The narrow rail keeps an amber dot on each page that needs you. Under 1280 the help column folds first. These are real container queries in settings.css.')
    PAGES['layout-narrow.html'] = ('Narrow window: Overview, Providers, Phone, Search', L, '900 x 700')
    doc('layout-narrow-sheet.html', 'Narrow window: a sheet covers the page', nw('bot', 'btools', 'Tools', PB.TOOLS_SUB, PB.bot_tools_body(), sh=PB.bot_apps_sheet(), back=('Tools', '#')), solo=True,
        note='900 x 700. The sheet is a modal dialog that covers the whole content area. It starts at the top of the window, scrolls by itself, and keeps one header in view with Back, the title and Close. The page, the rail and the breadcrumb bar behind it are inert, and nothing else on this page can take focus, so Tab and Shift+Tab stay in the dialog. Esc and Close return focus to the row that opened it: that needs the built app (TASKS N1, Q3).')
    PAGES['layout-narrow-sheet.html'] = ('Narrow window: Gmail and other apps as a covering dialog', L, '900 x 700, alone on its page')

    ph = lambda cap, *a, **k: f'<figure><figcaption>{cap}</figcaption>{W(*a, frame="f-phone", **k)}</figure>'
    doc('layout-phone.html', 'Phone and web view', '<div class="frames">' +
        ph('<b>1. Settings.</b> The rail is the first screen. Search on top, view switch at the foot.', 'app', 'index', 'Overview', '', '', railscreen=True) +
        ph('<b>2. Overview.</b> A page pushes in. Back names where it goes. Changed recently is kept on the computer and is not sent to a phone. The shortcuts are only things this phone can do.', 'app', 'index', 'Overview', f'Your bots are running. {F.NEEDS_YOU} things need you.', PA.overview_body(phone=True), back=('Settings', '#')) +
        ph('<b>3. Providers, in the phone app.</b> Readouts only. Keys and model servers are added on your computer. A Store app never shows Add credit.', 'app', 'providers', 'Providers', 'Accounts, plans and keys you have.', PA.providers_phone(store=True), back=('Settings', '#')) +
        ph('<b>3b. Providers, in a phone browser.</b> The same readouts. Add credit is offered here, because this is not a Store app.', 'app', 'providers', 'Providers', 'Accounts, plans and keys you have.', PA.providers_phone(store=False), back=('Settings', '#')) +
        ph('<b>4. Phone &amp; remote access, on the phone itself.</b> Calls work here. Setup says where it is done.', 'app', 'phone', 'Phone & remote access', 'Calls, and your devices.', PA.phone_body(on_phone=True), back=('Settings', '#')) +
        ph('<b>5. Bot: Tools, on the phone.</b> Values only. Every switch here is a change to the bot, which only the computer may make, so each row says so. One tap target per row.', 'bot', 'btools', 'Tools', PB.TOOLS_SUB, PB.bot_tools_body(phone=True), back=('Dax', '#')) +
        ph('<b>6. Gmail and other apps, on the phone.</b> Which apps a bot may use is read and changed on the computer only, so the phone shows where to go and nothing else. A full-screen sheet with Back is drawn alone in layout-phone-sheet.html.', 'bot', 'btools', 'Gmail and other apps', 'Which apps Dax may use.',
           ban('Which apps Dax may use is set on your computer. This phone cannot see or change it, and cannot approve an app request.', 'off') +
           S('On your computer', R('Gmail and other apps', 'Open Dax, then Tools, on your computer.', icon='link', st=('', 'Computer only')), R('1 app request is waiting', 'Review it on your computer.', icon='warn', st=('warn', 'Needs you')), scope='Only Dax'), back=('Tools', '#')) +
        ph('<b>7. Search.</b> Same index. A result this phone cannot change is grey and says where to change it. A value kept to the computer is not shown, and is not sent to the phone.', 'app', '', 'Results for "port"', '4 results, all set on your computer.', search_port(phone=True), back=('Settings', '#')) +
        ph('<b>8. Bot: Engine &amp; model, on the phone.</b> The bot\'s usual model is set on the computer. The phone says so and points to what it can do.', 'bot', 'model', 'Engine & model', 'What runs Dax.',
           ban('On your phone you choose the model for one chat, in that chat\'s header. The model Dax starts every chat with is set on your computer.', 'off') +
           S('Engine and model', R('Engine', 'Change this on your computer.', icon='eng', st=('t', F.DAX['engine'])), R('Model', 'Change this on your computer.', icon='model', st=('t', F.DAX['model'])), scope='Only Dax'), back=('Dax', '#')) + '</div>',
        note='Layout 3, under 760 px: phone app, web view, or a very narrow window. Drawn at 390 x 844. Push navigation: rail, then page, then sheet as a full screen. Clicks count the same way: Settings, page, one reveal.')
    PAGES['layout-phone.html'] = ('Phone and web view: 9 screens', L, '390 x 844')
    this_phone = sheet('Pixel 9', 'This phone. Murage app 1.0.21 on Android 15. Added 2 Nov.',
        lab('Name') + line('Pixel 9', 'The name is changed on your computer.') +
        lab('What this phone may do', 'Set on your computer') + line('Reach your bots', '', txt('Always')) + line('Control the computer of a bot', '', txt('Off')) + line('Share and ask', '', txt('On')) +
        lab('Notifications') + line('<span id="tp1">Notifications on this phone</span>', 'With previews.', sw(True, 'tp1')) +
        rmzone('Removes Pixel 9 from your computer. It needs a new code to come back.', B('Sign out this device', 'dng')), 'phone', 'tph')
    doc('layout-phone-sheet.html', 'Phone: a sheet is a full screen with Back', '<div class="frames">' + ph('', 'app', 'phone', 'Pixel 9', '', '', sh=this_phone, back=('Phone & remote access', '#'), headless=True) + '</div>', solo=True,
        note='390 x 844. On a phone a sheet is a full screen. Its header carries the title and the one Back, and stays in view while the sheet scrolls; no second Back is drawn behind it. Nothing else on this page can take focus. The sheet is one this phone is allowed to use: its own device record and Sign out this device. The app access sheet is not drawn on a phone, because reading and changing it are computer only (server/route-policy.ts:398-399).')
    PAGES['layout-phone-sheet.html'] = ('Phone: a full-screen sheet with one Back', L, '390 x 844, alone on its page')
    import pages_skills as PS
    r1, r2, r3, r4, r5 = PS.skills_states()
    SUBS = f'{PS.ALLN} skills.'
    doc('skills-states.html', 'Skills: states', lab_('1. The library is getting ready', 'First open after an update. Your own skills and the ones on bots already work.') + W('app', 'skills', 'Skills', SUBS, r1) +
        lab_('2. Nothing matches', 'The one button widens the search') + W('app', 'skills', 'Skills', SUBS, r2) +
        lab_('3. The library could not be searched', 'Never drawn as an empty library') + W('app', 'skills', 'Skills', SUBS, r3) +
        lab_('4. A bot with no skills on') + W('bot', 'bskills', 'Skills', 'Know-how Otto follows. None on.', r4) +
        lab_('5. A bot that cannot use skills', 'The reason and the fix, not a dead switch') + W('bot', 'bskills', 'Skills', 'Know-how Zed follows.', r5),
        note='Skills states (skills study 3.5). The library index is built in the background after an update (libraryReady, server/skills-api.ts:331). A failed search never reads as No skills. A bot on the Grok API or a box agent cannot use skills (server/index.ts:33878); its page and its row in a skill sheet say why. Otto and Zed stand in for those two states; the fixture has no such bot.')
    PAGES['skills-states.html'] = ('Skills: getting ready, no match, could not search, none on, cannot use', S_, 'Five windows')

    # --- patterns
    pat = ('<div class="idx"><h1>Patterns and status words</h1><p>The rules every page follows. Builders copy these, not a page.</p>'
        '<h2>Status: one vocabulary, four colours</h2><div class="card">' +
        R('Green: working', 'Account or app: Signed in. Key: Working. Engine or computer: Ready. Messaging app: Connected. Tool or feature: On. Device: Connected now.', end=pill('ok', 'Signed in') + pill('ok', 'Working') + pill('ok', 'Ready') + pill('ok', 'Connected'), cls='why') +
        R('Amber: needs you', 'Always also listed under Needs you on Overview and marked in the rail.', end=pill('warn', 'Needs sign-in') + pill('warn', 'Needs you') + pill('warn', 'Removal pending')) +
        R('Red: broken and blocking a bot now', 'Always also under Needs you. Used rarely.', end=pill('bad', 'Stopped') + pill('bad', 'Not working')) +
        R('Grey: off, not set up, a count, or unknown', 'Never a warning. A count is plain text, never a pill.', end=pill('', 'Off') + pill('', 'Not set up') + pill('', 'Always on') + pill('', 'Could not check') + pill('', 'Checking') + txt('17 of 21')) +
        R('Saved is not a status', 'It is a line of text beside the control.', end=saved('Dark')) +
        R('A row with a switch has no pill', 'If the thing behind the switch is failing, the reason is the row\'s own line of text, and it is listed under Needs you.', icon='sliders', on=False) + '</div>'
        '<h2>Changing several: one bar, everywhere</h2><div class="card">' + selbar(3, 39, pick('Set approval level', 'Approval level') + B('Apply', 'sm pri')) +
        R('Tick rows, choose once, Apply', 'The bar appears only when a row is ticked. Apply saves one bot at a time and each row says how it went. A picker on a row still saves that one row at once.', icon='bots') + '</div>'
        '<h2>Switches say what On means</h2><div class="card">' + R('Calls today', 'On means the thing happens. No switch is named for turning something off.', icon='call', on=True) + '</div>'
        '<h2>Rows: three ways in, each looks different</h2><div class="card">' +
        R('Opens its sheet', 'The whole row is the target. Chevron at the end. No Change or Manage buttons.', icon='globe', on=True, open=True) +
        R('Goes to another page', 'Ends with the page name and an arrow.', icon='plug', go=('Connected apps', '#')) +
        R('Does something now', 'A visible button is always an action that happens when pressed.', icon='backup', act=B('Back up now', 'sm pri')) +
        R('Keyboard focus', 'One ring on every control.', icon='key', act='<button type="button" class="btn sm demo-focus">Focused</button>') + '</div>'
        '<h2>Remove: one zone, at the foot of the thing\'s sheet</h2><div class="card pad">' + rmzone('One line that says what is lost and how to come back.', B('Remove this device', 'dng')) + '</div>'
        '<h2>Scope tags: who does this change?</h2><div class="card pad"><span class="sc">Everywhere</span> <span class="sc">All bots</span> <span class="sc">Only Dax</span> <span class="sc">This computer</span> <span class="sc">Only here</span>'
        '<p style="margin-top:8px">On the section heading, right aligned. On a row only when it differs from its section. Where a value is stored goes in the helper line.</p></div>'
        '<h2>Tokens added in v4</h2><div class="card pad"><p><span class="sw" style="background:var(--accent-text)"></span>--accent-text for links and small orange text. '
        '<span class="sw" style="background:var(--accent-fill)"></span>--accent-fill for primary buttons and switches. <span class="sw" style="background:var(--ctl-line)"></span>--ctl-line for control edges. '
        '<span class="sw" style="background:var(--bad-fill)"></span>--bad-fill for the destructive confirm. <span class="sw" style="background:var(--focus)"></span>--focus for the ring.</p></div></div>')
    doc('patterns.html', 'Patterns', pat, note='Visual fixes in one place (ruling 11): status colour map, one way to open a row, one Remove pattern, one Advanced pattern (see simple-vs-advanced.html), scope tags, focus ring, tokens.')
    PAGES['patterns.html'] = ('Patterns and status words', S_, 'The contract builders copy')

def reference():
    rows = ''.join(f'<tr><th scope="row">{e(a)}</th><td>{e(b)}</td><td>{e(c)}</td></tr>' for a, b, c in F.table())
    doc('fixture.html', 'The fixture', '<div class="idx"><h1>The fixture: one owner, 39 bots, one Dax</h1><p>Every value below is defined once, in _gen/fixture.py. Every mockup reads it from there, and the build fails if a page disagrees.</p>'
        f'<div class="card"><table class="fx"><thead><tr><th scope="col">Fact</th><th scope="col">Value</th><th scope="col">Shown on</th></tr></thead><tbody>{rows}</tbody></table></div></div>',
        note='MAIN ruling, truth first. This table is the source for the mockups and becomes the Q1 fixture.')
    PAGES['fixture.html'] = ('The fixture table', 'Reference', 'One source for every mockup value')
    h = ''.join(f'<h3 id="help.{k}">{e(t)} <small>{k}</small></h3><p>{e(p)}</p>' for k, t, p in X.HELP)
    doc('help.html', 'Help topics', f'<div class="idx helpt"><h1>Help: the 24 topics</h1><p>Each named link in Settings opens the help panel at one of these, beside the page.</p>{h}</div>',
        note='The text of all 24 topics (build row H1). One short paragraph each, in the same words the pages use.')
    PAGES['help.html'] = ('Help: the 24 topics, written', 'Reference', 'One paragraph each')

def index():
    reference()
    order = ['App pages', 'Bot pages', 'Sheets and flows', 'Search', 'States', 'Narrow and phone layouts', 'Reference']
    h = '<div class="idx"><h1>Murage Settings v10 mockups</h1><p>Design only. Static pages, no scripts. Rail pages are drawn at the real window size, 1440 x 900. They follow light or dark from your system. Every value about the owner and the bots comes from one fixture (fixture.html). Companion documents: settings-v10-design/out/IA-PROPOSAL-v10.md and TASKS-v10.md.</p>'
    for g in order:
        items = [(f, t, d) for f, (t, gg, d) in PAGES.items() if gg == g]
        h += f'<h2>{g} ({len(items)})</h2><div class="grid">' + ''.join(f'<a href="{f}">{e(t)}<small>{e(d)}</small></a>' for f, t, d in items) + '</div>'
    FILES['index.html'] = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Murage Settings v9: all mockups</title>\n'
                           '<meta name="viewport" content="width=device-width, initial-scale=1">\n<link rel="stylesheet" href="icons.css">\n<link rel="stylesheet" href="settings.css">\n</head>\n<body>\n' + h + '</div>\n</body>\n</html>\n')
