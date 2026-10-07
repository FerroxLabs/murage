// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Signature tables for the Murage for Chrome hard floor (spec 2.5.6).
//
// The floor is the short list of steps no mode can lift: agreeing to terms,
// proving you are human, typing a secret or card, and pressing the final pay
// button. These tables name the known consent managers, CAPTCHA and challenge
// vendors and payment providers. Everything here is local: a CSS selector the
// page collector can test, a frame host the classifier can compare, or a page
// title. Nothing is fetched. The side panel imports the category labels so the
// extension and the server say the same thing.

export const FLOOR_KINDS = ["consent", "verification", "credentials", "payment"] as const;
export type FloorKind = (typeof FLOOR_KINDS)[number];

/** Short owner-facing phrase for each floor category (no page text, no prices). */
export const FLOOR_OWNER_PHRASE: Record<FloorKind, string> = {
  consent: "agree to the site's terms or consent",
  verification: "prove you are human",
  credentials: "enter a password, code, card or ID",
  payment: "press the final pay button",
};

/** D1: account and security changes are classed under consent by the floor; the owner is told what they are in their own words. */
export const ACCOUNT_OWNER_PHRASE = "change an account or security setting";

/** Plain category names for the side panel and activity log. */
export const FLOOR_CATEGORY_LABEL: Record<FloorKind, string> = {
  consent: "Terms and consent",
  verification: "Human verification",
  credentials: "Passwords, codes, card and ID",
  payment: "Final pay button",
};

export type SignatureKind = "consent" | "captcha" | "payment";

export interface FrameSignature {
  id: string;
  label: string;
  kind: SignatureKind;
  /** Frame hosts. A host matches itself and any subdomain of it. */
  hosts: readonly string[];
  /** Hosts shared with a large site: they match only when the frame path starts with pathPrefix. */
  pathHosts?: readonly string[];
  pathPrefix?: string;
  /** CSS selectors for the page collector (isolated world). */
  selectors: readonly string[];
  /** Frame name prefixes (for example Sourcepoint message frames). */
  frameNamePrefixes?: readonly string[];
}

export const CONSENT_MANAGERS: readonly FrameSignature[] = [
  { id: "onetrust", label: "OneTrust", kind: "consent", hosts: ["cookielaw.org", "onetrust.com", "onetrust.eu"], selectors: ["#onetrust-banner-sdk", "#onetrust-accept-btn-handler", "#onetrust-consent-sdk", "#onetrust-pc-sdk"] },
  { id: "cookiebot", label: "Cookiebot", kind: "consent", hosts: ["cookiebot.com"], selectors: ["#CybotCookiebotDialog", "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll"] },
  { id: "trustarc", label: "TrustArc", kind: "consent", hosts: ["trustarc.com", "truste.com"], selectors: ["#truste-consent-track", ".truste_box_overlay", "#truste-cookie-button"] },
  { id: "quantcast", label: "Quantcast Choice / InMobi", kind: "consent", hosts: ["quantcast.mgr.consensu.org", "quantcast.com", "inmobi.com"], selectors: [".qc-cmp2-container", "#qc-cmp2-container", ".qc-cmp2-summary-buttons"] },
  { id: "didomi", label: "Didomi", kind: "consent", hosts: ["didomi.io", "privacy-center.org"], selectors: ["#didomi-host", "#didomi-popup", ".didomi-popup-container"] },
  { id: "usercentrics", label: "Usercentrics", kind: "consent", hosts: ["usercentrics.eu", "usercentrics.com"], selectors: ["#usercentrics-root", "#uc-center-container"] },
  { id: "osano", label: "Osano", kind: "consent", hosts: ["osano.com"], selectors: [".osano-cm-window", ".osano-cm-dialog"] },
  { id: "termly", label: "Termly", kind: "consent", hosts: ["termly.io"], selectors: ["#termly-code-snippet-support", ".t-consentPrompt"] },
  { id: "iubenda", label: "iubenda", kind: "consent", hosts: ["iubenda.com"], selectors: ["#iubenda-cs-banner", ".iubenda-cs-container"] },
  { id: "complianz", label: "Complianz", kind: "consent", hosts: [], selectors: ["#cmplz-cookiebanner-container", ".cmplz-cookiebanner"] },
  { id: "klaro", label: "Klaro", kind: "consent", hosts: [], selectors: [".klaro", "#klaro"] },
  { id: "cookieyes", label: "CookieYes", kind: "consent", hosts: ["cookieyes.com"], selectors: [".cky-consent-container", ".cky-btn-accept"] },
  { id: "sourcepoint", label: "Sourcepoint", kind: "consent", hosts: ["sourcepoint.com", "privacy-mgmt.com", "sp-prod.net"], selectors: ["[id^='sp_message_container']"], frameNamePrefixes: ["sp_message_iframe"] },
  { id: "funding-choices", label: "Google Funding Choices", kind: "consent", hosts: ["fundingchoicesmessages.google.com"], selectors: [".fc-consent-root", ".fc-dialog-container"] },
  { id: "ketch", label: "Ketch", kind: "consent", hosts: ["ketchcdn.com", "ketchjs.com", "ketch.com"], selectors: ["#lanyard_root", "[id^='ketch-']"] },
  { id: "admiral", label: "Admiral", kind: "consent", hosts: ["getadmiral.com", "admiral.com"], selectors: ["[class*='admiral-']"] },
  { id: "axeptio", label: "Axeptio", kind: "consent", hosts: ["axept.io"], selectors: ["#axeptio_overlay", "#axeptio_btn"] },
  { id: "borlabs", label: "Borlabs Cookie", kind: "consent", hosts: [], selectors: ["#BorlabsCookieBox", ".BorlabsCookie"] },
  { id: "iab-tcf", label: "IAB TCF or GPP locator", kind: "consent", hosts: ["consensu.org"], selectors: ["iframe[name='__tcfapiLocator']", "iframe[name='__gppLocator']", "iframe[name='__uspapiLocator']"], frameNamePrefixes: ["__tcfapiLocator", "__gppLocator"] },
];

