// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A failed turn used to show the provider's own words as its sentence:
// `API error (status 400): {"error":{"message":…}}`. That text is written for
// a developer, names nobody, and says nothing about what to do (0.1.61 G11,
// Sean's screenshot of a Flux 400 on deepseek-v4-pro). The error card now
// leads with one plain sentence naming the bot and keeps the raw text under
// Technical details. Only text that is plainly a raw API response is
// rewritten; Murage's own sentences are left as written.

/** Looks like a provider's HTTP response rather than a sentence Murage wrote. */
const RAW_API = /\bAPI error\b|\bstatus(?: code)?:?\s*[45]\d\d\b|\bHTTP\/?[\d.]*\s*[45]\d\d\b|^\s*[45]\d\d\b|invalid_request_error|\bapi_error\b|^\s*\{\s*"(?:type|error)"/i;

/** The provider saying the model takes no image input. */
const UNSEEING = /(?:does not|doesn't|do not|not|cannot|can't)\s+(?:support|accept|allow|handle)\w*\s+(?:\w+\s+){0,3}(?:image|vision|multimodal)|(?:image|vision|multimodal)\w*\s+(?:\w+\s+){0,3}(?:is\s+|are\s+)?(?:not supported|unsupported|not enabled|not available)|unknown variant `image_url`/i;

function statusOf(text: string): number | undefined {
  const match = /\bstatus(?: code)?:?\s*([45]\d\d)\b|\bHTTP\/?[\d.]*\s*([45]\d\d)\b|^\s*([45]\d\d)\b/i.exec(text);
  const code = match ? Number(match[1] ?? match[2] ?? match[3]) : undefined;
  return code && Number.isFinite(code) ? code : undefined;
}

/** One plain sentence for a raw provider error, naming the bot, or undefined
 *  when the message is not a raw API response. */
export function plainEngineError(message: string, botName: string, options: { details?: boolean } = {}): string | undefined {
  const text = message.slice(0, 4096);
  if (!text.trim() || !RAW_API.test(text)) return undefined;
  const status = statusOf(text);
  if (/context[_ ]length|too long|maximum context|too many tokens|prompt is too long/i.test(text) || status === 413) {
    return `This conversation is too long for ${botName}'s model. Start a new conversation, or choose a model with a larger context.`;
  }
  const imageRequest = status === undefined || status === 400 || status === 415 || status === 422;
  // Only the provider's own "no images here" says the model cannot see; any
  // other image complaint (bad data, too large) is about the picture.
  if (imageRequest && UNSEEING.test(text)) {
    return `${botName}'s model can't read images, so it couldn't answer. Send the message again without the picture, or choose a model that reads images.`;
  }
  if (imageRequest && /\bimage|image_url/i.test(text)) {
    return `${botName}'s model provider couldn't use the picture. Send it again, or send the message without it.`;
  }
  if (status === 404 || /model[^.]{0,80}(?:does not exist|not found)/i.test(text)) {
    return `${botName}'s model isn't available from its provider. Choose another model for ${botName}.`;
  }
  if ((status !== undefined && status >= 500) || /\bapi_error\b|internal server error|overloaded/i.test(text)) {
    return `${botName}'s model provider had a problem on its side. Try again in a moment.`;
  }
  return options.details === false
    ? `${botName}'s model provider turned this request down.`
    : `${botName}'s model provider turned this request down. The details below say why.`;
}
