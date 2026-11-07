// Candle helpers and indicators for the Fund Holdings Scan (same formulas as TradingView / Chartink).

const IST_OFFSET_SECONDS = 19800; // UTC+5:30
const SESSION_START_MINUTES = 9 * 60 + 15; // NSE opens 09:15 IST

/**
 * Groups 1-hour bars into candles of `hours` hours, aligned to the 09:15 IST session open
 * (3 hours -> 09:15, 12:15, 15:15), the same way TradingView builds 180-minute NSE candles.
 * bars: [{ t (unix seconds), o, h, l, c }] in time order.
 */
export function aggregateBars(bars, hours = 3) {
  const out = [];
  let key = null;
  for (const bar of bars) {
    const ist = bar.t + IST_OFFSET_SECONDS;
    const day = Math.floor(ist / 86400);
    const minutes = Math.floor((ist % 86400) / 60);
    const size = Math.round(hours * 60); // candle length in minutes (3 minutes = 0.05 hours)
    const bucket = Math.floor((minutes - SESSION_START_MINUTES) / size);
    const k = `${day}:${bucket}`;
    if (k !== key) {
      // Time the candle by its slot start (09:15, 09:18, …), even when the first minutes had no trades.
      const start = day * 86400 + (SESSION_START_MINUTES + bucket * size) * 60 - IST_OFFSET_SECONDS;
      out.push({ t: start, o: bar.o, h: bar.h, l: bar.l, c: bar.c });
      key = k;
    } else {
      const last = out[out.length - 1];
      last.h = Math.max(last.h, bar.h);
      last.l = Math.min(last.l, bar.l);
      last.c = bar.c;
    }
  }
  return out;
}

/**
 * Groups daily bars into weekly (Monday to Friday) or monthly candles, using the IST calendar date.
 * period: 'week' | 'month'
 */
export function groupByPeriod(bars, period) {
  const out = [];
  let key = null;
  for (const bar of bars) {
    const date = new Date((bar.t + IST_OFFSET_SECONDS) * 1000);
    const day = Math.floor((bar.t + IST_OFFSET_SECONDS) / 86400);
    // 1 Jan 1970 was a Thursday, so (day + 3) / 7 changes on Mondays.
    const k = period === 'week' ? Math.floor((day + 3) / 7) : date.getUTCFullYear() * 12 + date.getUTCMonth();
    if (k !== key) {
      out.push({ t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c });
      key = k;
    } else {
      const last = out[out.length - 1];
      last.h = Math.max(last.h, bar.h);
      last.l = Math.min(last.l, bar.l);
      last.c = bar.c;
    }
  }
  return out;
}

/** Exponential moving average of closes, seeded with the simple average of the first `period` closes. */
export function ema(candles, period) {
  const values = new Array(candles.length).fill(null);
  if (candles.length < period) return values;
  const k = 2 / (period + 1);
  let prev = candles.slice(0, period).reduce((sum, x) => sum + x.c, 0) / period;
  values[period - 1] = prev;
  for (let i = period; i < candles.length; i++) {
    prev = candles[i].c * k + prev * (1 - k);
    values[i] = prev;
  }
  return values;
}

/** Supertrend(period, multiplier) with Wilder ATR. Returns { value, direction } arrays (direction 1 = up, -1 = down). */
export function supertrend(candles, period, multiplier) {
  const n = candles.length;
  const value = new Array(n).fill(null);
  const direction = new Array(n).fill(null);
  if (n <= period) return { value, direction };

  let atr = 0;
  let upper = null;
  let lower = null;
  let trend = 1;
  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].c;
    const tr = Math.max(c.h - c.l, Math.abs(c.h - prevClose), Math.abs(c.l - prevClose));
    if (i < period) {
      atr += tr;
      continue;
    }
    atr = i === period ? (atr + tr) / period : (atr * (period - 1) + tr) / period;

    const mid = (c.h + c.l) / 2;
    let up = mid - multiplier * atr;
    let dn = mid + multiplier * atr;
    if (lower !== null && prevClose > lower) up = Math.max(up, lower);
    if (upper !== null && prevClose < upper) dn = Math.min(dn, upper);

    if (upper !== null) {
      if (trend === -1 && c.c > dn) trend = 1;
      else if (trend === 1 && c.c < up) trend = -1;
    }
    lower = up;
    upper = dn;
    value[i] = trend === 1 ? up : dn;
    direction[i] = trend;
  }
  return { value, direction };
}

