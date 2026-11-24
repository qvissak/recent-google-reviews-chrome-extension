import { CalculateRecentRatingUseCase } from '../../usecases/CalculateRecentRatingUseCase.js';
import { LoadReviewsUseCase } from '../../usecases/LoadReviewsUseCase.js';
import { ManageExtensionSettingsUseCase } from '../../usecases/ManageExtensionSettingsUseCase.js';
import { GoogleDomReviewDao } from '../../adapters/dao/GoogleDomReviewDao.js';
import { CachingGoogleReviewSource } from '../../adapters/dao/CachingGoogleReviewSource.js';
import { GoogleReviewsLoader } from '../../adapters/dao/GoogleReviewsLoader.js';
import { ChromeStorageSettingsDao } from '../../adapters/dao/ChromeStorageSettingsDao.js';
import { RatingBadgePresenter } from '../../adapters/presenters/RatingBadgePresenter.js';
import { ReviewsModalPresenter } from '../../adapters/presenters/ReviewsModalPresenter.js';
import { LoadingNoticePresenter } from '../../adapters/presenters/LoadingNoticePresenter.js';
import { BadgeDomRenderer } from '../ui/BadgeDomRenderer.js';
import { ReviewsModalRenderer } from '../ui/ReviewsModalRenderer.js';
import { LoadingNoticeRenderer } from '../ui/LoadingNoticeRenderer.js';
import { ReviewsModalController } from './ReviewsModalController.js';
import { BackgroundLoadController } from './BackgroundLoadController.js';
import { loadWindowFor, trendWindowsFor } from '../../domain/entities/TimeWindow.js';
import { isMapsPage, isMobileLayout } from './googleLayout.js';

// The longest the "page is paused" notice stays up. It closes by itself when the calculation ends; this is the backstop for
// one that runs long, so the page is never held behind an explanation it cannot get rid of.
const NOTICE_TIMEOUT_MS = 10000;

const OWN_UI = '[data-rgr-root], [data-rgr-tip], [data-rgr-modal], [data-rgr-notice]';

function isOwnNode(node) {
  const el = node.nodeType === 1 ? node : node.parentElement;
  return Boolean(el?.closest?.(OWN_UI)) || (node.nodeType === 1 && node.matches?.(OWN_UI));
}

/** True when a mutation was caused only by our own UI (prevents feedback loops). */
function isOwnMutation(record) {
  if (isOwnNode(record.target)) return true;
  const nodes = [...record.addedNodes, ...record.removedNodes];
  return nodes.length > 0 && nodes.every(isOwnNode);
}

/**
 * Composition root for the content script. Wires use cases, adapters and the
 * renderers, and re-runs the pipeline (debounced) whenever Google's SPA mutates the DOM.
 */
export class ContentScriptController {
  constructor({
    window,
    document,
    settingsUseCase,
    calculateUseCase,
    presenter,
    renderer,
    modal = null,
    autoLoad = null,
    notice = null,
    noticeTimeoutMs = NOTICE_TIMEOUT_MS,
    isSupported = () => true,
    surface = () => (isMapsPage(document.location) ? 'maps' : 'search'),
    debounceMs = 300,
    maxWaitMs = 1500,
  }) {
    this.window = window;
    this.document = document;
    this.settingsUseCase = settingsUseCase;
    this.calculateUseCase = calculateUseCase;
    this.presenter = presenter;
    this.renderer = renderer;
    this.modal = modal;
    this.autoLoad = autoLoad;
    this.notice = notice; // { presenter, renderer }: the "page is paused for a few seconds, and why" popup
    this.isSupported = isSupported; // false on a Google layout we cannot read (its phone layout): a note instead of numbers
    this.surface = surface; // 'search' | 'maps': which on/off setting applies to the page we are on (Google navigates between them without a reload)
    this.debounceMs = debounceMs;
    this.maxWaitMs = maxWaitMs;

    this.settings = null;
    /** 'idle' | 'loading' | 'incomplete' — anything but 'idle' means the data held is not a finished result */
    this.loadState = 'idle';
    this.badgeCalculating = false; // the badge shows its "calculating" skeleton: a load is running or about to start
    this.noticeTimeoutMs = noticeTimeoutMs;
    this.noticeExpired = false; // for this calculation: the next one shows the notice again
    this.noticeTimer = null;
    this.observer = null;
    this.unsubscribe = null;
    this.timer = null;
    this.firstScheduledAt = null;
  }

