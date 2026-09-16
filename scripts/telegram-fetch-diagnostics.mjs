// Qualification-only observer. Never record URLs, headers, bodies or error text.
const codes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);
const codeOf = error => codes.has(error?.code) ? error.code : 'unclassified';
export function observeTelegramFetch(fetcher, record) {
  return async function(input, options) {
    let observed = false;
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      observed = url.origin === 'https://api.telegram.org' && url.pathname.endsWith('/getMe');
    } catch { /* Let the original fetch validate its input. */ }
    if (!observed) return fetcher(input, options);
    const started = Date.now();
    const emit = value => { try { record(value); } catch { /* Observation must not change transport. */ } };
    try {
      const response = await fetcher(input, options);
      emit({ operation: 'getMe', elapsedMs: Date.now() - started, status: response.status });
      return response;
    } catch (error) {
      emit({ operation: 'getMe', elapsedMs: Date.now() - started, failed: true,
        code: codeOf(error?.cause ?? error),
        nestedCodes: Array.isArray(error?.cause?.errors) ? error.cause.errors.slice(0, 8).map(codeOf) : [] });
      throw error;
    }
  };
}
globalThis.fetch = observeTelegramFetch(globalThis.fetch.bind(globalThis), value => process.stderr.write('[telegram-network-diagnostic] ' + JSON.stringify(value) + '\n'));
