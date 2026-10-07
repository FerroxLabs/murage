// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { classifyFloor } from "./browser-floor.ts";
import type { FloorFacts, FloorKind } from "./browser-floor.ts";
import {
  CONSENT_AGREE_VERB, CONSENT_CONTROL_STRONG, CONSENT_CONTROL_WEAK, CONSENT_DECLINE, CONSENT_OPENERS, CONSENT_SAVE_CHOICES,
  CONSENT_TOPIC, CREDENTIAL_FIELD, DESTRUCTIVE_PATTERNS, FLOOR_LANGS, FOUNDRY_PAY_PATTERNS, ID_UPLOAD_FIELD, OAUTH_ALLOW,
  OAUTH_PHRASES, PAY_CONTROL, PAY_CONTROL_WEAK, SENTENCE_AGREE, SENTENCE_BY_ACTION, VERIFY_HUMAN, VERIFY_WORD, compilePhrases, foldText,
} from "./browser-floor-lexicon.ts";
import {
  ALL_FRAME_SIGNATURES, FLOOR_CATEGORY_LABEL, FLOOR_KINDS, FLOOR_OWNER_PHRASE, matchFrame, matchFrameName, signatureSelectors,
} from "../shared/browser-floor-signatures.ts";

type Expected = FloorKind | null;
type Row = [label: string, facts: FloorFacts, expected: Expected];

// ---------------------------------------------------------------------------
// Fact builders
// ---------------------------------------------------------------------------

const click = (name: string, extra: Partial<FloorFacts> = {}): FloorFacts => ({ operation: "click", tag: "button", role: "button", name, ...extra });
const link = (name: string, extra: Partial<FloorFacts> = {}): FloorFacts => ({ operation: "click", tag: "a", role: "link", name, ...extra });
const submit = (name: string, extra: Partial<FloorFacts> = {}): FloorFacts => ({ operation: "click", tag: "button", type: "submit", role: "button", name, submits: true, ...extra });
const box = (name: string, extra: Partial<FloorFacts> = {}): FloorFacts => ({ operation: "click", tag: "input", type: "checkbox", role: "checkbox", name, ...extra });
const typing = (name: string, extra: Partial<FloorFacts> = {}): FloorFacts => ({ operation: "type", tag: "input", type: "text", role: "textbox", name, ...extra });
const inCmp: Partial<FloorFacts> = { signatures: { consentManager: true } };
const inCard: Partial<FloorFacts> = { form: { hasCardFields: true } };
const consentPage: Partial<FloorFacts> = { snippets: { dialog: "We use cookies. By using this site you accept our privacy policy and terms." } };

let rowsRun = 0;
function runRows(rows: Row[]) {
  rowsRun += rows.length;
  for (const [label, facts, expected] of rows) {
    const got = classifyFloor(facts);
    expect(got.floor, `${label} -> ${got.rule}`).toBe(expected);
    expect(got.reason.length).toBeGreaterThan(0);
  }
}

// ---------------------------------------------------------------------------
// Per-language tables: every language gets the same battery
// ---------------------------------------------------------------------------

interface LangBattery {
  agree: string[];
  checkbox: string[];
  decline: string[];
  human: string[];
  verify: string[];
  pay: string[];
  field: string[];
  idUpload: string[];
  benign: string[];
  weakConsent: string;
  weakPay: string;
  sentence: string;
  /** a button name that appears in the sentence */
  sentenceButton: string;
  oauth: string;
  dialog: string;
  paymentDialog: string;
}

