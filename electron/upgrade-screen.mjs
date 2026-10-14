// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What the one wait window says while the memory upgrade runs before the server listens. The server and the start-up note give one reading in
// the contract's shape (shared/upgrade-contract.mjs, read by memory-upgrade-status.mjs); the window family of the reducer (shared/upgrade-machine.mjs)
// owns every figure (the percent, the time left, whether the work is moving, whether to stay open), and this module only turns its selection into
// words: the title, the sentence about what the owner has and how long it takes, the line for the step under way, a counter that is real, and a
// sentence for screen readers. The window (startup-splash.mjs) draws the view; it knows no words and no numbers of its own.
//
// Words: English plus the seven shipped languages, like the rest of the shell. Never on this screen: raw ids, file names, schema versions,
// seconds in an estimate, a bar that goes backwards, and anything that reads as the data being wrong.
import { formatDone, formatTotal, memorySpan } from "../shared/upgrade-wait.mjs";
import { initialContext, reduce, selectWindow } from "../shared/upgrade-machine.mjs";
import { memoryUpgradeLocale } from "./memory-upgrade-status.mjs";

export const UPGRADE_TEXT = {
  en: {
    "counting.title": "Getting Murage ready", "counting.line": "Looking at what you have", title: "Updating your memory",
    lead3: "You have {messages} messages in {conversations} conversations and {span} of memory.", lead2: "You have {messages} messages in {conversations} conversations.", lead1: "You have {messages} messages.", lead0: "Murage is getting your memory ready.",
    "span.years": "{n} years", "span.year": "a year", "span.months": "{n} months",
    wait: "This will take a while. Do not disconnect.", keep: "Keep Murage open.",
    "left.under": "Under a minute left.", "left.one": "About a minute left.", "left.many": "About {n} minutes left.",
    "slow.lead": "This step is taking a little longer. It is still moving.", "slow.percent": "{percent}% done.", "slow.long": "Still moving. Keep Murage open.",
    "line.checking": "Looking at what you have", "line.copying": "Making a copy first", "line.migrating": "Setting up the new memory format", "line.committing": "Writing the change", "line.generic": "Getting your memory ready",
    "counter.messages": "{done} of {total} messages", "counter.bytes": "{done} of {total}", footer: "Nothing is removed. Your conversations and memory stay as they are.",
    "finishing.title": "Opening Murage", "finishing.line": "Murage opens in a moment.", "aria.percent": "{percent} percent done.",
    "working.still": "Murage is still working. Keep Murage open.", minimize: "Minimize", quit: "Quit Murage", "quit.note": "Quitting now pauses this. Murage continues next time you open it.",
  },
  de: {
    "counting.title": "Murage wird vorbereitet", "counting.line": "Murage sieht sich an, was du hast", title: "Dein Gedächtnis wird aktualisiert",
    lead3: "Du hast {messages} Nachrichten in {conversations} Unterhaltungen und {span} Gedächtnis.", lead2: "Du hast {messages} Nachrichten in {conversations} Unterhaltungen.", lead1: "Du hast {messages} Nachrichten.", lead0: "Murage bereitet dein Gedächtnis vor.",
    "span.years": "{n} Jahre", "span.year": "ein Jahr", "span.months": "{n} Monate",
    wait: "Das dauert eine Weile. Trenne die Verbindung nicht.", keep: "Lass Murage geöffnet.",
    "left.under": "Weniger als eine Minute übrig.", "left.one": "Noch etwa eine Minute.", "left.many": "Noch etwa {n} Minuten.",
    "slow.lead": "Dieser Schritt dauert etwas länger. Es geht trotzdem weiter.", "slow.percent": "{percent} % erledigt.", "slow.long": "Es läuft weiter. Lass Murage geöffnet.",
    "line.checking": "Murage sieht sich an, was du hast", "line.copying": "Zuerst wird eine Kopie angelegt", "line.migrating": "Das neue Gedächtnisformat wird eingerichtet", "line.committing": "Die Änderung wird geschrieben", "line.generic": "Dein Gedächtnis wird vorbereitet",
    "counter.messages": "{done} von {total} Nachrichten", "counter.bytes": "{done} von {total}", footer: "Nichts wird entfernt. Deine Unterhaltungen und dein Gedächtnis bleiben, wie sie sind.",
    "finishing.title": "Murage wird geöffnet", "finishing.line": "Murage öffnet sich gleich.", "aria.percent": "{percent} Prozent erledigt.",
    "working.still": "Murage arbeitet noch. Lass Murage geöffnet.", minimize: "Minimieren", quit: "Murage beenden", "quit.note": "Wenn du jetzt beendest, wird das angehalten. Murage macht beim nächsten Öffnen weiter.",
  },
  es: {
    "counting.title": "Preparando Murage", "counting.line": "Revisando lo que tienes", title: "Actualizando tu memoria",
    lead3: "Tienes {messages} mensajes en {conversations} conversaciones y {span} de memoria.", lead2: "Tienes {messages} mensajes en {conversations} conversaciones.", lead1: "Tienes {messages} mensajes.", lead0: "Murage está preparando tu memoria.",
    "span.years": "{n} años", "span.year": "un año", "span.months": "{n} meses",
    wait: "Esto tardará un rato. No te desconectes.", keep: "Mantén Murage abierto.",
    "left.under": "Queda menos de un minuto.", "left.one": "Queda aproximadamente un minuto.", "left.many": "Quedan unos {n} minutos.",
    "slow.lead": "Este paso está tardando un poco más. Sigue avanzando.", "slow.percent": "{percent}% completado.", "slow.long": "Sigue avanzando. Mantén Murage abierto.",
    "line.checking": "Revisando lo que tienes", "line.copying": "Haciendo primero una copia", "line.migrating": "Preparando el nuevo formato de memoria", "line.committing": "Escribiendo el cambio", "line.generic": "Preparando tu memoria",
    "counter.messages": "{done} de {total} mensajes", "counter.bytes": "{done} de {total}", footer: "No se elimina nada. Tus conversaciones y tu memoria se quedan como están.",
    "finishing.title": "Abriendo Murage", "finishing.line": "Murage se abre en un momento.", "aria.percent": "{percent} por ciento completado.",
    "working.still": "Murage sigue trabajando. Mantén Murage abierto.", minimize: "Minimizar", quit: "Salir de Murage", "quit.note": "Si sales ahora, esto se pausa. Murage continúa la próxima vez que lo abras.",
  },
  fr: {
    "counting.title": "Préparation de Murage", "counting.line": "Examen de ce que tu as", title: "Mise à jour de ta mémoire",
    lead3: "Tu as {messages} messages dans {conversations} conversations et {span} de mémoire.", lead2: "Tu as {messages} messages dans {conversations} conversations.", lead1: "Tu as {messages} messages.", lead0: "Murage prépare ta mémoire.",
    "span.years": "{n} ans", "span.year": "un an", "span.months": "{n} mois",
    wait: "Cela prendra un moment. Ne te déconnecte pas.", keep: "Garde Murage ouvert.",
    "left.under": "Il reste moins d'une minute.", "left.one": "Il reste environ une minute.", "left.many": "Il reste environ {n} minutes.",
    "slow.lead": "Cette étape prend un peu plus de temps. Cela avance toujours.", "slow.percent": "{percent} % effectué.", "slow.long": "Cela avance toujours. Garde Murage ouvert.",
    "line.checking": "Examen de ce que tu as", "line.copying": "Création d'une copie d'abord", "line.migrating": "Mise en place du nouveau format de mémoire", "line.committing": "Enregistrement du changement", "line.generic": "Préparation de ta mémoire",
    "counter.messages": "{done} sur {total} messages", "counter.bytes": "{done} sur {total}", footer: "Rien n'est supprimé. Tes conversations et ta mémoire restent telles quelles.",
    "finishing.title": "Ouverture de Murage", "finishing.line": "Murage s'ouvre dans un instant.", "aria.percent": "{percent} pour cent effectué.",
    "working.still": "Murage travaille toujours. Garde Murage ouvert.", minimize: "Réduire", quit: "Quitter Murage", "quit.note": "Quitter maintenant met cela en pause. Murage continue à la prochaine ouverture.",
  },
  hi: {
    "counting.title": "Murage तैयार हो रहा है", "counting.line": "देखा जा रहा है कि आपके पास क्या है", title: "आपकी मेमोरी अपडेट हो रही है",
    lead3: "आपके पास {conversations} बातचीत में {messages} संदेश और {span} की मेमोरी है।", lead2: "आपके पास {conversations} बातचीत में {messages} संदेश हैं।", lead1: "आपके पास {messages} संदेश हैं।", lead0: "Murage आपकी मेमोरी तैयार कर रहा है।",
    "span.years": "{n} साल", "span.year": "एक साल", "span.months": "{n} महीने",
    wait: "इसमें कुछ समय लगेगा। डिस्कनेक्ट न करें।", keep: "Murage को खुला रखें।",
    "left.under": "एक मिनट से कम बचा है।", "left.one": "लगभग एक मिनट बचा है।", "left.many": "लगभग {n} मिनट बचे हैं।",
    "slow.lead": "इस चरण में थोड़ा ज़्यादा समय लग रहा है। काम अभी भी आगे बढ़ रहा है।", "slow.percent": "{percent}% पूरा।", "slow.long": "काम आगे बढ़ रहा है। Murage को खुला रखें।",
    "line.checking": "देखा जा रहा है कि आपके पास क्या है", "line.copying": "पहले एक कॉपी बनाई जा रही है", "line.migrating": "मेमोरी का नया फ़ॉर्मेट तैयार किया जा रहा है", "line.committing": "बदलाव लिखा जा रहा है", "line.generic": "आपकी मेमोरी तैयार की जा रही है",
    "counter.messages": "{total} में से {done} संदेश", "counter.bytes": "{total} में से {done}", footer: "कुछ भी हटाया नहीं जाता। आपकी बातचीत और मेमोरी जैसी हैं वैसी ही रहती हैं।",
    "finishing.title": "Murage खुल रहा है", "finishing.line": "Murage कुछ ही पल में खुलेगा।", "aria.percent": "{percent} प्रतिशत पूरा।",
    "working.still": "Murage अभी भी काम कर रहा है। Murage को खुला रखें।", minimize: "छोटा करें", quit: "Murage बंद करें", "quit.note": "अभी बंद करने पर यह काम रुक जाएगा। अगली बार Murage खोलने पर यह आगे बढ़ेगा।",
  },
  ja: {
    "counting.title": "Murage を準備しています", "counting.line": "お持ちのデータを確認しています", title: "メモリを更新しています",
    lead3: "{conversations}件の会話に{messages}件のメッセージと、{span}分のメモリがあります。", lead2: "{conversations}件の会話に{messages}件のメッセージがあります。", lead1: "メッセージが{messages}件あります。", lead0: "Murage がメモリを準備しています。",
    "span.years": "{n}年", "span.year": "1年", "span.months": "{n}か月",
    wait: "しばらく時間がかかります。接続を切らないでください。", keep: "Murage は開いたままにしてください。",
    "left.under": "残り1分未満です。", "left.one": "残り約1分です。", "left.many": "残り約{n}分です。",
    "slow.lead": "このステップには少し時間がかかっています。処理は進んでいます。", "slow.percent": "{percent}% 完了。", "slow.long": "処理は進んでいます。Murage は開いたままにしてください。",
    "line.checking": "お持ちのデータを確認しています", "line.copying": "最初にコピーを作成しています", "line.migrating": "新しいメモリ形式を準備しています", "line.committing": "変更を書き込んでいます", "line.generic": "メモリを準備しています",
    "counter.messages": "{total}件中{done}件のメッセージ", "counter.bytes": "{total}中{done}", footer: "何も削除されません。会話とメモリはそのまま残ります。",
    "finishing.title": "Murage を開いています", "finishing.line": "まもなく Murage が開きます。", "aria.percent": "{percent}パーセント完了。",
    "working.still": "Murage は作業を続けています。開いたままにしてください。", minimize: "最小化", quit: "Murage を終了", "quit.note": "今終了すると、この処理は一時停止します。次に Murage を開くと続きから進みます。",
  },
  pt: {
    "counting.title": "Preparando o Murage", "counting.line": "Vendo o que você tem", title: "Atualizando sua memória",
    lead3: "Você tem {messages} mensagens em {conversations} conversas e {span} de memória.", lead2: "Você tem {messages} mensagens em {conversations} conversas.", lead1: "Você tem {messages} mensagens.", lead0: "O Murage está preparando sua memória.",
    "span.years": "{n} anos", "span.year": "um ano", "span.months": "{n} meses",
    wait: "Isso vai levar um tempo. Não desconecte.", keep: "Mantenha o Murage aberto.",
    "left.under": "Falta menos de um minuto.", "left.one": "Falta cerca de um minuto.", "left.many": "Faltam cerca de {n} minutos.",
    "slow.lead": "Esta etapa está demorando um pouco mais. Continua avançando.", "slow.percent": "{percent}% concluído.", "slow.long": "Continua avançando. Mantenha o Murage aberto.",
    "line.checking": "Vendo o que você tem", "line.copying": "Primeiro, fazendo uma cópia", "line.migrating": "Preparando o novo formato de memória", "line.committing": "Gravando a mudança", "line.generic": "Preparando sua memória",
    "counter.messages": "{done} de {total} mensagens", "counter.bytes": "{done} de {total}", footer: "Nada é removido. Suas conversas e sua memória continuam como estão.",
    "finishing.title": "Abrindo o Murage", "finishing.line": "O Murage abre em instantes.", "aria.percent": "{percent} por cento concluído.",
    "working.still": "O Murage ainda está trabalhando. Mantenha o Murage aberto.", minimize: "Minimizar", quit: "Sair do Murage", "quit.note": "Sair agora pausa isso. O Murage continua na próxima vez que você abrir.",
  },
  zh: {
    "counting.title": "正在准备 Murage", "counting.line": "正在查看你拥有的内容", title: "正在更新你的记忆",
    lead3: "你有 {conversations} 个对话、{messages} 条消息,以及 {span}的记忆。", lead2: "你有 {conversations} 个对话、{messages} 条消息。", lead1: "你有 {messages} 条消息。", lead0: "Murage 正在准备你的记忆。",
    "span.years": "{n} 年", "span.year": "1 年", "span.months": "{n} 个月",
    wait: "这需要一些时间。请勿断开连接。", keep: "请保持 Murage 打开。",
    "left.under": "剩余不到一分钟。", "left.one": "大约还剩一分钟。", "left.many": "大约还剩 {n} 分钟。",
    "slow.lead": "这一步需要多花一点时间。它仍在推进。", "slow.percent": "已完成 {percent}%。", "slow.long": "仍在推进。请保持 Murage 打开。",
    "line.checking": "正在查看你拥有的内容", "line.copying": "先创建一份副本", "line.migrating": "正在设置新的记忆格式", "line.committing": "正在写入更改", "line.generic": "正在准备你的记忆",
    "counter.messages": "{total} 条消息中的 {done} 条", "counter.bytes": "{total} 中的 {done}", footer: "不会删除任何内容。你的对话和记忆保持原样。",
    "finishing.title": "正在打开 Murage", "finishing.line": "Murage 即将打开。", "aria.percent": "已完成百分之 {percent}。",
    "working.still": "Murage 仍在工作。请保持 Murage 打开。", minimize: "最小化", quit: "退出 Murage", "quit.note": "现在退出会暂停这项工作。下次打开 Murage 时会继续。",
  },
};

