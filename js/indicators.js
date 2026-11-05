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
    const bucket = Math.floor((minutes - SESSION_START_MINUTES) / (hours * 60));
    const k = `${day}:${bucket}`;
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

/**
 * Runs the scan on the latest candle ("current") against the one before it ("previous"):
 *   1. previous close < previous open
 *   2. previous close < previous Supertrend(stPeriod, stMultiplier)
 *   3. previous close > previous EMA(emaPeriod)
 *   4. current high crossed above previous high (Chartink "crossed above": now above, and it was not above one candle earlier)
 */
export function fundScan(candles, { emaPeriod = 9, stPeriod = 100, stMultiplier = 3 } = {}) {
  const n = candles.length;
  if (n < Math.max(stPeriod + 3, emaPeriod + 3)) return { error: `Not enough price history (${n} candles).` };

  const emaValues = ema(candles, emaPeriod);
  const st = supertrend(candles, stPeriod, stMultiplier);
  const cur = candles[n - 1];
  const prev = candles[n - 2];
  const prev2 = candles[n - 3];
  const prevEma = emaValues[n - 2];
  const prevSt = st.value[n - 2];

  const checks = {
    redCandle: prev.c < prev.o,
    belowSupertrend: prevSt !== null && prev.c < prevSt,
    aboveEma: prevEma !== null && prev.c > prevEma,
    highCrossed: cur.h > prev.h && prev.h <= prev2.h,
  };
  return {
    current: cur,
    previous: prev,
    prevEma,
    prevSupertrend: prevSt,
    checks,
    match: Object.values(checks).every(Boolean),
  };
}
