import { getPeriodsPerYear, BREAKDOWN_VIEWS } from './utils.js';

/**
 * Future value with compound interest and optional periodic contributions (end of period).
 */
export function compoundFutureValue({
  principal = 0,
  contribution = 0,
  annualRatePercent,
  years,
  frequency = 'monthly',
}) {
  const m = getPeriodsPerYear(frequency);
  const n = Math.round(m * years);
  const r = annualRatePercent / 100 / m;

  const growth = Math.pow(1 + r, n);
  const fvPrincipal = principal * growth;

  let fvContributions = 0;
  if (contribution > 0) {
    if (r === 0) {
      fvContributions = contribution * n;
    } else {
      fvContributions = contribution * ((growth - 1) / r);
    }
  }

  const totalContributions = principal + contribution * n;
  const interestEarned = fvPrincipal + fvContributions - totalContributions;

  return {
    futureValue: fvPrincipal + fvContributions,
    principalGrowth: fvPrincipal,
    contributionsGrowth: fvContributions,
    totalContributions,
    interestEarned,
    periods: n,
    ratePerPeriod: r * 100,
  };
}

/**
 * Required periodic contribution to reach target corpus (goal planning).
 */
export function requiredContribution({
  targetCorpus,
  principal = 0,
  annualRatePercent,
  years,
  frequency = 'monthly',
}) {
  const m = getPeriodsPerYear(frequency);
  const n = Math.round(m * years);
  const r = annualRatePercent / 100 / m;
  const growth = Math.pow(1 + r, n);
  const fvFromPrincipal = principal * growth;
  const gap = targetCorpus - fvFromPrincipal;

  if (gap <= 0) {
    return {
      requiredPerPeriod: 0,
      futureValue: fvFromPrincipal,
      gap: 0,
      totalInvested: principal,
      interestEarned: fvFromPrincipal - principal,
      periods: n,
      achievableWithoutContributions: true,
    };
  }

  let requiredPerPeriod;
  if (r === 0) {
    requiredPerPeriod = gap / n;
  } else {
    requiredPerPeriod = gap / ((growth - 1) / r);
  }

  const totalContributions = principal + requiredPerPeriod * n;
  const fv = fvFromPrincipal + requiredPerPeriod * ((growth - 1) / r);

  return {
    requiredPerPeriod,
    futureValue: fv,
    gap,
    totalInvested: totalContributions,
    interestEarned: fv - totalContributions,
    periods: n,
    achievableWithoutContributions: false,
  };
}

/** Simple interest: A = P(1 + rt) */
export function simpleInterest({ principal, annualRatePercent, years }) {
  const r = annualRatePercent / 100;
  const interest = principal * r * years;
  return {
    futureValue: principal + interest,
    interestEarned: interest,
    totalContributions: principal,
  };
}

