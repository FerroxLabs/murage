# App Privacy answers

Use these answers only after confirming that the submitted binary and the
production hosted service still match this repository.

- Tracking: **No**
- Data used for third-party advertising, developer advertising, or marketing:
  **None**
- Third-party advertising or analytics SDKs: **None**
- Data linked to the user, for **App Functionality** and **Account Management**:
  - Contact Info: **Email Address**
  - Identifiers: **User ID** and **Device ID** (opaque account and computer
    installation identifiers)
- Data used for **Security/Fraud Prevention** and service reliability:
  computer platform/app version, security timestamps, rate-limit state,
  redacted operational errors, and connection/request metadata processed by
  Cloudflare. Select the closest current App Store Connect diagnostic/other-data
  categories during submission and do not mark these as tracking.
- User Content: messages, approvals, transcripts, and screen frames are
  processed transiently when the optional hosted route is used, but are not
  retained by the developer's control plane. Confirm the current App Store
  Connect definition of ephemeral processing when answering the collection
  question for the submitted build.
- Privacy policy URL:
  `https://github.com/milind-soni/OpenMausBot/blob/main/docs/ios-privacy.md`

The email is entered on the companion computer, not in the iOS app. Local Wi-Fi
and Tailscale pairing require no OpenMausBot account. If the desktop user opts
into **Use your phone anywhere**, OpenMausBot stores the account and installation
metadata above in Cloudflare D1 and Cloudflare proxies the encrypted phone
traffic to that user's computer. The computer remains the only transcript
store; the control plane does not receive a persistent cloud copy.

Re-evaluate these answers and `PrivacyInfo.xcprivacy` before every upload,
especially if analytics, push delivery, crash reporting, or content retention
is added.