const BATTERY: Record<(typeof FLOOR_LANGS)[number], LangBattery> = {
  en: {
    agree: ["I agree", "Accept all", "Agree and continue", "Allow all cookies", "I accept the terms"],
    checkbox: ["I agree to the Terms of Service", "I have read the privacy policy", "Accept the licence agreement"],
    decline: ["Reject all", "Only necessary", "No thanks", "I do not agree"],
    human: ["I'm not a robot", "Verify you are human", "Click here to verify", "Press and hold"],
    verify: ["Verify", "Verify email"],
    pay: ["Pay now", "Place order", "Buy now", "Complete purchase", "Donate"],
    field: ["Password", "Card number", "CVV", "Verification code", "Routing number", "Social security number"],
    idUpload: ["Upload your passport", "Driver's license photo"],
    benign: ["Search", "Add to cart", "Promo code", "Zip code", "Open menu"],
    weakConsent: "Accept",
    weakPay: "Subscribe",
    sentence: "By clicking Create account you agree to our Terms of Service.",
    sentenceButton: "Create account",
    oauth: "Dax Notes wants to access your account",
    dialog: "Do you agree to the updated terms?",
    paymentDialog: "Place your order now?",
  },
  es: {
    agree: ["Acepto", "Aceptar todas las cookies", "Estoy de acuerdo", "Aceptar y continuar", "Permitir todas las cookies"],
    checkbox: ["Acepto los términos y condiciones", "He leído la política de privacidad", "Estoy de acuerdo con el acuerdo de licencia"],
    decline: ["Rechazar todo", "Solo necesarias", "No gracias", "No acepto"],
    human: ["No soy un robot", "Verifica que eres humano", "Haz clic para verificar", "Mantén pulsado"],
    verify: ["Verificar", "Verifica tu correo"],
    pay: ["Pagar ahora", "Realizar pedido", "Comprar ahora", "Finalizar compra", "Donar"],
    field: ["Contraseña", "Número de tarjeta", "CVV", "Código de verificación", "Número de cuenta", "Número de seguro social"],
    idUpload: ["Sube tu pasaporte", "Foto del DNI"],
    benign: ["Buscar", "Añadir al carrito", "Código promocional", "Código postal", "Abrir menú"],
    weakConsent: "Aceptar",
    weakPay: "Suscribirse",
    sentence: "Al hacer clic en Crear cuenta aceptas nuestros términos.",
    sentenceButton: "Crear cuenta",
    oauth: "Dax Notes quiere acceder a tu cuenta",
    dialog: "¿Estás de acuerdo con los nuevos términos?",
    paymentDialog: "¿Confirmar pago ahora?",
  },
  fr: {
    agree: ["J'accepte", "Tout accepter", "Je suis d'accord", "Accepter et continuer", "Autoriser tous les cookies"],
    checkbox: ["J'accepte les conditions générales", "J'ai lu la politique de confidentialité", "Accepter l'accord de licence"],
    decline: ["Tout refuser", "Uniquement nécessaires", "Non merci", "Je refuse"],
    human: ["Je ne suis pas un robot", "Vérifiez que vous êtes humain", "Cliquez pour vérifier", "Appuyez et maintenez"],
    verify: ["Vérifier", "Vérifier mon e-mail"],
    pay: ["Payer maintenant", "Passer la commande", "Acheter maintenant", "Finaliser l'achat", "Faire un don"],
    field: ["Mot de passe", "Numéro de carte", "Cryptogramme", "Code de vérification", "Numéro de compte", "Numéro de sécurité sociale"],
    idUpload: ["Téléversez votre passeport", "Carte d'identité"],
    benign: ["Rechercher", "Ajouter au panier", "Code promo", "Code postal", "Ouvrir le menu"],
    weakConsent: "Accepter",
    weakPay: "S'abonner",
    sentence: "En cliquant sur Créer un compte, vous acceptez nos conditions.",
    sentenceButton: "Créer un compte",
    oauth: "Dax Notes souhaite accéder à votre compte",
    dialog: "Acceptez-vous les nouvelles conditions ? J'accepte les conditions",
    paymentDialog: "Confirmer le paiement maintenant ? Valider la commande",
  },
  de: {
    agree: ["Ich stimme zu", "Alle akzeptieren", "Ich bin einverstanden", "Akzeptieren und weiter", "Alle Cookies zulassen"],
    checkbox: ["Ich akzeptiere die AGB", "Ich habe die Datenschutzerklärung gelesen", "Ich stimme den Nutzungsbedingungen zu"],
    decline: ["Alle ablehnen", "Nur notwendige", "Nein danke", "Ich stimme nicht zu"],
    human: ["Ich bin kein Roboter", "Bestätigen Sie, dass Sie ein Mensch sind", "Klicken Sie hier, um zu verifizieren", "Drücken und halten"],
    verify: ["Verifizieren", "E-Mail verifizieren"],
    pay: ["Jetzt bezahlen", "Zahlungspflichtig bestellen", "Jetzt kaufen", "Bestellung abschließen", "Jetzt spenden"],
    field: ["Passwort", "Kartennummer", "Sicherheitscode", "Bestätigungscode", "Kontonummer", "Sozialversicherungsnummer"],
    idUpload: ["Reisepass hochladen", "Foto vom Führerschein"],
    benign: ["Suchen", "In den Warenkorb", "Gutscheincode", "Postleitzahl", "Menü öffnen"],
    weakConsent: "Akzeptieren",
    weakPay: "Abonnieren",
    sentence: "Mit dem Klick auf Konto erstellen stimmen Sie den Nutzungsbedingungen zu.",
    sentenceButton: "Konto erstellen",
    oauth: "Dax Notes möchte auf Ihr Konto zugreifen",
    dialog: "Stimmen Sie den neuen Bedingungen zu?",
    paymentDialog: "Bestellung abschließen und Zahlung bestätigen?",
  },
  pt: {
    agree: ["Eu concordo", "Aceitar todos os cookies", "Eu aceito", "Aceitar e continuar", "Permitir todos os cookies"],
    checkbox: ["Li e concordo com os termos de uso", "Aceito a política de privacidade", "Concordo com o contrato de licença"],
    decline: ["Rejeitar tudo", "Apenas necessários", "Não, obrigado", "Não concordo"],
    human: ["Não sou um robô", "Confirme que você é humano", "Clique para verificar", "Pressione e segure"],
    verify: ["Verificar", "Verifique seu e-mail"],
    pay: ["Pagar agora", "Finalizar pedido", "Comprar agora", "Confirmar pagamento", "Doar"],
    field: ["Senha", "Número do cartão", "Código de segurança", "Código de verificação", "Número da conta", "CPF"],
    idUpload: ["Envie seu passaporte", "Foto da carteira de motorista"],
    benign: ["Pesquisar", "Adicionar ao carrinho", "Cupom de desconto", "CEP", "Abrir menu"],
    weakConsent: "Aceitar",
    weakPay: "Assinar",
    sentence: "Ao clicar em Criar conta, você concorda com nossos termos.",
    sentenceButton: "Criar conta",
    oauth: "Dax Notes quer acessar sua conta",
    dialog: "Você concorda com os novos termos?",
    paymentDialog: "Finalizar pedido e confirmar pagamento?",
  },
  ja: {
    agree: ["同意します", "すべて同意", "同意して続行", "すべて許可", "利用規約に同意"],
    checkbox: ["利用規約に同意する", "プライバシーポリシーを読みました", "ライセンス契約を承諾します"],
    decline: ["すべて拒否", "必須のみ", "同意しません", "同意せずに続行"],
    human: ["ロボットではありません", "人間であることを確認", "クリックして認証", "長押し"],
    verify: ["認証", "本人確認"],
    pay: ["今すぐ支払う", "注文を確定する", "今すぐ購入", "購入を完了", "寄付する"],
    field: ["パスワード", "カード番号", "セキュリティコード", "認証コード", "口座番号", "マイナンバー"],
    idUpload: ["パスポートをアップロード", "運転免許証の写真"],
    benign: ["検索", "カートに追加", "クーポンコード", "郵便番号", "メニューを開く"],
    weakConsent: "同意",
    weakPay: "購読する",
    sentence: "アカウントを作成すると、利用規約に同意したことになります。",
    sentenceButton: "アカウントを作成",
    oauth: "Dax Notesがあなたのアカウントへのアクセスを求めています",
    dialog: "新しい利用規約に同意しますか。",
    paymentDialog: "注文を確定しますか。",
  },
  zh: {
    agree: ["我同意", "全部接受", "同意并继续", "接受所有cookie", "我已阅读并同意"],
    checkbox: ["我同意服务条款", "我已阅读隐私政策", "接受许可协议"],
    decline: ["全部拒绝", "仅必要", "我不同意", "以后再说"],
    human: ["我不是机器人", "验证您是真人", "点击验证", "长按"],
    verify: ["验证", "驗證"],
    pay: ["立即支付", "提交订单", "立即购买", "确认付款", "立即捐款"],
    field: ["密码", "银行卡号", "安全码", "短信验证码", "有效期", "身份证"],
    idUpload: ["上传护照", "驾驶证照片"],
    benign: ["搜索", "加入购物车", "优惠码", "邮政编码", "打开菜单"],
    weakConsent: "同意",
    weakPay: "订阅",
    sentence: "点击创建账户即表示您同意我们的服务条款。",
    sentenceButton: "创建账户",
    oauth: "Dax Notes 想要访问您的账户",
    dialog: "您同意新的服务条款吗？",
    paymentDialog: "确认付款并提交订单吗？",
  },
  hi: {
    agree: ["मैं सहमत हूं", "सभी स्वीकार करें", "सहमत और जारी रखें", "सभी कुकीज़ स्वीकार करें", "मैं स्वीकार करता हूं"],
    checkbox: ["मैं नियम और शर्तों से सहमत हूं", "मैंने गोपनीयता नीति पढ़ ली है", "लाइसेंस समझौता स्वीकार करें"],
    decline: ["सभी अस्वीकार करें", "केवल आवश्यक", "नहीं धन्यवाद", "सहमत नहीं"],
    human: ["मैं रोबोट नहीं हूं", "सत्यापित करने के लिए क्लिक करें", "दबाकर रखें", "कैप्चा"],
    verify: ["सत्यापित करें", "ईमेल सत्यापन"],
    pay: ["अभी भुगतान करें", "ऑर्डर दें", "अभी खरीदें", "भुगतान की पुष्टि करें", "दान करें"],
    field: ["पासवर्ड", "कार्ड नंबर", "सुरक्षा कोड", "ओटीपी", "खाता संख्या", "आधार नंबर"],
    idUpload: ["पासपोर्ट अपलोड करें", "ड्राइविंग लाइसेंस की फोटो"],
    benign: ["खोजें", "कार्ट में जोड़ें", "प्रोमो कोड", "डाक क्षेत्र", "मेनू खोलें"],
    weakConsent: "स्वीकार करें",
    weakPay: "सदस्यता लें",
    sentence: "खाता बनाकर आप हमारी शर्तों से सहमत होते हैं।",
    sentenceButton: "खाता बनाएं",
    oauth: "Dax Notes आपके खाते तक पहुंच का अनुरोध कर रहा है",
    dialog: "क्या आप नई शर्तों से सहमत हैं?",
    paymentDialog: "भुगतान की पुष्टि करें और ऑर्डर दें?",
  },
};