/** Generic rule the collector applies on top of the named managers. */
export const GENERIC_CONSENT_CONTAINER_RULE =
  "a fixed or sticky container whose text contains cookie plus accept or agree";

export const CAPTCHA_SIGNATURES: readonly FrameSignature[] = [
  { id: "recaptcha", label: "Google reCAPTCHA", kind: "captcha", hosts: ["recaptcha.net"], pathHosts: ["google.com"], pathPrefix: "/recaptcha", selectors: [".g-recaptcha", "iframe[src*='recaptcha']", ".grecaptcha-badge", "#recaptcha"] },
  { id: "hcaptcha", label: "hCaptcha", kind: "captcha", hosts: ["hcaptcha.com"], selectors: [".h-captcha", "iframe[src*='hcaptcha.com']"] },
  { id: "turnstile", label: "Cloudflare Turnstile and challenge", kind: "captcha", hosts: ["challenges.cloudflare.com"], selectors: [".cf-turnstile", "#challenge-form", "#cf-challenge-running", "#challenge-stage", "iframe[src*='challenges.cloudflare.com']"] },
  { id: "aws-waf", label: "AWS WAF CAPTCHA", kind: "captcha", hosts: ["awswaf.com", "captcha.awswaf.com"], selectors: ["#captcha-container", "awswaf-captcha"] },
  { id: "arkose", label: "Arkose Labs", kind: "captcha", hosts: ["arkoselabs.com", "funcaptcha.com"], selectors: ["#FunCaptcha", "iframe[src*='arkoselabs.com']"] },
  { id: "geetest", label: "GeeTest", kind: "captcha", hosts: ["geetest.com", "gt4.geetest.com"], selectors: [".geetest_holder", ".geetest_panel"] },
  { id: "human-px", label: "HUMAN (PerimeterX)", kind: "captcha", hosts: ["perimeterx.net", "px-cdn.net", "px-cloud.net", "px-client.net"], selectors: ["#px-captcha", "[id^='px-captcha']"] },
  { id: "datadome", label: "DataDome", kind: "captcha", hosts: ["captcha-delivery.com", "datadome.co"], selectors: ["iframe[src*='captcha-delivery.com']", "#ddv1-captcha-container"] },
  { id: "friendly-captcha", label: "Friendly Captcha", kind: "captcha", hosts: ["friendlycaptcha.com", "friendlycaptcha.eu"], selectors: [".frc-captcha"] },
  { id: "mtcaptcha", label: "MTCaptcha", kind: "captcha", hosts: ["mtcaptcha.com"], selectors: [".mtcaptcha", "#mtcaptcha"] },
  { id: "keycaptcha", label: "KeyCAPTCHA", kind: "captcha", hosts: ["keycaptcha.com"], selectors: ["#div_for_keycaptcha"] },
  { id: "smartcaptcha", label: "Yandex SmartCaptcha", kind: "captcha", hosts: ["smartcaptcha.yandexcloud.net"], selectors: [".smart-captcha"] },
  { id: "captcha-generic", label: "Generic CAPTCHA widget", kind: "captcha", hosts: ["captcha.com"], selectors: ["[data-sitekey]", "[class*='captcha' i]", "[id*='captcha' i]"] },
];

