export function formatCurrency(value, currency = 'INR', locale = 'en-IN') {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(n);
}

export function formatNumber(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  }).format(n);
}

export function formatPercent(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(digits)}%`;
}

export function parseInput(value, fallback = 0) {
  if (value === '' || value == null) return fallback;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

export const COMPOUNDING = {
  daily: { label: 'Daily (365 days)', shortLabel: 'day', periodsPerYear: 365 },
  'daily-business': { label: 'Daily (business days, no weekends)', shortLabel: 'business day', periodsPerYear: 252 },
  weekly: { label: 'Weekly', shortLabel: 'week', periodsPerYear: 52 },
  monthly: { label: 'Monthly', shortLabel: 'month', periodsPerYear: 12 },
  quarterly: { label: 'Quarterly', shortLabel: 'quarter', periodsPerYear: 4 },
  'half-yearly': { label: 'Half-yearly', shortLabel: 'half-year', periodsPerYear: 2 },
  yearly: { label: 'Yearly', shortLabel: 'year', periodsPerYear: 1 },
};

export const BREAKDOWN_VIEWS = {
  daily: { label: 'Daily', periodsPerYear: 365 },
  weekly: { label: 'Weekly', periodsPerYear: 52 },
  monthly: { label: 'Monthly', periodsPerYear: 12 },
  yearly: { label: 'Yearly', periodsPerYear: 1 },
};

/** How the interest-rate input should be interpreted. */
export const RATE_PERIODS = {
  daily: { label: 'Per day (365 days)', shortLabel: 'day', periodsPerYear: 365 },
  'daily-business': { label: 'Per business day (252 days)', shortLabel: 'business day', periodsPerYear: 252 },
  weekly: { label: 'Per week', shortLabel: 'week', periodsPerYear: 52 },
  'bi-weekly': { label: 'Per bi-week (fortnight)', shortLabel: 'bi-week', periodsPerYear: 26 },
  monthly: { label: 'Per month', shortLabel: 'month', periodsPerYear: 12 },
  quarterly: { label: 'Per quarter', shortLabel: 'quarter', periodsPerYear: 4 },
  'half-yearly': { label: 'Per half-year', shortLabel: 'half-year', periodsPerYear: 2 },
  yearly: { label: 'Per annum (yearly)', shortLabel: 'year', periodsPerYear: 1 },
};

export function getPeriodsPerYear(frequency) {
  return COMPOUNDING[frequency]?.periodsPerYear ?? 12;
}

export function getRatePeriodsPerYear(ratePeriod) {
  return RATE_PERIODS[ratePeriod]?.periodsPerYear ?? 1;
}

/** Convert entered rate (quoted per ratePeriod) to nominal annual % p.a. */
export function toNominalAnnualPercent(ratePercent, ratePeriod = 'yearly') {
  return ratePercent * getRatePeriodsPerYear(ratePeriod);
}

/** Rate per compounding period as a decimal (e.g. 0.01 = 1%). */
export function ratePerCompoundPeriod(ratePercent, ratePeriod, compoundFrequency) {
  const nominalAnnual = toNominalAnnualPercent(ratePercent, ratePeriod) / 100;
  return nominalAnnual / getPeriodsPerYear(compoundFrequency);
}

/** Convert years + months inputs to total years (decimal). */
export function durationToYears(years, months) {
  const y = Number(years) || 0;
  const m = Number(months) || 0;
  if (y < 0 || m < 0) throw new Error('Time cannot be negative.');
  if (m >= 12) throw new Error('Months must be between 0 and 11.');
  const total = y + m / 12;
  if (total <= 0) throw new Error('Time period must be greater than zero.');
  return total;
}

/** Human-readable duration label. */
export function formatDuration(years, months) {
  const y = Number(years) || 0;
  const m = Number(months) || 0;
  const parts = [];
  if (y > 0) parts.push(`${y} year${y === 1 ? '' : 's'}`);
  if (m > 0) parts.push(`${m} month${m === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' ') : '0 months';
}

export function validatePositive(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
}

export function validateRate(value, name = 'Return rate') {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${name} must be between 0 and 100.`);
  }
}

export function validateYears(value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Time period must be greater than zero.');
  }
}

export const PREPAY_FREQUENCIES = {
  quarterly: { label: 'Quarterly (every 3 months)', intervalMonths: 3 },
  'half-yearly': { label: 'Half-yearly (every 6 months)', intervalMonths: 6 },
  yearly: { label: 'Yearly (every 12 months)', intervalMonths: 12 },
};

export function validateDuration(years, months) {
  const y = Number(years) || 0;
  const m = Number(months) || 0;
  if (y < 0 || m < 0) throw new Error('Time cannot be negative.');
  if (m >= 12) throw new Error('Months must be between 0 and 11.');
  if (y + m / 12 <= 0) throw new Error('Time period must be greater than zero.');
}
