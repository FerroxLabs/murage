// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lexicons for the Murage for Chrome hard floor (spec 2.5.3), in eight
// languages: English, Spanish, French, German, Portuguese (Brazil), Japanese,
// Chinese (simplified and traditional) and Hindi.
//
// One table per job. Every table must carry all eight languages (the type
// enforces it and a test checks none is empty). The classifier matches across
// all eight languages on every page, because the page language is not known.
//
// Matching rules (spec 2.5.3): text is NFKC-normalised, lower-cased, stripped
// of zero-width characters, accents and punctuation, and whitespace is
// collapsed before matching. Scripts that use spaces match on word boundaries;
// Japanese and Chinese match as substrings. An entry that starts with "=" must
// equal the whole text (after the same clean-up).
//
// The destructive and pay patterns at the bottom are ported from Sean's own
// FoundryInChrome (src/lib/automation/trust.ts, DESTRUCTIVE_PATTERNS). It is
// his code, copied here on purpose and not imported.

export const FLOOR_LANGS = ["en", "es", "fr", "de", "pt", "ja", "zh", "hi"] as const;
export type FloorLang = (typeof FLOOR_LANGS)[number];
export type PhraseTable = Record<FloorLang, readonly string[]>;

// ---------------------------------------------------------------------------
// Text clean-up and matching
// ---------------------------------------------------------------------------