describe("floor classifier: the same battery in all eight languages", () => {
  for (const lang of FLOOR_LANGS) {
    const b = BATTERY[lang];
    describe(lang, () => {
      it("F1: agree and accept controls are floor", () => {
        runRows(b.agree.map(name => [`${lang} agree ${name}`, click(name), "consent"] as Row));
      });
      it("F1: consent checkboxes are floor, by label and by nearby sentence", () => {
        runRows(b.checkbox.map(name => [`${lang} checkbox ${name}`, box(name), "consent"] as Row));
        runRows([[`${lang} unlabeled box beside sentence`, box("", { snippets: { after: b.sentence } }), "consent"]]);
      });
      it("F1: declining binds nothing, in and out of a consent manager", () => {
        runRows(b.decline.map(name => [`${lang} decline ${name}`, click(name), null] as Row));
        runRows(b.decline.map(name => [`${lang} decline in cmp ${name}`, click(name, inCmp), null] as Row));
      });
      it("F1: every control inside a consent manager is floor except declining", () => {
        runRows([[`${lang} cmp toggle`, box("Marketing", inCmp), "consent"], [`${lang} cmp strong`, click(b.agree[0], inCmp), "consent"]]);
      });
      it("F1: a click-to-agree sentence makes the submit button floor", () => {
        runRows([
          [`${lang} sentence names the button`, submit(b.sentenceButton, { snippets: { form: b.sentence } }), "consent"],
          [`${lang} sentence in landmark`, submit(b.sentenceButton, { snippets: { landmark: b.sentence } }), "consent"],
        ]);
      });
      it("F1: a bare weak word is floor only with consent context", () => {
        runRows([
          [`${lang} bare weak, no context`, click(b.weakConsent), null],
          [`${lang} bare weak, consent manager on page`, click(b.weakConsent, { page: { hasConsentManager: true } }), "consent"],
          [`${lang} bare weak, terms dialog`, click(b.weakConsent, consentPage), "consent"],
        ]);
      });
      it("F1: OAuth screens are floor (D7)", () => {
        runRows([
          [`${lang} oauth text`, click(b.agree[0].length ? "Allow" : "Allow", { snippets: { dialog: b.oauth } }), "consent"],
          [`${lang} oauth text, other button`, click("Continue", { snippets: { landmark: b.oauth } }), "consent"],
        ]);
      });
      it("F1: a consent dialog answer is floor, dismissing it is not", () => {
        runRows([
          [`${lang} confirm accept`, { operation: "dialog_accept", dialog: { kind: "confirm", text: b.dialog } }, "consent"],
          [`${lang} confirm dismiss`, { operation: "dialog_dismiss", dialog: { kind: "confirm", text: b.dialog } }, null],
        ]);
      });
      it("F2: human verification names are floor", () => {
        runRows(b.human.map(name => [`${lang} human ${name}`, click(name), "verification"] as Row));
        runRows(b.verify.map(name => [`${lang} verify ${name}`, click(name), "verification"] as Row));
      });
      it("F3: secret, code, card and ID fields are floor when typed into", () => {
        runRows(b.field.map(name => [`${lang} field ${name}`, typing(name), "credentials"] as Row));
        runRows(b.field.map(name => [`${lang} field fill ${name}`, { ...typing(name), operation: "fill" }, "credentials"] as Row));
      });
      it("F3: ID document uploads are floor", () => {
        runRows(b.idUpload.map(name => [`${lang} upload ${name}`, { operation: "upload", tag: "input", type: "file", name }, "credentials"] as Row));
      });
      it("F4: pay and order controls are floor", () => {
        runRows(b.pay.map(name => [`${lang} pay ${name}`, click(name), "payment"] as Row));
      });
      it("F4: bare subscribe is floor only with payment context", () => {
        runRows([
          [`${lang} subscribe, no context`, click(b.weakPay), null],
          [`${lang} subscribe, card fields`, click(b.weakPay, inCard), "payment"],
        ]);
      });
      it("F4: a payment dialog is floor", () => {
        runRows([[`${lang} payment dialog`, { operation: "dialog_accept", dialog: { kind: "confirm", text: b.paymentDialog } }, "payment"]]);
      });
      it("near-misses are not floor", () => {
        runRows(b.benign.map(name => [`${lang} benign click ${name}`, click(name), null] as Row));
        runRows(b.benign.map(name => [`${lang} benign type ${name}`, typing(name), null] as Row));
      });
    });
  }
});

// ---------------------------------------------------------------------------
// English detail: every spec bullet and every tricky near-miss
// ---------------------------------------------------------------------------

