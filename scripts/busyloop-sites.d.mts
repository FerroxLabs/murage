export interface ResponseSite {
  key: string;
  kind: string;
  guarded: boolean;
  reason?: string;
  entry: string;
  start: number;
  end: number;
  scope: string;
}
export function inventory(overrides?: Map<string, string>): { sites: ResponseSite[]; errors: string[] };
