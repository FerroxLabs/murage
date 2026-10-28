import MurageShellCore

// N10 implementation is shared with the extension through Core; no signer or
// bootstrap client is linked into the extension.
extension PhoneAskTokenStore: PhoneJobsTokenWriting {}
