// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
/** D7: the one plain line under a blocked rebuild (an attempt may have been written), beside which the chat offers Send again. The English is
 * the reviewed (Sol r2) text of the key `engine.submission.resendOffer`. ONE constant: the server writes it, src/lib/tool-budget-copy.ts maps it
 * back to the person's language, and the tests compare against it, so the three cannot drift apart. */
export const RESEND_OFFER_LINE = "The AI may already be working on this message, so Murage did not send it twice. Use Send again to send it now.";
/** The line for a refused turn whose words came from outside (a webhook, channel or app trigger): no owner message exists to send again. Mapped
 * back to the person's language by src/lib/tool-budget-copy.ts (key `engine.submission.outsideInput`). */
export const OUTSIDE_INPUT_REFUSED_LINE = "Stopped: a memory check on outside input did not pass.";
