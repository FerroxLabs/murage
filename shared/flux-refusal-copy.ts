// Cause-specific Flux copy from refusal-contract-A2 §2.4.
import type { Reason } from './flux-busyloop.ts';
export const FLUX_REFUSAL_LINES: Partial<Record<Reason, string>> = {
  "freeCap": "You've used this month's free Flux allowance. Upgrade your Flux plan to keep going. Your message is kept.",
  "freeCredit": "Your $1 of free Flux credit is used up. Add a card in Flux billing to keep going. Your message is kept.",
  "requestCap": "Your Flux plan reached its 10 million request cap. Turn on auto-upgrade in your Flux dashboard to continue. Your message is kept.",
  "planCap": "Your Flux plan's monthly cap is reached. Upgrade in Flux to continue. Your message is kept.",
  "planAllowance": "You've used this month's Flux plan allowance. Allow overage in Flux billing to keep going now. Your message is kept.",
  "spendCap": "The spend cap you set in Flux is reached. Raise it in Flux billing or wait for it to reset. Your message is kept.",
  "keyBudget": "This Flux key reached its monthly budget. Raise the key's budget in Flux or use another key. Your message is kept.",
  "keyTokens": "This Flux key used its monthly token limit. Raise the key's limit in Flux or use another key. Your message is kept.",
  "botBudget": "This bot reached its monthly Flux budget. Raise the bot's budget in Flux. Your message is kept.",
  "keyLifetime": "This Flux key used its lifetime spend cap. Raise the cap in Flux or use another key. Your message is kept.",
  "accountCeiling": "Your Flux account reached its monthly spending ceiling. Adding credit won't lift it; contact support@fluxrouter.ai to raise it. Your message is kept.",
  "credit": "Your Flux credit has run out. Top up in Flux billing to keep going. Your message is kept.",
  "creditHold": "Flux has put this account's credit on hold. Contact support@fluxrouter.ai. Your message is kept.",
  "keyRevoked": "Flux says this key has been revoked. Make a new key in Flux and add it in Settings.",
  "keyNotFound": "Flux couldn't find a record for this key. Contact support@fluxrouter.ai. Your message is kept.",
  "keyAccess": "Flux couldn't link this key to an active plan. Contact support@fluxrouter.ai. Your message is kept.",
  "accessUnknown": "Flux couldn't confirm this key's access just now. Contact support@fluxrouter.ai if it keeps happening. Your message is kept.",
  "keyRefused": "Flux didn't accept this request with this key, and didn't say why. Check the key at fluxrouter.ai/home/keys. Your message is kept.",
  "fluxStop": "Flux stopped this request and didn't say why. Your message is kept. You can send it again, or check your Flux account.",
  "unknownLimit": "Flux is limiting requests on this key and didn't say for how long. Your message is kept. Send it again in a minute."
};