const fill = (template, params) => template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));

/** The sentence for a number of minutes from `etaMinutes`: 0 under a minute, 1 about a minute, more "about N minutes". `kind` is "left". */
export function etaSentence(text, kind, minutes) {
  if (minutes === 0) return text[`${kind}.under`];
  if (minutes === 1) return text[`${kind}.one`];
  return fill(text[`${kind}.many`], { n: minutes });
}

/** A step named by the phase. The last of the migration's steps writes the change (the heartbeat's step label says which one is running). */
function lineKey(phaseId, step) {
  if (phaseId === "checking") return "line.checking";
  if (phaseId === "copying") return "line.copying";
  if (phaseId === "migrating") return step === "committing" ? "line.committing" : "line.migrating";
  return "line.generic";
}

/** The wait window's view of an upgrade, one per shell launch. It holds the window family of the reducer, so what it has shown (the percent, the time
 * left) never goes back, and it says only what the reading knows: counts only when they are exact, a percent only once a known launch has said how far
 * it is, "still working" only when nothing has advanced for a minute (and then no estimate), and nothing about how long is left unless a steady estimate holds. */
export function createUpgradeScreen({ language, now = Date.now, describeBytes = (n) => String(n) } = {}) {
  const lang = memoryUpgradeLocale(language);
  const text = UPGRADE_TEXT[lang] ?? UPGRADE_TEXT.en;
  const locale = typeof language === "string" && language ? language.replace("_", "-") : "en";
  let ctx = initialContext("window");
  let lastCounter = null, step = "";
  const base = { locale, footer: text.footer, minimizable: true, controls: { minimize: text.minimize, quit: text.quit, quitNote: text["quit.note"] } };
  const counterOf = (counter) => {
    if (!counter) return null;
    if (counter.unit === "messages" && counter.total > 1) return { kind: "count", done: counter.done, total: counter.total, template: text["counter.messages"] };
    if (counter.unit === "bytes" && counter.total > 0) return { kind: "text", text: fill(text["counter.bytes"], { done: describeBytes(counter.done), total: describeBytes(counter.total) }) };
    return null;
  };
  /** The words for the reducer's selection. */
  const render = () => {
    const v = selectWindow(ctx);
    if (!v) return null;
    if (v.mode === "finishing") {
      const counter = lastCounter?.kind === "count" ? { ...lastCounter, done: lastCounter.total } : lastCounter;
      return { ...base, mode: "finishing", title: text["finishing.title"], lead: "", line: text["finishing.line"], counter, percent: v.percent, indeterminate: v.percent === null, elapsedMs: null, keepOpen: false, aria: `${text["finishing.title"]}. ${text["finishing.line"]}` };
    }
    const counter = counterOf(v.counter);
    lastCounter = counter;
    const line = text[lineKey(v.phaseId, step)];
    if (v.mode === "counting") {
      const view = { ...base, mode: "counting", title: text["counting.title"], lead: "", line: text["counting.line"], counter: null, percent: v.percent, indeterminate: true, elapsedMs: v.elapsedMs, keepOpen: v.keepOpen };
      return { ...view, aria: view.line };
    }
    const left = v.etaMinutes !== null ? etaSentence(text, "left", v.etaMinutes) : "";
    const counterSentence = counter?.kind === "count" ? fill(text["counter.messages"], { done: formatDone(counter.done, locale), total: formatTotal(counter.total, locale) }) + "." : "";
    let leadText;
    if (v.longSlow) leadText = text["slow.long"];
    else if (v.slow) leadText = [text["slow.lead"], counterSentence || (v.percent === null ? "" : fill(text["slow.percent"], { percent: v.percent })), left].filter(Boolean).join(" ");
    // a real stall: the plain line alone, never an estimate made from movement that has stopped
    else if (v.late) leadText = text["working.still"];
    else if (v.neutral) leadText = [text["working.still"], left].filter(Boolean).join(" ");
    // Before a steady estimate exists nothing is said about how long: only that it takes a while. A measured estimate is shown once it holds.
    else leadText = [leadSentence(text, v.counts, locale, now()), ...(v.etaMinutes !== null ? [left, text.keep] : [text.wait])].join(" ");
    const ariaParts = [];
    if (v.percent !== null) ariaParts.push(fill(text["aria.percent"], { percent: v.percent }));
    if (counterSentence) ariaParts.push(counterSentence);
    if (left) ariaParts.push(left);
    if (ariaParts.length === 0) ariaParts.push(line);
    return { ...base, mode: v.slow ? "slow" : "blocking", title: text.title, lead: leadText, line, counter, percent: v.percent, indeterminate: v.indeterminate, elapsedMs: v.elapsedMs, keepOpen: v.keepOpen, aria: ariaParts.join(" ") };
  };
  const dispatch = (event) => { ctx = reduce(ctx, { at: now(), ...event }); return render(); };
  return {
    text,
    /** The view for one reading of the note (or of the 503 body): `status.upgrade` is the contract's parsed result. A reading that does not parse is
     * kept out of the figures and the view carries on (a server that predates the contract shows activity only). */
    update(status, _percent, { copiedBytes } = {}) {
      if (!status) return dispatch({ type: "READ_FAILED" });
      step = typeof status.step === "string" ? status.step : step;
      const parsed = status.upgrade;
      if (!parsed?.ok) return dispatch({ type: "MALFORMED", reason: parsed?.reason ?? "legacy" });
      const copy = copiedBytes > 0 && status.copyBytes > 0 ? { done: Math.min(copiedBytes, status.copyBytes), total: status.copyBytes } : null;
      return dispatch({ type: "READING", state: parsed.state, copy });
    },
    /** Nothing could be read this time (the note is missing or unwritable and the server did not answer either): the view carries on. */
    failed() { return dispatch({ type: "READ_FAILED" }); },
    /** Time passes with no new reading (the sleep gap is noticed here too). */
    tick() { return dispatch({ type: "TICK" }); },
    /** The computer is going to sleep (the shell's power hook): the time asleep is not time waited. */
    suspend() { return dispatch({ type: "SUSPEND" }); },
    /** The computer woke: estimates made before sleep say nothing about after, so the gate and the sense of "moving" start again. */
    wake() { return dispatch({ type: "RESUME" }); },
    /** The server is listening (or the window is about to open): the same window says the app is opening. */
    finishing({ ready = false } = {}) { return dispatch({ type: "LISTEN", ready }) ?? render(); },
    /** The machine's context, for tests. */
    context: () => ctx,
  };
}

/** "You have 1.2 million messages in 48,000 conversations and 8 years of memory." with whatever of it is known. */
export function leadSentence(text, counts, locale, now = Date.now()) {
  const messages = counts?.messages > 0 ? formatTotal(counts.messages, locale) : null;
  const conversations = counts?.conversations > 0 ? formatTotal(counts.conversations, locale) : null;
  if (!messages) return text.lead0;
  if (!conversations) return fill(text.lead1, { messages });
  const span = memorySpan(counts.firstMessageAt, now);
  if (!span) return fill(text.lead2, { messages, conversations });
  return fill(text.lead3, { messages, conversations, span: fill(text[`span.${span.kind}`], { n: span.n }) });
}