/** Simple moving average of closes. */
export function sma(candles, period) {
  const values = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].c;
    if (i >= period) sum -= candles[i - period].c;
    if (i >= period - 1) values[i] = sum / period;
  }
  return values;
}

// ---- Scan rules ----
// A rule compares two operands: { left, op, right }.
// An operand is { bar, kind, p1, p2, value }:
//   bar  0 = current candle, 1 = previous, 2 = two candles ago
//   kind 'open' | 'high' | 'low' | 'close' | 'ema' (p1 = period) | 'sma' (p1 = period)
//        | 'supertrend' (p1 = ATR period, p2 = multiplier) | 'value' (a fixed number in `value`)

export const RULE_OPERATORS = {
  gt: '>',
  lt: '<',
  gte: '≥',
  lte: '≤',
  crossAbove: 'crossed above',
  crossBelow: 'crossed below',
};

export const DEFAULT_RULES = [
  { left: { bar: 1, kind: 'close' }, op: 'lt', right: { bar: 1, kind: 'open' } },
  { left: { bar: 1, kind: 'close' }, op: 'lt', right: { bar: 1, kind: 'supertrend', p1: 100, p2: 3 } },
  { left: { bar: 1, kind: 'close' }, op: 'gt', right: { bar: 1, kind: 'ema', p1: 9 } },
  { left: { bar: 0, kind: 'high' }, op: 'crossAbove', right: { bar: 1, kind: 'high' } },
];

const PRICE_FIELDS = { open: 'o', high: 'h', low: 'l', close: 'c' };

function seriesFor(candles, operand, cache) {
  const key = `${operand.kind}:${operand.p1 ?? ''}:${operand.p2 ?? ''}`;
  if (cache.has(key)) return cache.get(key);
  let series;
  if (PRICE_FIELDS[operand.kind]) series = candles.map((c) => c[PRICE_FIELDS[operand.kind]]);
  else if (operand.kind === 'ema') series = ema(candles, operand.p1);
  else if (operand.kind === 'sma') series = sma(candles, operand.p1);
  else if (operand.kind === 'supertrend') series = supertrend(candles, operand.p1, operand.p2).value;
  else throw new Error(`Unknown value "${operand.kind}".`);
  cache.set(key, series);
  return series;
}

/** Candles an operand needs before its first value exists. */
function warmup(operand) {
  if (operand.kind === 'ema' || operand.kind === 'sma') return operand.p1;
  if (operand.kind === 'supertrend') return operand.p1 + 1;
  return 1;
}

/** Fewest candles needed to evaluate every rule (crosses look one candle further back). */
export function candlesNeeded(rules) {
  let need = 3;
  for (const rule of rules) {
    const extra = rule.op === 'crossAbove' || rule.op === 'crossBelow' ? 1 : 0;
    for (const side of [rule.left, rule.right]) {
      if (side.kind !== 'value') need = Math.max(need, warmup(side) + side.bar + extra);
    }
  }
  return need;
}

/**
 * Checks every rule on the latest candles.
 * Returns { results: [{ ok, left, right }], match, current } or { error }.
 * "A crossed above B" means A > B now and A <= B one candle earlier (Chartink's meaning).
 */
export function evaluateRules(candles, rules) {
  const n = candles.length;
  const need = candlesNeeded(rules);
  if (n < need) return { error: `Not enough price history: ${n} candles, these conditions need at least ${need}.` };

  const cache = new Map();
  const valueOf = (operand, shift) => {
    if (operand.kind === 'value') return operand.value;
    return seriesFor(candles, operand, cache)[n - 1 - operand.bar - shift] ?? null;
  };

  const results = rules.map((rule) => {
    const left = valueOf(rule.left, 0);
    const right = valueOf(rule.right, 0);
    let ok = false;
    if (left !== null && right !== null) {
      if (rule.op === 'gt') ok = left > right;
      else if (rule.op === 'lt') ok = left < right;
      else if (rule.op === 'gte') ok = left >= right;
      else if (rule.op === 'lte') ok = left <= right;
      else {
        const leftBefore = valueOf(rule.left, 1);
        const rightBefore = valueOf(rule.right, 1);
        if (leftBefore !== null && rightBefore !== null) {
          ok =
            rule.op === 'crossAbove'
              ? left > right && leftBefore <= rightBefore
              : left < right && leftBefore >= rightBefore;
        }
      }
    }
    return { ok, left, right };
  });

  return { results, match: results.every((r) => r.ok), current: candles[n - 1] };
}
