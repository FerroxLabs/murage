import { isFileRevision } from "../../shared/workspace-files";
import { imageRecoveryOwner, retainLocalMediaGeneration, localMedia, refreshLocalMedia, retryLocalMedia, subscribeLocalMedia, type LocalMediaRequest, type LocalMediaResolution, type MediaApi } from './media-resolve';
import { claimLocalImageLightbox, localImageCost, LOCAL_IMAGE_INLINE_MAX_DECODED_BYTES, queueImageDiscovery, reserveLocalImage, watchLocalImageBudget } from './local-image-budget';
import { localImageByteUrl, saveLocalImage } from './local-image-save';
export const LOCAL_IMAGE_LOAD_DEADLINE_MS = 15_000;
type Ready = Extract<LocalMediaResolution, { state: 'ready' }>;
export type LocalImageState = 'waiting' | 'resolving' | 'refreshing' | 'opening' | 'saving' | 'ready-loading' | 'ready' | 'ready-large' | 'budget-wait' | 'outside' | 'remote' | 'not-listed' | 'missing' | 'changed' | 'denied' | 'unsupported' | 'unanswered' | 'load-failed' | 'save-failed' | 'disposed';
export interface LocalImageView { saving?: boolean; state: LocalImageState; ready?: Ready; surface: 'thumbnail' | 'lightbox'; node: number; changedShown?: boolean }
export class LocalImageController {
  view: LocalImageView = { state: 'waiting', surface: 'thumbnail', node: 0 };
  private owner = imageRecoveryOwner();
  private visible = false;
  private explicit = false;
  private desired: 'thumbnail' | 'lightbox' = 'thumbnail';
  private release?: () => void;
  private releaseGeneration?: () => void;
  private releaseLightbox?: () => void;
  private cancelDiscovery?: () => void;
  private unsubscribe: () => void;
  private unwatch: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private element: HTMLImageElement | null = null;
  private operation = 0;
  private pending = false;
  private saveAction?: ReturnType<typeof saveLocalImage>;
  private sequence = 0;
  constructor(readonly request: LocalMediaRequest, private api: MediaApi, private changed: () => void) {
    this.unsubscribe = subscribeLocalMedia(request, result => {
      if (this.owner.terminal || this.pending || this.view.state === 'disposed' || result.state !== 'ready' || !this.view.ready || result.generation <= this.view.ready.generation) return;
      if (this.owner.spent) { this.terminal('load-failed'); return; }
      this.owner.spent = true; void this.admit(result);
    });
    this.unwatch = watchLocalImageBudget(() => { if (this.view.state === 'budget-wait' && this.view.ready) void this.admit(this.view.ready); });
  }
  private set(state: LocalImageState, ready = this.view.ready) { this.view = { ...this.view, saving: !!this.saveAction, state, ready, surface: this.desired }; this.changed(); }
  private remove() {
    this.element?.removeAttribute('src'); this.element?.removeAttribute('srcset'); this.element = null;
    clearTimeout(this.timer); this.timer = undefined;
    this.release?.(); this.release = undefined;
    this.view = { ...this.view, node: 0 };
  }
  private terminal(state: LocalImageState) { this.releaseGeneration?.(); this.releaseGeneration = undefined; this.remove(); this.owner.terminal = true; this.releaseLightbox?.(); this.releaseLightbox = undefined; this.set(state); }
  attach(element: HTMLImageElement | null, node: number) { if (node === this.view.node) this.element = element; }
  visibility(visible: boolean) {
    if (this.view.state === 'disposed') return;
    this.visible = visible;
    if (!visible && this.desired !== 'lightbox') {
      this.explicit = false; this.remove();
      if (!this.owner.terminal && !this.saveAction) this.set('waiting');
    } else if (visible && this.view.state === 'waiting') {
      if (this.view.ready) void this.admit(this.view.ready); else this.resolve(false);
    }
  }
  retry() {
    if (this.pending || this.saveAction || this.view.state === 'ready-loading' || this.view.state === 'disposed') return;
    this.remove(); this.owner = imageRecoveryOwner(); this.explicit = true; this.resolve(true);
  }
  private resolve(retry: boolean) {
    if (this.pending || this.owner.terminal) return;
    const operation = ++this.operation; this.pending = true; this.set('resolving');
    void this.discovery(() => (retry ? retryLocalMedia : localMedia)(this.request, this.api)).then(async result => {
      if (operation !== this.operation) return;
      this.pending = false; await this.admit(result);
    });
  }
  private discovery(work: () => Promise<LocalMediaResolution>): Promise<LocalMediaResolution> {
    return new Promise(resolve => {
      const cancel = queueImageDiscovery(async () => {
        try { resolve(await work()); }
        catch { resolve({ state: 'unavailable', why: 'unanswered' }); }
      });
      this.cancelDiscovery = () => { cancel(); resolve({ state: 'unavailable', why: 'unanswered' }); };
    });
  }
  private async renew(): Promise<LocalMediaResolution> {
    const ready = this.view.ready;
    if (!ready) return { state: 'unavailable', why: 'unanswered' };
    return this.discovery(() => refreshLocalMedia(this.request, ready.generation, 'image', this.owner, this.api));
  }
  private async recover() {
    if (this.pending) return;
    this.saveAction?.dispose(); this.saveAction = undefined;
    this.remove(); const operation = ++this.operation; this.pending = true; this.set('refreshing');
    const result = await this.renew();
    if (operation !== this.operation) return;
    this.pending = false; await this.admit(result);
  }
  private async admit(result: LocalMediaResolution): Promise<void> {
    if (this.view.state === 'disposed') return;
    this.remove();
    if (result.state === 'exhausted') { this.terminal('load-failed'); return; }
    if (result.state === 'unavailable') { this.terminal(result.why); return; }
    if (result.state === 'unplayable') { this.terminal(result.reason); return; }
    this.releaseGeneration?.(); this.releaseGeneration = retainLocalMediaGeneration(result);
    this.view = { ...this.view, ready: result };
    const asset = result.asset;
    if (asset.kind !== 'image' || !asset.capabilities?.preview) { this.terminal('unsupported'); return; }
    if (!isFileRevision(asset.revision) || !localImageByteUrl(result.url) || !Number.isFinite(result.expiresAt)) { this.terminal('unanswered'); return; }
    const cost = localImageCost(asset);
    if (cost === null) { this.terminal('unsupported'); return; }
    if (!this.visible && !this.explicit && this.desired !== 'lightbox') { this.set('waiting'); return; }
    if (result.expiresAt! - Date.now() <= 15_000) {
      if (this.owner.spent) { this.terminal('load-failed'); return; }
      await this.recover(); return;
    }
    if (this.desired === 'thumbnail' && cost > LOCAL_IMAGE_INLINE_MAX_DECODED_BYTES) { this.set('ready-large'); return; }
    this.release = reserveLocalImage(cost) ?? undefined;
    if (!this.release) { this.set('budget-wait'); return; }
    const node = ++this.sequence;
    this.view = { ...this.view, node, surface: this.desired, state: 'ready-loading' }; this.changed();
    this.timer = setTimeout(() => this.error(node), LOCAL_IMAGE_LOAD_DEADLINE_MS);
  }
  loaded(node: number) { if (!node || node !== this.view.node) return; clearTimeout(this.timer); this.timer = undefined; this.set(this.saveAction ? 'saving' : 'ready'); }
  error(node: number) {
    if (!node || node !== this.view.node || this.view.state === 'disposed') return;
    this.remove(); if (this.owner.spent) this.terminal('load-failed'); else void this.recover();
  }
  open() {
    if (this.pending || this.owner.terminal || !this.view.ready || this.saveAction) return;
    this.desired = 'lightbox'; this.explicit = true;
    this.releaseLightbox ??= claimLocalImageLightbox(() => this.close());
    this.set('opening'); void this.admit(this.view.ready);
  }
  close() {
    this.releaseLightbox?.(); this.releaseLightbox = undefined;
    this.desired = 'thumbnail'; this.explicit = false; this.remove();
    if (this.view.state === 'disposed' || this.owner.terminal) return;
    if (this.view.ready && !this.pending) void this.admit(this.view.ready); else this.set('waiting');
  }
  save() {
    if (this.saveAction || this.pending || this.owner.terminal || !this.view.ready?.asset.capabilities.download) return;
    const operation = this.operation, shown = this.view.ready;
    let expectedId = shown.asset.id, expectedRevision = shown.asset.revision, renewing = false;
    const action = saveLocalImage({ shown, renew: async () => {
      this.pending = true; renewing = true;
      try { const result = await this.renew(); if (operation === this.operation && result.state === 'ready') { expectedId = result.asset.id; expectedRevision = result.asset.revision; await this.admit(result); } return result; }
      finally { this.pending = false; renewing = false; }
    }, live: () => this.view.state !== 'disposed' && !this.owner.terminal && this.operation === operation && (renewing || (this.view.ready?.asset.id === expectedId && this.view.ready.asset.revision === expectedRevision)) });
    if (!action.acquired) return;
    this.saveAction = action; this.set('saving');
    void action.result.then(result => {
      if (this.saveAction === action) this.saveAction = undefined;
      if (operation !== this.operation || this.view.state === 'disposed') return;
      if (result.state === 'failed') this.terminal('save-failed');
      else if (result.state === 'unavailable') { if (result.resolution.state === 'exhausted') this.terminal('save-failed'); else void this.admit(result.resolution); }
      else if (result.state === 'changed') { this.view = { ...this.view, changedShown: true }; void this.admit(result.resolution); }
      else if (!this.owner.terminal && this.view.ready) { if (this.view.node) this.set('ready'); else void this.admit(this.view.ready); }
    });
  }
  dispose() {
    ++this.operation; this.releaseGeneration?.(); this.releaseGeneration = undefined; this.owner.terminal = true; this.remove(); this.cancelDiscovery?.(); this.unsubscribe(); this.unwatch(); this.saveAction?.dispose(); this.releaseLightbox?.(); this.view = { ...this.view, saving: false, state: 'disposed' };
  }
}
