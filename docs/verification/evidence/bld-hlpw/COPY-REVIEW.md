# New English strings for Sol copy review

These are in the unmounted dialog or its helpers. They are not approved copy or a claim of a shipped flow.

| String | Use |
|---|---|
| Set password for {name} | Dialog title |
| Password | Visible input label |
| Preparing password protection… | Opening status |
| Password protection is unavailable. Nothing was sent. | Opening failure |
| Copy this password to share with them. Murage won’t show it again after you close this window. | Helper |
| Copy password | Secondary action |
| Use my own | Secondary action |
| Use at least 12 characters, with an uppercase letter, a lowercase letter, a number and a symbol. | Exact custom validation |
| Add user | Primary submit |
| Adding user… | Disabled submit status |
| User added. Copy their password before closing. | Success status |
| We’re checking whether the user was added. We won’t add them again. | Uncertain result |
| Copied. We’ll clear it in 60 seconds. | Only after a retention-capable native adapter succeeds |
| Password copying is unavailable on this computer. | Fail-closed copying; no manual-copy fallback |
| Done | Success/uncertain close |
| Close | Other close |
| Password generation is unavailable. | Generator failure |
| Password protection is unavailable. | Native coordinator refusal |
| This password submission is no longer available. | Nonce/capability refusal |
| The user could not be confirmed. | Fixed transport-envelope error |
| This user creation is already held or cannot be verified. | Fixed claim/inventory refusal |

`Invalid random range.`, `Leak evidence is incomplete.`, and `A secret reached a protected sink.` are developer/test diagnostics, not product copy. The dedicated route's `desktop_owner_required` and `invalid_submission` are unsurfaced helper codes. The required full-flow owner-only copy and existing-user recovery copy have not been wired.
