// CONNECTING ONE ACCOUNT, FROM ANYWHERE.
//
// The flow itself is not new: authorize, open the provider's page in the
// real browser, then watch the connector status until it turns. What is new
// is that it is a module rather than three closures inside the connected
// apps dialog (src/components/PluginsPanel.tsx), because the first run asks
// for exactly this from inside a chat message and a card cannot reach into
// a modal's state to borrow it.
//
// Everything that touches the world is an argument: the request function,
// the external open, the clock. That is what makes a browserless test of
// this possible, and a browserless test is the only kind this repository
// runs.

/** As `/api/connectors?services=…` reports one service. A subset of the
 *  dialog's own `ConnectorStatus`: this module reads only what it needs to
 *  decide whether to keep waiting. */
export interface ConnectAppStatus {
  connected: boolean;
  pending?: boolean;
  status?: string;
  /** The accounts already on this app, as far as their labels go, so a form
   *  can fill in a label that is still free. */
  accounts?: ConnectAppAccount[];
}

/** One account on an app, as `/api/connectors` reports it: only what picking
 *  a free label needs. */
export interface ConnectAppAccount {
  alias?: string;
  status?: string;
}

/**
 * A label the person confirmed in the label form (ConnectLabelForm).
 *
 * Only `confirmedConnectLabel` makes one, so a sign-in can start only from a
 * label somebody confirmed (#758). The type is what holds that line: a plain
 * string, a bot's suggestion or a default, does not fit where a sign-in asks
 * for one.
 */
export type ConfirmedConnectLabel = string & { readonly __confirmedConnectLabel: true };

export interface ConnectAppOptions {
  /** The app's `api` helper, or a fake. */
  request: (path: string, init?: RequestInit) => Promise<any>;
  /** Hand the authorization URL to the real browser. */
  openExternal: (url: string) => Promise<void>;
  /**
   * Whether this is the desktop app.
   *
   * The same guard PluginsPanel applies (`if (desktop !== true) return`) and
   * for the same reason: authorizing writes a credential into the machine's
   * secure store, which a paired phone's view of this workspace has no
   * business doing. Undecided is not permission, so anything but `true`
   * refuses.
   */
  desktop: boolean | null;
  /**
   * The label the person confirmed in the label form (ConnectLabelForm),
   * the same rule the connected apps dialog keeps (#758): nothing is
   * authorized until a label is confirmed. Required, and an empty one
   * refuses before any request.
   */
  alias: ConfirmedConnectLabel;
  /** How long between status reads, and how many. The dialog polls every
   *  five seconds for two minutes; the card inherits that. */
  pollIntervalMs?: number;
  attempts?: number;
  /** Injectable sleep, so a test does not wait two real minutes. */
  wait?: (ms: number) => Promise<void>;
  /** Stop polling early, for a card that has left the screen. */
  cancelled?: () => boolean;
}

export const CONNECT_APP_DESKTOP_ONLY = "Connect this from Murage on your computer.";
export const CONNECT_APP_NEEDS_LABEL = "Enter a label for the account, such as work or personal.";
/** The label the first-run cards fill in, so confirming it is one press. */
export const CONNECT_APP_DEFAULT_LABEL = "personal";
/** The longest label the label form accepts, as in the connected apps dialog. */
export const CONNECT_APP_LABEL_MAX = 64;
/** The line the label form shows when the label it sent is held by another account. */
export const CONNECT_APP_LABEL_TAKEN = "That label is already in use. Try another.";
export const CONNECT_APP_NO_URL = "That app did not give us a connection page. Try it again in a moment.";

/** The label to send, or null when there is none to confirm. The one place a
 *  ConfirmedConnectLabel is made; the label form is its one caller in the app. */
export function confirmedConnectLabel(draft: string): ConfirmedConnectLabel | null {
  const alias = typeof draft === "string" ? draft.trim() : "";
  return alias && alias.length <= CONNECT_APP_LABEL_MAX ? (alias as ConfirmedConnectLabel) : null;
}

/** A sign-in the server refused because another account already holds the
 *  label (the broker's 409, kept as its own sentence by the harness). */
export function connectLabelTaken(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  const message = error instanceof Error ? error.message : "";
  return status === 409 && /^Account alias ".*" is already in use/i.test(message);
}

/** An account whose label still counts: anything but a failed or expired
 *  attempt, which the harness clears before it signs in under that label. */
function holdsLabel(account: ConnectAppAccount): boolean {
  return !/^(failed|expired)$/i.test(account.status ?? "");
}

/**
 * The first label still free on this app: `base`, then "base 2", "base 3"...
 * (the numbering the harness itself uses when a Reconnect needs a new label).
 * Labels compare without case, the way the harness matches them. Only what
 * the caller already knows is read; a label taken since then is caught by the
 * server's refusal and said on the form.
 */
