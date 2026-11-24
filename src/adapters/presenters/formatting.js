/** Formatting helpers shared by the presenters. Pure functions, no DOM. */

export const MINUS = '−';

/** 4.25 -> "4.3"; always one decimal. */
export const fmt = (n) => n.toFixed(1);

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * @param {number | null} delta  recent average minus all-time rating
 * @returns {{ short: string, long: string } | null}
 */
export function formatDelta(delta) {
  if (delta === null) return null;
  if (delta === 0) return { short: '±0.0', long: 'Same as all-time rating' };
  const sign = delta > 0 ? '+' : MINUS;
  const text = `${sign}${fmt(Math.abs(delta))}`;
  return { short: text, long: `${text} vs all-time` };
}

/** 'positive' | 'negative' | 'neutral' | 'muted' */
export function toneFor(delta, hasSample) {
  if (!hasSample) return 'muted';
  if (delta === null || delta === 0) return 'neutral';
  return delta > 0 ? 'positive' : 'negative';
}
