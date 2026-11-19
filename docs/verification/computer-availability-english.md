# Computer availability refusal copy

Owner: new3-g5b (computer proxy response and this inventory).

`server/computer-proxy.ts`, `computer_request_help`, when the control endpoint
answers but cannot create the help request:

> The person could not be paged for this computer right now. Carry on carefully or tell them in chat.

This is an error tool result with no computer action. It tells the bot the page
failed and gives it a plain next step. It carries no endpoint, credential or
internal failure detail. Authorization failures still close the consuming mount;
this wording is for an unavailable help request after the availability check.
