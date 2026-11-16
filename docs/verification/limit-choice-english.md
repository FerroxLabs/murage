# Limit choice responses

Producer and English-copy owner: G2 (`server/index.ts`, `answerLimitCard`).
The registered decision service owns the single-use answer receipt.
Renderer owner: G2 (`src/components/ThreadFollowControls.tsx`, `LimitOfferCard`).

The server stores an accepted choice awaiting application on the message, beside
the signed card. The card remains terminal; the renderer offers only that same
choice until application completes. A retry retains the accepted checkbox flags.

| English string | When shown |
| --- | --- |
| That choice is already being answered. | Another answer for this card is in flight. |
| This choice is no longer available. | The offered choice, durable authority or current principal cannot be validated. |
| The choice could not be delivered. Nothing was confirmed. | The registered answer has no accepted delivery receipt. |
