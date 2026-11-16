# Support runbook: a Cloud home held because the email already has a Flux Router account

Owner: Cloud support (Sean at launch, then the support manager). Applies from the Cloud launch.

## The one rule
Only the buyer can prove the email, by entering the code from the card in their signed-in Cloud portal. Support never links, never stamps and never accepts any other proof. Support can resend the code, fix a mail problem, or stop a disputed link.

## What the buyer sees
Every buyer is mailed a code when the checkout completes, to the account's stored contact email. The My Cloud page shows the "Confirm your email" card, with "Send a new code", until the code is entered. A code lasts 10 minutes and allows 5 tries. A correct code links the account and starts the bots in seconds.

## What fires
Nothing at checkout: a buyer who has not entered the code yet is normal and pages nobody. Alert `credit.email_unverified_hold` pages only when the buyer is still unconfirmed 24 hours after the home went active (once per account and email address; it resolves when they enter the code or change the address). While held, the home has no Flux key and spends no credit. The plan fee was charged at checkout (every server starts at payment; there is no trial).

## Steps
1. Reply within 1 hour. Ask the buyer to press "Send a new code" on the card, check spam and junk, and enter the code within 10 minutes.
2. If the code does not arrive, send a fresh one to the stored address:
   `POST /v1/internal/flux/email-proof/resend {"account_id": "<account id>", "by": "<your name>"}` (operator auth). Both fields are required and nothing else is accepted. It never takes an address; it always mails the contact email on file, and it writes an audit row with your name. The buyer enters the new code on the card as usual (the card always uses the newest code).
3. If the buyer says the address on file is wrong, they change their contact email in the portal. That clears any old proof and shows a new card for the new address. Support never edits an email.
4. If the mail still does not arrive after a resend, treat it as a mail outage: check the mail sender's status and logs, and page Sean if mail is failing. Do not link by any other route.
5. Check, within 5 minutes of the buyer entering the code: the card is gone, the home has an active Flux key, the credit grant shows granted and the alert is resolved. Tell the buyer their bots are ready.

## Someone else's email (dispute)
- Anyone who says the email is theirs and was used without consent, whether the portal buyer, a person writing to the support mailbox, or anyone else: run
  `POST /v1/internal/flux/email-proof/dispute {"account_id": "<account id>", "note": "<ticket id>", "by": "<your name>"}` and post it in the Cloud alerts channel for its owner (MurageCloud). Sean is paged only if money is involved or the account is already linked (then the route raises the page credit.email_proof_disputed itself). All three fields are required (the note is 3 to 2000 characters) and nothing else is accepted.
- If the account is not linked yet, this clears the proof and blocks any new proof, any call to Flux and any link, even after an email change, until Sean clears it:
  `POST /v1/internal/flux/email-proof/dispute-clear {"account_id": "<account id>", "by": "<your name>"}`. Both fields are required and nothing else is accepted. After the clear the buyer asks for a new code on the card. If a clear returns cleared:false with reason newer_dispute, a newer dispute arrived: read it, then decide again. With reason no_dispute there was no dispute left to clear.
- If the account is not linked yet, the dispute also raises one daily digest item (credit.email_proof_disputed_unlinked), never a page. Its owner is MurageCloud, who follows up with the buyer within a day. A repeat dispute adds no second item, dispute-clear resolves it, and a dispute after the clear opens it again.
- If the account is already linked, the route only pages. Sean decides with Flux (FluxMain) what happens to the link. Do not unlink anything yourself.

## Never
- Never link or record proof on an email claim, a screenshot, a forwarded mail, a "From" header, a phrase typed back in a ticket, a name or billing-address match, a Stripe receipt, a call or a chat.
- Never edit flux_links, supabase_identities or flux_email_proof by hand, never call Flux ensure yourself, never ask Flux to link from their side.

## Money
- Held under 24 hours: no action.
- Held 24 hours or more: credit the held days back (Cloud refund rule; Sean owns refunds at launch). If the buyer asks to cancel while held, refund in full.

## Escalate to Sean
- A dispute only if money is involved or the account is already linked (the route raises the page credit.email_proof_disputed). Every other dispute is posted in the Cloud alerts channel for its owner (MurageCloud); Sean is not paged for it.
- Alert flux.link_email_mismatch_unlinked: the buyer changed their email while their Flux account was being linked. It is an automatic page to the Cloud alerts channel for its owner (MurageCloud), and to Sean personally only if money is involved. Flux (FluxMain) re-points the link on MurageMain's word, and that decision is posted in the same channel. Do not change anything yourself.
  - At launch a hand re-point is ALWAYS link-only. Flux checks that no Cloud key was ever made for the account, then re-points the link to the new email, only on MurageMain's word for each case, and reports the state before and after.
  - Hand operations NEVER change the buyer's Flux sign-in email. ONLY the reviewed relink route (FluxMain's, with its own review) may move a sign-in, because it ties the create to the ensure in one act.
  - A buyer stuck on an old email they can no longer reach: Wait for the relink route; no hand move. Tell the buyer we will move their Flux sign-in once that is ready. Post it in the Cloud alerts channel for its owner (MurageCloud); Sean only if money is involved.
- More than 3 holds in a day, a code mail bounce, or a resend that does not arrive (it may be a mail or Flux problem, not the buyer).
