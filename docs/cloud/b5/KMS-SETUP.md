# KMS setup (AWS KMS envelope encryption for home keys)

What changed: home keys (data key, bootstrap secret, volume key) used to be wrapped in the Worker with AES-GCM under the
Worker secret `CLOUD_KEK_V1`. Now each key is encrypted by AWS KMS (`Encrypt`/`Decrypt`, SigV4 from the Worker, no SDK)
under one customer-managed key, with encryption context `{homeId: <id>}`. A wrapped blob copied to another home's row will
not decrypt. Blobs are stored as `v2.<base64>` with `kek_id = kms1`; old `v1.` blobs stay readable until migrated.

What this does and does not buy (be honest with auditors):
- A copy of the D1 database, or `wrangler` deploy rights alone, no longer unwrap anything offline. Unwrapping needs live,
  logged, revocable AWS calls.
- Anyone who can deploy Worker code AND who holds or can read the AWS credentials bound to the Worker can still call KMS
  from inside the Worker. Mitigate: the AWS keys are set once by Sean with `wrangler secret put` (never by CI), CI deploys
  with a token that cannot edit secrets, CloudTrail alerts on `Decrypt` volume, and the key can be disabled in one click.

## 1. Create the key (Sean, AWS console or CLI, once)

```
aws kms create-key --region eu-west-1 --description "murage-cloud home keys" --key-usage ENCRYPT_DECRYPT --key-spec SYMMETRIC_DEFAULT
aws kms create-alias --alias-name alias/murage-cloud-homekeys --target-key-id <KeyId>
aws kms enable-key-rotation --key-id <KeyId>
```
Note the full key ARN: `arn:aws:kms:eu-west-1:<acct>:key/<uuid>` (the Worker needs the ARN, not the alias).

## 2. IAM user for the Worker (least privilege, one key, encrypt/decrypt only, context required)

Create IAM user `murage-cloud-worker` with NO console access and no other policies, and attach:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EncryptDecryptHomeKeysOnly",
      "Effect": "Allow",
      "Action": ["kms:Encrypt", "kms:Decrypt"],
      "Resource": "arn:aws:kms:eu-west-1:<ACCOUNT_ID>:key/<KEY_UUID>",
      "Condition": {
        "ForAllValues:StringEquals": { "kms:EncryptionContextKeys": ["homeId"] },
        "Null": { "kms:EncryptionContextKeys": "false" }
      }
    }
  ]
}
```
This allows only Encrypt and Decrypt (no GenerateDataKey, ReEncrypt, Describe, key admin) on that one key, and only when the
request carries exactly the `homeId` context key. (IAM cannot pin the context VALUE; the per-home value is enforced by KMS
itself at decrypt time.) Also add to the KEY policy (not just IAM) a statement denying `kms:ScheduleKeyDeletion` and
`kms:PutKeyPolicy` to this user, and keep key administration with Sean's admin role.

Create one access key for that user. Do NOT save it to disk; paste it straight into wrangler (step 3).

## 3. Set the Worker config (Sean, production account; staging likewise with `--env staging`)

```
cd cloudflare/control-plane
printf %s "arn:aws:kms:eu-west-1:<ACCOUNT_ID>:key/<KEY_UUID>" | pnpm exec wrangler secret put AWS_KMS_KEY_ARN
printf %s "eu-west-1"            | pnpm exec wrangler secret put AWS_KMS_REGION
pnpm exec wrangler secret put AWS_ACCESS_KEY_ID        # paste when prompted
pnpm exec wrangler secret put AWS_SECRET_ACCESS_KEY    # paste when prompted
```
All four must be present; a partial set fails closed (`cloud_key_unavailable`), it never falls back to the Worker secret.

## 4. Migrate existing keys (only staging/B1 test homes have any today)

Keep `CLOUD_KEK_V1` set during migration so v1 blobs can be read. Then, with the admin token:
```
curl -s -X POST https://<control-plane>/v1/machines/rewrap-keys -H "authorization: Bearer $CLOUD_ADMIN_TOKEN" -d '{"limit":100}'
```
Repeat until the answer is `{"rewrapped":0,"failed":0,"remaining":0}`. It is idempotent, swaps each row only if it is still the
exact v1 row it read (a concurrent rotate wins), and moves `kek_id` to `kms1`. Then delete the old secret:
`pnpm exec wrangler secret delete CLOUD_KEK_V1`. After that, even full deploy access cannot unwrap offline.

## 5. Watch it

- CloudTrail: alarm on `Decrypt` count per hour well above (homes x boots) and on any `Decrypt` outside the Worker's egress.
- The control plane already logs every unwrap in `cloud_unwrap_log` and raises `unwrap_alert_required` above 3/day/home.
- Rollback: re-enable the old secret and `wrap` falls back only when the AWS_* set is absent (staging).

## Cost
KMS key $1/month + $0.03 per 10,000 requests. A home does about 3 decrypts per boot; the fleet is rounding error.
