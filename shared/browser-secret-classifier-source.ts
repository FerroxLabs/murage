// SPDX-License-Identifier: AGPL-3.0-or-later
// Round 8: the source text of the ONE secret classifier for Murage for Chrome. Everything that lets a value leave a page (the recipient scan, the intent
// and approval lines, the action digest, screenshot masks, the protected-document guard) asks this file and nothing else.
//
// It is a source string on purpose. The page-side scripts (which run inside the owner's page, in the extension's isolated world) embed the
// very same text, so the server and the page can never disagree; the server compiles the string once. No imports.
//
// What it knows, after normalising digits (full-width, Arabic-Indic, Devanagari, Thai and the other Unicode decimal scripts become 0-9)
// and removing separators (spaces, dots, dashes, slashes, underscores, dots and the unicode look-alikes):
//  - a bare number of 4 to 9 digits: a PIN, a one-time code of 4 to 8 digits, a card half, a social security number;
//  - a number of 13 to 19 digits: a payment card (grouped any way);
//  - a name (type, id, label, placeholder, autocomplete) that says password, code, card, SSN or ID in the common languages.
// A number that starts with + or carries brackets is shaped like a phone number and is not a secret by shape.
// When in doubt it says secret.

export const SECRET_CLASSIFIER_SOURCE = String.raw`(function(){
  var ZEROS=[0x30,0x660,0x6f0,0x7c0,0x966,0x9e6,0xa66,0xae6,0xb66,0xbe6,0xc66,0xce6,0xd66,0xde6,0xe50,0xed0,0xf20,0x1040,0x1090,0x17e0,0x1810,0x1946,0x19d0,0x1a80,0x1a90,0x1b50,0x1bb0,0x1c40,0x1c50,0xa620,0xa8d0,0xa900,0xa9d0,0xa9f0,0xaa50,0xabf0,0xff10,0x104a0,0x10d30,0x11066,0x110f0,0x11136,0x111d0,0x112f0,0x11450,0x114d0,0x11650,0x116c0,0x11730,0x118e0,0x11950,0x11c50,0x11d50,0x11da0,0x16a60,0x16ac0,0x16b50,0x1d7ce,0x1d7d8,0x1d7e2,0x1d7ec,0x1d7f6,0x1e140,0x1e2f0,0x1e4f0,0x1e950,0x1fbf0];
  var ND=/\p{Nd}/u;
  var SEP=/[\s\u00a0\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff\u2010-\u2015\u2212\u30fc\uff0d\-.,_\u00b7\u2022\u2219\u30fb'\u2019\/\\|:;*\u066b\u066c\u060c]/g;
  function normalize(v){
    var s=String(v==null?'':v);
    try{s=s.normalize('NFKC');}catch(e){}
    // Round 9: invisible format characters (word joiner, bidi marks and overrides, zero-width) never hide a number.
    // Round 10 (R9-03): nor do combining marks (grapheme joiner U+034F, variation selectors), control characters or the blank fillers.
    try{s=s.replace(/[\p{Cf}\p{M}\p{Cc}\u034f\u115f\u1160\u17b4\u17b5\u2800\u3164\uffa0\u{e0000}-\u{e0fff}]/gu,'');}catch(e){}
    var out='';
    for(var ch of s){
      if(ND.test(ch)){
        var cp=ch.codePointAt(0),z=0x30;
        for(var i=0;i<ZEROS.length;i++){if(ZEROS[i]<=cp&&cp-ZEROS[i]<10)z=ZEROS[i];}
        out+=String(Math.min(9,Math.max(0,cp-z)));
      }else out+=ch;
    }
    return out;
  }
  function luhn(d){var sum=0;for(var i=0;i<d.length;i++){var n=d.charCodeAt(d.length-1-i)-48;if(i%2===1){n*=2;if(n>9)n-=9;}sum+=n;}return sum%10===0;}
  function digitsOnly(v){var t=normalize(v).trim();var b=t.replace(SEP,'').replace(/[()+]/g,'');return /^[0-9]+$/.test(b)?b:'';}
  // A leading + or brackets shape a phone number, which is allowed as a recipient unless it is really a card (13 to 19 digits, Luhn) or a 9 digit SSN.
  function phoneShaped(v){var t=normalize(v).trim();return /^[+(]/.test(t)||/[()]/.test(t);}
  function looksLikeSecretValue(v){
    var b=digitsOnly(v);
    if(!b)return false;
    // Round 10 (R10-08): brackets or a plus never exempt a 4 to 9 digit number (a code, a PIN, an SSN, a card half). Only longer numbers read as phones.
    if(phoneShaped(v))return (b.length>=4&&b.length<=9)||(b.length>=13&&b.length<=19&&luhn(b));
    if(b.length>=4&&b.length<=9)return true;
    if(b.length>=13&&b.length<=19)return true;
    return false;
  }
  var NAME=/(pass(word|wd|code|phrase)?|pwd|secret|api.?key|private.?key|access.?token|auth.?token|refresh.?token|token|one.?time|otp|totp|2fa|mfa|verif\w*.?code|security.?code|confirmation.?code|recovery|seed.?phrase|mnemonic|(^|[^a-z])cc-[a-z]|card.?(number|no\b|num)|credit.?card|debit.?card|ccnum|cvv|cvc|csc|expir|bank.?account|account.?number|routing|sort.?code|iban|social.?sec|ssn|national.?id|tax.?id|passport|\bpin\b|\u5bc6\u7801|\u5bc6\u78bc|\u53e3\u4ee4|\u9a8c\u8bc1\u7801|\u9a57\u8b49\u78bc|\u6821\u9a8c\u7801|\u30ab\u30fc\u30c9\u756a\u53f7|\u30ab\u30fc\u30c9|\u30af\u30ec\u30b8\u30c3\u30c8|\u6697\u8a3c|\u30d1\u30b9\u30ef\u30fc\u30c9|\u8a8d\u8a3c\u30b3\u30fc\u30c9|\u8a8d\u8a3c|\u30ef\u30f3\u30bf\u30a4\u30e0|\u30de\u30a4\u30ca\u30f3\u30d0\u30fc|\u5361\u53f7|\u5361\u865f|\u4fe1\u7528\u5361|\u94f6\u884c\u5361|\u9280\u884c\u5361|\u8eab\u4efd\u8bc1|\u8eab\u5206\u8b49|\ube44\ubc00\ubc88\ud638|\uce74\ub4dc\ubc88\ud638|\uc778\uc99d\ubc88\ud638|\uc8fc\ubbfc\ub4f1\ub85d|\u043f\u0430\u0440\u043e\u043b\u044c|\u043d\u043e\u043c\u0435\u0440 \u043a\u0430\u0440\u0442\u044b|\u043a\u043e\u0434|contrase|clave|tarjeta|mot de passe|carte|kreditkarte|passwort|senha|cart\u00e3o|\u0643\u0644\u0645\u0629|\u0631\u0645\u0632|\u092a\u093e\u0938\u0935\u0930\u094d\u0921)/iu;
  // Words that say a nearby number is a code: used by page-output redaction to decide about a 4 to 9 digit number in running text.
  var CONTEXT=/(code|otp|pin\b|passcode|verif|token|security|confirm|authenticat|c\u00f3digo|codigo|kod\b|k\u00f3d|\u0643\u0648\u062f|\u0631\u0645\u0632|\u0631\u0642\u0645|\u9a8c\u8bc1|\u9a57\u8b49|\u6821\u9a8c|\u30b3\u30fc\u30c9|\u8a8d\u8a3c|\ucf54\ub4dc|\uc778\uc99d|\u043a\u043e\u0434|\u092a\u093e\u0938|\u0915\u094b\u0921)/iu;
  function secretContext(text){var s=String(text==null?'':text);try{s=s.normalize('NFKC');}catch(e){}return CONTEXT.test(s);}
  // Shapes that are ordinary text, not secrets, unless a word beside them says otherwise: a year, an ISO-style date, a price with cents.
  function ordinaryNumber(v){
    var t=normalize(v).trim();
    if(/^(19|20)\d{2}$/.test(t))return true;
    if(/^(19|20)\d{2}[-\/.](0?[1-9]|1[0-2])[-\/.](0?[1-9]|[12]\d|3[01])$/.test(t))return true;
    if(/^\d{1,3}(,\d{3})*\.\d{1,2}$/.test(t)||/^\d{1,7}[.,]\d{2}$/.test(t))return true;
    return false;
  }
  // A social security number grouped 3-2-4 in any digit script; a long mixed letter-and-digit string with no spaces (an API key, a session id).
  function ssnShape(v){return /^\d{3}[\s\-.\u2010-\u2015\u2212]\d{2}[\s\-.\u2010-\u2015\u2212]\d{4}$/.test(normalize(v).trim());}
  function opaqueToken(v){var t=String(v==null?'':v).trim();return /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_\-]{20,}$/.test(t);}
  function secretName(text){var s=String(text==null?'':text);try{s=s.normalize('NFKC');}catch(e){}return NAME.test(s);}
  return {normalize:normalize,digitsOnly:digitsOnly,looksLikeSecretValue:looksLikeSecretValue,secretName:secretName,secretContext:secretContext,ordinaryNumber:ordinaryNumber,ssnShape:ssnShape,opaqueToken:opaqueToken,luhn:luhn};
})()`;