describe("F1: terms, policies and consent (English detail)", () => {
  const rows: Row[] = [
    ["I agree button", click("I agree"), "consent"],
    ["Agree and continue", click("Agree and continue"), "consent"],
    ["Accept and continue", click("Accept and continue"), "consent"],
    ["Allow cookies", click("Allow cookies"), "consent"],
    ["Consent to all", click("Consent to all"), "consent"],
    ["Accept & Continue with ampersand", click("Accept & Continue"), "consent"],
    ["link styled as Accept all", link("Accept all"), "consent"],
    ["checkbox, terms label", box("I agree to the Terms and Privacy Policy"), "consent"],
    ["checkbox, EULA", box("EULA"), "consent"],
    ["checkbox, acknowledge", box("I acknowledge the disclaimer"), "consent"],
    ["checkbox, I have read", box("I have read the policy"), "consent"],
    ["switch role, consent", { operation: "click", tag: "div", role: "switch", name: "Accept cookies" }, "consent"],
    ["radio, consent", { operation: "click", tag: "input", type: "radio", name: "I consent" }, "consent"],
    ["check operation", { ...box("I agree"), operation: "check" }, "consent"],
    ["Space on a consent checkbox", { ...box("I agree"), operation: "press", key: " " }, "consent"],
    ["unlabeled box, sentence after", box("", { snippets: { after: "I accept the Privacy Policy" } }), "consent"],
    ["unlabeled box, sentence before", box("", { snippets: { before: "Please confirm: I agree to the terms" } }), "consent"],
    ["unrelated label box, sentence beside it", box("Remember me", { snippets: { after: "I agree to the Terms of Service" } }), "consent"],
    ["By clicking sentence names the label", submit("Create account", { snippets: { form: "By clicking Create account you agree to our Terms" } }), "consent"],
    ["By continuing sentence, generic submit", submit("Next", { snippets: { dialog: "By continuing, you agree to our Terms of Use." } }), "consent"],
    ["By signing up", submit("Join", { snippets: { landmark: "By signing up you accept the Privacy Policy" } }), "consent"],
    ["By placing your order", click("Complete", { snippets: { form: "By placing your order you agree to our conditions." } }), "consent"],
    ["you consent sentence names label", click("Save", { snippets: { form: "Press Save and you consent to data processing." } }), "consent"],
    ["OneTrust accept", click("Accept All Cookies", { ...inCmp }), "consent"],
    ["CMP customised toggle", box("Targeting cookies", inCmp), "consent"],
    ["CMP anything else", click("Continue", inCmp), "consent"],
    ["CMP save, optional unknown", click("Save preferences", inCmp), "consent"],
    ["CMP save, optional on", click("Save my choices", { ...inCmp, consentOptionalOn: true }), "consent"],
    ["CMP by frame host", click("Got it", { frame: { host: "cdn.cookielaw.org", readable: true } }), "consent"],
    ["OAuth text in dialog", click("Allow", { snippets: { dialog: "Dax Notes wants to access your account" } }), "consent"],
    ["OAuth text, Connect button", click("Connect my notes", { snippets: { landmark: "Dax Notes wants to access your account" } }), "consent"],
    ["OAuth path plus Allow", click("Allow", { page: { urlPath: "/o/oauth2/auth" } }), "consent"],
    ["OAuth path plus Authorize", click("Authorize", { page: { urlPath: "/oauth/authorize" } }), "consent"],
    ["OAuth consent path plus Continue", click("Continue", { page: { urlPath: "/consent" } }), "consent"],
    ["confirm dialog consent", { operation: "dialog_accept", dialog: { kind: "confirm", text: "Do you agree to the updated terms?" } }, "consent"],
    ["prompt dialog consent answered", { operation: "dialog_answer", dialog: { kind: "prompt", text: "Type I accept to agree to the privacy policy" } }, "consent"],
    ["weak Accept with terms dialog", click("Accept", consentPage), "consent"],
    ["weak Agree with consent manager on the page", click("Agree", { page: { hasConsentManager: true } }), "consent"],
    ["weak Continue with sentence anywhere", click("Continue", { snippets: { landmark: "You agree to our Terms when you continue." } }), "consent"],
    ["weak Allow, frames hold a TCF locator", click("Allow", { page: { frames: [{ host: "quantcast.mgr.consensu.org" }] } }), "consent"],
    ["Press Enter on Accept all", { ...click("Accept all"), operation: "press", key: "Enter" }, "consent"],
    ["zero-width evasion", click("I ag​ree"), "consent"],
    ["full-width evasion", click("Ａｃｃｅｐｔ ａｌｌ"), "consent"],
    ["upper case and spacing", click("  ACCEPT    ALL  COOKIES  "), "consent"],
  ];
  it("floors the consent cases", () => runRows(rows));

  const benign: Row[] = [
    ["Agree on a plain FAQ accordion", { operation: "click", tag: "button", role: "button", name: "Agree", snippets: { landmark: "Frequently asked questions. Do cats purr when happy?" } }, null],
    ["Accept a calendar invitation", click("Accept", { snippets: { form: "Priya invited you to Weekly sync, Tuesday 10:00. Accept Maybe Decline" } }), null],
    ["Confirm a shipping address with no context", click("Confirm"), null],
    ["Continue with no context", click("Continue"), null],
    ["Allow with no context", click("Allow"), null],
    ["Got it tooltip with no context", click("Got it"), null],
    ["Reject all", click("Reject all"), null],
    ["Only necessary", click("Only necessary"), null],
    ["Close X on cookie banner", click("×", inCmp), null],
    ["Close on cookie banner", click("Close", inCmp), null],
    ["Cancel in cookie banner", click("Cancel", inCmp), null],
    ["Manage preferences in banner", click("Manage preferences", inCmp), null],
    ["Cookie settings in banner", click("Cookie settings", inCmp), null],
    ["Privacy policy link in banner", link("Privacy policy", inCmp), null],
    ["Save with every optional category off", click("Save preferences", { ...inCmp, consentOptionalOn: false }), null],
    ["Terms link is only reading", link("Terms of Service", { snippets: { form: "By clicking Sign up you agree to our Terms of Service and Privacy Policy." } }), null],
    ["Privacy link is only reading", link("Privacy Policy", { snippets: { landmark: "By continuing you agree to our Terms and Privacy Policy." } }), null],
    ["Cancel next to a click-to-agree sentence", click("Cancel", { snippets: { dialog: "By clicking Accept you agree to the Terms." } }), null],
    ["Decline next to a click-to-agree sentence", click("Decline", { snippets: { dialog: "By clicking Accept you agree to the Terms." } }), null],
    ["I do not agree radio", { operation: "click", tag: "input", type: "radio", name: "I do not agree" }, null],
    ["Do not accept button, not the strong phrase", click("Don't accept all cookies"), null],
    ["Disagree is not agree", click("Disagree"), null],
    ["Continue without accepting", click("Continue without accepting"), null],
    ["OAuth Cancel", click("Cancel", { snippets: { dialog: "Dax Notes wants to access your account" } }), null],
    ["OAuth Deny", click("Deny", { snippets: { dialog: "Dax Notes wants to access your account" } }), null],
    ["Dismissing a consent confirm", { operation: "dialog_dismiss", dialog: { kind: "confirm", text: "Do you agree to the updated terms?" } }, null],
    ["alert that mentions terms only informs", { operation: "dialog_accept", dialog: { kind: "alert", text: "Our terms changed yesterday." } }, null],
    ["confirm that is not about consent", { operation: "dialog_accept", dialog: { kind: "confirm", text: "Leave this page? Changes may be lost." } }, null],
    ["plain button, plain page", click("Show more"), null],
    ["Open menu", click("Open menu"), null],
    ["Add to cart", click("Add to cart"), null],
    ["Delete is level 3 not floor", click("Delete"), null],
    ["Remove is level 3 not floor", click("Remove item"), null],
    ["Cancel subscription is level 3 not floor", click("Cancel subscription"), null],
    ["Purchase history link", link("Purchase history"), null],
    ["Repay now is not Pay now", click("Repay later in the app settings"), null],
    ["checkbox about newsletters", box("Send me the weekly newsletter"), null],
    ["checkbox Remember me", box("Remember me"), null],
    ["checkbox Select all rows", box("Select all rows"), null],
  ];
  it("lets the near-misses through", () => runRows(benign));
});

describe("F2: human verification (English detail)", () => {
  const rows: Row[] = [
    ["bare Verify", click("Verify"), "verification"],
    ["Verify email in Gmail", click("Verify email", { page: { urlPath: "/mail/u/0/", title: "Inbox - Gmail" } }), "verification"],
    ["Verify in a checkout", click("Verify", { form: { hasCardFields: true } }), "verification"],
    ["Verify address (documented false positive, H12)", click("Verify address"), "verification"],
    ["Verify your identity", click("Verify your identity"), "verification"],
    ["I am human", click("I am human"), "verification"],
    ["I'm not a robot checkbox", box("I'm not a robot"), "verification"],
    ["Im not a robot without apostrophe", box("Im not a robot"), "verification"],
    ["curly apostrophe", click("I’m not a robot"), "verification"],
    ["Prove you are human", click("Prove you are human"), "verification"],
    ["Slide to verify", click("Slide to verify"), "verification"],
    ["Complete the security check", click("Complete the security check"), "verification"],
    ["Press and hold button", click("Press & Hold"), "verification"],
    ["captcha by name", click("Refresh captcha image"), "verification"],
    ["reCAPTCHA signature on target", click("anything", { signatures: { captcha: true } }), "verification"],
    ["hCaptcha frame host", click("anything", { frame: { host: "newassets.hcaptcha.com", readable: true } }), "verification"],
    ["reCAPTCHA frame with path", click("anything", { frame: { host: "www.google.com", path: "/recaptcha/api2/anchor", readable: true } }), "verification"],
    ["Turnstile frame host", click("anything", { frame: { host: "challenges.cloudflare.com", readable: true } }), "verification"],
    ["any click on a challenge interstitial", click("Home", { signatures: { challengePage: true } }), "verification"],
    ["challenge page by title", link("Continue to site", { page: { title: "Just a moment..." } }), "verification"],
    ["challenge page by localized title", click("Seguir", { page: { title: "Un momento…" } }), "verification"],
    ["challenge page by path", click("x", { page: { urlPath: "/cdn-cgi/challenge-platform/h/b/orchestrate" } }), "verification"],
    ["typing on a challenge page", { ...typing("Search"), signatures: { challengePage: true } }, "verification"],
    ["unreadable captcha frame", click("x", { frame: { host: "geo.captcha-delivery.com", readable: false } }), "verification"],
    ["weak Accept next to a CAPTCHA", click("Continue", { page: { hasCaptcha: true } }), "verification"],
  ];
  it("floors the verification cases", () => runRows(rows));

  const benign: Row[] = [
    ["Verified purchase badge text is not Verify", click("Verified purchase"), null],
    ["reading on a challenge page stays allowed", { operation: "read", signatures: { challengePage: true } }, null],
    ["snapshot on a challenge page", { operation: "snapshot", signatures: { challengePage: true } }, null],
    ["Security settings link", link("Security settings"), null],
    ["Robot vacuum product", link("Robot vacuum cleaner"), null],
    ["Human resources link", link("Human resources"), null],
  ];
  it("lets the near-misses through", () => runRows(benign));
});

