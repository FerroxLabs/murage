'use client';

import { useEffect } from 'react';

/** FirstPromoter company id. Public: it ships in every partner's tracking snippet. */
const FIRSTPROMOTER_CID = 'd5vrmq6s';

/**
 * Loads FirstPromoter's tracker only for visitors who arrived through a partner link (`?fpr=`) or already carry its
 * referral cookie (`_fprom_tid` / `_fprom_ref`), so everyone else gets no third-party script and no tracking cookie.
 * Same rule as murage.ai. The tracker sets `_fprom_tid`, which checkout reads on the server as fp_tid.
 */
export function ReferralTracking() {
  useEffect(() => {
    const fromLink = new URLSearchParams(window.location.search).has('fpr');
    const hasCookie = /(?:^|;\s*)_fprom_(?:tid|ref)=/.test(document.cookie);
    if (!fromLink && !hasCookie) return;
    if (document.getElementById('fpr-js')) return;

    type Fpr = ((...args: unknown[]) => void) & { q?: unknown[][] };
    const w = window as unknown as { fpr?: Fpr };
    if (!w.fpr) {
      const fpr: Fpr = (...args) => {
        fpr.q = fpr.q ?? [];
        if (args[0] === 'set') fpr.q.unshift(args);
        else fpr.q.push(args);
      };
      w.fpr = fpr;
    }
    w.fpr('init', { cid: FIRSTPROMOTER_CID });
    w.fpr('click');

    const script = document.createElement('script');
    script.id = 'fpr-js';
    script.src = 'https://cdn.firstpromoter.com/fpr.js';
    script.async = true;
    document.head.appendChild(script);
  }, []);
  return null;
}