/** EMI for loan amount P, annual rate, tenure in months */
export function emiCalculator({ loanAmount, annualRatePercent, tenureMonths }) {
  const r = annualRatePercent / 100 / 12;
  const n = tenureMonths;
  let emi;
  if (r === 0) {
    emi = loanAmount / n;
  } else {
    emi = (loanAmount * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
  }
  const totalPayment = emi * n;
  return {
    emi,
    totalPayment,
    totalInterest: totalPayment - loanAmount,
    tenureMonths: n,
  };
}

const PREPAY_INTERVAL_MONTHS = {
  quarterly: 3,
  'half-yearly': 6,
  yearly: 12,
};

/** Build map of month index → total prepayment due that month. */
function buildPrepaySchedule(prepayments, maxMonths) {
  const byMonth = new Map();
  prepayments.forEach(({ frequency, amount, startMonth }) => {
    const interval = PREPAY_INTERVAL_MONTHS[frequency] ?? 12;
    const start = Math.max(1, Number(startMonth) || interval);
    const prepayAmount = Number(amount) || 0;
    if (prepayAmount <= 0) return;

    for (let m = start; m <= maxMonths; m += interval) {
      byMonth.set(m, (byMonth.get(m) || 0) + prepayAmount);
    }
  });
  return byMonth;
}

/**
 * EMI amortization with optional partial prepayments (quarterly / half-yearly / yearly).
 * EMI stays fixed at the original schedule; prepayments reduce tenure.
 */
export function emiWithPrepayments({
  loanAmount,
  annualRatePercent,
  tenureMonths,
  prepayments = [],
}) {
  const base = emiCalculator({ loanAmount, annualRatePercent, tenureMonths });
  const r = annualRatePercent / 100 / 12;
  const emi = base.emi;
  const prepayByMonth = buildPrepaySchedule(prepayments, tenureMonths * 2);
  const maxMonths = Math.max(tenureMonths * 2, 600);

  let balance = loanAmount;
  let month = 0;
  let totalInterest = 0;
  let totalPaid = 0;
  let totalPrepaid = 0;
  const schedule = [];

  while (balance > 0.005 && month < maxMonths) {
    month += 1;
    const opening = balance;
    const interest = balance * r;
    const prepay = prepayByMonth.get(month) || 0;
    const totalDue = balance + interest;

    if (emi + prepay >= totalDue - 0.005) {
      const finalPayment = totalDue;
      totalInterest += interest;
      totalPaid += finalPayment;
      totalPrepaid += prepay;
      schedule.push({
        month,
        opening,
        emi: finalPayment - prepay,
        prepay,
        interest,
        principal: opening - prepay,
        closing: 0,
      });
      balance = 0;
      break;
    }

    const principal = emi - interest + prepay;
    balance -= principal;
    totalInterest += interest;
    totalPaid += emi + prepay;
    totalPrepaid += prepay;

    schedule.push({
      month,
      opening,
      emi,
      prepay,
      interest,
      principal: principal - prepay,
      closing: Math.max(balance, 0),
    });
  }

  return {
    emi,
    originalTenureMonths: tenureMonths,
    actualTenureMonths: month,
    monthsSaved: Math.max(0, tenureMonths - month),
    totalPaid,
    totalInterest,
    totalPrepaid,
    interestSaved: Math.max(0, base.totalInterest - totalInterest),
    schedule,
    originalTotalPayment: base.totalPayment,
    originalTotalInterest: base.totalInterest,
  };
}

/**
 * Shares to buy at currentPrice so total P&L is zero when market price hits resistance.
 * lots: [{ qty, price }], resistance R, currentPrice P
 * X = S * (A - R) / (R - P)
 */
export function stockNeutralAtResistance({ lots, resistance, currentPrice }) {
  let totalShares = 0;
  let totalCost = 0;

  lots.forEach(({ qty, price }) => {
    if (qty <= 0 || price < 0) return;
    totalShares += qty;
    totalCost += qty * price;
  });

  if (totalShares <= 0) {
    throw new Error('Add at least one purchase with quantity greater than zero.');
  }
  if (resistance <= 0 || currentPrice <= 0) {
    throw new Error('Current price and resistance must be greater than zero.');
  }

  const avgCost = totalCost / totalShares;
  const R = resistance;
  const P = currentPrice;

  if (Math.abs(R - P) < 1e-9) {
    if (Math.abs(avgCost - R) < 1e-6) {
      return {
        status: 'already_neutral',
        totalShares,
        totalCost,
        avgCost,
        resistance: R,
        currentPrice: P,
        sharesNeeded: 0,
        message: 'Your average cost already equals the resistance price — you are already neutral at that level.',
      };
    }
    throw new Error(
      'Current price cannot equal resistance unless your average cost already matches. Adjust one of the values.'
    );
  }

  const exactShares = (totalShares * (avgCost - R)) / (R - P);

  if (exactShares <= 0) {
    let reason = 'No additional shares needed at the current price to reach neutrality at resistance.';
    if (avgCost <= R && P < R) {
      reason = 'Your average is already at or below resistance — you are neutral or in profit when price reaches resistance.';
    } else if (avgCost >= R && P > R) {
      reason = 'Cannot reach neutrality at resistance by buying above the resistance price.';
    }
    return {
      status: 'not_needed',
      totalShares,
      totalCost,
      avgCost,
      resistance: R,
      currentPrice: P,
      sharesNeeded: 0,
      exactSharesNeeded: exactShares,
      message: reason,
    };
  }

  const sharesNeeded = Math.ceil(exactShares - 1e-9);
  const additionalInvestment = sharesNeeded * P;
  const newTotalShares = totalShares + sharesNeeded;
  const newTotalCost = totalCost + additionalInvestment;
  const newAverage = newTotalCost / newTotalShares;
  const pnlAtResistance = newTotalShares * R - newTotalCost;

  return {
    status: 'buy',
    totalShares,
    totalCost,
    avgCost,
    resistance: R,
    currentPrice: P,
    exactSharesNeeded: exactShares,
    sharesNeeded,
    additionalInvestment,
    newTotalShares,
    newAverage,
    pnlAtResistance,
  };
}

/** Present value: what lump sum today equals future amount */
export function presentValue({ futureAmount, annualRatePercent, years, frequency = 'yearly' }) {
  const m = getPeriodsPerYear(frequency);
  const n = Math.round(m * years);
  const r = annualRatePercent / 100 / m;
  const pv = futureAmount / Math.pow(1 + r, n);
  return { presentValue: pv, discount: futureAmount - pv };
}

/** Whether a calendar day index (1-based) falls on Mon–Fri (day 1 = Monday). */
function isBusinessDay(dayIndex) {
  return (dayIndex - 1) % 7 < 5;
}

/** Nth business day (1-based) mapped to a calendar day index. */
function nthBusinessCalendarDay(n, totalDays) {
  if (n <= 0) return 0;
  let count = 0;
  for (let d = 1; d <= totalDays; d += 1) {
    if (isBusinessDay(d)) {
      count += 1;
      if (count === n) return d;
    }
  }
  return totalDays;
}

/** Calendar day range for compounding period i (0-based index). */
function periodDayRange(periodIndex, totalPeriods, totalDays, frequency) {
  if (frequency === 'daily-business') {
    const totalBusinessDays = Math.max(1, Math.round(252 * (totalDays / 365)));
    const endBiz = Math.max(1, Math.round(((periodIndex + 1) / totalPeriods) * totalBusinessDays));
    const startBiz = periodIndex === 0 ? 1 : Math.round((periodIndex / totalPeriods) * totalBusinessDays) + 1;
    const startDay = periodIndex === 0 ? 1 : nthBusinessCalendarDay(startBiz - 1, totalDays) + 1;
    const endDay = nthBusinessCalendarDay(endBiz, totalDays);
    return {
      startDay: Math.min(Math.max(startDay, 1), totalDays),
      endDay: Math.min(Math.max(endDay, startDay), totalDays),
    };
  }

  const startDay = Math.floor((periodIndex * totalDays) / totalPeriods) + 1;
  const endDay = Math.floor(((periodIndex + 1) * totalDays) / totalPeriods);
  return {
    startDay: Math.min(startDay, totalDays),
    endDay: Math.min(Math.max(endDay, startDay), totalDays),
  };
}

/** Expand compounding periods into daily rows with interest spread across each period. */
function expandCompoundPeriodsToDaily(periods, totalDays) {
  const dayMeta = Array.from({ length: totalDays + 1 }, () => null);

  periods.forEach((p) => {
    const daysInPeriod = p.endDay - p.startDay + 1;
    const dailyInterest = p.interest / daysInPeriod;
    const dailyContrib = p.contributed / daysInPeriod;
    for (let d = p.startDay; d <= p.endDay; d += 1) {
      dayMeta[d] = { dailyInterest, dailyContrib, periodStartBalance: p.startBalance };
    }
  });

  const rows = [];
  let balance = periods[0]?.startBalance ?? 0;

  for (let d = 1; d <= totalDays; d += 1) {
    const meta = dayMeta[d];
    const startBalance = balance;
    const dailyInterest = meta?.dailyInterest ?? 0;
    const dailyContrib = meta?.dailyContrib ?? 0;
    balance += dailyInterest + dailyContrib;

    rows.push({
      period: d,
      startBalance,
      contributed: dailyContrib,
      interest: dailyInterest,
      endBalance: balance,
    });
  }

  return rows;
}

/** Simulate each compounding period, then aggregate into daily/weekly/monthly/yearly rows. */
export function compoundBreakdown({
  principal = 0,
  contribution = 0,
  annualRatePercent,
  years,
  frequency = 'monthly',
  viewMode = 'yearly',
}) {
  const compPerYear = getPeriodsPerYear(frequency);
  const totalPeriods = Math.max(1, Math.round(compPerYear * years));
  const r = annualRatePercent / 100 / compPerYear;
  const totalDays = Math.max(1, Math.round(years * 365));

  if (viewMode === 'daily') {
    const periods = [];
    let balance = principal;

    for (let i = 0; i < totalPeriods; i += 1) {
      const { startDay, endDay } = periodDayRange(i, totalPeriods, totalDays, frequency);
      const startBalance = balance;
      const before = balance;
      balance = balance * (1 + r) + contribution;

      periods.push({
        startDay,
        endDay,
        startBalance,
        contributed: contribution,
        interest: balance - before - contribution,
        endBalance: balance,
      });
    }

    return expandCompoundPeriodsToDaily(periods, totalDays);
  }

  const viewPerYear = BREAKDOWN_VIEWS[viewMode]?.periodsPerYear ?? 1;
  const buckets = new Map();

  let balance = principal;
  for (let i = 1; i <= totalPeriods; i += 1) {
    const bucketIndex = Math.ceil((i / totalPeriods) * (years * viewPerYear)) || 1;
    const maxBucket = Math.max(1, Math.ceil(years * viewPerYear));
    const key = Math.min(bucketIndex, maxBucket);

    if (!buckets.has(key)) {
      buckets.set(key, {
        period: key,
        startBalance: balance,
        contributed: 0,
        interest: 0,
        endBalance: balance,
      });
    }

    const bucket = buckets.get(key);
    const start = balance;
    balance = balance * (1 + r) + contribution;
    bucket.contributed += contribution;
    bucket.interest += balance - start - contribution;
    bucket.endBalance = balance;
  }

  return Array.from(buckets.values());
}

/** Simple interest breakdown — linear accrual grouped by view mode. */
export function simpleInterestBreakdown({
  principal,
  annualRatePercent,
  years,
  viewMode = 'yearly',
}) {
  const r = annualRatePercent / 100;

  if (viewMode === 'daily') {
    const totalDays = Math.max(1, Math.round(years * 365));
    const interestPerDay = (principal * r * years) / totalDays;
    const rows = [];
    let cumulativeInterest = 0;

    for (let d = 1; d <= totalDays; d += 1) {
      cumulativeInterest += interestPerDay;
      rows.push({
        period: d,
        startBalance: principal + cumulativeInterest - interestPerDay,
        contributed: 0,
        interest: interestPerDay,
        endBalance: principal + cumulativeInterest,
      });
    }
    return rows;
  }

  const viewPerYear = BREAKDOWN_VIEWS[viewMode]?.periodsPerYear ?? 1;
  const totalBuckets = Math.max(1, Math.ceil(years * viewPerYear));
  const periodYears = years / totalBuckets;
  const interestPerBucket = principal * r * periodYears;

  const rows = [];
  let cumulativeInterest = 0;
  for (let i = 1; i <= totalBuckets; i += 1) {
    cumulativeInterest += interestPerBucket;
    rows.push({
      period: i,
      startBalance: principal + cumulativeInterest - interestPerBucket,
      contributed: 0,
      interest: interestPerBucket,
      endBalance: principal + cumulativeInterest,
    });
  }
  return rows;
}

/** Goal planner breakdown using required contribution at chosen frequency. */
export function goalBreakdown({
  targetCorpus,
  principal = 0,
  annualRatePercent,
  years,
  frequency = 'monthly',
  viewMode = 'yearly',
}) {
  const req = requiredContribution({
    targetCorpus,
    principal,
    annualRatePercent,
    years,
    frequency,
  });

  if (req.achievableWithoutContributions) {
    return compoundBreakdown({
      principal,
      contribution: 0,
      annualRatePercent,
      years,
      frequency,
      viewMode,
    });
  }

  return compoundBreakdown({
    principal,
    contribution: req.requiredPerPeriod,
    annualRatePercent,
    years,
    frequency,
    viewMode,
  });
}

/** Compare all contribution frequencies for same goal */
export function goalAcrossFrequencies(params) {
  const frequencies = ['monthly', 'quarterly', 'half-yearly', 'yearly'];
  return frequencies.map((frequency) => ({
    frequency,
    ...requiredContribution({ ...params, frequency }),
  }));
}

/** @deprecated Use compoundBreakdown with viewMode='yearly' */
export function yearBreakdown(params) {
  return compoundBreakdown({ ...params, viewMode: 'yearly' });
}

export function breakdownPeriodLabel(viewMode, period) {
  const labels = { daily: 'Day', weekly: 'Week', monthly: 'Month', yearly: 'Year' };
  return `${labels[viewMode] || 'Period'} ${period}`;
}

/**
 * MTF (Margin Trading Facility) interest. The broker funds (positionValue - ownCapital)
 * and charges a flat daily rate on that funded amount for every calendar day held.
 */
export function mtfInterest({ positionValue, ownCapital, dailyRatePercent, holdingDays }) {
  const fundedAmount = Math.max(positionValue - ownCapital, 0);
  const dailyInterest = (fundedAmount * dailyRatePercent) / 100;
  const totalInterest = dailyInterest * holdingDays;
  const schedule = [];
  for (let day = 1; day <= holdingDays; day += 1) {
    schedule.push({ day, interest: dailyInterest, cumulative: dailyInterest * day });
  }
  return {
    fundedAmount,
    leverage: ownCapital > 0 ? positionValue / ownCapital : 0,
    dailyInterest,
    monthlyInterest: dailyInterest * 30,
    annualRatePercent: dailyRatePercent * 365,
    totalInterest,
    breakevenPercent: positionValue > 0 ? (totalInterest / positionValue) * 100 : 0,
    schedule,
  };
}