describe("F3: passwords, codes, card and ID entry (English detail)", () => {
  const rows: Row[] = [
    ["type=password", { operation: "type", tag: "input", type: "password", name: "" }, "credentials"],
    ["password revealed as type=text, flag set", { operation: "type", tag: "input", type: "text", name: "Secret", wasPassword: true }, "credentials"],
    ["autocomplete current-password", typing("Field", { autocomplete: "current-password" }), "credentials"],
    ["autocomplete new-password", typing("Field", { autocomplete: "new-password" }), "credentials"],
    ["autocomplete one-time-code", typing("Field", { autocomplete: "one-time-code" }), "credentials"],
    ["autocomplete cc-number", typing("Field", { autocomplete: "cc-number" }), "credentials"],
    ["autocomplete cc-exp", typing("Field", { autocomplete: "cc-exp" }), "credentials"],
    ["autocomplete cc-csc", typing("Field", { autocomplete: "cc-csc" }), "credentials"],
    ["autocomplete with section prefix", typing("Field", { autocomplete: "section-blue billing cc-name" }), "credentials"],
    ["Card number on a tel input via label for", { operation: "type", tag: "input", type: "tel", name: "Card number" }, "credentials"],
    ["IBAN", typing("IBAN"), "credentials"],
    ["Sort code", typing("Sort code"), "credentials"],
    ["Expiry date", typing("Expiry date"), "credentials"],
    ["MM/YY", typing("MM/YY"), "credentials"],
    ["Name on card", typing("Name on card"), "credentials"],
    ["PIN", typing("PIN"), "credentials"],
    ["One-time code", typing("One-time code"), "credentials"],
    ["Authenticator code", typing("Enter the code from your authenticator app"), "credentials"],
    ["2FA", typing("2FA code"), "credentials"],
    ["National insurance number", typing("National Insurance number"), "credentials"],
    ["Passport number", typing("Passport number"), "credentials"],
    ["Tax ID", typing("Tax ID"), "credentials"],
    ["identifier cvv", typing("", { fieldName: "payment_cvv" }), "credentials"],
    ["identifier camel case cardNumber", typing("", { fieldName: "cardNumber" }), "credentials"],
    ["identifier passwd", typing("", { fieldName: "user passwd" }), "credentials"],
    ["placeholder only is not enough, name wins", typing("Card number", { placeholder: "1234" }), "credentials"],
    ["select into expiry month", { operation: "select", tag: "select", name: "Expiry month" }, "credentials"],
    ["paste into password", { operation: "paste", tag: "input", type: "password", name: "" }, "credentials"],
    ["printable key into password", { operation: "press", key: "a", tag: "input", type: "password", name: "" }, "credentials"],
    ["keyboard_type into focused card field", { operation: "keyboard_type", tag: "input", type: "text", name: "Card number" }, "credentials"],
    ["unknown printable key counts as typing", { operation: "press", tag: "input", type: "password", name: "" }, "credentials"],
    ["upload passport", { operation: "upload", tag: "input", type: "file", name: "Passport scan" }, "credentials"],
    ["upload selfie", { operation: "upload", tag: "input", type: "file", name: "Take a selfie" }, "credentials"],
    ["upload ID by identifier", { operation: "upload", tag: "input", type: "file", name: "", fieldName: "passport_upload" }, "credentials"],
    ["click into a payment iframe", click("Card number", { signatures: { payment: true } }), "credentials"],
    ["click into Stripe frame by host", click("x", { frame: { host: "js.stripe.com", readable: true } }), "credentials"],
    ["typing inside payment frame", { operation: "type", tag: "input", type: "text", name: "", signatures: { payment: true } }, "credentials"],
    ["unreadable Stripe frame", click("x", { frame: { host: "js.stripe.com", readable: false } }), "credentials"],
    ["sign-in submit with a password field", submit("Log in", { form: { hasPasswordField: true } }), "credentials"],
    ["Enter in a password form", { operation: "press", key: "Enter", tag: "input", type: "text", name: "Email", submits: true, form: { hasPasswordField: true } }, "credentials"],
    ["submit a one-time-code form", submit("Next", { form: { hasOneTimeCodeField: true } }), "credentials"],
    ["prompt dialog asks for a password", { operation: "dialog_answer", dialog: { kind: "prompt", text: "Enter your password to continue" } }, "credentials"],
  ];
  it("floors the credential cases", () => runRows(rows));

  const benign: Row[] = [
    ["Search box", typing("Search"), null],
    ["Email field", typing("Email address"), null],
    ["Username field", typing("Username"), null],
    ["Full name", typing("Full name"), null],
    ["Promo code", typing("Promo code"), null],
    ["Coupon code", typing("Coupon code"), null],
    ["Zip code", typing("Zip code"), null],
    ["Postal code", typing("Postal code"), null],
    ["Country code", typing("Country code"), null],
    ["Message body", typing("Message"), null],
    ["Pinterest board", typing("Pinterest board name"), null],
    ["transaction-amount alone is not floor", typing("Amount", { autocomplete: "transaction-amount" }), null],
    ["autocomplete email", typing("Email", { autocomplete: "email" }), null],
    ["Backspace in a password field is not typing a secret", { operation: "press", key: "Backspace", tag: "input", type: "password", name: "", form: { hasPasswordField: true } }, null],
    ["Tab key", { operation: "press", key: "Tab", tag: "input", type: "text", name: "Email" }, null],
    ["clicking into a password field only focuses it", { operation: "click", tag: "input", type: "password", name: "Password" }, null],
    ["textarea whose text holds the word password", { operation: "click", tag: "textarea", name: "Notes", text: "my password reminder" }, null],
    ["upload a CV", { operation: "upload", tag: "input", type: "file", name: "Upload your CV" }, null],
    ["upload a profile photo", { operation: "upload", tag: "input", type: "file", name: "Profile photo" }, null],
    ["identifier optional is not otp", typing("Note", { fieldName: "optional_note" }), null],
    ["submit a form with no password", submit("Send message", { form: {} }), null],
    ["alert about a password", { operation: "dialog_accept", dialog: { kind: "alert", text: "Your password changed." } }, null],
  ];
  it("lets the near-misses through", () => runRows(benign));
});

