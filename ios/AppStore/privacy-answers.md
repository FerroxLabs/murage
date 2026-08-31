# App Privacy answers

Use these answers only after confirming that the submitted binary and the
production hosted service still match this repository.

- Tracking: **No**
- Data used for third-party advertising, developer advertising, or marketing:
  **None**
- Third-party advertising or analytics SDKs: **None**
- Data linked to the user, for **App Functionality**:
  - Contact Info: **Email Address** (the profile email exposed by the paired
    computer)
  - Identifiers: **Device ID** (the opaque paired-device identifier returned
    by the user's computer)
- Data used for **Security/Fraud Prevention** and service reliability:
  computer platform/app version, security timestamps, rate-limit state,
  redacted operational errors, and connection/request metadata processed by
  Cloudflare. Select the closest current App Store Connect diagnostic/other-data
  categories during submission and do not mark these as tracking.
- User Content: messages, approvals, transcripts, screen frames, and content
  the user explicitly selects in another app's Share sheet are
  processed transiently when the optional hosted route is used, but are not
  retained by the developer's control plane. Confirm the current App Store
  Connect definition of ephemeral processing when answering the collection
  question for the submitted build.
- Privacy policy URL:
  `https://github.com/milind-soni/OpenMausBot/blob/main/docs/ios-privacy.md`

The iOS app does not receive the hosted account's user ID or the computer's
hosted installation ID. Email sign-in for optional hosted access happens on the
companion computer, and local Wi-Fi and Tailscale pairing require no OpenMausBot
account. If the desktop user opts into **Use your phone anywhere**, Cloudflare
proxies the encrypted phone traffic to that user's computer. The computer
remains the only transcript store; the control plane does not receive a
persistent cloud copy.

Share-sheet images and documents are transferred only after the user chooses a
paired computer and bot or room, then taps **Send**. They are written to that
computer's local OpenMausBot attachments directory; neither the extension nor
the hosted control plane keeps a persistent copy. The extension removes its
temporary copy after completion or cancellation; if iOS terminates it during a
transfer, the next Share-sheet session or app foreground removes the abandoned
copy.

Re-evaluate these answers and `PrivacyInfo.xcprivacy` before every upload,
especially if analytics, push delivery, crash reporting, or content retention
is added.
