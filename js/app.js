import {
  formatCurrency,
  formatNumber,
  formatPercent,
  parseInput,
  COMPOUNDING,
  RATE_PERIODS,
  BREAKDOWN_VIEWS,
  validatePositive,
  validateRate,
  validateDuration,
  durationToYears,
  formatDuration,
  toNominalAnnualPercent,
  ratePerCompoundPeriod,
  PREPAY_FREQUENCIES,
} from './utils.js';
import {
  compoundFutureValue,
  requiredContribution,
  goalAcrossFrequencies,
  simpleInterest,
  emiWithPrepayments,
  stockNeutralAtResistance,
  presentValue,
  mtfInterest,
  mtfLotsPnl,
  compoundBreakdown,
  simpleInterestBreakdown,
  goalBreakdown,
  breakdownPeriodLabel,
} from './finance.js';
import { downloadExcel, downloadPDF } from './export.js';

let currency = 'INR';

/** @type {Map<string, { title: string, headers: string[], rows: object[], viewMode: string }>} */
const breakdownCache = new Map();

function $(id) {
  return document.getElementById(id);
}

function getCurrency() {
  return $('currencySelect')?.value || 'INR';
}

function fc(value) {
  return formatCurrency(value, getCurrency());
}

function show(el) {
  el.classList.remove('hidden');
}

function hide(el) {
  el.classList.add('hidden');
}

function renderResultCard(container, heroLabel, heroValue, items) {
  container.innerHTML = `
    <h3>${heroLabel}</h3>
    <div class="result-hero">${heroValue}</div>
    <div class="result-grid">
      ${items
        .map(
          (item) => `
        <div class="result-item ${item.highlight ? 'highlight' : ''}">
          <span>${item.label}</span>
          <span>${item.value}</span>
        </div>`
        )
        .join('')}
    </div>
  `;
  show(container);
}

function renderError(container, message) {
  container.innerHTML = `<p class="error-msg">${message}</p>`;
  show(container);
}

function readDuration(yearsId, monthsId) {
  const years = parseInput($(yearsId).value);
  const months = parseInput($(monthsId).value);
  validateDuration(years, months);
  return { years, months, totalYears: durationToYears(years, months) };
}

function updateCompoundLabels() {
  const freq = $('ciFrequency')?.value || 'monthly';
  const ratePeriod = $('ciRatePeriod')?.value || 'yearly';
  const freqShort = COMPOUNDING[freq]?.shortLabel || 'period';
  const rateShort = RATE_PERIODS[ratePeriod]?.shortLabel || 'year';

  const contribLabel = $('ciContributionLabel');
  if (contribLabel) {
    contribLabel.textContent = `Regular contribution (per ${freqShort})`;
  }

  const rateLabel = $('ciRateLabel');
  if (rateLabel) {
    rateLabel.textContent = `Interest / return rate (% per ${rateShort})`;
  }
}