describe("F4: the final pay button (English detail)", () => {
  const rows: Row[] = [
    ["Pay", click("Pay"), "payment"],
    ["Pay now", click("Pay now"), "payment"],
    ["Pay with amount", click("Pay $20.00"), "payment"],
    ["Pay with card", click("Pay with card"), "payment"],
    ["Place order", click("Place order"), "payment"],
    ["Place your order", click("Place your order"), "payment"],
    ["Complete order", click("Complete order"), "payment"],
    ["Complete purchase", click("Complete purchase"), "payment"],
    ["Confirm and pay", click("Confirm and pay"), "payment"],
    ["Buy now", click("Buy now"), "payment"],
    ["Submit payment", click("Submit payment"), "payment"],
    ["Confirm purchase", click("Confirm purchase"), "payment"],
    ["Book and pay", click("Book and pay"), "payment"],
    ["Donate", click("Donate"), "payment"],
    ["Purchase", click("Purchase"), "payment"],
    ["Order now", click("Order now"), "payment"],
    ["One-click buy", click("Buy with 1-Click"), "payment"],
    ["Foundry pattern: submit order", click("SubmitOrder"), "payment"],
    ["Foundry pattern: confirm payment", click("Confirm   Payment"), "payment"],
    ["Foundry pattern: PayNow", click("PayNow"), "payment"],
    ["Foundry pattern: placeorder", click("placeorder"), "payment"],
    ["input type=submit with value Pay now", { operation: "click", tag: "input", type: "submit", name: "", buttonValue: "Pay now" }, "payment"],
    ["aria-label only", { operation: "click", tag: "div", role: "button", name: "", ariaLabel: "Place order" }, "payment"],
    ["Subscribe with card fields", click("Subscribe", inCard), "payment"],
    ["Start trial in a payment frame page", click("Start free trial", { page: { hasPaymentFrame: true } }), "payment"],
    ["Confirm with a payment request button", click("Confirm", { page: { hasPaymentRequestButton: true } }), "payment"],
    ["Continue with a currency amount in the form", click("Continue", { snippets: { form: "Total: $42.00 Shipping: $4.00" } }), "payment"],
    ["Submit with a currency amount flag", click("Submit", { form: { hasCurrencyAmount: true } }), "payment"],
    ["Continue in a dialog showing euros", click("Continue", { snippets: { dialog: "You will be charged 19,99 EUR today" } }), "payment"],
    ["Continue with Stripe frame on page", click("Continue", { page: { frames: [{ host: "js.stripe.com" }] } }), "payment"],
    ["Continue in payment signature", click("Continue", { signatures: { payment: true } }), "payment"],
    ["submit a card form whatever the label", submit("Save", { form: { hasCardFields: true } }), "payment"],
    ["Enter in a card form", { operation: "press", key: "Enter", tag: "input", type: "text", name: "Email", submits: true, form: { hasCardFields: true } }, "payment"],
    ["payment dialog", { operation: "dialog_accept", dialog: { kind: "confirm", text: "Place your order for the blue mug?" } }, "payment"],
  ];
  it("floors the payment cases", () => runRows(rows));

  const benign: Row[] = [
    ["Add to cart", click("Add to cart"), null],
    ["Proceed to checkout", click("Proceed to checkout"), null],
    ["Continue shopping", click("Continue shopping"), null],
    ["Subscribe to a newsletter, no payment context", click("Subscribe"), null],
    ["Start trial with no payment context", click("Start trial"), null],
    ["Submit a contact form", submit("Submit", { form: {} }), null],
    ["Payment settings link", link("Payment settings"), null],
    ["Payroll link", link("Payroll"), null],
    ["Pay attention heading is not a control", link("Learn how to pay attention in class and read faster, a long article title that goes on and on for many words"), null],
    ["Price in unrelated landmark does not count", click("Continue", { snippets: { landmark: "Gadgets from $9" } }), null],
    ["Order history link", link("Order history"), null],
    ["Track order", click("Track order"), null],
    ["Donate link text inside a long sentence", link("We donated seven hundred trees to the national forest last year and you can read the full story here, with pictures"), null],
  ];
  it("lets the near-misses through", () => runRows(benign));
});

// ---------------------------------------------------------------------------
// Rule interplay, reads, and when unsure
// ---------------------------------------------------------------------------

describe("rule interplay", () => {
  it("reads never floor, whatever the page", () => {
    const ops = ["read", "snapshot", "screenshot", "scroll", "navigate", "wait", "hover", "find"];
    for (const operation of ops) {
      const got = classifyFloor({ operation, name: "I agree", signatures: { captcha: true, challengePage: true, payment: true }, factsFailed: true });
      expect(got.floor, operation).toBeNull();
    }
  });
  it("navigating to an OAuth endpoint is a read", () => {
    expect(classifyFloor({ operation: "navigate", page: { urlPath: "/oauth/authorize" } }).floor).toBeNull();
  });
  it("credentials win over consent, consent wins over weak words", () => {
    expect(classifyFloor(typing("Password", { snippets: { form: "By signing up you agree to our Terms" } })).floor).toBe("credentials");
    expect(classifyFloor(click("Pay now", { snippets: { form: "By placing your order you agree to the Terms" } })).floor).toBe("payment");
    expect(classifyFloor(submit("Create account", { form: { hasPasswordField: true }, snippets: { form: "By clicking Create account you agree to our Terms" } })).floor).toBe("consent");
    expect(classifyFloor(submit("Log in", { form: { hasPasswordField: true } })).floor).toBe("credentials");
  });
  it("a Close button in a payment frame is still inside the form", () => {
    expect(classifyFloor(click("Close", { signatures: { payment: true } })).floor).toBe("credentials");
  });
  it("a decline inside a CAPTCHA is still the CAPTCHA", () => {
    expect(classifyFloor(click("Cancel", { signatures: { captcha: true } })).floor).toBe("verification");
  });
  it("snippets are capped, not trusted", () => {
    const huge = "x".repeat(50_000);
    const got = classifyFloor(click("Next", { snippets: { form: huge, dialog: huge, landmark: huge, before: huge, after: huge } }));
    expect(got.floor).toBeNull();
  });
  it("a long control name retains its payment classification", () => {
    const long = "Press here to read why we think you should buy now and why everyone should agree that this article is long ".repeat(3);
    expect(classifyFloor(link(long)).floor).toBe("payment");
  });
  it("a long name that is itself a click-to-agree sentence is floor", () => {
    const sentence = "By clicking this button you agree to the Terms of Service, the Privacy Policy and the Cookie Policy of this website and all of its affiliated companies.";
    expect(classifyFloor(click(sentence)).floor).toBe("consent");
  });
  it("reason, rule and unsure are plain, stable and free of page text", () => {
    const got = classifyFloor(click("I agree to the secret page text 12345"));
    expect(got.rule).toBeTruthy();
    expect(got.reason).not.toContain("12345");
    expect(got.unsure).toBeUndefined();
  });
});

