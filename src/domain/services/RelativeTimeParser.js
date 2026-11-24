/**
 * Domain service: turns Google's relative review timestamps
 * ("just now", "2 days ago", "42 weeks ago", "a year ago", "Edited 3 months ago")
 * into a normalized age bucket.
 *
 * Pure logic. No DOM, no browser APIs, no dependencies outside the domain.
 * English only — other locales return null (treated as "unparseable").
 */

export const AgeUnit = Object.freeze({
  JUST_NOW: 'JUST_NOW',
  MINUTES: 'MINUTES',
  HOURS: 'HOURS',
  DAYS: 'DAYS',
  WEEKS: 'WEEKS',
  MONTHS: 'MONTHS',
  YEARS: 'YEARS',
});

/**
 * @typedef {Object} AgeBucket
 * @property {string} unit        One of AgeUnit.
 * @property {number} value       Quantity in that unit ("42 weeks ago" -> 42).
 * @property {number} approxDays  Rough age in days (month = 30d, year = 365d).
 */

const UNIT_BY_WORD = Object.freeze({
  second: { unit: AgeUnit.JUST_NOW, days: 0 },
  sec: { unit: AgeUnit.JUST_NOW, days: 0 },
  minute: { unit: AgeUnit.MINUTES, days: 1 / 1440 },
  min: { unit: AgeUnit.MINUTES, days: 1 / 1440 },
  hour: { unit: AgeUnit.HOURS, days: 1 / 24 },
  hr: { unit: AgeUnit.HOURS, days: 1 / 24 },
  day: { unit: AgeUnit.DAYS, days: 1 },
  week: { unit: AgeUnit.WEEKS, days: 7 },
  month: { unit: AgeUnit.MONTHS, days: 30 },
  year: { unit: AgeUnit.YEARS, days: 365 },
});

const QUANTITY_WORDS = Object.freeze({ a: 1, an: 1, one: 1 });

const RELATIVE_PATTERN =
  /^(a|an|one|\d{1,4})\s+(second|sec|minute|min|hour|hr|day|week|month|year)s?\s+ago$/;

function normalize(raw) {
  return raw
    .toLowerCase()
    .replace(/[\s  ]+/g, ' ')
    .trim()
    .replace(/^edited\s+/, '')
    .replace(/\s+on google$/, '')
    .replace(/\.$/, '')
    .trim();
}

function bucket(unit, value, approxDays) {
  return Object.freeze({ unit, value, approxDays });
}

export class RelativeTimeParser {
  /**
   * @param {string} raw
   * @returns {AgeBucket | null} null when the string is not a recognized relative timestamp.
   */
  parse(raw) {
    if (typeof raw !== 'string') return null;
    const text = normalize(raw);
    if (!text || text.length > 40) return null;

    if (text === 'just now' || text === 'now' || text === 'moments ago') {
      return bucket(AgeUnit.JUST_NOW, 0, 0);
    }
    if (text === 'today') return bucket(AgeUnit.DAYS, 0, 0);
    if (text === 'yesterday') return bucket(AgeUnit.DAYS, 1, 1);

    const match = RELATIVE_PATTERN.exec(text);
    if (!match) return null;

    const [, quantity, word] = match;
    const value = quantity in QUANTITY_WORDS ? QUANTITY_WORDS[quantity] : Number(quantity);
    const { unit, days } = UNIT_BY_WORD[word];
    if (unit === AgeUnit.JUST_NOW) return bucket(unit, 0, 0);
    return bucket(unit, value, value * days);
  }
}
