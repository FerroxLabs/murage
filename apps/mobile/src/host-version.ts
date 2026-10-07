export const MIN_HOST_CAPABILITY = 1;

export function hostCapabilityOk(mobile: unknown): boolean {
  return typeof mobile === "number" && Number.isInteger(mobile) && mobile >= MIN_HOST_CAPABILITY;
}
