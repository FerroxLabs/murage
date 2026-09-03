# Composio behind Flux — the terms question, and why it is already live

Queue item 5. The handoff said this was "blocking, non-technical: read
Composio's ToS on proxying/reselling". I read it. The answer is not what the
question assumed, and the framing needs correcting before anyone builds.

## THE FINDING THAT CHANGES THE QUESTION

**Murage already serves many end users through one Composio account. Today. In
shipped code.**

`activeBroker()` (`server/composio.ts`, ~:195) is the single choke point, and
its own doc comment says so plainly:

> A workspace key WINS. Somebody who pasted their own Composio key did it on
> purpose... **The managed broker remains the default for everyone who
> configures nothing, which is nearly everyone.**

So the exposure is not something "rolling Composio into FluxRouter" would
create. It is the status quo. Pointing `MURAGE_COMPOSIO_BROKER_URL` at Flux
changes **who bills and meters the traffic**, not **whether one account fronts
many users**. That was always the actual terms question, and it is live right
now rather than pending a decision.

This makes the ToS read more urgent, not less — but it also means the Flux move
is not the thing gated on it. Two separable decisions:

1. *May one Ferrox Composio account front many end users at all?* — **live
   today, unresolved, applies to the shipped product.**
2. *Should the broker sit behind Flux so it inherits Flux's billing,
   entitlement and metering?* — cheap, config not code, and strictly an
   improvement on the status quo regardless of how (1) lands.

## WHAT THE PUBLIC TERMS ACTUALLY SAY

`https://composio.dev/terms`, read 2026-09-03. Fourteen sections.

**Section 4, "Restrictions on Use", does not restrict any of this.** No clause
on reselling, sublicensing, providing access on behalf of third parties,
service-bureau use, multi-tenancy, white-labelling, credential sharing, or
building a competing service. What it does prohibit is the ordinary list:
breaking the law, harming minors, spam and unsolicited advertising,
impersonation, and conduct that restricts others' use of the platform.

**Section 3 grants** "a limited, non-exclusive, **non-transferable**,
revocable license to access and use our platform", and is expressly
"Subject to your compliance with these Terms and our Fair Usage Policy".

## TWO THINGS I COULD NOT RESOLVE — do not treat this as cleared

1. **Section 3 read inconsistently across two passes.** One extraction of the
   same page reported Section 3 as saying the license "does not include any
   resale or commercial use of the platform or its contents"; a second reported
   it as expressly permitting "personal and commercial purposes". These cannot
   both be true. I did not resolve it and I am not going to guess on a clause
   this load-bearing. **A human must read Section 3 verbatim in a browser.**
   That single sentence decides item (1) above.

2. **The Fair Usage Policy was not obtainable.** Section 3 conditions the whole
   licence on it and the document gives no URL. That policy, not Section 4, is
   where a per-account usage ceiling or a one-account-one-user rule would
   actually live. It is the real gate and it has not been read.

Regardless of how those land, **"non-transferable" is the load-bearing word**
in what I could confirm, and a broker fronting other people's OAuth
connections is exactly the shape a transfer clause is written about.

## THE ENGINEERING, IF AND WHEN IT IS CLEARED

Unchanged from the handoff and still correct:

- **Do NOT reimplement Composio inside Flux.** OAuth lifecycle across 250+ apps
  is a product with a permanent maintenance treadmill, not a routing layer.
- The broker swap is config: `activeBroker()` already resolves a URL + token in
  one place and `brokerRequest` routes through it, so no caller can go around
  it. Flux already has entitlement, pricing and metering.
- **The OAuth callback flow is stateful and will not survive a naive proxy.**
  That is the one piece of real work, and it should be scoped before anyone
  calls this cheap.

## NEXT ACTION

Not code. Someone reads Section 3 in a browser and asks Composio directly, in
writing, whether one account may front many end users' connections. Ask them
rather than infer it: a written answer is worth more than either reading of an
ambiguous clause, and the product is already operating on the answer.
