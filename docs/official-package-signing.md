# Official packages: signing

Murage shows an **Official** mark on a team or bot only when it carries a valid
Ed25519 signature from a key the app trusts. Nothing else earns the mark: an
unsigned package, a bad signature, a changed file or an unknown key gets no
mark. Every package, signed or not, still goes through the full import guard
(Skill Guard over every text field).

## What is signed

The signature covers a canonical digest of the whole package document (keys
sorted, no whitespace), without the `signature` field itself:

    murage.package.signature.v1\n + sha256(canonical JSON)

For a package archive (`.zip`) the signed document is `manifest.json`, which
lists the SHA-256 of every bundled file, so the signature covers every file. For
a team or package JSON file it is the whole file. The `signature` field is:

    { "alg": "ed25519", "keyId": "<16 hex>", "value": "<base64>" }

Code: `server/package-signature.ts`. Tests use a key pair made during the run.

## The real key (generated and kept offline by the release owner)

No real private key exists in this repository and none must ever be committed,
pasted into a chat or printed. Generate it on an offline machine:

    openssl genpkey -algorithm ed25519 -out official-ed25519.pem
    chmod 600 official-ed25519.pem

Get the public half in the form the app holds (SPKI DER, base64) and its id:

    openssl pkey -in official-ed25519.pem -pubout -outform DER | base64
    openssl pkey -in official-ed25519.pem -pubout -outform DER | openssl dgst -sha256 -hex

The id is the first 16 hex characters of that SHA-256. Add both to
`OFFICIAL_PACKAGE_KEYS` in `server/package-signature.ts`:

    { id: "0123456789abcdef", publicKey: "MCowBQYDK2VwAyEA..." }

That array ships empty until then, so no package shows Official before the key
is added. Keep the `.pem` offline and backed up; the app only ever needs the
public key.

## Signing a package

On the offline machine, with the repo checked out:

    node scripts/sign-package.mjs --key /path/to/official-ed25519.pem team.json team.signed.json
    node scripts/sign-package.mjs --key /path/to/official-ed25519.pem bundle.zip bundle.signed.zip

The key is read from the file path and never printed. The script refuses to
overwrite an existing output and checks the result verifies before finishing.
Ship the signed file.

## Rotating or revoking

`OFFICIAL_PACKAGE_KEYS` can hold several keys: add the new public key, sign new
packages with it, and remove the old key in a later release. Removing a key
from the list revokes every package signed with it. Editing a signed package in
any way removes the mark.