  /** The reviews modal is created after this controller (it needs a handle back to it). */
  attachModal(modal) {
    this.modal = modal;
  }

  /** The background calculation is created after this controller (it needs a handle back to it). */
  attachAutoLoad(autoLoad) {
    this.autoLoad = autoLoad;
  }

  async start() {
    this.settings = await this.settingsUseCase.getSettings();
    this.unsubscribe = this.settingsUseCase.subscribe((settings) => {
      this.settings = settings;
      this.schedule(true);
    });

    this.observer = new this.window.MutationObserver((records) => {
      if (records.some((r) => !isOwnMutation(r))) this.schedule();
    });
    this.observer.observe(this.document.documentElement, { childList: true, subtree: true });

    this.update();
  }

  stop() {
    this.observer?.disconnect();
    this.unsubscribe?.();
    this.window.clearTimeout(this.timer);
    this.window.clearTimeout(this.noticeTimer);
    this.timer = null;
    this.noticeTimer = null;
    this.firstScheduledAt = null;
    this.modal?.close();
    this.autoLoad?.dispose();
    this.notice?.renderer.dispose();
    this.renderer.dispose();
  }

  /** Debounce with a max wait, so a page that mutates continuously still gets updates. */
  schedule(immediate = false) {
    const now = Date.now();
    if (this.firstScheduledAt === null) this.firstScheduledAt = now;
    this.window.clearTimeout(this.timer);

    const waited = now - this.firstScheduledAt;
    const delay = immediate ? 0 : Math.max(0, Math.min(this.debounceMs, this.maxWaitMs - waited));
    this.timer = this.window.setTimeout(() => {
      this.timer = null;
      this.firstScheduledAt = null;
      this.update();
    }, delay);
  }

  /**
   * The reviews modal reports its loading state. While reviews are loading — or after a load was
   * abandoned — the badge shows its skeleton instead of a half-computed number.
   * @param {'idle' | 'loading' | 'incomplete'} state  Only 'loading' means the data is unfinished: an abandoned load
   *        has already been discarded, leaving the badge with nothing calculated.
   */
  setLoadState(state) {
    if (state === this.loadState) return;
    this.loadState = state;
    this.update();
  }

  /** Has the user switched the badge on for the kind of page this is (Search or Maps)? */
  #enabledHere() {
    const settings = this.settings;
    return Boolean(this.surface() === 'maps' ? settings?.mapsEnabled : settings?.searchEnabled);
  }

  /**
   * Show the "page is paused" notice for as long as the badge is calculating, unless something else already explains it:
   * the reviews modal covers the page with its own skeleton, so the notice steps aside for it (a modal closed mid-load is
   * detached, and the page is paused again, so the notice returns). It follows the badge's skeleton rather than the load
   * itself, so it is up from the moment the calculation is committed to, not only after the background controller's
   * settle delay. That also rules out a layout we do not load on and a page with no badge (not a place).
   */
  syncNotice() {
    if (!this.notice) return;
    const wanted = this.#enabledHere() && this.badgeCalculating && !this.modal?.isOpen && !this.noticeExpired;
    if (wanted) this.notice.renderer.render(this.notice.presenter.present());
    else this.notice.renderer.dispose();
  }

  /** The notice lives for one calculation: it ends with it, or after noticeTimeoutMs, whichever comes first. */
  #trackCalculating(calculating) {
    if (calculating && !this.badgeCalculating && this.notice) {
      this.noticeTimer = this.window.setTimeout(() => {
        this.noticeTimer = null;
        this.noticeExpired = true;
        this.syncNotice();
      }, this.noticeTimeoutMs);
    }
    if (!calculating) {
      this.window.clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
      this.noticeExpired = false;
    }
    this.badgeCalculating = calculating;
    this.syncNotice();
  }

  /** Switch the time window now (badge and modal update immediately) and persist the choice. */
  async setTimeWindow(timeWindow) {
    this.settings = { ...this.settings, timeWindow };
    this.update();
    try {
      await this.settingsUseCase.setTimeWindow?.(timeWindow);
    } catch (error) {
      console.warn('[Recent Google Reviews] could not save the time window', error);
    }
  }

  update() {
    try {
      if (!this.#enabledHere()) {
        this.renderer.remove();
        this.modal?.close();
        this.#trackCalculating(false);
        return;
      }
      // One read of the reviews gives every window: the selected one (the modal's) and the strip's three (up to the user's longest).
      const trend = trendWindowsFor(this.settings.maxMonths);
      const ids = [...new Set([this.settings.timeWindow, ...trend])];
      const summaries = new Map(this.calculateUseCase.executeAll({ timeWindows: ids }).map((s, i) => [ids[i], s]));
      const summary = summaries.get(this.settings.timeWindow);
      const supported = this.isSupported();
      const badge = this.presenter.present(summary, {
        pending: this.loadState === 'loading',
        willCalculate: this.autoLoad ? this.autoLoad.expects(summary) : true,
        unsupported: !supported,
        windows: trend.map((id) => summaries.get(id)),
      });
      this.renderer.render(badge);
      this.modal?.refresh();
      const badgeShown = Boolean(this.document.querySelector('[data-rgr-root]'));
      this.#trackCalculating(badge.state === 'loading' && badgeShown);
      // Nothing is loaded on a layout we cannot read: driving Google's page there would only navigate the user away.
      if (supported) this.autoLoad?.consider(summary, { badgeShown });
    } catch (error) {
      console.warn('[Recent Google Reviews] update failed', error);
    }
  }
}

