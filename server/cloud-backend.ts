export const CLOUD_BACKEND_CHANGE_ERROR = "stop the active turn before changing the cloud backend";

export function cloudBackendChangeError(botBusy: boolean, activeVpsThread: boolean): string | null {
  return botBusy || activeVpsThread ? CLOUD_BACKEND_CHANGE_ERROR : null;
}