export const PAYMENT_SIGNATURES: readonly FrameSignature[] = [
  { id: "stripe", label: "Stripe", kind: "payment", hosts: ["js.stripe.com", "m.stripe.network", "hooks.stripe.com", "checkout.stripe.com", "m.stripe.com"], selectors: [".StripeElement", "iframe[src*='js.stripe.com']", "iframe[name^='__privateStripeFrame']"] },
  { id: "braintree", label: "Braintree", kind: "payment", hosts: ["braintreegateway.com", "braintree-api.com", "braintreepayments.com"], selectors: ["[data-braintree-id]", "iframe[src*='braintreegateway.com']", "iframe[name^='braintree-hosted-field']"] },
  { id: "adyen", label: "Adyen", kind: "payment", hosts: ["adyen.com", "adyenpayments.com"], selectors: [".adyen-checkout__card", "[class*='adyen-checkout']"] },
  { id: "checkout-com", label: "Checkout.com", kind: "payment", hosts: ["checkout.com", "cko-lab.com"], selectors: ["iframe[src*='checkout.com']", ".frames-container"] },
  { id: "square", label: "Square", kind: "payment", hosts: ["squareup.com", "squarecdn.com", "squareupsandbox.com"], selectors: ["#sq-card-number", ".sq-card-wrapper", "iframe[src*='squareup.com']"] },
  { id: "paypal", label: "PayPal", kind: "payment", hosts: ["paypal.com", "paypalobjects.com"], selectors: ["#paypal-button-container", "iframe[src*='paypal.com/sdk']", "iframe[src*='paypal.com/smart']", "[data-funding-source='paypal']"] },
  { id: "klarna", label: "Klarna", kind: "payment", hosts: ["klarna.com", "klarnacdn.net"], selectors: ["klarna-placement", "iframe[src*='klarna']"] },
  { id: "affirm", label: "Affirm", kind: "payment", hosts: ["affirm.com"], selectors: ["[class*='affirm-']"] },
  { id: "shopify-pay", label: "Shop Pay and Shopify checkout fields", kind: "payment", hosts: ["shopifycs.com", "pay.shopify.com", "checkout.pci.shopifyinc.com"], selectors: ["iframe[src*='shopifycs.com']"] },
  { id: "authorize-net", label: "Authorize.Net", kind: "payment", hosts: ["authorize.net"], selectors: ["#AcceptUIContainer"] },
  { id: "apple-pay", label: "Apple Pay", kind: "payment", hosts: ["apple-pay-gateway.apple.com"], selectors: ["apple-pay-button", "[style*='-apple-pay-button']", ".apple-pay-button"] },
  { id: "google-pay", label: "Google Pay", kind: "payment", hosts: ["pay.google.com", "payments.google.com"], selectors: ["gpay-button", ".gpay-button", ".gpay-card-info-container"] },
  { id: "payment-request", label: "Payment Request button", kind: "payment", hosts: [], selectors: ["[data-payment-request]", "payment-request-button"] },
];

