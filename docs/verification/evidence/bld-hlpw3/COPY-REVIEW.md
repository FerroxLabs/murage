# Sol copy review

Independent model copy review by the assigned Sol reviewer for job bld-hlpw3. This is a model review, not human approval. The reviewer did not change product code and did not run tests or containers.

Reviewed the complete inventories in docs/verification/evidence/bld-hlpw/COPY-REVIEW.md and docs/verification/evidence/bld-hlpw2/COPY-REVIEW.md, and the actual dialog in src/components/HighLevelSetPassword.tsx.

The proposed product strings below use plain words and contain no dashes. Review acceptance concerns wording. It does not prove that native protection, clipboard removal, durable request handling, production integration or packaged behavior works.

## Required corrections

1. The unknown dialog phase appears after any submit exception and does not itself start another check. “We’re checking whether the user was added” can falsely claim ongoing work. “We won’t add them again” is broader than the protected request. Use the exact replacement below unless the product can prove an active check and a broader guarantee in every displayed case. The design prescribed the earlier wording, so this is an explicit copy finding rather than a claim that the implementation followed that wording incorrectly.
2. “Copied. We’ll clear it in 60 seconds.” must never be shown on a normal clipboard write or a renderer timer alone. Its replacement still requires confirmed native clipboard ownership and independent removal within 60 seconds. A failed or uncertain copy must show the existing refusal. Replacing newer clipboard content is not permitted. This review cannot approve displaying a timed removal promise on an unqualified native implementation.
3. The host inventory uses internal words such as completion, journal, claim, identity and inventory. The exact replacements below explain what the owner can do or what Murage could not establish.
4. “User added” is accepted only after a confirmed creation result or a conclusive scoped recovery result. An HTTP success code alone, an empty inventory, a partial inventory or an exception must not show success.
5. “Nothing was sent” is accepted only on a refusal before any dispatch for this request. Do not reuse that sentence for an uncertain request or a consumed completion that may already have been sent.

## Exact replacement inventory

| Existing text | Reviewed replacement |
| --- | --- |
| We’re checking whether the user was added. We won’t add them again. | We could not confirm whether the user was added. We won’t send this request again. |
| Copied. We’ll clear it in 60 seconds. | Password copied. It will leave the clipboard within 60 seconds. |
| Adding a user requires desktop password completion. | Set the password in the desktop app to add this user. |
| Desktop password completion is required. | Set the password in the desktop app to add this user. |
| Desktop password completion is unavailable. | This password request is no longer available. |
| The reviewed user location changed. | The location for this user changed. Review the request again. |
| The user identity journal is unavailable. Nothing was sent. | We could not save this request safely. Nothing was sent. |
| The user identity claim is unavailable. | We could not confirm that this request can be sent safely. |
| The user inventory could not be verified. Nothing was sent. | We could not check the users in this location. Nothing was sent. |
| This user creation is already held or cannot be verified. | We could not confirm whether the user was added. We won’t send this request again. |

The two no resend replacements require the durable request guard to block another send for the same request. They do not prohibit a separate future owner request after resolution. The location replacement requires a fresh review to be an available recovery path; if the request cannot be reviewed again, use only “The location for this user changed.”

## Accepted exact inventory

| Text | Condition or use |
| --- | --- |
| Set password for {name} | Dialog title. The name must come from the reviewed request. |
| Password | Input label. |
| Preparing password protection… | Protection is being established. |
| Password protection is unavailable. Nothing was sent. | Opening failed before dispatch. |
| Copy this password to share with them. Murage won’t show it again after you close this window. | Murage discards the dialog secret and cannot recover it after close. This does not claim universal memory erasure. |
| Copy password | Protected native copy action only. |
| Use my own | Switch to an editable password. |
| Use at least 12 characters, with an uppercase letter, a lowercase letter, a number and a symbol. | Matches the actual password validator. |
| Add user | Submit the reviewed creation. |
| Adding user… | Dispatch is pending. |
| User added. Copy their password before closing. | Confirmed creation only. |
| Password copying is unavailable on this computer. | No protected copy, including a failed or uncertain native copy. No manual copy fallback. |
| Done | Close a settled dialog. |
| Close | Close another dialog state. |
| Password generation is unavailable. | Generator refusal. |
| Password protection is unavailable. | Protection refusal. |
| This password submission is no longer available. | Expired or consumed submission. |
| The user could not be confirmed. | Fixed response for an unconfirmed outcome. It does not claim failure or success. |
| Only you can add users, from the desktop app. | Admission is restricted to the direct owner in the desktop app. |
| The profile photo URL is invalid. | Schema diagnostic. It must not echo the invalid URL. |
| User changes must stay in this location. | Trusted location enforcement. |

## Diagnostic inventory

“Invalid random range.”, “Leak evidence is incomplete.” and “A secret reached a protected sink.” remain accepted as developer or test diagnostics only. The helper codes desktop_owner_required and invalid_submission are not owner copy and are outside the plain language inventory.

## Result

The accepted strings and exact replacements above have received this independent Sol model copy review. The original unknown outcome sentence and the internal host wording are not accepted as final owner copy. The timed clipboard sentence is accepted only with the stated native proof. No human approval, implementation completion, successful creation, successful resend prevention or packaged native qualification is asserted by this document.

## Integration followup review

The builder supplied this exact additional integration inventory for independent review. No product code was changed by the reviewer.

| Exact text | Review result |
| --- | --- |
| Set password | Accepted for a button that opens the protected password dialog for an already reviewed user creation request. This label must not imply that an existing user's password is being changed. The dialog's submit button remains “Add user”. |
| Only you can add users, from the desktop app. | Accepted as a route refusal for a caller who lacks direct owner admission from the desktop app. |
| This password submission is no longer available. | Accepted as a route refusal for an unavailable submission. It does not assert whether creation was dispatched. |
| Password protection is unavailable. | Accepted for IPC and generator failures. It makes no creation outcome or dispatch claim. |

For a transport failure before the main process can establish whether a dispatch occurred, the reviewed exact sentence is:

> We could not confirm whether the user was added.

That sentence makes no promise of an active check, a successful creation, a failed creation or resend prevention. The earlier two sentence replacement remains appropriate only after the durable request guard is known to prohibit another send for that request. Do not add an invitation to try again to either version while the result is uncertain.

The builder reports that the design prescribed “We’re checking whether the user was added. We won’t add them again.” may remain for now. Its presence does not resolve the copy finding. This review does not accept that sentence on a path without an actual check and an established durable guard. The final inventory must distinguish a retained design requirement from wording accepted by copy review.
