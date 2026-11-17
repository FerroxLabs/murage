# Fuigo 1.0.41 capture findings

Real released binary, SHA checked; isolated container with loopback stub and --network none. Upstream body provenance is PROVISIONAL pending the FluxMain production record and 11-09 live commit. No customer data or real keys used.

## S1
```json
{"jsonrpc":"2.0","id":3,"error":{"code":-32003,"message":"Rate limited","data":{"message":"API error (status 429 Too Many Requests): rate_limit_exceeded: Your account's monthly free-tier token allowance is exhausted. Free-tier allowances are enforced across every key on the account. Upgrade at fluxrouter.ai/pricing to continue.","error_kind":"rate_limited","verdicts":{"creditLimit":false,"freeUsage":false,"reauth":false,"httpStatus":429,"maxTokensTruncation":false,"httpDump":false,"diskFull":false,"consumerUpsell":false}}}}
```
Retry notices: 2. POST requests: 3.

## S2
```json
{"jsonrpc":"2.0","id":3,"error":{"code":-32003,"message":"Rate limited","data":{"message":"API error (status 429 Too Many Requests): throttling_error: litellm.RateLimitError: {\"error\": {\"type\": \"rate_limit_exceeded\", \"state\": \"free_cap_reached\", \"tier\": \"free\", \"message\": \"Your account's monthly free-tier token allowance is exhausted. Free-tier allowances are enforced across every key on the account. Upgrade a…","error_kind":"rate_limited","verdicts":{"creditLimit":false,"freeUsage":false,"reauth":false,"httpStatus":429,"maxTokensTruncation":false,"httpDump":false,"diskFull":false,"consumerUpsell":false}}}}
```
Retry notices: 2. POST requests: 3.

## S3
```json
{"jsonrpc":"2.0","id":3,"error":{"code":-32003,"message":"Rate limited","data":{"message":"API error (status 429 Too Many Requests): rate_limit_exceeded: Rate limit exceeded. Please retry.","error_kind":"rate_limited","verdicts":{"creditLimit":false,"freeUsage":false,"reauth":false,"httpStatus":429,"maxTokensTruncation":false,"httpDump":false,"diskFull":false,"consumerUpsell":false}}}}
```
Retry notices: 2. POST requests: 3.

## S4
```json
{"jsonrpc":"2.0","id":3,"error":{"code":-32603,"message":"Internal error","data":{"message":"API error (status 402 Payment Required): None: Your prepaid credit balance is exhausted. Top up to keep going. Top up at https://fluxrouter.ai/home/billing","http_status":402,"error_kind":"api","verdicts":{"creditLimit":true,"freeUsage":false,"reauth":false,"httpStatus":402,"maxTokensTruncation":false,"httpDump":false,"diskFull":false,"consumerUpsell":false}}}}
```
Retry notices: 1. POST requests: 2.

S1 preserves monthly-free-tier words in the Display form. State and tier are absent. HTTP 429 survives twice: the Display prefix and data.verdicts.httpStatus. The ruling’s claim that HTTP status is entirely stripped is corrected by these bytes. R1 is expected GREEN on the baseline; disabling B2 alone cannot make R1 fail. The status-less synthetic contract test provides the B2 mutation check.

S2 preserves the state fragment and the monthly words in the 280-character prefix for this source-derived wrapper. This does not settle whether the production wrapper has a longer prefix; that remains open until the FluxMain cross-check.

S3 is a deliberately controlled busy response with Retry-After: 5; S4 uses the source’s credit sentence. Both are real engine captures of stub responses, not production traffic.

Fuigo 1.0.42 captured evidence (R3) remains pending the other lane’s release candidate and pin.