export const ALL_FRAME_SIGNATURES: readonly FrameSignature[] = [
  ...CONSENT_MANAGERS,
  ...CAPTCHA_SIGNATURES,
  ...PAYMENT_SIGNATURES,
];

export interface FrameRef {
  host: string;
  /** Path of the frame URL, when the collector kept it. */
  path?: string;
}

function hostMatches(host: string, pattern: string): boolean {
  return host === pattern || host.endsWith("." + pattern);
}

function normalHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
}

/** Which known framework a frame belongs to, by host (and path where a vendor shares a host). */
export function matchFrame(frame: FrameRef): FrameSignature | null {
  const host = normalHost(frame.host || "");
  if (!host) return null;
  const path = (frame.path ?? "").toLowerCase();
  for (const sig of ALL_FRAME_SIGNATURES) {
    for (const pattern of sig.hosts) {
      if (!hostMatches(host, pattern)) continue;
      // A vendor that shares a host with a large site (google.com, paypal.com)
      // only matches on its path. An unknown path never matches such a host.
      if (sig.id === "paypal" && !/^\/(sdk|smart|checkoutnow|webapps|v1\/)/.test(path)) continue;
      return sig;
    }
  }
  for (const sig of ALL_FRAME_SIGNATURES) {
    if (!sig.pathHosts || !sig.pathPrefix) continue;
    if (sig.pathHosts.some(pattern => hostMatches(host, pattern)) && path.startsWith(sig.pathPrefix)) return sig;
  }
  return null;
}

export function matchFrameName(name: string): FrameSignature | null {
  const lower = name.toLowerCase();
  for (const sig of ALL_FRAME_SIGNATURES) {
    if (sig.frameNamePrefixes?.some(prefix => lower.startsWith(prefix.toLowerCase()))) return sig;
  }
  return null;
}

/** Every selector of one kind, for the page collector to test in the isolated world. */
export function signatureSelectors(kind: SignatureKind): string[] {
  return ALL_FRAME_SIGNATURES.filter(sig => sig.kind === kind).flatMap(sig => [...sig.selectors]);
}

/** Challenge interstitial pages: titles are folded (lower case, no accents, no punctuation) before matching. */
export const CHALLENGE_TITLE_PREFIXES: readonly string[] = [
  "just a moment",
  "un instant",
  "un momento",
  "einen moment",
  "nur einen moment",
  "um momento",
  "one moment",
  "attention required",
  "ちょっと待ってください",
  "しばらくお待ちください",
  "请稍候",
  "請稍候",
  "稍等片刻",
  "कृपया प्रतीक्षा करें",
];

export const CHALLENGE_TITLE_PHRASES: readonly string[] = [
  "verify you are human",
  "are you a robot",
  "are you human",
  "checking your browser",
  "checking if the site connection is secure",
  "one more step",
  "please wait while we verify",
  "security check",
  "human verification",
  "robot check",
  "bot verification",
  "pardon our interruption",
  "ddos protection by",
  "captcha",
  "verifica que eres humano",
  "vérifiez que vous êtes humain",
  "bestätigen sie, dass sie ein mensch sind",
  "verifique que você é humano",
  "人机验证",
  "人機驗證",
  "ロボットではありません",
];

/** URL paths of vendor challenge endpoints. */
export const CHALLENGE_PATH_PATTERNS: readonly RegExp[] = [
  /^\/cdn-cgi\/(challenge-platform|l\/chk_captcha)/i,
  /^\/(captcha|recaptcha|hcaptcha)(\/|$)/i,
  /^\/sorry\/index/i,
  /^\/_incapsula_resource/i,
  /^\/distil_r_captcha/i,
  /^\/captcha-delivery/i,
  /^\/px\/captcha/i,
];

/** OAuth and app authorisation endpoints (decision D7). */
export const OAUTH_PATH_PATTERN =
  /(^|\/)(oauth2?|oidc|openid|authorize|authorise|consent|grant|dialog\/oauth|o\/oauth2|signin\/oauth|login\/oauth|connect\/authorize)(\/|$|\.)/i;