function breakdownTableHtml({ cacheKey, title, rows, viewMode, periodCol = 'Period' }) {
  const interestHeader = viewMode === 'daily' ? 'Daily interest' : 'Interest';
  const headers = [periodCol, 'Start balance', 'Contributed', interestHeader, 'End balance'];
  const formattedRows = rows.map((row) => [
    breakdownPeriodLabel(viewMode, row.period),
    fc(row.startBalance),
    fc(row.contributed),
    fc(row.interest),
    fc(row.endBalance),
  ]);

  breakdownCache.set(cacheKey, {
    title,
    headers,
    rows: formattedRows,
    viewMode,
  });

  const rowHint =
    viewMode === 'daily' && rows.length > 100
      ? `<p class="hint breakdown-row-hint">${formatNumber(rows.length, 0)} days — daily interest is spread evenly within each compounding period. Scroll or export for the full list.</p>`
      : viewMode === 'daily'
        ? `<p class="hint breakdown-row-hint">Daily interest is spread evenly across days within each compounding period (totals match the calculator).</p>`
        : '';

  return `
    <div class="breakdown-toolbar">
      <h3>${title}</h3>
      <div class="breakdown-controls">
        <label for="${cacheKey}-view">View by</label>
        <select id="${cacheKey}-view" class="breakdown-view-select" data-cache-key="${cacheKey}">
          ${Object.entries(BREAKDOWN_VIEWS)
            .map(
              ([key, { label }]) =>
                `<option value="${key}" ${key === viewMode ? 'selected' : ''}>${label}</option>`
            )
            .join('')}
        </select>
        <button type="button" class="btn btn-export" data-export="excel" data-cache-key="${cacheKey}">Excel</button>
        <button type="button" class="btn btn-export" data-export="pdf" data-cache-key="${cacheKey}">PDF</button>
      </div>
    </div>
    ${rowHint}
    <div class="table-scroll${viewMode === 'daily' ? ' table-scroll-daily' : ''}">
    <table>
      <thead>
        <tr>
          ${headers.map((h) => `<th>${h}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
        ${formattedRows
          .map(
            (cells) => `
          <tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`
          )
          .join('')}
      </tbody>
    </table>
    </div>
  `;
}

function wireBreakdownControls(container, onViewChange) {
  container.querySelectorAll('.breakdown-view-select').forEach((select) => {
    select.addEventListener('change', () => onViewChange(select.dataset.cacheKey, select.value));
  });

  container.querySelectorAll('.btn-export').forEach((btn) => {
    btn.addEventListener('click', () => {
      const { cacheKey, export: format } = btn.dataset;
      const data = breakdownCache.get(cacheKey);
      if (!data) return;

      const slug = cacheKey.replace(/[^a-z0-9]/gi, '-').toLowerCase();
      const filename = `finance-suite-${slug}-${data.viewMode}.${format === 'excel' ? 'xlsx' : 'pdf'}`;

      try {
        if (format === 'excel') {
          downloadExcel({ title: data.title, headers: data.headers, rows: data.rows, filename });
        } else {
          downloadPDF({ title: data.title, headers: data.headers, rows: data.rows, filename });
        }
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

function switchCalculator(id) {
  const menuItems = document.querySelectorAll('.menu-item');
  const panels = document.querySelectorAll('.panel');
  const mobileSelect = $('calcMenuSelect');

  menuItems.forEach((item) => {
    const match = item.dataset.tab === id;
    item.classList.toggle('active', match);
    item.setAttribute('aria-selected', match ? 'true' : 'false');
  });

  panels.forEach((p) => {
    const match = p.id === `panel-${id}`;
    p.classList.toggle('active', match);
    p.hidden = !match;
  });

  if (mobileSelect && mobileSelect.value !== id) {
    mobileSelect.value = id;
  }

  // Expand the group containing the active item
  const activeItem = document.querySelector(`.menu-item[data-tab="${id}"]`);
  const group = activeItem?.closest('.menu-group');
  if (group?.classList.contains('collapsed')) {
    group.classList.remove('collapsed');
    group.querySelector('.menu-group-toggle')?.setAttribute('aria-expanded', 'true');
  }
}

function initCollapsibleMenu() {
  document.querySelectorAll('.menu-group-toggle').forEach((toggle) => {
    toggle.addEventListener('click', () => {
      const group = toggle.closest('.menu-group');
      const collapsed = group.classList.toggle('collapsed');
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
  });
}

function initTabs() {
  const menuItems = document.querySelectorAll('.menu-item');
  const mobileSelect = $('calcMenuSelect');

  menuItems.forEach((item) => {
    item.addEventListener('click', () => switchCalculator(item.dataset.tab));
  });

  mobileSelect?.addEventListener('change', () => {
    switchCalculator(mobileSelect.value);
  });

  initCollapsibleMenu();
}

/** @type {object|null} */
let compoundState = null;

function renderCompoundBreakdown(viewMode = 'yearly') {
  if (!compoundState) return;
  const breakdownEl = $('breakdownCompound');
  const { principal, contribution, ratePercent, ratePeriod, totalYears, frequency } = compoundState;
  const annualRatePercent = toNominalAnnualPercent(ratePercent, ratePeriod);

  const rows = compoundBreakdown({
    principal,
    contribution,
    annualRatePercent,
    years: totalYears,
    frequency,
    viewMode,
  });

  const viewLabel = BREAKDOWN_VIEWS[viewMode].label;
  breakdownEl.innerHTML = breakdownTableHtml({
    cacheKey: 'compound',
    title: `${viewLabel} breakdown`,
    rows,
    viewMode,
  });
  wireBreakdownControls(breakdownEl, (_, mode) => renderCompoundBreakdown(mode));
  show(breakdownEl);
}

function initCompound() {
  updateCompoundLabels();
  $('ciFrequency')?.addEventListener('change', updateCompoundLabels);
  $('ciRatePeriod')?.addEventListener('change', updateCompoundLabels);

  $('formCompound').addEventListener('submit', (e) => {
    e.preventDefault();
    const resultEl = $('resultCompound');
    const breakdownEl = $('breakdownCompound');
    try {
      const principal = parseInput($('ciPrincipal').value);
      const contribution = parseInput($('ciContribution').value);
      const ratePercent = parseInput($('ciRate').value);
      const ratePeriod = $('ciRatePeriod').value;
      const { years, months, totalYears } = readDuration('ciYears', 'ciMonths');
      const frequency = $('ciFrequency').value;

      validatePositive(principal, 'Principal');
      validatePositive(contribution, 'Contribution');
      validateRate(ratePercent);

      const annualRatePercent = toNominalAnnualPercent(ratePercent, ratePeriod);
      const rPerPeriod = ratePerCompoundPeriod(ratePercent, ratePeriod, frequency) * 100;

      const r = compoundFutureValue({
        principal,
        contribution,
        annualRatePercent,
        years: totalYears,
        frequency,
      });

      compoundState = { principal, contribution, ratePercent, ratePeriod, totalYears, frequency };

      const rateShort = RATE_PERIODS[ratePeriod].shortLabel;
      renderResultCard(
        resultEl,
        'Future value (maturity amount)',
        fc(r.futureValue),
        [
          { label: 'Total amount invested', value: fc(r.totalContributions) },
          { label: 'Interest / gains earned', value: fc(r.interestEarned), highlight: true },
          { label: 'Growth from initial deposit', value: fc(r.principalGrowth) },
          { label: 'Growth from contributions', value: fc(r.contributionsGrowth) },
          {
            label: 'Rate entered',
            value: `${formatPercent(ratePercent, 4)} per ${rateShort}`,
          },
          {
            label: 'Nominal annual equivalent',
            value: `${formatPercent(annualRatePercent, 4)} p.a.`,
          },
          {
            label: `Rate per ${COMPOUNDING[frequency].shortLabel}`,
            value: formatPercent(rPerPeriod, 4),
          },
          { label: 'Compounding frequency', value: COMPOUNDING[frequency].label },
          { label: 'Duration', value: formatDuration(years, months) },
          { label: 'Total periods', value: formatNumber(r.periods, 0) },
        ]
      );

      const currentView = breakdownEl.querySelector('.breakdown-view-select')?.value || 'yearly';
      renderCompoundBreakdown(currentView);
    } catch (err) {
      renderError(resultEl, err.message);
      hide(breakdownEl);
      compoundState = null;
    }
  });
}

/** @type {object|null} */
let goalState = null;

function renderGoalBreakdown(viewMode = 'yearly') {
  if (!goalState) return;
  const breakdownEl = $('breakdownGoal');
  const { targetCorpus, principal, annualRatePercent, totalYears, frequency } = goalState;

  const rows = goalBreakdown({
    targetCorpus,
    principal,
    annualRatePercent,
    years: totalYears,
    frequency,
    viewMode,
  });

  const viewLabel = BREAKDOWN_VIEWS[viewMode].label;
  breakdownEl.innerHTML = breakdownTableHtml({
    cacheKey: 'goal',
    title: `Goal progress — ${viewLabel} breakdown`,
    rows,
    viewMode,
  });
  wireBreakdownControls(breakdownEl, (_, mode) => renderGoalBreakdown(mode));
  show(breakdownEl);
}

function initGoal() {
  $('formGoal').addEventListener('submit', (e) => {
    e.preventDefault();
    const resultEl = $('resultGoal');
    const breakdownEl = $('breakdownGoal');
    try {
      const targetCorpus = parseInput($('goalCorpus').value);
      const principal = parseInput($('goalPrincipal').value);
      const annualRatePercent = parseInput($('goalRate').value);
      const { years, months, totalYears } = readDuration('goalYears', 'goalMonths');
      const frequency = $('goalFrequency').value;

      validatePositive(targetCorpus, 'Target corpus');
      validatePositive(principal, 'Existing savings');
      validateRate(annualRatePercent);

      goalState = { targetCorpus, principal, annualRatePercent, totalYears, frequency };

      const all = goalAcrossFrequencies({
        targetCorpus,
        principal,
        annualRatePercent,
        years: totalYears,
      });

      const monthly = all.find((x) => x.frequency === 'monthly');
      const achievable = monthly?.achievableWithoutContributions;

      let html = `
        <h3>Investment required to reach ${fc(targetCorpus)}</h3>
        <div class="result-hero">${achievable ? 'Goal already achievable!' : fc(monthly?.requiredPerPeriod || 0) + ' / month'}</div>
      `;

      if (achievable) {
        html += `<p class="hint">Your existing savings of ${fc(principal)} is projected to reach ${fc(monthly.futureValue)} in ${formatDuration(years, months)} at ${formatPercent(annualRatePercent)} return — no additional contributions needed.</p>`;
      } else {
        html += `<div class="goal-freq-grid">`;
        all.forEach((item, idx) => {
          const label = COMPOUNDING[item.frequency].label;
          html += `
            <div class="goal-freq-card ${idx === 0 ? 'best' : ''}">
              <h4>${label}${idx === 0 ? ' (most common)' : ''}</h4>
              <div class="amount">${fc(item.requiredPerPeriod)}</div>
              <div class="hint">per ${label.toLowerCase()} period · total invested ${fc(item.totalInvested)} · gains ${fc(item.interestEarned)}</div>
            </div>`;
        });
        html += `</div>`;
      }

      html += `
        <div class="result-grid" style="margin-top:1rem">
          <div class="result-item"><span>Target corpus</span><span>${fc(targetCorpus)}</span></div>
          <div class="result-item"><span>Existing savings</span><span>${fc(principal)}</span></div>
          <div class="result-item"><span>Expected return</span><span>${formatPercent(annualRatePercent)} p.a.</span></div>
          <div class="result-item"><span>Time horizon</span><span>${formatDuration(years, months)}</span></div>
        </div>`;

      resultEl.innerHTML = html;
      show(resultEl);

      const currentView = breakdownEl.querySelector('.breakdown-view-select')?.value || 'yearly';
      renderGoalBreakdown(currentView);
    } catch (err) {
      renderError(resultEl, err.message);
      hide(breakdownEl);
      goalState = null;
    }
  });
}

function initSip() {
  $('formSip').addEventListener('submit', (e) => {
    e.preventDefault();
    const resultEl = $('resultSip');
    try {
      const principal = parseInput($('sipPrincipal').value);
      const contribution = parseInput($('sipAmount').value);
      const annualRatePercent = parseInput($('sipRate').value);
      const years = parseInput($('sipYears').value);
      const frequency = $('sipFrequency').value;

      validatePositive(principal, 'Lump sum');
      validatePositive(contribution, 'Investment amount');
      validateRate(annualRatePercent);
      if (years <= 0) throw new Error('Time period must be greater than zero.');

      const r = compoundFutureValue({
        principal,
        contribution,
        annualRatePercent,
        years,
        frequency,
      });

      renderResultCard(
        resultEl,
        'Estimated future value',
        fc(r.futureValue),
        [
          {
            label: `Investment per ${COMPOUNDING[frequency].label.toLowerCase()} period`,
            value: fc(contribution),
          },
          { label: 'Total invested', value: fc(r.totalContributions) },
          { label: 'Wealth gained (returns)', value: fc(r.interestEarned), highlight: true },
          { label: 'Return multiple', value: `${(r.futureValue / r.totalContributions || 0).toFixed(2)}×` },
        ]
      );
    } catch (err) {
      renderError(resultEl, err.message);
    }
  });
}

/** @type {object|null} */
let simpleState = null;

function renderSimpleBreakdown(viewMode = 'yearly') {
  if (!simpleState) return;
  const breakdownEl = $('breakdownSimple');
  const { principal, annualRatePercent, totalYears } = simpleState;

  const rows = simpleInterestBreakdown({
    principal,
    annualRatePercent,
    years: totalYears,
    viewMode,
  });

  const viewLabel = BREAKDOWN_VIEWS[viewMode].label;
  breakdownEl.innerHTML = breakdownTableHtml({
    cacheKey: 'simple',
    title: `Simple interest — ${viewLabel} breakdown`,
    rows,
    viewMode,
  });
  wireBreakdownControls(breakdownEl, (_, mode) => renderSimpleBreakdown(mode));
  show(breakdownEl);
}

function initSimple() {
  $('formSimple').addEventListener('submit', (e) => {
    e.preventDefault();
    const resultEl = $('resultSimple');
    const breakdownEl = $('breakdownSimple');
    try {
      const principal = parseInput($('siPrincipal').value);
      const annualRatePercent = parseInput($('siRate').value);
      const { years, months, totalYears } = readDuration('siYears', 'siMonths');

      validatePositive(principal, 'Principal');
      validateRate(annualRatePercent, 'Interest rate');

      simpleState = { principal, annualRatePercent, totalYears };

      const r = simpleInterest({ principal, annualRatePercent, years: totalYears });

      renderResultCard(resultEl, 'Amount after simple interest', fc(r.futureValue), [
        { label: 'Principal', value: fc(principal) },
        { label: 'Interest earned', value: fc(r.interestEarned), highlight: true },
        { label: 'Rate', value: formatPercent(annualRatePercent) + ' p.a.' },
        { label: 'Duration', value: formatDuration(years, months) },
      ]);

      const currentView = breakdownEl.querySelector('.breakdown-view-select')?.value || 'yearly';
      renderSimpleBreakdown(currentView);
    } catch (err) {
      renderError(resultEl, err.message);
      hide(breakdownEl);
      simpleState = null;
    }
  });
}

function initEmi() {
  /** @type {{ id: number, frequency: string, amount: number, startMonth: number }[]} */
  let prepayments = [];
  let prepayId = 1;

  const prepayBody = $('emiPrepayBody');
  const prepayEmpty = $('emiPrepayEmpty');
  const prepayTable = $('emiPrepayTable');

  function readPrepaymentsFromGrid() {
    return prepayments.map((p) => ({ ...p }));
  }

  function renderPrepayGrid() {
    if (!prepayBody) return;

    if (prepayments.length === 0) {
      prepayBody.innerHTML = '';
      prepayEmpty?.classList.remove('hidden');
      prepayTable?.classList.add('hidden');
      return;
    }

    prepayEmpty?.classList.add('hidden');
    prepayTable?.classList.remove('hidden');

    prepayBody.innerHTML = prepayments
      .map(
        (p) => `
      <tr data-id="${p.id}">
        <td>
          <select class="prepay-freq" data-id="${p.id}" aria-label="Prepayment frequency">
            ${Object.entries(PREPAY_FREQUENCIES)
              .map(
                ([key, { label }]) =>
                  `<option value="${key}" ${p.frequency === key ? 'selected' : ''}>${label}</option>`
              )
              .join('')}
          </select>
        </td>
        <td>
          <input type="number" class="prepay-amount" data-id="${p.id}" min="0" step="1000" value="${p.amount}" aria-label="Prepayment amount" />
        </td>
        <td>
          <input type="number" class="prepay-start" data-id="${p.id}" min="1" step="1" value="${p.startMonth}" aria-label="First prepayment month" />
        </td>
        <td>
          <button type="button" class="btn btn-danger btn-sm prepay-delete" data-id="${p.id}" aria-label="Delete prepayment">Delete</button>
        </td>
      </tr>`
      )
      .join('');

    prepayBody.querySelectorAll('.prepay-delete').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.id);
        prepayments = prepayments.filter((p) => p.id !== id);
        renderPrepayGrid();
      });
    });

    prepayBody.querySelectorAll('.prepay-freq, .prepay-amount, .prepay-start').forEach((el) => {
      el.addEventListener('change', syncPrepayFromGrid);
      el.addEventListener('input', syncPrepayFromGrid);
    });
  }

  function syncPrepayFromGrid() {
    prepayments = prepayments.map((p) => {
      const row = prepayBody.querySelector(`tr[data-id="${p.id}"]`);
      if (!row) return p;
      return {
        ...p,
        frequency: row.querySelector('.prepay-freq')?.value || p.frequency,
        amount: parseInput(row.querySelector('.prepay-amount')?.value, p.amount),
        startMonth: parseInput(row.querySelector('.prepay-start')?.value, p.startMonth),
      };
    });
  }

  $('emiAddPrepay')?.addEventListener('click', () => {
    prepayments.push({
      id: prepayId++,
      frequency: 'yearly',
      amount: 100000,
      startMonth: 12,
    });
    renderPrepayGrid();
  });

  function formatTenure(months) {
    const yrs = Math.floor(months / 12);
    const mos = months % 12;
    const parts = [];
    if (yrs > 0) parts.push(`${yrs} yr${yrs === 1 ? '' : 's'}`);
    if (mos > 0) parts.push(`${mos} mo${mos === 1 ? '' : 's'}`);
    return parts.length ? `${formatNumber(months, 0)} months (${parts.join(' ')})` : `${formatNumber(months, 0)} months`;
  }

  function renderEmiBreakdown(schedule) {
    const breakdownEl = $('breakdownEmi');
    if (!schedule.length) {
      hide(breakdownEl);
      return;
    }

    breakdownEl.innerHTML = `
      <h3>Month-by-month amortization</h3>
      <div class="table-scroll table-scroll-daily">
        <table>
          <thead>
            <tr>
              <th>Month</th>
              <th>Opening balance</th>
              <th>EMI</th>
              <th>Prepayment</th>
              <th>Interest</th>
              <th>Principal</th>
              <th>Closing balance</th>
            </tr>
          </thead>
          <tbody>
            ${schedule
              .map(
                (row) => `
              <tr>
                <td>${row.month}</td>
                <td>${fc(row.opening)}</td>
                <td>${fc(row.emi)}</td>
                <td>${row.prepay > 0 ? fc(row.prepay) : '—'}</td>
                <td>${fc(row.interest)}</td>
                <td>${fc(row.principal)}</td>
                <td>${fc(row.closing)}</td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;
    show(breakdownEl);
  }

  $('formEmi').addEventListener('submit', (e) => {
    e.preventDefault();
    const resultEl = $('resultEmi');
    syncPrepayFromGrid();
    try {
      const loanAmount = parseInput($('emiAmount').value);
      const annualRatePercent = parseInput($('emiRate').value);
      const tenureMonths = parseInput($('emiTenure').value);
      const activePrepayments = readPrepaymentsFromGrid().filter((p) => p.amount > 0);

      validatePositive(loanAmount, 'Loan amount');
      validateRate(annualRatePercent, 'Interest rate');
      if (tenureMonths <= 0) throw new Error('Tenure must be greater than zero.');

      activePrepayments.forEach((p, i) => {
        if (p.startMonth <= 0) throw new Error(`Prepayment ${i + 1}: first payment month must be at least 1.`);
      });

      // Always build the amortization schedule so the month-wise table shows even without prepayments.
      const r = emiWithPrepayments({
        loanAmount,
        annualRatePercent,
        tenureMonths,
        prepayments: activePrepayments,
      });

      const hasPrepay = activePrepayments.length > 0;
      const heroLabel = hasPrepay ? 'Loan completes in' : 'Monthly EMI';
      const heroValue = hasPrepay ? formatTenure(r.actualTenureMonths) : fc(r.emi);

      const items = [
        { label: 'Monthly EMI (unchanged)', value: fc(r.emi) },
        { label: 'Loan amount', value: fc(loanAmount) },
        {
          label: hasPrepay ? 'Revised tenure' : 'Tenure',
          value: formatTenure(r.actualTenureMonths),
          highlight: hasPrepay,
        },
      ];

      if (hasPrepay) {
        items.push(
          { label: 'Original tenure', value: formatTenure(r.originalTenureMonths) },
          { label: 'Months saved', value: formatNumber(r.monthsSaved, 0), highlight: true },
          { label: 'Total prepayments', value: fc(r.totalPrepaid) },
          { label: 'Total interest paid', value: fc(r.totalInterest) },
          { label: 'Interest saved vs original', value: fc(r.interestSaved), highlight: true },
          { label: 'Total amount paid', value: fc(r.totalPaid) },
          { label: 'Original total interest', value: fc(r.originalTotalInterest) }
        );
      } else {
        items.push(
          { label: 'Total payment', value: fc(r.totalPaid) },
          { label: 'Total interest', value: fc(r.totalInterest), highlight: true }
        );
      }

      renderResultCard(resultEl, heroLabel, heroValue, items);
      renderEmiBreakdown(r.schedule);

      const sipPercent = parseInput($('emiSipPercent').value, 0);
      const sipRate = parseInput($('emiSipRate').value, 12);
      const sipResultEl = $('resultEmiSip');

      if (sipPercent > 0) {
        if (sipPercent > 100) throw new Error('SIP percentage cannot exceed 100%.');
        validateRate(sipRate, 'SIP return rate');

        const monthlySip = r.emi * (sipPercent / 100);
        const sipYears = r.actualTenureMonths / 12;
        const sip = compoundFutureValue({
          principal: 0,
          contribution: monthlySip,
          annualRatePercent: sipRate,
          years: sipYears,
          frequency: 'monthly',
        });

        const sipMonths = r.actualTenureMonths;
        const sipYearsPart = Math.floor(sipMonths / 12);
        const sipMonthsPart = sipMonths % 12;

        renderResultCard(
          sipResultEl,
          'SIP maturity (parallel investment)',
          fc(sip.futureValue),
          [
            {
              label: 'Monthly SIP amount',
              value: `${fc(monthlySip)} (${formatPercent(sipPercent, 0)} of EMI)`,
            },
            {
              label: 'SIP tenure (matches loan completion)',
              value: formatTenure(sipMonths),
              highlight: true,
            },
            { label: 'Expected SIP return', value: `${formatPercent(sipRate)} p.a.` },
            { label: 'Total SIP invested', value: fc(sip.totalContributions) },
            { label: 'Wealth gained (returns)', value: fc(sip.interestEarned), highlight: true },
            {
              label: 'Return multiple',
              value: `${(sip.futureValue / sip.totalContributions || 0).toFixed(2)}×`,
            },
            {
              label: 'SIP duration detail',
              value:
                sipYearsPart || sipMonthsPart
                  ? `${sipYearsPart} year${sipYearsPart === 1 ? '' : 's'} ${sipMonthsPart} month${sipMonthsPart === 1 ? '' : 's'}`
                  : `${sipMonths} months`,
            },
          ]
        );
        sipResultEl.classList.add('sip-result-card');
      } else {
        hide(sipResultEl);
      }
    } catch (err) {
      renderError(resultEl, err.message);
      hide($('breakdownEmi'));
      hide($('resultEmiSip'));
    }
  });

  renderPrepayGrid();
}

function initAvgNeutral() {
  /** @type {{ id: number, qty: number, price: number }[]} */
  let lots = [];
  let lotId = 1;

  const lotBody = $('avgLotBody');
  const lotEmpty = $('avgLotEmpty');
  const lotTable = $('avgLotTable');

  function renderLotGrid() {
    if (!lotBody) return;

    if (lots.length === 0) {
      lotBody.innerHTML = '';
      lotEmpty?.classList.remove('hidden');
      lotTable?.classList.add('hidden');
      return;
    }

    lotEmpty?.classList.add('hidden');
    lotTable?.classList.remove('hidden');

    lotBody.innerHTML = lots
      .map(
        (lot) => `
      <tr data-id="${lot.id}">
        <td><input type="number" class="avg-qty" data-id="${lot.id}" min="1" step="1" value="${lot.qty}" aria-label="Quantity" /></td>
        <td><input type="number" class="avg-price" data-id="${lot.id}" min="0" step="0.05" value="${lot.price}" aria-label="Buy price" /></td>
        <td><button type="button" class="btn btn-danger btn-sm avg-delete" data-id="${lot.id}">Delete</button></td>
      </tr>`
      )
      .join('');

    lotBody.querySelectorAll('.avg-delete').forEach((btn) => {
      btn.addEventListener('click', () => {
        lots = lots.filter((l) => l.id !== Number(btn.dataset.id));
        renderLotGrid();
      });
    });
  }

  function syncLotsFromGrid() {
    lots = lots.map((lot) => {
      const row = lotBody.querySelector(`tr[data-id="${lot.id}"]`);
      if (!row) return lot;
      return {
        ...lot,
        qty: parseInput(row.querySelector('.avg-qty')?.value, lot.qty),
        price: parseInput(row.querySelector('.avg-price')?.value, lot.price),
      };
    });
  }

  $('avgAddLot')?.addEventListener('click', () => {
    lots.push({ id: lotId++, qty: 100, price: 200 });
    renderLotGrid();
  });

  // Default sample row
  lots.push({ id: lotId++, qty: 100, price: 200 });
  renderLotGrid();

  $('formAvgNeutral')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const resultEl = $('resultAvgNeutral');
    syncLotsFromGrid();

    try {
      const resistance = parseInput($('avgResistance').value);
      const currentPrice = parseInput($('avgCurrentPrice').value);
      const activeLots = lots.filter((l) => l.qty > 0);

      activeLots.forEach((l, i) => {
        validatePositive(l.qty, `Purchase ${i + 1} quantity`);
        validatePositive(l.price, `Purchase ${i + 1} buy price`);
      });
      validatePositive(currentPrice, 'Current price');

      const r = stockNeutralAtResistance({
        lots: activeLots,
        resistance,
        currentPrice,
      });

      if (r.status === 'already_neutral' || r.status === 'not_needed') {
        resultEl.innerHTML = `
          <h3>Current position</h3>
          <div class="result-hero">${fc(r.avgCost)}</div>
          <p class="hint">${r.message}</p>
          <div class="result-grid">
            <div class="result-item"><span>Total shares held</span><span>${formatNumber(r.totalShares, 0)}</span></div>
            <div class="result-item"><span>Total invested</span><span>${fc(r.totalCost)}</span></div>
            <div class="result-item"><span>Average buy price</span><span>${fc(r.avgCost)}</span></div>
            <div class="result-item"><span>Current price</span><span>${fc(r.currentPrice)}</span></div>
            <div class="result-item"><span>Resistance point</span><span>${fc(r.resistance)}</span></div>
          </div>`;
        show(resultEl);
        return;
      }

      renderResultCard(
        resultEl,
        'Shares to buy (neutral at resistance)',
        formatNumber(r.sharesNeeded, 0),
        [
          { label: 'Exact shares needed', value: formatNumber(r.exactSharesNeeded, 2) },
          { label: 'Investment at current price', value: fc(r.additionalInvestment), highlight: true },
          { label: 'Current price (buy at)', value: fc(r.currentPrice) },
          { label: 'Resistance (neutral at)', value: fc(r.resistance) },
          { label: 'Current shares held', value: formatNumber(r.totalShares, 0) },
          { label: 'Current average buy price', value: fc(r.avgCost) },
          { label: 'Current total invested', value: fc(r.totalCost) },
          { label: 'New total shares after buy', value: formatNumber(r.newTotalShares, 0) },
          { label: 'New average buy price', value: fc(r.newAverage) },
          {
            label: 'P&L at resistance (verify)',
            value: fc(r.pnlAtResistance),
            highlight: true,
          },
        ]
      );
    } catch (err) {
      renderError(resultEl, err.message);
    }
  });
}

function initPresent() {
  $('formPresent').addEventListener('submit', (e) => {
    e.preventDefault();
    const resultEl = $('resultPresent');
    try {
      const futureAmount = parseInput($('pvFuture').value);
      const annualRatePercent = parseInput($('pvRate').value);
      const years = parseInput($('pvYears').value);
      const frequency = $('pvFrequency').value;

      validatePositive(futureAmount, 'Future amount');
      validateRate(annualRatePercent);
      if (years <= 0) throw new Error('Time period must be greater than zero.');

      const r = presentValue({ futureAmount, annualRatePercent, years, frequency });

      renderResultCard(resultEl, 'Present value (invest today)', fc(r.presentValue), [
        { label: 'Future amount needed', value: fc(futureAmount) },
        { label: 'Discount / time value', value: fc(r.discount), highlight: true },
        { label: 'Return assumption', value: formatPercent(annualRatePercent) + ' p.a.' },
        { label: 'Years', value: formatNumber(years, 0) },
      ]);
    } catch (err) {
      renderError(resultEl, err.message);
    }
  });
}

function initMtf() {
  $('formMtf').addEventListener('submit', (e) => {
    e.preventDefault();
    const resultEl = $('resultMtf');
    const breakdownEl = $('breakdownMtf');
    try {
      const positionValue = parseInput($('mtfPosition').value);
      const ownCapital = parseInput($('mtfOwn').value);
      const dailyRatePercent = parseInput($('mtfRate').value);
      const holdingDays = Math.floor(parseInput($('mtfDays').value));

      validatePositive(positionValue, 'Stock value');
      validatePositive(ownCapital, 'Your own amount');
      validateRate(dailyRatePercent, 'Interest rate');
      if (ownCapital > positionValue) throw new Error('Your own amount cannot exceed the total stock value.');
      if (holdingDays < 1 || holdingDays > 365) throw new Error('Holding period must be between 1 and 365 days.');

      const r = mtfInterest({ positionValue, ownCapital, dailyRatePercent, holdingDays });

      renderResultCard(resultEl, 'Interest per day', fc(r.dailyInterest), [
        { label: 'Total stock value', value: fc(positionValue) },
        { label: 'Your own amount', value: fc(ownCapital) },
        { label: 'Broker-funded amount', value: fc(r.fundedAmount) },
        { label: 'Leverage', value: `${r.leverage.toFixed(2)}×` },
        { label: 'Interest rate', value: `${formatPercent(dailyRatePercent, 3)} per day (${formatPercent(r.annualRatePercent)} p.a.)` },
        { label: 'Interest for 30 days', value: fc(r.monthlyInterest) },
        { label: `Total interest for ${holdingDays} day${holdingDays === 1 ? '' : 's'}`, value: fc(r.totalInterest), highlight: true },
        { label: 'Price rise needed to break even', value: formatPercent(r.breakevenPercent, 2), highlight: true },
      ]);

      breakdownEl.innerHTML = `
        <h3>Day-by-day interest</h3>
        <div class="table-scroll table-scroll-daily">
          <table>
            <thead>
              <tr><th>Day</th><th>Interest for the day</th><th>Total interest so far</th></tr>
            </thead>
            <tbody>
              ${r.schedule
                .map((row) => `<tr><td>${row.day}</td><td>${fc(row.interest)}</td><td>${fc(row.cumulative)}</td></tr>`)
                .join('')}
            </tbody>
          </table>
        </div>
      `;
      show(breakdownEl);
    } catch (err) {
      renderError(resultEl, err.message);
      hide(breakdownEl);
    }
  });
}

function initMtfPnl() {
  let lots = [
    { id: 1, quantity: 5, price: 11205, days: 56 },
    { id: 2, quantity: 5, price: 10626.3, days: 25 },
  ];
  let lotId = 3;
  const pnlClass = (v) => (v >= 0 ? 'pnl-profit' : 'pnl-loss');
  const pnl = (v, text) => `<span class="${pnlClass(v)}">${text}</span>`;
  const lotBody = $('mpLotBody');

  function syncLots() {
    lots = lots.map((lot) => {
      const row = lotBody.querySelector(`tr[data-id="${lot.id}"]`);
      if (!row) return lot;
      return {
        ...lot,
        quantity: parseInput(row.querySelector('.mp-qty').value, lot.quantity),
        price: parseInput(row.querySelector('.mp-price').value, lot.price),
        days: parseInput(row.querySelector('.mp-days').value, lot.days),
      };
    });
  }

  function renderLots() {
    lotBody.innerHTML = lots
      .map(
        (lot) => `
      <tr data-id="${lot.id}">
        <td><input type="number" class="mp-qty" min="1" step="1" value="${lot.quantity}" aria-label="Quantity" /></td>
        <td><input type="number" class="mp-price" min="0" step="0.05" value="${lot.price}" aria-label="Buy price" /></td>
        <td><input type="number" class="mp-days" min="1" step="1" value="${lot.days}" aria-label="Days held" /></td>
        <td><button type="button" class="btn btn-danger btn-sm mp-delete" data-id="${lot.id}" aria-label="Delete transaction">Delete</button></td>
      </tr>`
      )
      .join('');

    lotBody.querySelectorAll('.mp-delete').forEach((btn) => {
      btn.addEventListener('click', () => {
        syncLots();
        const id = Number(btn.dataset.id);
        lots = lots.filter((lot) => lot.id !== id);
        renderLots();
      });
    });
  }

  $('mpAddLot').addEventListener('click', () => {
    syncLots();
    lots.push({ id: lotId++, quantity: 1, price: 0, days: 1 });
    renderLots();
  });

  $('formMtfPnl').addEventListener('submit', (e) => {
    e.preventDefault();
    const resultEl = $('resultMtfPnl');
    const breakdownEl = $('breakdownMtfPnl');
    syncLots();
    try {
      const name = $('mpName').value.trim() || 'Position';
      const currentPrice = parseInput($('mpCmp').value);
      const leverage = parseInput($('mpLeverage').value);
      const dailyRatePercent = parseInput($('mpRate').value);

      validatePositive(currentPrice, 'Current price');
      validateRate(dailyRatePercent, 'Interest rate');
      if (leverage < 1) throw new Error('Leverage must be at least 1x.');
      if (lots.length === 0) throw new Error('Add at least one buy transaction.');
      lots.forEach((lot, i) => {
        validatePositive(lot.quantity, `Transaction ${i + 1} quantity`);
        validatePositive(lot.price, `Transaction ${i + 1} buy price`);
        if (Math.floor(lot.days) < 1) throw new Error(`Transaction ${i + 1}: days held must be at least 1.`);
      });

      const { rows, total } = mtfLotsPnl({
        lots: lots.map((lot) => ({ quantity: lot.quantity, price: lot.price, days: Math.floor(lot.days) })),
        currentPrice,
        leverage,
        dailyRatePercent,
      });

      const label = total.netPnl >= 0 ? 'Net profit' : 'Net loss';
      const escapedName = name.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

      renderResultCard(
        resultEl,
        `${escapedName} — total ${label.toLowerCase()} after interest`,
        pnl(total.netPnl, `${fc(total.netPnl)} (${formatPercent(total.netPercentOnCapital, 2)})`),
        [
          { label: 'Total shares', value: formatNumber(total.quantity, 0) },
          { label: 'Average buy price', value: fc(total.avgPrice) },
          { label: 'Total buy value', value: fc(total.buyValue) },
          { label: 'Your own amount', value: fc(total.ownCapital) },
          { label: 'Broker-funded amount', value: fc(total.fundedAmount) },
          { label: 'Interest per day (all transactions)', value: fc(total.dailyInterest) },
          { label: 'Total interest paid', value: fc(total.interest), highlight: true },
          { label: 'Profit / loss before interest', value: pnl(total.grossPnl, `${fc(total.grossPnl)} (${formatPercent(total.grossPercentOnCapital, 2)} on your amount)`) },
          { label: `${label} after interest`, value: pnl(total.netPnl, `${fc(total.netPnl)} (${formatPercent(total.netPercentOnCapital, 2)} on your amount)`), highlight: true },
          { label: 'Before interest, % of buy value', value: pnl(total.grossPnl, formatPercent(total.grossPercentOnBuyValue, 2)) },
          { label: 'After interest, % of buy value', value: pnl(total.netPnl, formatPercent(total.netPercentOnBuyValue, 2)) },
        ]
      );

      breakdownEl.innerHTML = `
        <h3>Per transaction</h3>
        <div class="table-scroll table-scroll-daily">
          <table>
            <thead>
              <tr>
                <th>Qty</th><th>Buy price</th><th>Days</th><th>Buy value</th><th>Own amount</th>
                <th>Interest</th><th>P&amp;L before interest</th><th>P&amp;L after interest</th><th>After interest %</th>
              </tr>
            </thead>
            <tbody>
              ${rows
                .map(
                  (row) => `
                <tr>
                  <td>${formatNumber(row.quantity, 0)}</td>
                  <td>${fc(row.price)}</td>
                  <td>${row.days}</td>
                  <td>${fc(row.buyValue)}</td>
                  <td>${fc(row.ownCapital)}</td>
                  <td>${fc(row.interest)}</td>
                  <td class="${pnlClass(row.grossPnl)}">${fc(row.grossPnl)}</td>
                  <td class="${pnlClass(row.netPnl)}">${fc(row.netPnl)}</td>
                  <td class="${pnlClass(row.netPnl)}">${formatPercent(row.netPercentOnCapital, 2)}</td>
                </tr>`
                )
                .join('')}
              <tr>
                <td><strong>${formatNumber(total.quantity, 0)}</strong></td>
                <td><strong>${fc(total.avgPrice)}</strong></td>
                <td></td>
                <td><strong>${fc(total.buyValue)}</strong></td>
                <td><strong>${fc(total.ownCapital)}</strong></td>
                <td><strong>${fc(total.interest)}</strong></td>
                <td class="${pnlClass(total.grossPnl)}"><strong>${fc(total.grossPnl)}</strong></td>
                <td class="${pnlClass(total.netPnl)}"><strong>${fc(total.netPnl)}</strong></td>
                <td class="${pnlClass(total.netPnl)}"><strong>${formatPercent(total.netPercentOnCapital, 2)}</strong></td>
              </tr>
            </tbody>
          </table>
        </div>
      `;
      show(breakdownEl);
    } catch (err) {
      renderError(resultEl, err.message);
      hide(breakdownEl);
    }
  });

  renderLots();
}

function runInitialCalculations() {
  $('formCompound').requestSubmit();
  $('formGoal').requestSubmit();
  $('formSimple').requestSubmit();
  $('formEmi').requestSubmit();
  $('formMtf').requestSubmit();
  $('formMtfPnl').requestSubmit();
}

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initCompound();
  initGoal();
  initSip();
  initSimple();
  initEmi();
  initAvgNeutral();
  initPresent();
  initMtf();
  initMtfPnl();
  runInitialCalculations();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
