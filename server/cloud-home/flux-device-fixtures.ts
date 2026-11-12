// FluxMain recorded staging rehearsal r3, 2026-11-12. Credentials replaced with fixture values.
export const recordedCapabilities = (origin: string) => ({
  device_authorization_grant: true, bot_keys: true, client_id: "murage-cloud", scope: "email:owner",
  grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  device_authorization_endpoint: `${origin}/api/device/code`, token_endpoint: `${origin}/api/device/token`,
  revocation_endpoint: `${origin}/api/device/revoke`, verification_uri: `${origin}/device`,
  expires_in: 600, interval: 5, slow_down_increment: 5, max_interval: 60,
});
export const recordedCode = (origin: string) => ({
  device_code: "fixture-device-code", user_code: "ABCD-1234", verification_uri: `${origin}/device`,
  verification_uri_complete: `${origin}/device?user_code=ABCD-1234`, expires_in: 600, interval: 5,
});