const INVISIBLE = /[­͏᠎​-‏‪-‮⁠-⁤﻿]/gu;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** The one normal form used for both phrases and page text. */
export function foldText(input: string): string {
  let s = String(input ?? "").normalize("NFKC").replace(INVISIBLE, "").toLowerCase();
  s = s.replace(/[‘’ʼʹ`´]/gu, "'");
  s = s.normalize("NFD").replace(/[̀-ͯ]/gu, "").normalize("NFC");
  s = s.replace(/&/gu, " and ");
  s = s.replace(/[^\p{L}\p{N}\p{M}'\s]/gu, " ");
  return s.replace(/\s+/gu, " ").trim();
}

export interface PhraseMatcher {
  /** Does folded text contain (or, for "=" entries, equal) any phrase? */
  test(folded: string): boolean;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function compilePhrases(table: PhraseTable): PhraseMatcher {
  const exact = new Set<string>();
  const substrings: string[] = [];
  const spaced: string[] = [];
  for (const lang of FLOOR_LANGS) {
    for (const raw of table[lang]) {
      const isExact = raw.startsWith("=");
      const phrase = foldText(isExact ? raw.slice(1) : raw);
      if (!phrase) continue;
      if (isExact) exact.add(phrase);
      else if (CJK.test(phrase)) substrings.push(phrase);
      else spaced.push(phrase);
    }
  }
  spaced.sort((a, b) => b.length - a.length);
  const boundary = spaced.length
    ? new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])(?:${spaced.map(escapeRegex).join("|")})(?![\\p{L}\\p{N}\\p{M}])`, "u")
    : null;
  return {
    test(folded: string): boolean {
      if (!folded) return false;
      if (exact.has(folded)) return true;
      if (boundary && boundary.test(folded)) return true;
      for (const phrase of substrings) if (folded.includes(phrase)) return true;
      return false;
    },
  };
}

// ---------------------------------------------------------------------------
// F1. Terms, policies and consent
// ---------------------------------------------------------------------------

/** Controls whose name says they accept or agree. Floor on their own. */
export const CONSENT_CONTROL_STRONG: PhraseTable = {
  en: ["i agree", "i accept", "i consent", "i have read and agree", "i have read and accept", "i understand and agree", "yes i agree", "yes i accept", "agree and continue", "agree and join", "agree and sign up", "agree and proceed", "agree and close", "agree to all", "agree to terms", "agree to the terms", "agree to cookies", "accept and continue", "accept and close", "accept and proceed", "accept and sign in", "accept all", "accept all cookies", "accept cookies", "accept terms", "accept the terms", "accept recommended", "consent to all", "allow all", "allow all cookies", "allow cookies"],
  es: ["acepto", "estoy de acuerdo", "he leído y acepto", "doy mi consentimiento", "consiento", "aceptar todo", "aceptar todas", "aceptar todas las cookies", "aceptar cookies", "aceptar y continuar", "aceptar y cerrar", "aceptar y seguir", "aceptar y registrarme", "aceptar y unirme", "aceptar los términos", "aceptar términos y condiciones", "de acuerdo y continuar", "estoy de acuerdo y continuar", "permitir todo", "permitir todas", "permitir todas las cookies", "permitir cookies"],
  fr: ["j'accepte", "je suis d'accord", "j'ai lu et j'accepte", "je consens", "tout accepter", "accepter tout", "accepter et continuer", "accepter et fermer", "accepter et poursuivre", "accepter et s'inscrire", "accepter les cookies", "accepter tous les cookies", "accepter les conditions", "d'accord et continuer", "j'accepte et je continue", "tout autoriser", "autoriser tout", "autoriser tous les cookies", "autoriser les cookies"],
  de: ["ich stimme zu", "ich akzeptiere", "ich bin einverstanden", "ich habe gelesen und akzeptiere", "ich willige ein", "alle akzeptieren", "alles akzeptieren", "alle annehmen", "alle cookies akzeptieren", "cookies akzeptieren", "akzeptieren und weiter", "akzeptieren und fortfahren", "akzeptieren und schließen", "akzeptieren und schliessen", "zustimmen und weiter", "zustimmen und fortfahren", "zustimmen und schließen", "einverstanden und weiter", "alle zulassen", "alle cookies zulassen", "agb akzeptieren", "bedingungen akzeptieren"],
  pt: ["eu concordo", "eu aceito", "concordo", "aceito", "aceito tudo", "li e concordo", "li e aceito", "eu consinto", "dou meu consentimento", "aceitar tudo", "aceitar todos", "aceitar todos os cookies", "aceitar cookies", "aceitar e continuar", "aceitar e fechar", "aceitar e entrar", "aceitar e criar conta", "aceitar termos", "concordar e continuar", "concordar com os termos", "concordo e continuo", "permitir tudo", "permitir todos os cookies", "permitir cookies", "autorizar tudo"],
  ja: ["同意します", "同意して続行", "同意して次へ", "同意して進む", "同意して登録", "同意して開始", "同意してログイン", "同意してアカウントを作成", "同意して閉じる", "承諾します", "承諾する", "承認して続行", "すべて同意", "全て同意", "すべて許可", "全て許可", "すべて受け入れる", "全て受け入れる", "すべて承諾", "すべて承認", "すべてのcookieを許可", "すべてのクッキーを許可", "クッキーを許可", "cookieを許可", "利用規約に同意", "規約に同意", "プライバシーポリシーに同意"],
  zh: ["我同意", "我接受", "我已阅读并同意", "我已閱讀並同意", "同意并继续", "同意並繼續", "同意并注册", "同意並註冊", "同意并登录", "同意并关闭", "接受并继续", "接受並繼續", "全部接受", "接受全部", "接受所有", "接受所有cookie", "接受cookie", "允许所有", "允許所有", "允许全部", "全部允许", "全部允許", "同意所有", "同意全部", "同意条款", "同意條款", "同意隐私政策", "同意隱私權政策", "同意用户协议", "同意使用条款"],
  hi: ["मैं सहमत हूं", "मैं सहमत हूँ", "मैं स्वीकार करता हूं", "मैं स्वीकार करता हूँ", "मैं स्वीकार करती हूं", "मैं स्वीकार करती हूँ", "सहमत हूं", "सहमत हूँ", "मैं सहमति देता हूं", "सहमति दें", "सहमत और जारी रखें", "सहमत होकर जारी रखें", "स्वीकार करें और जारी रखें", "स्वीकार करें और बंद करें", "सभी स्वीकार करें", "सभी को स्वीकार करें", "सभी कुकीज़ स्वीकार करें", "कुकीज़ स्वीकार करें", "सभी की अनुमति दें", "सभी कुकीज़ की अनुमति दें", "मैंने पढ़ लिया है और सहमत हूं", "शर्तें स्वीकार करें", "नियम और शर्तें स्वीकार करें"],
};

/** Bare ambiguous words. Floor only when consent, challenge or payment context is present. */
export const CONSENT_CONTROL_WEAK: PhraseTable = {
  en: ["=accept", "=agree", "=allow", "=confirm", "=continue", "=proceed", "=got it", "=i understand"],
  es: ["=aceptar", "=de acuerdo", "=confirmar", "=continuar", "=permitir", "=entendido", "=lo entiendo"],
  fr: ["=accepter", "=d'accord", "=confirmer", "=continuer", "=autoriser", "=compris", "=j'ai compris"],
  de: ["=akzeptieren", "=zustimmen", "=einverstanden", "=bestätigen", "=weiter", "=fortfahren", "=zulassen", "=verstanden"],
  pt: ["=aceitar", "=concordar", "=confirmar", "=continuar", "=permitir", "=entendi", "=entendido"],
  ja: ["=同意", "=同意する", "=承諾", "=承認", "=受け入れる", "=確認", "=確認する", "=続ける", "=続行", "=許可", "=許可する", "=理解しました", "=わかりました"],
  zh: ["=同意", "=接受", "=确认", "=確認", "=继续", "=繼續", "=允许", "=允許", "=我知道了", "=知道了"],
  hi: ["=सहमत", "=सहमत हैं", "=स्वीकार करें", "=स्वीकारें", "=पुष्टि करें", "=जारी रखें", "=अनुमति दें", "=समझ गया", "=समझ गई"],
};

/** Words in a checkbox, switch or radio name that say it binds the owner. */
export const CONSENT_AGREE_VERB: PhraseTable = {
  en: ["agree", "agreed", "accept", "consent", "acknowledge", "i have read", "i've read", "authorize", "authorise"],
  es: ["acepto", "aceptar", "acepta", "estoy de acuerdo", "de acuerdo con", "consiento", "consentimiento", "reconozco", "he leído", "autorizo"],
  fr: ["j'accepte", "accepter", "accepte", "je suis d'accord", "d'accord avec", "je consens", "je reconnais", "j'ai lu", "j'autorise", "autorise"],
  de: ["stimme zu", "zustimmen", "akzeptiere", "akzeptieren", "einverstanden", "willige ein", "habe gelesen", "gelesen und"],
  pt: ["concordo", "concordar", "aceito", "aceitar", "consinto", "reconheço", "li e", "autorizo"],
  ja: ["同意", "承諾", "承認", "受け入れ", "了承", "確認しました", "読みました", "理解しました"],
  zh: ["同意", "接受", "我已阅读", "我已閱讀", "已阅读", "已閱讀", "授权", "授權", "承认", "确认已", "确认我已"],
  hi: ["सहमत", "स्वीकार", "सहमति", "मैंने पढ़ लिया", "पढ़ा है", "अधिकृत", "मान्यता"],
};

/** Subjects that terms and consent are about. */
export const CONSENT_TOPIC: PhraseTable = {
  en: ["terms", "conditions", "policy", "policies", "privacy", "eula", "license", "licence", "cookie", "cookies", "consent", "agreement", "gdpr", "data processing", "disclaimer", "waiver"],
  es: ["términos", "condiciones", "política", "políticas", "privacidad", "licencia", "cookies", "consentimiento", "acuerdo", "aviso legal", "contrato", "protección de datos"],
  fr: ["conditions", "termes", "politique", "confidentialité", "licence", "cookies", "consentement", "accord", "mentions légales", "cgu", "cgv", "protection des données"],
  de: ["bedingungen", "agb", "nutzungsbedingungen", "datenschutz", "datenschutzerklärung", "richtlinie", "lizenz", "cookies", "einwilligung", "vereinbarung", "haftungsausschluss"],
  pt: ["termos", "condições", "política", "políticas", "privacidade", "licença", "cookies", "consentimento", "acordo", "contrato", "proteção de dados"],
  ja: ["利用規約", "規約", "約款", "プライバシー", "ポリシー", "ライセンス", "クッキー", "cookie", "同意", "契約", "個人情報"],
  zh: ["条款", "條款", "条件", "條件", "政策", "隐私", "隱私", "协议", "協議", "cookie", "同意", "声明", "聲明", "合同"],
  hi: ["शर्तें", "शर्तों", "नियम", "नीति", "गोपनीयता", "लाइसेंस", "कुकी", "कुकीज़", "सहमति", "समझौता", "अनुबंध", "डेटा सुरक्षा"],
};

/** The start of a click-to-agree sentence: "By clicking ...", "By continuing ...". */
export const SENTENCE_BY_ACTION: PhraseTable = {
  en: ["by clicking", "by tapping", "by pressing", "by selecting", "by continuing", "by signing up", "by signing in", "by logging in", "by creating", "by registering", "by placing", "by submitting", "by joining", "by proceeding", "by using", "by checking", "by ticking", "by completing", "by purchasing", "by subscribing", "by accessing"],
  es: ["al hacer clic", "al pulsar", "al continuar", "al registrarte", "al registrarse", "al crear", "al iniciar sesión", "al realizar", "al enviar", "al unirte", "al usar", "al utilizar", "al suscribirte", "al comprar"],
  fr: ["en cliquant", "en continuant", "en vous inscrivant", "en créant", "en passant", "en validant", "en soumettant", "en vous connectant", "en utilisant", "en rejoignant", "en appuyant", "en cochant", "en achetant", "en vous abonnant", "en poursuivant"],
  de: ["mit dem klick", "durch klicken", "durch klick", "indem sie auf", "indem du auf", "mit der anmeldung", "durch die anmeldung", "durch die registrierung", "mit der registrierung", "durch fortfahren", "mit dem fortfahren", "durch die nutzung", "durch die bestellung", "mit der bestellung", "durch das erstellen", "durch das absenden", "mit dem absenden", "wenn sie auf", "wenn du auf"],
  pt: ["ao clicar", "ao continuar", "ao se cadastrar", "ao cadastrar-se", "ao criar", "ao registrar", "ao fazer", "ao finalizar", "ao enviar", "ao usar", "ao utilizar", "ao entrar", "ao se inscrever", "ao comprar", "ao prosseguir"],
  ja: ["をクリックすると", "クリックすると", "続行すると", "続けると", "登録すると", "アカウントを作成すると", "注文を確定すると", "ログインすると", "送信すると", "利用すると", "タップすると", "押すと", "進むと"],
  zh: ["点击即", "點擊即", "继续即", "繼續即", "注册即", "註冊即", "登录即", "登錄即", "创建账户即", "创建账号即", "提交订单即", "下单即", "使用即", "即表示", "即视为", "即視為", "即代表", "即默认", "即默認", "继续使用"],
  hi: ["क्लिक करके", "जारी रखकर", "साइन अप करके", "खाता बनाकर", "ऑर्डर देकर", "पंजीकरण करके", "सबमिट करके", "उपयोग करके", "लॉग इन करके", "जारी रखने पर", "क्लिक करने पर", "साइन अप करने पर", "खाता बनाने पर"],
};

/** The agreement half of a click-to-agree sentence. */
export const SENTENCE_AGREE: PhraseTable = {
  en: ["you agree", "you accept", "you consent", "you acknowledge", "you are agreeing", "you're agreeing", "you confirm that you have read", "you have read and agree", "i agree", "i accept", "i have read", "agree to our", "agree to the", "accept our", "accept the terms"],
  es: ["aceptas", "aceptan", "usted acepta", "estás de acuerdo", "estas de acuerdo", "estás aceptando", "consientes", "reconoces", "acepto", "estoy de acuerdo", "he leído"],
  fr: ["vous acceptez", "tu acceptes", "vous êtes d'accord", "vous consentez", "vous reconnaissez", "vous confirmez avoir lu", "j'accepte", "j'ai lu", "acceptez nos", "acceptez les"],
  de: ["stimmen sie zu", "stimmst du zu", "stimmen sie den", "erklären sie sich", "erklärst du dich", "akzeptieren sie", "akzeptierst du", "sie akzeptieren", "sie stimmen", "ich stimme zu", "ich akzeptiere", "einverstanden"],
  pt: ["você concorda", "voce concorda", "você aceita", "você consente", "você reconhece", "concorda com", "você está concordando", "concordo", "aceito", "li e", "aceita os", "aceita nossos"],
  ja: ["同意したことになります", "同意したものとみなされ", "同意したものとみなします", "同意するものとします", "同意したとみなし", "同意します", "同意の上", "承諾したものと", "承諾します", "同意したことに", "同意したもの"],
  zh: ["您同意", "你同意", "您接受", "你接受", "表示您同意", "表示同意", "表示你同意", "视为同意", "視為同意", "我同意", "已阅读并同意", "已閱讀並同意", "同意并接受", "同意我们的", "同意我們的", "接受我们的"],
  hi: ["आप सहमत होते हैं", "आप सहमत हैं", "आप स्वीकार करते हैं", "आप सहमति देते हैं", "सहमत होते हैं", "सहमत हैं", "मैं सहमत", "मैं स्वीकार", "आप मानते हैं", "आप सहमति"],
};

/**
 * Refusals. Declining binds nothing (decision D2), so these are never F1 floor.
 * "=" entries are whole-name matches ("Accept and close" must not be read as "close").
 */
export const CONSENT_DECLINE: PhraseTable = {
  en: ["reject all", "reject", "decline", "decline all", "deny", "refuse", "disagree", "only necessary", "necessary only", "only essential", "essential only", "continue without accepting", "continue without agreeing", "no thanks", "no thank you", "not now", "maybe later", "i do not agree", "i don't agree", "i do not accept", "i don't accept", "do not accept", "don't accept", "do not agree", "don't agree", "opt out", "do not sell", "=close", "=cancel", "=dismiss", "=no", "=back", "=skip", "=x"],
  es: ["rechazar todo", "rechazar todas", "rechazar", "denegar", "declinar", "no acepto", "no estoy de acuerdo", "no consiento", "no permitir", "solo necesarias", "solo las necesarias", "solo esenciales", "solo cookies necesarias", "continuar sin aceptar", "no gracias", "no, gracias", "ahora no", "quizás más tarde", "=cerrar", "=cancelar", "=no", "=volver", "=omitir", "=x"],
  fr: ["tout refuser", "refuser tout", "refuser", "décliner", "je refuse", "je n'accepte pas", "je ne suis pas d'accord", "ne pas accepter", "ne pas autoriser", "uniquement nécessaires", "seulement les nécessaires", "cookies nécessaires uniquement", "continuer sans accepter", "non merci", "pas maintenant", "plus tard", "=fermer", "=annuler", "=non", "=retour", "=passer", "=x"],
  de: ["alle ablehnen", "ablehnen", "verweigern", "nicht zustimmen", "ich stimme nicht zu", "ich lehne ab", "nicht akzeptieren", "nicht zulassen", "nur notwendige", "nur erforderliche", "nur essenzielle", "nur technisch notwendige", "ohne zustimmung fortfahren", "weiter ohne zustimmung", "ohne zu akzeptieren", "nein danke", "nicht jetzt", "später", "=schließen", "=schliessen", "=abbrechen", "=nein", "=zurück", "=überspringen", "=x"],
  pt: ["rejeitar tudo", "rejeitar todos", "rejeitar", "recusar tudo", "recusar", "negar", "discordo", "não aceito", "não concordo", "não consinto", "não permitir", "apenas necessários", "somente necessários", "apenas essenciais", "continuar sem aceitar", "não, obrigado", "não obrigado", "agora não", "talvez depois", "=fechar", "=cancelar", "=não", "=voltar", "=pular", "=x"],
  ja: ["すべて拒否", "全て拒否", "拒否", "同意しません", "同意しない", "承諾しません", "必須のみ", "必要なもののみ", "必要なクッキーのみ", "必須クッキーのみ", "同意せずに続行", "同意せず", "=いいえ", "=後で", "今はしない", "=閉じる", "キャンセル", "=戻る", "スキップ", "許可しない"],
  zh: ["全部拒绝", "全部拒絕", "拒绝全部", "拒绝所有", "拒绝", "拒絕", "我不同意", "不同意", "不接受", "仅必要", "僅必要", "仅限必要", "僅限必要", "仅接受必要", "仅允许必要", "不，谢谢", "不谢谢", "暂不", "稍后", "以后再说", "=关闭", "=關閉", "=取消", "=返回", "=跳过", "=跳過", "=否", "=不", "不允许", "不允許"],
  hi: ["सभी अस्वीकार करें", "अस्वीकार करें", "अस्वीकार", "मना करें", "इनकार करें", "सहमत नहीं", "मैं सहमत नहीं", "स्वीकार नहीं", "अनुमति न दें", "केवल आवश्यक", "सिर्फ आवश्यक", "बिना स्वीकार किए जारी रखें", "नहीं धन्यवाद", "अभी नहीं", "=बाद में", "=बंद करें", "=रद्द करें", "=नहीं", "=वापस", "=छोड़ें", "=x"],
};

/** Controls inside a consent banner that only open settings or a policy. They bind nothing. */
export const CONSENT_OPENERS: PhraseTable = {
  en: ["manage", "customize", "customise", "preferences", "settings", "more options", "learn more", "more information", "show details", "show purposes", "vendors", "privacy policy", "cookie policy", "cookie notice", "read more", "options"],
  es: ["gestionar", "administrar", "personalizar", "configurar", "configuración", "preferencias", "más opciones", "más información", "saber más", "ver detalles", "política de privacidad", "política de cookies", "opciones"],
  fr: ["gérer", "personnaliser", "paramétrer", "paramètres", "préférences", "plus d'options", "en savoir plus", "plus d'informations", "afficher les détails", "politique de confidentialité", "politique de cookies", "options"],
  de: ["verwalten", "anpassen", "einstellungen", "präferenzen", "weitere optionen", "mehr erfahren", "mehr informationen", "details anzeigen", "datenschutzerklärung", "datenschutzrichtlinie", "cookie richtlinie", "optionen", "individuell"],
  pt: ["gerenciar", "gerir", "personalizar", "configurar", "configurações", "preferências", "mais opções", "saiba mais", "mais informações", "ver detalhes", "política de privacidade", "política de cookies", "opções"],
  ja: ["管理", "カスタマイズ", "設定", "詳細", "詳しく", "オプション", "プライバシーポリシー", "クッキーポリシー", "cookieポリシー"],
  zh: ["管理", "自定义", "自訂", "自定義", "设置", "設定", "偏好", "更多选项", "更多選項", "了解更多", "详情", "隐私政策", "隱私政策", "隐私权政策", "cookie政策", "选项"],
  hi: ["प्रबंधित करें", "अनुकूलित करें", "सेटिंग", "प्राथमिकताएं", "और विकल्प", "अधिक जानें", "अधिक जानकारी", "गोपनीयता नीति", "कुकी नीति", "विकल्प"],
};

/** "Save my choices" style buttons: floor in a consent banner unless every optional category is off (D2). */
export const CONSENT_SAVE_CHOICES: PhraseTable = {
  en: ["save preferences", "save settings", "save my preferences", "save my choices", "save choices", "confirm my choices", "confirm choices", "confirm selection", "allow selection", "allow selected", "accept selected", "accept selection", "save and close", "save and continue", "apply preferences", "=save"],
  es: ["guardar preferencias", "guardar configuración", "guardar mis preferencias", "guardar selección", "confirmar mis opciones", "confirmar selección", "permitir selección", "aceptar selección", "guardar y cerrar", "=guardar"],
  fr: ["enregistrer les préférences", "enregistrer mes préférences", "enregistrer mes choix", "enregistrer", "confirmer mes choix", "valider mes choix", "autoriser la sélection", "accepter la sélection", "enregistrer et fermer"],
  de: ["einstellungen speichern", "auswahl speichern", "auswahl bestätigen", "meine auswahl bestätigen", "auswahl zulassen", "auswahl akzeptieren", "speichern und schließen", "=speichern"],
  pt: ["salvar preferências", "salvar configurações", "salvar minhas preferências", "salvar minhas escolhas", "confirmar minhas escolhas", "confirmar seleção", "permitir seleção", "aceitar seleção", "salvar e fechar", "=salvar"],
  ja: ["設定を保存", "選択を保存", "選択内容を保存", "選択を確定", "選択を許可", "選択を承諾", "保存して閉じる", "=保存"],
  zh: ["保存设置", "保存設定", "保存偏好", "保存选择", "保存選擇", "确认我的选择", "確認我的選擇", "允许所选", "允許所選", "接受所选", "保存并关闭", "=保存"],
  hi: ["प्राथमिकताएं सहेजें", "सेटिंग सहेजें", "मेरी पसंद सहेजें", "चयन की पुष्टि करें", "चयन की अनुमति दें", "चयनित स्वीकार करें", "सहेजें और बंद करें", "=सहेजें"],
};

/** App authorisation screens (decision D7). */
export const OAUTH_PHRASES: PhraseTable = {
  en: ["wants to access your account", "wants to access", "would like to access", "is requesting access", "requests access", "requesting permission", "wants permission to", "would like permission to", "allow this app", "authorize this app", "authorise this app", "authorize access", "authorise access", "authorize application", "authorize app", "grant access", "grant this app", "connect to your account", "access to your account", "permissions requested", "this app will be able to", "will be able to see", "give access"],
  es: ["quiere acceder a tu cuenta", "quiere acceder", "desea acceder", "solicita acceso", "solicita permiso", "permitir que esta aplicación", "autorizar esta aplicación", "autorizar acceso", "conceder acceso", "dar acceso", "acceso a tu cuenta", "permisos solicitados", "podrá ver", "podrá acceder"],
  fr: ["souhaite accéder à votre compte", "souhaite accéder", "veut accéder", "aimerait accéder", "demande l'accès", "demande l'autorisation", "autoriser cette application", "autoriser l'accès", "accorder l'accès", "accès à votre compte", "autorisations demandées", "pourra voir", "pourra accéder"],
  de: ["möchte auf ihr konto zugreifen", "möchte auf dein konto zugreifen", "möchte zugreifen", "fordert zugriff", "bittet um zugriff", "zugriff auf ihr konto", "zugriff auf dein konto", "diese app autorisieren", "app autorisieren", "zugriff gewähren", "zugriff erlauben", "angeforderte berechtigungen", "wird in der lage sein"],
  pt: ["quer acessar sua conta", "quer acessar", "deseja acessar", "solicita acesso", "solicita permissão", "autorizar este aplicativo", "autorizar acesso", "conceder acesso", "permitir acesso", "acesso à sua conta", "permissões solicitadas", "poderá ver", "poderá acessar"],
  ja: ["アカウントにアクセスすることを求めています", "アカウントへのアクセス", "アクセスを許可", "アクセスを求めて", "アクセスをリクエスト", "アクセスしようとして", "アプリを承認", "アプリを許可", "アクセス許可", "権限をリクエスト", "権限を要求", "連携を許可", "アクセスを承認", "アクセスの許可"],
  zh: ["想要访问您的账户", "想要訪問您的帳戶", "请求访问", "請求訪問", "想访问你的", "想要访问", "想要訪問", "授权此应用", "授權此應用", "授权访问", "授權訪問", "允许访问", "允許訪問", "访问您的账号", "访问你的账号", "请求的权限", "請求的權限", "授权应用", "授權應用"],
  hi: ["आपके खाते तक पहुंच", "आपके खाते तक पहुँच", "पहुंच का अनुरोध", "पहुंच की अनुमति", "पहुँच की अनुमति", "इस ऐप को अनुमति", "ऐप को अधिकृत", "पहुंच दें", "अनुमति का अनुरोध", "अनुरोधित अनुमतियां", "तक पहुंचना चाहता है", "तक पहुँचना चाहता है", "तक पहुंचना चाहती है"],
};

/** Button names that grant an app access, used when only the URL says "oauth". */
export const OAUTH_ALLOW: PhraseTable = {
  en: ["allow access", "authorize", "authorise", "grant access", "approve", "connect", "link account", "continue as", "=allow", "=yes"],
  es: ["permitir acceso", "autorizar", "conceder acceso", "aprobar", "conectar", "vincular cuenta", "continuar como", "=permitir", "=sí"],
  fr: ["autoriser l'accès", "autoriser", "accorder l'accès", "approuver", "connecter", "associer le compte", "continuer en tant que", "=oui"],
  de: ["zugriff erlauben", "zugriff gewähren", "autorisieren", "genehmigen", "verbinden", "konto verknüpfen", "weiter als", "=erlauben", "=zulassen", "=ja"],
  pt: ["permitir acesso", "autorizar", "conceder acesso", "aprovar", "conectar", "vincular conta", "continuar como", "=permitir", "=sim"],
  ja: ["アクセスを許可", "許可", "承認", "連携", "接続", "続行", "=はい"],
  zh: ["允许", "允許", "授权", "授權", "同意授权", "批准", "连接", "連接", "继续", "=是"],
  hi: ["पहुंच की अनुमति दें", "अनुमति दें", "अधिकृत करें", "मंज़ूरी दें", "कनेक्ट करें", "खाता लिंक करें", "के रूप में जारी रखें", "=हां", "=हाँ"],
};

// ---------------------------------------------------------------------------
// F2. Human verification
// ---------------------------------------------------------------------------

/** Controls and prompts that ask a person to prove they are one. */
export const VERIFY_HUMAN: PhraseTable = {
  en: ["i'm not a robot", "i am not a robot", "im not a robot", "not a robot", "i'm not a bot", "not a bot", "i'm human", "i am human", "i am a human", "verify you are human", "verify you're human", "verify that you are human", "verify that you're human", "confirm you are human", "confirm you're human", "prove you are human", "prove you're human", "are you human", "human verification", "click here to verify", "click to verify", "tap to verify", "press and hold", "hold to verify", "slide to verify", "complete the security check", "complete the captcha", "security check", "captcha", "recaptcha", "hcaptcha", "verify yourself", "verification challenge"],
  es: ["no soy un robot", "no soy robot", "soy humano", "verifica que eres humano", "verifica que eres una persona", "verificar que eres humano", "confirma que eres humano", "demuestra que eres humano", "verificación humana", "haz clic para verificar", "haga clic para verificar", "clic aquí para verificar", "mantén pulsado", "mantener presionado", "mantén presionado", "completa la verificación de seguridad", "comprobación de seguridad", "verificación de seguridad", "captcha"],
  fr: ["je ne suis pas un robot", "je suis humain", "vérifiez que vous êtes humain", "vérifier que vous êtes humain", "confirmez que vous êtes humain", "prouvez que vous êtes humain", "vérification humaine", "cliquez pour vérifier", "cliquez ici pour vérifier", "appuyez et maintenez", "maintenir appuyé", "maintenez appuyé", "effectuez le contrôle de sécurité", "contrôle de sécurité", "vérification de sécurité", "captcha"],
  de: ["ich bin kein roboter", "ich bin kein bot", "ich bin ein mensch", "bestätigen sie, dass sie ein mensch sind", "bestätigen sie, dass sie kein roboter sind", "verifizieren sie, dass sie ein mensch sind", "menschliche verifizierung", "zur verifizierung klicken", "klicken sie hier, um zu verifizieren", "drücken und halten", "gedrückt halten", "sicherheitsüberprüfung", "sicherheitsprüfung", "sicherheitscheck", "captcha"],
  pt: ["não sou um robô", "nao sou um robo", "não sou robô", "sou humano", "verifique que você é humano", "confirme que você é humano", "prove que você é humano", "verificação humana", "clique para verificar", "clique aqui para verificar", "pressione e segure", "mantenha pressionado", "verificação de segurança", "captcha"],
  ja: ["ロボットではありません", "人間であることを確認", "人間であることを証明", "人間であることを認証", "人間確認", "人間かどうか", "認証するにはクリック", "クリックして認証", "クリックして確認", "長押し", "押し続け", "セキュリティチェック", "セキュリティ確認", "キャプチャ", "captcha"],
  zh: ["我不是机器人", "我不是機器人", "我是人类", "我是人類", "验证您是真人", "驗證您是真人", "验证你是人类", "确认您是真人", "確認您是真人", "证明您是人类", "人机验证", "人機驗證", "点击验证", "點擊驗證", "点击此处验证", "按住", "长按", "長按", "安全检查", "安全檢查", "安全验证", "captcha"],
  hi: ["मैं रोबोट नहीं हूं", "मैं रोबोट नहीं हूँ", "मैं इंसान हूं", "मैं इंसान हूँ", "सत्यापित करें कि आप इंसान हैं", "पुष्टि करें कि आप इंसान हैं", "सत्यापित करने के लिए क्लिक करें", "यहां क्लिक करके सत्यापित करें", "दबाकर रखें", "दबाएं और रखें", "सुरक्षा जांच", "कैप्चा", "मानव सत्यापन", "मानव सत्यापित करें", "captcha"],
};

/** The bare word "verify" (spec 2.5: a bare Verify is floor, and so is Verify email). */
export const VERIFY_WORD: PhraseTable = {
  en: ["verify", "verification"],
  es: ["verificar", "verifica", "verifique", "verificación"],
  fr: ["vérifier", "vérifiez", "vérification"],
  de: ["verifizieren", "verifiziere", "verifizierung", "verifikation"],
  pt: ["verificar", "verifique", "verificação"],
  ja: ["認証", "検証", "本人確認"],
  zh: ["验证", "驗證", "核实", "核實"],
  hi: ["सत्यापित", "सत्यापन", "वेरीफाई", "वेरिफाई"],
};

// ---------------------------------------------------------------------------
// F3. Credentials, codes, card, ID and payment entry
// ---------------------------------------------------------------------------

/** Field names and labels that ask for a secret, code, card or ID number. */
export const CREDENTIAL_FIELD: PhraseTable = {
  en: ["password", "passcode", "pin", "one time code", "one time password", "otp", "verification code", "security code", "confirmation code", "authentication code", "authenticator", "2fa", "two factor", "mfa", "sms code", "recovery code", "backup code", "enter code", "enter the code", "digit code", "cvv", "cvc", "csc", "card number", "credit card", "debit card", "card no", "card security", "expiry", "expiration", "exp date", "mm yy", "name on card", "cardholder", "iban", "sort code", "routing number", "account number", "bank account", "swift", "ssn", "social security", "national insurance", "national id", "identity number", "passport", "driving licence", "driving license", "driver's license", "driver license", "licence number", "license number", "tax id", "taxpayer"],
  es: ["contraseña", "clave de acceso", "clave secreta", "pin", "código de un solo uso", "código de verificación", "código de seguridad", "código de confirmación", "código otp", "código de autenticación", "autenticador", "verificación en dos pasos", "2fa", "cvv", "cvc", "número de tarjeta", "tarjeta de crédito", "tarjeta de débito", "caducidad", "fecha de caducidad", "fecha de vencimiento", "vencimiento", "titular de la tarjeta", "nombre en la tarjeta", "iban", "número de cuenta", "cuenta bancaria", "clabe", "dni", "nif", "pasaporte", "número de seguro social", "seguridad social", "carnet de conducir", "licencia de conducir", "permiso de conducir", "número de identificación", "identificación fiscal", "rfc", "curp"],
  fr: ["mot de passe", "code pin", "pin", "code à usage unique", "code unique", "code de vérification", "code de sécurité", "code de confirmation", "code de validation", "code otp", "code d'authentification", "authentificateur", "double authentification", "authentification à deux facteurs", "code secret", "2fa", "cvv", "cvc", "cryptogramme", "numéro de carte", "carte bancaire", "carte de crédit", "date d'expiration", "expiration", "titulaire de la carte", "nom sur la carte", "iban", "numéro de compte", "compte bancaire", "rib", "numéro de sécurité sociale", "sécurité sociale", "numéro d'identification", "carte d'identité", "passeport", "permis de conduire", "numéro fiscal", "identifiant fiscal"],
  de: ["passwort", "kennwort", "pin", "einmalcode", "einmalpasswort", "einmal passwort", "bestätigungscode", "sicherheitscode", "verifizierungscode", "verifikationscode", "authentifizierungscode", "authenticator", "zwei faktor", "2fa", "cvv", "cvc", "kartennummer", "kreditkartennummer", "kreditkarte", "gültig bis", "ablaufdatum", "karteninhaber", "name auf der karte", "iban", "bankleitzahl", "kontonummer", "bankkonto", "sozialversicherungsnummer", "steuer id", "steuernummer", "steueridentifikationsnummer", "personalausweis", "ausweisnummer", "reisepass", "führerschein"],
  pt: ["senha", "palavra passe", "código pin", "pin", "código único", "código de uso único", "código de verificação", "código de segurança", "código de confirmação", "código otp", "código de autenticação", "autenticador", "verificação em duas etapas", "autenticação de dois fatores", "2fa", "cvv", "cvc", "número do cartão", "cartão de crédito", "cartão de débito", "data de validade", "validade do cartão", "titular do cartão", "nome no cartão", "iban", "número da conta", "conta bancária", "cpf", "rg", "cnh", "passaporte", "carteira de motorista", "carteira de habilitação", "número de identificação", "número do seguro social", "nif", "documento de identidade"],
  ja: ["パスワード", "暗証番号", "ワンタイム", "認証コード", "確認コード", "セキュリティコード", "認証番号", "二段階認証", "2段階認証", "二要素認証", "認証アプリ", "cvv", "cvc", "カード番号", "クレジットカード", "デビットカード", "有効期限", "カード名義", "名義人", "口座番号", "銀行口座", "マイナンバー", "パスポート", "運転免許", "免許証", "本人確認書類", "iban"],
  zh: ["密码", "密碼", "口令", "pin码", "pin碼", "一次性密码", "一次性密碼", "一次性验证码", "动态口令", "验证码", "驗證碼", "安全码", "安全碼", "确认码", "認證碼", "双重验证", "雙重驗證", "两步验证", "兩步驗證", "身份验证器", "cvv", "cvc", "银行卡号", "銀行卡號", "信用卡号", "信用卡號", "信用卡", "借记卡", "卡号", "卡號", "有效期", "持卡人", "银行账号", "银行账户", "銀行賬號", "身份证", "身份證", "护照", "護照", "驾驶证", "駕駛證", "社会保障号", "纳税人识别号", "短信验证码", "短信驗證碼"],
  hi: ["पासवर्ड", "पिन", "ओटीपी", "वन टाइम पासवर्ड", "एक बार का कोड", "सत्यापन कोड", "सुरक्षा कोड", "पुष्टिकरण कोड", "ऑथेंटिकेटर", "दो चरणीय सत्यापन", "टू फैक्टर", "2fa", "सीवीवी", "cvv", "सीवीसी", "कार्ड नंबर", "क्रेडिट कार्ड", "डेबिट कार्ड", "समाप्ति तिथि", "एक्सपायरी", "कार्डधारक", "कार्ड पर नाम", "आईबैन", "खाता संख्या", "बैंक खाता", "आधार नंबर", "आधार कार्ड", "आधार संख्या", "पैन नंबर", "पैन कार्ड", "पासपोर्ट", "ड्राइविंग लाइसेंस", "पहचान पत्र", "सामाजिक सुरक्षा"],
};

/** Upload fields that ask for an ID document or a selfie. */
export const ID_UPLOAD_FIELD: PhraseTable = {
  en: ["=id", "photo id", "government id", "identity document", "id document", "id card", "identity card", "national id", "passport", "driving licence", "driving license", "driver's license", "driver license", "selfie", "proof of identity"],
  es: ["documento de identidad", "documento de identificación", "dni", "pasaporte", "carnet de conducir", "licencia de conducir", "selfie", "autofoto", "prueba de identidad", "cédula"],
  fr: ["pièce d'identité", "carte d'identité", "passeport", "permis de conduire", "selfie", "justificatif d'identité"],
  de: ["ausweis", "personalausweis", "reisepass", "führerschein", "selfie", "identitätsnachweis", "ausweisdokument"],
  pt: ["documento de identidade", "documento de identificação", "passaporte", "carteira de motorista", "cnh", "selfie", "comprovante de identidade", "rg", "cpf"],
  ja: ["本人確認書類", "身分証", "身分証明書", "運転免許証", "免許証", "パスポート", "マイナンバーカード", "自撮り", "セルフィー"],
  zh: ["身份证", "身份證", "身份证明", "护照", "護照", "驾驶证", "駕駛證", "自拍", "证件", "證件"],
  hi: ["पहचान पत्र", "पहचान प्रमाण", "आधार कार्ड", "पासपोर्ट", "ड्राइविंग लाइसेंस", "सेल्फी", "पैन कार्ड", "=आईडी"],
};

/** autocomplete tokens that make a field a credential, code or card field. */
export const CREDENTIAL_AUTOCOMPLETE_TOKENS: readonly string[] = ["current-password", "new-password", "one-time-code"];
export const CARD_AUTOCOMPLETE_PREFIX = "cc-";

/** Identifier tokens (id or name attribute, split on punctuation and camel case) that mark a secret field. */
export const CREDENTIAL_IDENTIFIER_TOKENS: readonly string[] = ["password", "passwd", "pwd", "passcode", "otp", "cvv", "cvc", "csc", "iban", "ssn", "ccnum", "cardnumber", "cardnum", "creditcard", "ccexp", "cccvc"];

// ---------------------------------------------------------------------------
// F4. The final pay button
// ---------------------------------------------------------------------------

/** Controls that pay, order or donate. Floor on their own. */
export const PAY_CONTROL: PhraseTable = {
  en: ["=pay", "pay now", "pay today", "pay with", "pay by", "pay and", "pay for", "pay in full", "pay later", "pay total", "make payment", "make a payment", "make your payment", "submit payment", "confirm payment", "confirm and pay", "complete payment", "complete order", "complete purchase", "complete your order", "complete your purchase", "place order", "place your order", "place my order", "confirm order", "confirm your order", "confirm purchase", "confirm and purchase", "book and pay", "book now and pay", "buy now", "buy it now", "buy with", "buy for", "buy and", "purchase now", "=purchase", "order now", "submit order", "submit your order", "send payment", "send money", "confirm transfer", "transfer now", "donate", "donate now", "make a donation", "give now", "1 click", "one click", "one-click"],
  es: ["=pagar", "pagar ahora", "pagar con", "pagar y", "pagar pedido", "realizar pedido", "hacer pedido", "hacer el pedido", "realizar el pedido", "confirmar pedido", "confirmar y pagar", "confirmar pago", "confirmar compra", "completar pedido", "completar compra", "completar pago", "finalizar compra", "finalizar pedido", "finalizar pago", "comprar ahora", "comprar ya", "comprar con", "realizar pago", "efectuar pago", "enviar pago", "reservar y pagar", "=donar", "donar ahora", "hacer donación", "suscribirse y pagar", "pagar y suscribirse"],
  fr: ["=payer", "payer maintenant", "payer avec", "payer et", "payer la commande", "passer la commande", "passer commande", "valider la commande", "valider ma commande", "valider et payer", "valider le paiement", "confirmer et payer", "confirmer la commande", "confirmer le paiement", "confirmer l'achat", "finaliser la commande", "finaliser l'achat", "finaliser le paiement", "acheter maintenant", "acheter avec", "=acheter", "effectuer le paiement", "réserver et payer", "faire un don", "donner maintenant", "=donner"],
  de: ["=bezahlen", "jetzt bezahlen", "bezahlen mit", "bezahlen und", "kostenpflichtig bestellen", "zahlungspflichtig bestellen", "jetzt kaufen", "=kaufen", "kaufen mit", "bestellung aufgeben", "bestellung abschließen", "bestellung abschliessen", "jetzt bestellen", "=bestellen", "bestellen und bezahlen", "zahlung bestätigen", "bestellung bestätigen", "kauf abschließen", "kauf bestätigen", "zahlung abschließen", "zahlung senden", "verbindlich bestellen", "buchen und bezahlen", "=spenden", "jetzt spenden"],
  pt: ["=pagar", "pagar agora", "pagar com", "pagar e", "finalizar pedido", "finalizar compra", "finalizar pagamento", "fazer pedido", "realizar pedido", "confirmar pedido", "confirmar compra", "confirmar e pagar", "confirmar pagamento", "concluir pedido", "concluir compra", "concluir pagamento", "comprar agora", "=comprar", "comprar com", "efetuar pagamento", "enviar pagamento", "reservar e pagar", "=doar", "doar agora", "fazer doação", "fazer uma doação"],
  ja: ["支払う", "支払いを確定", "支払いを完了", "今すぐ支払", "注文を確定", "注文確定", "ご注文を確定", "注文する", "購入する", "購入を確定", "購入確定", "購入を完了", "購入手続きを完了", "今すぐ購入", "お支払いを確定", "お支払いを完了", "予約して支払う", "寄付する", "今すぐ寄付"],
  zh: ["=支付", "=付款", "立即支付", "立即付款", "确认支付", "確認支付", "确认付款", "確認付款", "确认订单", "確認訂單", "提交订单", "提交訂單", "=下单", "=下單", "立即购买", "立即購買", "马上购买", "确认购买", "確認購買", "完成支付", "完成付款", "完成订单", "完成購買", "去支付", "去付款", "支付并", "付款并", "=购买", "=購買", "捐款", "立即捐款", "立即捐赠", "预订并付款", "預訂並付款"],
  hi: ["अभी भुगतान करें", "भुगतान करें", "भुगतान की पुष्टि करें", "भुगतान पूरा करें", "भुगतान जमा करें", "ऑर्डर दें", "ऑर्डर करें", "ऑर्डर की पुष्टि करें", "ऑर्डर पूरा करें", "खरीदारी पूरी करें", "अभी खरीदें", "=खरीदें", "अभी पे करें", "पे करें", "दान करें", "अभी दान करें", "बुक करें और भुगतान करें"],
};

/** Words that pay only when the page carries payment context (a card form, a payment frame, an amount). */
export const PAY_CONTROL_WEAK: PhraseTable = {
  en: ["=subscribe", "=subscribe now", "=start trial", "=start free trial", "=start my free trial", "=try free", "=submit", "=confirm", "=continue", "=proceed", "=complete", "=start subscription"],
  es: ["=suscribirse", "=suscribirme", "=suscríbete", "=iniciar prueba", "=iniciar prueba gratuita", "=comenzar prueba gratis", "=enviar", "=confirmar", "=continuar", "=completar", "=finalizar"],
  fr: ["=s'abonner", "=souscrire", "=démarrer l'essai", "=commencer l'essai gratuit", "=essayer gratuitement", "=envoyer", "=valider", "=confirmer", "=continuer", "=terminer"],
  de: ["=abonnieren", "=jetzt abonnieren", "=testversion starten", "=kostenlos testen", "=absenden", "=senden", "=bestätigen", "=weiter", "=fortfahren", "=abschließen"],
  pt: ["=assinar", "=assinar agora", "=iniciar teste", "=iniciar teste gratuito", "=começar teste grátis", "=enviar", "=confirmar", "=continuar", "=concluir", "=finalizar"],
  ja: ["=購読する", "=無料トライアルを開始", "=無料で試す", "=送信", "=確認", "=続行", "=続ける", "=完了"],
  zh: ["=订阅", "=訂閱", "=开始试用", "=開始試用", "=免费试用", "=免費試用", "=提交", "=确认", "=確認", "=继续", "=繼續", "=完成"],
  hi: ["=सदस्यता लें", "=सब्सक्राइब करें", "=ट्रायल शुरू करें", "=निःशुल्क ट्रायल शुरू करें", "=सबमिट", "=सबमिट करें", "=पुष्टि करें", "=जारी रखें", "=पूरा करें"],
};

// ---------------------------------------------------------------------------
// Ported from Sean's FoundryInChrome (src/lib/automation/trust.ts)
// ---------------------------------------------------------------------------

/**
 * Ported verbatim from FoundryInChrome src/lib/automation/trust.ts
 * (DESTRUCTIVE_PATTERNS). Sean's own code, copied on purpose and not imported.
 * Delete, remove, cancel subscription and close account are level 3 (always
 * ask) in browser-levels.ts, not floor. The pay entries are tightened below
 * for the floor.
 */
export const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /delete/i,
  /remove/i,
  /purchase/i,
  /submit\s*order/i,
  /confirm\s*payment/i,
  /pay\s*now/i,
  /place\s*order/i,
  /cancel\s*subscription/i,
  /close\s*account/i,
];

/**
 * The pay entries of DESTRUCTIVE_PATTERNS, with a word boundary in front so
 * "Repay now" and a link called "Purchase history" are not read as the final
 * pay button. Matched against the cleaned control name (see foldText).
 */
export const FOUNDRY_PAY_PATTERNS: readonly RegExp[] = [
  /\bsubmit\s*order/,
  /\bconfirm\s*payment/,
  /\bpay\s*now/,
  /\bplace\s*order/,
];
