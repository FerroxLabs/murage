# Qualification signing identity variables

Owner: repository admin sets these five repository variables (Settings > Secrets and variables > Actions > Variables).
Consumers: the `verify` and `receipt` steps of the `verify-collector` job in `windows-qualsign.yml`, through `Write-QualsignReceipt.ps1` (owner winsac-qualsign); and `scripts/windows-qualsign-verify.mjs` (owner winsac-qualsign-verifier), whose caller (MAIN) passes the same values as `identity`.

| Variable | Exact value |
| --- | --- |
| `QUALSIGN_EXPECTED_SUBJECT` | `Ferrox Labs, LLC` |
| `QUALSIGN_EXPECTED_ISSUER_PREFIX` | `Microsoft ID Verified CS ` (trailing space is part of the value) |
| `QUALSIGN_EXPECTED_ROOT_CN` | `Microsoft Identity Verification Root Certificate Authority 2020` |
| `QUALSIGN_EXPECTED_ROOT_SHA256` | `5367f20c7ade0e2bca790915056d086b720c33c1fa2a2661acf787e3292e1270` |
| `QUALSIGN_EXPECTED_EKU` | `1.3.6.1.5.5.7.3.3,1.3.6.1.4.1.311.97.1.0,1.3.6.1.4.1.311.97.694597467.326663264.393302725.691001577` |

## Hardcoded vs caller-supplied

Caller-supplied, and not hardcoded anywhere: `QUALSIGN_EXPECTED_ROOT_SHA256` (Node: `identity.rootSha256`). Both consumers check that it is 64 lowercase hex characters and that it equals the SHA-256 of the presented root's raw DER. The value in the table is the measured one; a different value changes which root is accepted.

Caller-supplied but forced to equal a hardcoded literal: `QUALSIGN_EXPECTED_SUBJECT`, `QUALSIGN_EXPECTED_ISSUER_PREFIX`, `QUALSIGN_EXPECTED_ROOT_CN`, `QUALSIGN_EXPECTED_EKU` (as a set). PowerShell throws if any is empty or differs from its literal. Node throws unless `identity.subject`, `issuerPrefix`, `rootCn` and `ekus` equal `IDENTITY`.

Hardcoded only (no variable):
- Leaf: CN and O both equal the subject, exactly one RDN each.
- Issuer: O is `Microsoft Corporation`, and CN matches `Microsoft ID Verified CS (AOC|EOC) CA [0-9]{2}` with start and end-of-string anchors: PowerShell `\A…\z`, Node `^…(?![\s\S])` (nothing at all may follow the two digits). Neither accepts a trailing LF, CR, U+2028 or U+2029; a witness covers each, and a mutant that drops the Node end anchor is killed by all four. Microsoft issues from both families and rotates without notice, so the family and number are not pinned.
- Chain: exactly four elements: leaf, issuer, PCA, root. Every link's signature is verified with the next certificate's public key, ending at the pinned root. PowerShell does this with an offline `X509Chain.Build` (`Get-SignedChain`: custom root trust holding only the root whose DER matches `QUALSIGN_EXPECTED_ROOT_SHA256`, no revocation check, no downloads, evaluated at the leaf's `NotBefore`). The built chain must equal the supplied chain certificate for certificate, or nothing is written. The pins below are then applied to that built chain. PowerShell also requires each element's issuer DN to equal the next element's subject DN, and element 0 to be the signer leaf. Node builds the chain from the signed file's own certificates and verifies each link signature (`buildChain`).
- PCA: CN `Microsoft ID Verified Code Signing PCA 2021` **and** raw-DER SHA-256 `3d29798cc5d3f0644a7e0dc9cb1cade523ea5ec83b335109b605bfeaa7d5f5c1`. Source: the public v1.0.18 Authenticode chain, the same certificates as the test fixture. It verifies under the root above. A lookalike with the same CN and a different key is refused.
- EKUs: the three above must all be present, and no other `1.3.6.1.4.1.311.97.*` EKU may appear.

## Where the guard runs

`-Mode Verify` runs it after signtool and the online `X509Chain.Build`, before writing `verification.json`, which records the chain DER. `-Mode Receipt` runs it again before writing `qualsign-receipt.json`. That run takes the leaf from the file's own Authenticode signer, rebuilds and signature-verifies the chain offline from the recorded chain DER, refuses any difference between the two, and requires the recorded subject, issuer, chain subjects and EKUs to match those certificates. `verifyFetched` rebuilds the chain from the fetched exe.

`QUALSIGN_EXPECTED_ISSUER_PREFIX` is the common text before the family; the family and number check lives in code.
