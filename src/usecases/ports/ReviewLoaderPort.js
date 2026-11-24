/**
 * Port: makes more reviews available to the ReviewSourcePort.
 * (For Google that means opening its reviews list, sorting by newest and
 * scrolling it; the use case doesn't know or care.)
 */
export class ReviewLoaderPort {
  /** Make the reviews list available, newest first. Resolves when ready or given up. */
  async open() {
    throw new Error('ReviewLoaderPort.open() not implemented');
  }

  /** Is the reviews list currently open and loadable? (False if the page closed it underneath us.) */
  isOpen() {
    return true;
  }

  /** Load the next batch. @returns {Promise<boolean>} true if more reviews arrived. */
  async loadMore() {
    throw new Error('ReviewLoaderPort.loadMore() not implemented');
  }

  /** Put the page back the way it was found. */
  async close() {}
}
