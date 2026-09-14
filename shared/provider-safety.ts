// Adapted from OpenMausBot PR1103, commit
// 2df5cc5186f6ba2021e0f5702affe56ed5a965dd (Apache-2.0).
// Call only for provider error text, never ordinary assistant content.
export function isProviderSafetyBlock(message: string): boolean {
  return /\bblocked by (?:our|the provider['’]s) safety systems\b|\bsafety monitoring\b.{0,100}\b(?:paused|ended|blocked)\b|\b(?:safety_check_failed|safety_policy_violation)\b/i.test(message);
}
