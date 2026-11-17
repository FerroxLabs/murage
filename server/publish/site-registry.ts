// SPDX-License-Identifier: AGPL-3.0-or-later
import { hasNoLimits } from '../auto-approve.ts';
import type { Store } from '../store.ts';
import { readPublishedSites, type PublishedSite } from '../../shared/published-sites.ts';

/** Registry views are data selection, never permission to publish. Only the
 * owner's Settings view uses the stored setting; service callers must supply
 * the policy verified for their current turn, including guest turns. */
export class SiteRegistry {
  private readonly store: Store;
  constructor(store: Store) { this.store = store; }
  forTurn(botId: string, includeAll: boolean): PublishedSite[] {
    return readPublishedSites(this.store.bot(botId)?.publishedSites, includeAll);
  }
  forOwner(botId: string): PublishedSite[] {
    return this.forTurn(botId, hasNoLimits(this.store.bot(botId)));
  }
  save(botId: string, site: PublishedSite, includeAll?: boolean): void {
    const previous = includeAll === undefined ? this.forOwner(botId) : this.forTurn(botId, includeAll);
    this.store.patchBot(botId, { publishedSites: [...previous.filter(item => item.siteId !== site.siteId), site] });
  }
  remove(botId: string, siteId: string, includeAll?: boolean): void {
    const previous = includeAll === undefined ? this.forOwner(botId) : this.forTurn(botId, includeAll);
    this.store.patchBot(botId, { publishedSites: previous.filter(item => item.siteId !== siteId) });
  }
}