describe("when unsure, floor (spec 2.5.4)", () => {
  it("a missing or malformed facts object is floor and says so", () => {
    for (const bad of [undefined, null, 5, "x", {}, { operation: 3 }] as unknown[]) {
      const got = classifyFloor(bad as FloorFacts);
      expect(got.floor).not.toBeNull();
      expect(got.unsure).toBe(true);
    }
  });
  it("a classifier error is floor, never pass", () => {
    const hostile = {
      operation: "click",
      get name(): string { throw new Error("boom"); },
    } as unknown as FloorFacts;
    const got = classifyFloor(hostile);
    expect(got.floor).not.toBeNull();
    expect(got.unsure).toBe(true);
    expect(got.rule).toBe("classifier-error");
  });
  it("facts that could not be collected: input and upload are floor", () => {
    for (const operation of ["type", "fill", "upload", "select", "paste"]) {
      const got = classifyFloor({ operation, factsFailed: true });
      expect(got.floor, operation).toBe("credentials");
      expect(got.unsure).toBe(true);
    }
  });
  it("facts that could not be collected: a click with nothing known is floor", () => {
    const got = classifyFloor({ operation: "click", factsFailed: true });
    expect(got.floor).not.toBeNull();
    expect(got.unsure).toBe(true);
  });
  it("facts that could not be collected: even a known, harmless-looking link is floor (round 8, SEC-01)", () => {
    const got = classifyFloor({ operation: "click", tag: "a", role: "link", name: "Next page", factsFailed: true });
    expect(got.floor).not.toBeNull();
    expect(got.unsure).toBe(true);
  });
  it("facts that could not be collected still floor what the partial facts show", () => {
    expect(classifyFloor({ operation: "click", tag: "button", name: "Pay now", factsFailed: true }).floor).toBe("payment");
    expect(classifyFloor({ operation: "type", tag: "input", type: "password", factsFailed: true }).floor).toBe("credentials");
  });
  it("an unknown operation checks everything", () => {
    expect(classifyFloor({ operation: "mystery", tag: "input", type: "password", name: "" }).floor).toBe("credentials");
    expect(classifyFloor({ operation: "mystery", tag: "button", name: "Place order" }).floor).toBe("payment");
    expect(classifyFloor({ operation: "mystery", tag: "button", name: "Show more" }).floor).toBeNull();
  });
  it("an unreadable frame: floor on CAPTCHA, payment and consent hosts, else not floor", () => {
    expect(classifyFloor(click("x", { frame: { host: "www.recaptcha.net", readable: false } })).floor).toBe("verification");
    expect(classifyFloor(click("x", { frame: { host: "checkoutshopper-live.adyen.com", readable: false } })).floor).toBe("credentials");
    expect(classifyFloor(click("x", { frame: { host: "consent.cookiebot.com", readable: false } })).floor).toBe("consent");
    expect(classifyFloor(click("x", { frame: { host: "player.vimeo.com", readable: false } })).floor).toBeNull();
  });
  it("unreadable dialog text is floor", () => {
    const got = classifyFloor({ operation: "dialog_accept", dialog: { kind: "confirm", text: "" } });
    expect(got.floor).not.toBeNull();
    expect(got.unsure).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lexicon, normalisation and signatures
// ---------------------------------------------------------------------------

describe("lexicon", () => {
  const tables = {
    CONSENT_CONTROL_STRONG, CONSENT_CONTROL_WEAK, CONSENT_AGREE_VERB, CONSENT_TOPIC, SENTENCE_BY_ACTION, SENTENCE_AGREE, CONSENT_DECLINE,
    CONSENT_OPENERS, CONSENT_SAVE_CHOICES, OAUTH_PHRASES, OAUTH_ALLOW, VERIFY_HUMAN, VERIFY_WORD, CREDENTIAL_FIELD, ID_UPLOAD_FIELD, PAY_CONTROL, PAY_CONTROL_WEAK,
  };
  it("every table carries all eight languages and none is empty", () => {
    expect(FLOOR_LANGS).toEqual(["en", "es", "fr", "de", "pt", "ja", "zh", "hi"]);
    for (const [name, table] of Object.entries(tables)) {
      for (const lang of FLOOR_LANGS) {
        expect(table[lang].length, `${name}.${lang}`).toBeGreaterThan(0);
      }
    }
  });
  it("every phrase in every table matches itself after folding", () => {
    for (const [name, table] of Object.entries(tables)) {
      const matcher = compilePhrases(table);
      for (const lang of FLOOR_LANGS) {
        for (const phrase of table[lang]) {
          const text = phrase.startsWith("=") ? phrase.slice(1) : phrase;
          expect(matcher.test(foldText(text)), `${name}.${lang}: ${phrase}`).toBe(true);
        }
      }
    }
  });
  it("normalises NFKC, case, zero-width characters, accents, punctuation and spacing", () => {
    expect(foldText("  Ｉ​  AGREE!!  ")).toBe("i agree");
    expect(foldText("Acepto los Términos")).toBe("acepto los terminos");
    expect(foldText("I’m not a robot")).toBe("i'm not a robot");
    expect(foldText("Accept & Continue")).toBe("accept and continue");
    expect(foldText("ｱｲ")).toBe("アイ");
    expect(foldText("同意‍ します")).toBe("同意 します");
    expect(foldText("")).toBe("");
  });
  it("word boundaries keep short words honest", () => {
    const pay = compilePhrases({ ...PAY_CONTROL });
    expect(pay.test(foldText("Payroll"))).toBe(false);
    expect(pay.test(foldText("Repay now"))).toBe(false);
    expect(pay.test(foldText("Pay now"))).toBe(true);
    const verify = compilePhrases(VERIFY_WORD);
    expect(verify.test(foldText("Unverified"))).toBe(false);
    expect(verify.test(foldText("Verify"))).toBe(true);
    const agree = compilePhrases(CONSENT_AGREE_VERB);
    expect(agree.test(foldText("disagree"))).toBe(false);
    expect(agree.test(foldText("assent"))).toBe(false);
  });
  it("Japanese and Chinese match as substrings, Hindi on word boundaries", () => {
    expect(compilePhrases(CONSENT_CONTROL_STRONG).test(foldText("利用規約に同意して続行します"))).toBe(true);
    expect(compilePhrases(CONSENT_CONTROL_STRONG).test(foldText("असहमत हूं"))).toBe(false);
  });
  it("exact entries match the whole name only", () => {
    const decline = compilePhrases(CONSENT_DECLINE);
    expect(decline.test(foldText("Close"))).toBe(true);
    expect(decline.test(foldText("Accept and close"))).toBe(false);
  });
  it("ports Foundry's DESTRUCTIVE_PATTERNS verbatim and tightens only the pay entries", () => {
    expect(DESTRUCTIVE_PATTERNS.map(p => p.source)).toEqual(["delete", "remove", "purchase", "submit\\s*order", "confirm\\s*payment", "pay\\s*now", "place\\s*order", "cancel\\s*subscription", "close\\s*account"]);
    expect(FOUNDRY_PAY_PATTERNS).toHaveLength(4);
    for (const text of ["submit order", "confirm payment", "pay now", "place order"]) {
      expect(FOUNDRY_PAY_PATTERNS.some(p => p.test(text)), text).toBe(true);
    }
    expect(FOUNDRY_PAY_PATTERNS.some(p => p.test("repay now"))).toBe(false);
  });
});

describe("signatures", () => {
  it("every signature has an id, a label, a kind and something to look for", () => {
    const ids = new Set<string>();
    for (const sig of ALL_FRAME_SIGNATURES) {
      expect(ids.has(sig.id), sig.id).toBe(false);
      ids.add(sig.id);
      expect(sig.label.length).toBeGreaterThan(0);
      expect(sig.hosts.length + sig.selectors.length + (sig.frameNamePrefixes?.length ?? 0)).toBeGreaterThan(0);
    }
  });
  it("names the spec's frameworks", () => {
    for (const id of ["onetrust", "cookiebot", "trustarc", "quantcast", "didomi", "usercentrics", "osano", "termly", "iubenda", "complianz", "klaro", "cookieyes", "sourcepoint", "funding-choices", "ketch", "admiral", "axeptio", "borlabs", "iab-tcf", "recaptcha", "hcaptcha", "turnstile", "aws-waf", "arkose", "geetest", "human-px", "datadome", "friendly-captcha", "mtcaptcha", "keycaptcha", "stripe", "braintree", "adyen", "checkout-com", "square", "paypal", "klarna", "affirm", "apple-pay", "google-pay"]) {
      expect(ALL_FRAME_SIGNATURES.some(sig => sig.id === id), id).toBe(true);
    }
  });
  it("matches hosts and subdomains, and shared hosts only by path", () => {
    expect(matchFrame({ host: "js.stripe.com" })?.id).toBe("stripe");
    expect(matchFrame({ host: "geo.captcha-delivery.com" })?.id).toBe("datadome");
    expect(matchFrame({ host: "WWW.HCAPTCHA.COM." })?.id).toBe("hcaptcha");
    expect(matchFrame({ host: "www.google.com", path: "/recaptcha/api2/anchor" })?.id).toBe("recaptcha");
    expect(matchFrame({ host: "www.google.com", path: "/maps/embed" })).toBeNull();
    expect(matchFrame({ host: "www.google.com" })).toBeNull();
    expect(matchFrame({ host: "www.paypal.com", path: "/sdk/js" })?.id).toBe("paypal");
    expect(matchFrame({ host: "www.paypal.com", path: "/us/home" })).toBeNull();
    expect(matchFrame({ host: "notstripe.com" })).toBeNull();
    expect(matchFrame({ host: "" })).toBeNull();
    expect(matchFrameName("sp_message_iframe_12345")?.id).toBe("sourcepoint");
    expect(matchFrameName("__tcfapiLocator")?.id).toBe("iab-tcf");
    expect(matchFrameName("random")).toBeNull();
  });
  it("hands the collector its selectors by kind", () => {
    expect(signatureSelectors("consent")).toContain("#onetrust-accept-btn-handler");
    expect(signatureSelectors("consent")).toContain("#CybotCookiebotDialog");
    expect(signatureSelectors("captcha")).toContain(".g-recaptcha");
    expect(signatureSelectors("captcha")).toContain(".cf-turnstile");
    expect(signatureSelectors("payment")).toContain(".StripeElement");
    expect(signatureSelectors("payment")).toContain("apple-pay-button");
  });
  it("category labels cover the four kinds and obey the copy rules", () => {
    expect(FLOOR_KINDS).toEqual(["consent", "verification", "credentials", "payment"]);
    for (const kind of FLOOR_KINDS) {
      for (const text of [FLOOR_OWNER_PHRASE[kind], FLOOR_CATEGORY_LABEL[kind]]) {
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toMatch(/—|–/);
        expect(text).not.toMatch(/\b(safe|safely|safety|unsafe|composio)\b/i);
      }
    }
  });
});

describe("copy rules for the new files", () => {
  it("source files carry no em dash and none of the banned words", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["browser-floor.ts", "browser-floor-lexicon.ts", "../shared/browser-floor-signatures.ts"]) {
      const text = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(text, file).not.toMatch(/—/);
      expect(text, file).not.toMatch(/\b(safe|safely|safety|unsafe|composio)/i);
      expect(text, file).toContain("SPDX-License-Identifier: AGPL-3.0-or-later");
    }
  });
});

describe("coverage of the table", () => {
  it("runs at least 250 cases (spec F1)", () => {
    expect(rowsRun).toBeGreaterThanOrEqual(250);
  });
});

describe("Opus gate: key spellings never slip past the floor", () => {
  const variants = ["enter", "ENTER", "Return", "NumpadEnter", "Shift+Enter", "Ctrl+Enter", "ControlOrMeta+Enter", "space", "Space", "Spacebar", "Shift+Space", "Shift+ "];
  it.each(variants)("press %s on Accept all and on a terms checkbox is consent", (key) => {
    expect(classifyFloor({ ...click("Accept all"), operation: "press", key }).floor).toBe("consent");
    expect(classifyFloor({ ...box("I agree to the Terms of Service"), operation: "press", key }).floor).toBe("consent");
  });
  it("a modified printable key in a password field counts as typing", () => {
    expect(classifyFloor({ operation: "press", key: "Shift+A", tag: "input", type: "password", name: "" }).floor).toBe("credentials");
  });
  it("known inert keys stay inert", () => {
    expect(classifyFloor({ operation: "press", key: "Tab", tag: "input", type: "text", name: "Email" }).floor).toBeNull();
    expect(classifyFloor({ operation: "press", key: "Backspace", tag: "input", type: "password", name: "", form: { hasPasswordField: true } }).floor).toBeNull();
  });
});

describe("Opus gate round 2: line-break keys reach the floor as Enter", () => {
  it.each(["\n", "\r", "\r\n"])("press %j on Accept all is consent", (key) => {
    expect(classifyFloor({ ...click("Accept all"), operation: "press", key }).floor).toBe("consent");
  });
});

describe("Opus gate round 2: an unproven submit is a submit", () => {
  const login = { tag: "input", type: "email", role: "textbox", name: "Email", form: { hasPasswordField: true } } as Partial<FloorFacts>;
  it.each(["Enter", "Return", "\n", undefined])("press %j in a login form with submits unknown is credentials", (key) => {
    expect(classifyFloor({ ...login, operation: "press", ...(key === undefined ? {} : { key }) } as FloorFacts).floor).toBe("credentials");
  });
  it("submits: false proven by the collector still holds, and Space in the field is not a submit", () => {
    expect(classifyFloor({ ...login, operation: "press", key: "Enter", submits: false } as FloorFacts).floor).toBeNull();
    expect(classifyFloor({ ...login, operation: "press", key: " " } as FloorFacts).floor).toBeNull();
  });
  it("Enter in a card form with submits unknown is payment", () => {
    expect(classifyFloor({ tag: "input", type: "text", name: "Name on card", operation: "press", key: "Enter", form: { hasCardFields: true } } as FloorFacts).floor).toBe("payment");
  });
});

describe("Opus gate follow-up: a failed read with no name is unsure for clicks and presses", () => {
  it.each([["click", undefined], ["press", "Enter"], ["press", " "]] as const)("%s %s on a known tag with factsFailed and no name is floor (unsure)", (operation, key) => {
    const r = classifyFloor({ operation, ...(key ? { key } : {}), tag: "x-chat", factsFailed: true } as FloorFacts);
    expect(r.floor).not.toBeNull();
    expect(r.unsure).toBe(true);
  });
  it("a failed read that still has a plain name on a click is the owner's too (round 8, SEC-01)", () => {
    expect(classifyFloor({ operation: "click", tag: "button", name: "Next page", factsFailed: true } as FloorFacts).floor).not.toBeNull();
  });
});