export function firstFreeConnectLabel(
  accounts: readonly ConnectAppAccount[] | undefined,
  base: string = CONNECT_APP_DEFAULT_LABEL,
): string {
  const start = base.trim() || CONNECT_APP_DEFAULT_LABEL;
  const taken = new Set(
    (accounts ?? [])
      .filter(holdsLabel)
      .map((account) => (account.alias ?? "").trim().toLowerCase())
      .filter(Boolean),
  );
  if (!taken.has(start.toLowerCase())) return start;
  const stem = start.slice(0, CONNECT_APP_LABEL_MAX - 4).trimEnd();
  for (let n = 2; n < 1000; n += 1) {
    const label = `${stem} ${n}`;
    if (!taken.has(label.toLowerCase())) return label;
  }
  return start;
}

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_ATTEMPTS = 24;

/** A status that has stopped moving, either way. `expired` and `failed` are
 *  the provider's own words for a page that was opened and abandoned. */
export function connectAppSettled(status: ConnectAppStatus | undefined): boolean {
  if (!status) return false;
  if (status.connected && !status.pending) return true;
  return Boolean(status.status && /^(expired|failed)$/i.test(status.status));
}

/**
 * The status of the one account under `alias`, out of the whole app's.
 *
 * The app reads connected when ANY account on it is active, so with a "work"
 * account already on Gmail, a sign-in under "personal" would look finished
 * the moment it started. Only the account carrying this label counts: active
 * is finished, failed or expired is a dead page, and anything else, missing
 * included, is still in flight. Labels compare without case, as the harness
 * matches them.
 */
export function connectAppStatusForLabel(status: ConnectAppStatus, alias: string): ConnectAppStatus {
  const label = alias.trim().toLowerCase();
  const mine = (status.accounts ?? []).filter((account) => (account.alias ?? "").trim().toLowerCase() === label);
  const rank = (account: ConnectAppAccount) =>
    /^active$/i.test(account.status ?? "") ? 0 : /^(failed|expired)$/i.test(account.status ?? "") ? 2 : 1;
  const best = [...mine].sort((a, b) => rank(a) - rank(b))[0];
  const accounts = status.accounts ? { accounts: status.accounts } : {};
  if (!best) return { connected: false, pending: true, status: "INITIATED", ...accounts };
  const connected = rank(best) === 0;
  return {
    connected,
    pending: rank(best) === 1,
    ...(best.status ? { status: best.status } : {}),
    ...accounts,
  };
}

/** Read the status of one service. Never throws: a status read that fails is
 *  a reason to look again, not a reason to fail the connection that may well
 *  be succeeding in the browser. */
export async function readConnectAppStatus(
  slug: string,
  request: ConnectAppOptions["request"],
): Promise<ConnectAppStatus | undefined> {
  try {
    const body = await request(`/api/connectors?services=${encodeURIComponent(slug)}`);
    const service = body?.services?.[slug];
    if (!service || typeof service !== "object") return undefined;
    const accounts: ConnectAppAccount[] = Array.isArray(service.accounts)
      ? service.accounts.flatMap((account: unknown) => {
        // Only a labelled account can hold a label.
        if (!account || typeof account !== "object") return [];
        const { alias, status } = account as { alias?: unknown; status?: unknown };
        if (typeof alias !== "string" || !alias.trim()) return [];
        return [{ alias, ...(typeof status === "string" ? { status } : {}) }];
      })
      : [];
    return {
      connected: Boolean(service.connected),
      ...(service.pending === undefined ? {} : { pending: Boolean(service.pending) }),
      ...(typeof service.status === "string" ? { status: service.status } : {}),
      ...(accounts.length ? { accounts } : {}),
    };
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Connect one named app, start to finish, under the label the person
 * confirmed.
 *
 * Resolves with the last status this saw: connected when the person
 * finished in the browser, and an unfinished one when the wait ran out. An
 * unfinished connection is NOT an error. The person may still be typing
 * their password into the provider's page, and a card that announced a
 * failure over their shoulder while they did would be wrong and rude.
 * Only a refused authorize throws.
 */
export async function connectApp(slug: string, options: ConnectAppOptions): Promise<ConnectAppStatus> {
  if (options.desktop !== true) throw new Error(CONNECT_APP_DESKTOP_ONLY);
  // Checked here as well as by the type: a caller outside TypeScript, or a
  // cast, still sends nothing without a label.
  const alias = confirmedConnectLabel(options.alias);
  if (!alias) throw new Error(CONNECT_APP_NEEDS_LABEL);
  const authorized = await options.request(`/api/connectors/${encodeURIComponent(slug)}/authorize`, {
    method: "POST",
    body: JSON.stringify({ alias }),
  });
  const url = typeof authorized?.url === "string" ? authorized.url : "";
  if (!url) throw new Error(CONNECT_APP_NO_URL);
  await options.openExternal(url);

  const interval = options.pollIntervalMs ?? DEFAULT_INTERVAL_MS;
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const pause = options.wait ?? sleep;
  let last: ConnectAppStatus = { connected: false, pending: true, status: "INITIATED" };
  for (let tries = 0; tries < attempts; tries += 1) {
    if (options.cancelled?.()) return last;
    await pause(interval);
    if (options.cancelled?.()) return last;
    const read = await readConnectAppStatus(slug, options.request);
    // Settled only by the account under the label just confirmed, never by
    // another account the person already has on this app.
    const status = read ? connectAppStatusForLabel(read, alias) : undefined;
    if (status) last = status;
    if (connectAppSettled(status)) return last;
  }
  return last;
}