/** Real wiring, used by loader.js. Idempotent per page. */
export function bootstrap() {
  if (window.__recentGoogleReviewsStarted) return null;
  window.__recentGoogleReviewsStarted = true;

  const dao = new GoogleDomReviewDao({ document });
  const reviewSource = new CachingGoogleReviewSource({ dao });
  const calculateUseCase = new CalculateRecentRatingUseCase({ reviewSource });
  const loadUseCase = new LoadReviewsUseCase({
    reviewSource,
    reviewLoader: new GoogleReviewsLoader({ document, window }),
  });

  let modal = null;
  // Load far enough back to fill every window the strip shows (up to the user's longest), and the selected one if it reaches further.
  const loadWindow = () => loadWindowFor(controller.settings.timeWindow, controller.settings.maxMonths);
  const controller = new ContentScriptController({
    window,
    document,
    settingsUseCase: new ManageExtensionSettingsUseCase({
      settingsRepository: new ChromeStorageSettingsDao(),
    }),
    calculateUseCase,
    presenter: new RatingBadgePresenter(),
    notice: {
      presenter: new LoadingNoticePresenter(),
      renderer: new LoadingNoticeRenderer({ window, document }),
    },
    isSupported: () => !isMobileLayout(window.navigator),
    renderer: new BadgeDomRenderer({
      window,
      document,
      locateAnchor: () => dao.locateBadgeAnchor(),
      onActivate: (windowId) => {
        // Clicking a cell opens the modal on that window.
        if (windowId && windowId !== controller.settings.timeWindow) controller.setTimeWindow(windowId);
        modal?.open();
      },
    }),
  });

  modal = new ReviewsModalController({
    calculateUseCase,
    loadUseCase,
    presenter: new ReviewsModalPresenter(),
    renderer: new ReviewsModalRenderer({
      window,
      document,
      cloneCard: (id) => reviewSource.cardFor(id),
      onWindowChange: (windowId) => modal.changeWindow(windowId),
      onClose: () => modal.close(),
      onLoadMore: () => modal.loadMore(),
    }),
    getTimeWindow: () => controller.settings.timeWindow,
    getLoadWindow: loadWindow,
    setTimeWindow: (windowId) => controller.setTimeWindow(windowId),
    onLoadStateChange: (state) => controller.setLoadState(state),
    onVisibilityChange: () => controller.syncNotice(),
    stopBackground: () => autoLoad.stop(),
  });
  const autoLoad = new BackgroundLoadController({
    window,
    loadUseCase,
    readSummary: () => calculateUseCase.execute({ timeWindow: controller.settings.timeWindow }),
    getTimeWindow: loadWindow,
    isModalOpen: () => modal.isBusy,
    isPageHidden: () => document.hidden,
    onLoadStateChange: (state) => controller.setLoadState(state),
  });
  controller.attachModal(modal);
  controller.attachAutoLoad(autoLoad);

  controller.start();
  return controller;
}
