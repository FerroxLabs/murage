# Turn-card sites A-N: classification of cards outside the original list

G = written through `turnCardGate` (held once the owner's Stop reaches its turn). X = excluded, written directly.

- `browser_resume_timeout` card (server/index.ts, browser proxy catch): **X**. It is written on the capability claim's thread when a browser step's resume wait times out (server/browser-turn-execution.ts); an owner Stop ends the browser turn first, and that wait then settles with `browser_not_authorized` (abort listener), which writes no card, so this card can only follow a wait no Stop reached.
