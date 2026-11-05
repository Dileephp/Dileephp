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
import { aggregateBars, fundScan } from './indicators.js';

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

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
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

// Address of the deployed Chartink proxy (see worker/README.md). Users can also paste it into the page.
const DEFAULT_CHARTINK_PROXY = 'https://chartink-proxy.dileephp.workers.dev';
const PROXY_STORAGE_KEY = 'chartinkProxyUrl';

function readStoredProxy() {
  try {
    return localStorage.getItem(PROXY_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function storeProxy(value) {
  try {
    localStorage.setItem(PROXY_STORAGE_KEY, value);
  } catch {
    // Storage can be blocked (private mode); the address just won't be remembered.
  }
}

function initScreener() {
  const matchesEl = $('screenerMatches');
  const resultsEl = $('screenerResults');
  const proxyInput = $('scProxy');
  proxyInput.value = readStoredProxy() || DEFAULT_CHARTINK_PROXY;

  let stocks = [];
  let screenerName = '';
  let screenerSlug = '';
  let sortKey = 'sr';
  let sortDir = 1;
  let filterText = '';

  function proxyBase() {
    const base = proxyInput.value.trim().replace(/\/+$/, '');
    if (!base) throw new Error('Paste your proxy server address first (see "Proxy server address" above).');
    if (!/^https?:\/\//i.test(base)) throw new Error('The proxy address must start with https://');
    storeProxy(base);
    return base;
  }

  async function callProxy(path) {
    let response;
    try {
      response = await fetch(`${proxyBase()}${path}`);
    } catch (err) {
      if (err instanceof TypeError) {
        throw new Error('Could not reach the proxy. Check the address and your internet connection.');
      }
      throw err;
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Proxy error (${response.status}).`);
    return body;
  }

  function renderStocks() {
    const needle = filterText.trim().toLowerCase();
    const visible = stocks
      .filter((s) => !needle || `${s.nsecode} ${s.name}`.toLowerCase().includes(needle))
      .sort((a, b) => {
        const x = a[sortKey];
        const y = b[sortKey];
        const cmp = typeof x === 'string' ? x.localeCompare(y) : (x ?? 0) - (y ?? 0);
        return cmp * sortDir;
      });

    const gainers = stocks.filter((s) => s.per_chg > 0).length;
    const losers = stocks.filter((s) => s.per_chg < 0).length;
    const arrow = (key) => (sortKey === key ? (sortDir === 1 ? ' ▲' : ' ▼') : '');
    const header = (key, label) =>
      `<th><button type="button" class="sort-btn" data-sort="${key}">${label}${arrow(key)}</button></th>`;

    resultsEl.innerHTML = `
      <h3>${escapeHtml(screenerName)}</h3>
      <p class="hint screener-summary">
        ${stocks.length} stock${stocks.length === 1 ? '' : 's'} ·
        <span class="pnl-profit">${gainers} up</span> ·
        <span class="pnl-loss">${losers} down</span> ·
        <a href="https://chartink.com/screener/${encodeURIComponent(screenerSlug)}" target="_blank" rel="noopener">Open on Chartink</a>
      </p>
      <div class="field screener-filter">
        <input id="scFilter" type="search" placeholder="Filter by symbol or company" value="${escapeHtml(filterText)}" aria-label="Filter stocks" />
      </div>
      ${
        stocks.length === 0
          ? '<p class="hint">No stocks match this screener right now. Results depend on live market data, so try again during market hours.</p>'
          : `<div class="table-scroll table-scroll-daily">
        <table>
          <thead>
            <tr>
              ${header('sr', '#')}${header('nsecode', 'Symbol')}${header('name', 'Company')}
              ${header('per_chg', 'Change %')}${header('close', 'Price')}${header('volume', 'Volume')}
            </tr>
          </thead>
          <tbody>
            ${visible
              .map(
                (s) => `
              <tr>
                <td>${s.sr}</td>
                <td><a href="https://chartink.com/stocks/${encodeURIComponent(s.nsecode)}.html" target="_blank" rel="noopener"><strong>${escapeHtml(s.nsecode)}</strong></a></td>
                <td>${escapeHtml(s.name)}</td>
                <td class="${s.per_chg >= 0 ? 'pnl-profit' : 'pnl-loss'}">${s.per_chg > 0 ? '+' : ''}${formatNumber(s.per_chg, 2)}%</td>
                <td>${fc(s.close)}</td>
                <td>${formatNumber(s.volume, 0)}</td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>`
      }
    `;
    show(resultsEl);

    resultsEl.querySelectorAll('.sort-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.sort;
        sortDir = sortKey === key ? -sortDir : key === 'per_chg' || key === 'volume' ? -1 : 1;
        sortKey = key;
        renderStocks();
      });
    });

    const filterInput = $('scFilter');
    filterInput.addEventListener('input', () => {
      filterText = filterInput.value;
      renderStocks();
      const refocus = $('scFilter');
      refocus.focus();
      refocus.setSelectionRange(filterText.length, filterText.length);
    });
  }

  async function runScreener(slug, name) {
    renderResultCard(matchesEl, 'Loading…', '', [{ label: 'Screener', value: escapeHtml(name) }]);
    hide(resultsEl);
    try {
      const data = await callProxy(`/run?slug=${encodeURIComponent(slug)}`);
      stocks = data.stocks;
      screenerName = data.name;
      screenerSlug = data.slug;
      sortKey = 'sr';
      sortDir = 1;
      filterText = '';
      hide(matchesEl);
      renderStocks();
    } catch (err) {
      renderError(matchesEl, escapeHtml(err.message));
      hide(resultsEl);
    }
  }

  function renderMatches(screeners, term) {
    matchesEl.innerHTML = `
      <h3>${screeners.length} screener${screeners.length === 1 ? '' : 's'} found</h3>
      <p class="hint">Choose one to see its stocks.</p>
      <div class="screener-list">
        ${screeners
          .map(
            (s, i) => `
          <button type="button" class="screener-option" data-index="${i}">
            <span>${escapeHtml(s.name)}</span>
            <small>Updated ${escapeHtml(String(s.updatedAt || '').slice(0, 10))}</small>
          </button>`
          )
          .join('')}
      </div>
    `;
    show(matchesEl);
    matchesEl.querySelectorAll('.screener-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        const s = screeners[Number(btn.dataset.index)];
        runScreener(s.slug, s.name);
      });
    });

    const exact = screeners.filter((s) => s.name.trim().toLowerCase() === term.toLowerCase());
    if (exact.length === 1 || screeners.length === 1) {
      const only = exact[0] || screeners[0];
      runScreener(only.slug, only.name);
    }
  }

  $('formScreener').addEventListener('submit', async (e) => {
    e.preventDefault();
    const term = $('scName').value.trim();
    hide(resultsEl);
    try {
      if (!term) throw new Error('Enter a screener name.');
      renderResultCard(matchesEl, 'Searching…', '', [{ label: 'Screener', value: escapeHtml(term) }]);
      const data = await callProxy(`/search?q=${encodeURIComponent(term)}`);
      if (data.screeners.length === 0) {
        throw new Error('No public screener found with that name. Try fewer or different words.');
      }
      renderMatches(data.screeners, term);
    } catch (err) {
      renderError(matchesEl, escapeHtml(err.message));
    }
  });
}

// ---- Fund Holdings Scan: a fund's stocks checked against a 3-hour candle setup ----

const FUND_SCAN_RULES = [
  { key: 'redCandle', label: 'Prev C &lt; O' },
  { key: 'belowSupertrend', label: 'Prev C &lt; ST' },
  { key: 'aboveEma', label: 'Prev C &gt; EMA9' },
  { key: 'highCrossed', label: 'High ↑ prev' },
];

async function fundProxy(path) {
  const base = ($('scProxy').value.trim() || readStoredProxy() || DEFAULT_CHARTINK_PROXY).replace(/\/+$/, '');
  if (!base) throw new Error('Paste your proxy server address first (Chartink Screener tab → "Proxy server address").');
  if (!/^https?:\/\//i.test(base)) throw new Error('The proxy address must start with https://');
  let response;
  try {
    response = await fetch(`${base}${path}`);
  } catch (err) {
    if (err instanceof TypeError) throw new Error('Could not reach the proxy. Check the address and your internet connection.');
    throw err;
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Proxy error (${response.status}).`);
  return body;
}

async function readFundNamesFromFile(file) {
  if (typeof XLSX === 'undefined') throw new Error('The Excel reader did not load. Check your internet connection.');
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
  const names = rows.map((r) => String(r?.[0] ?? '').trim()).filter(Boolean);
  if (names.length && /^(fund|scheme|fund name|scheme name|name)$/i.test(names[0])) names.shift();
  return [...new Set(names)].slice(0, 20);
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function initFundScan() {
  const statusEl = $('fundScanStatus');
  const resultsEl = $('fundScanResults');
  const candleCache = new Map();
  const funds = [];
  let running = false;

  function setStatus(title, lines) {
    renderResultCard(statusEl, title, '', lines.map(([label, value]) => ({ label, value })));
  }

  async function scanHolding(h) {
    const key = h.searchId || `name:${h.name}`;
    if (!candleCache.has(key)) {
      const q = h.searchId ? `sid=${encodeURIComponent(h.searchId)}&name=${encodeURIComponent(h.name)}` : `name=${encodeURIComponent(h.name)}`;
      candleCache.set(key, fundProxy(`/candles?${q}`).catch((err) => ({ error: err.message })));
    }
    const data = await candleCache.get(key);
    if (data.error) return { ...h, error: data.error };
    const scan = fundScan(aggregateBars(data.bars, 3));
    return { ...h, symbol: data.symbol, exchange: data.exchange, ...scan };
  }

  function fundCardHtml(fund, index) {
    const scanned = fund.rows.filter((r) => !r.error);
    const matches = scanned.filter((r) => r.match);
    const visible = fund.showAll ? fund.rows : matches;
    const yes = (ok) => (ok ? '<span class="pnl-profit">✓</span>' : '<span class="pnl-loss">✗</span>');
    const when = (t) =>
      new Date(t * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    const latest = scanned.find((r) => r.current)?.current;
    const others = fund.otherMatches.length
      ? `<details class="fs-other"><summary>Not the right fund?</summary><div class="screener-list">${fund.otherMatches
          .map((f, i) => `<button type="button" class="screener-option" data-fund="${index}" data-alt="${i}"><span>${escapeHtml(f.name)}</span></button>`)
          .join('')}</div></details>`
      : '';

    const row = (r) => {
      const link = r.symbol
        ? `<a href="https://www.tradingview.com/chart/?symbol=${encodeURIComponent(`${r.exchange}:${r.symbol}`)}&interval=180" target="_blank" rel="noopener"><strong>${escapeHtml(r.symbol)}</strong></a>`
        : '—';
      const side =
        r.weight < 0
          ? ' <small class="pnl-loss">short</small>'
          : r.instrument !== 'Equity'
            ? ` <small>${escapeHtml(r.instrument)}</small>`
            : '';
      if (r.error) {
        return `<tr class="fs-muted"><td>${link}</td><td>${escapeHtml(r.name)}${side}</td><td>${formatNumber(r.weight, 2)}%</td><td colspan="9">${escapeHtml(r.error)}</td></tr>`;
      }
      return `<tr${r.match ? ' class="fs-match"' : ''}>
        <td>${link}</td><td>${escapeHtml(r.name)}${side}</td><td>${formatNumber(r.weight, 2)}%</td>
        <td>${formatNumber(r.previous.o, 2)} / ${formatNumber(r.previous.c, 2)}</td>
        <td>${formatNumber(r.prevEma, 2)}</td><td>${formatNumber(r.prevSupertrend, 2)}</td>
        <td>${formatNumber(r.previous.h, 2)} → ${formatNumber(r.current.h, 2)}</td>
        ${FUND_SCAN_RULES.map((rule) => `<td class="fs-check">${yes(r.checks[rule.key])}</td>`).join('')}
        <td class="fs-check">${r.match ? '<strong class="pnl-profit">Yes</strong>' : '—'}</td>
      </tr>`;
    };
    const order = (a, b) =>
      (b.match ? 1 : 0) - (a.match ? 1 : 0) || (a.error ? 1 : 0) - (b.error ? 1 : 0) || b.weight - a.weight;

    return `<div class="card table-card fs-fund">
      <h3>${escapeHtml(fund.name)}</h3>
      <p class="hint screener-summary">
        Portfolio as of ${escapeHtml(String(fund.portfolioDate || '').slice(0, 10) || 'unknown')} ·
        ${fund.rows.length} stock holdings · ${scanned.length} scanned ·
        <strong class="${matches.length ? 'pnl-profit' : ''}">${matches.length} match${matches.length === 1 ? '' : 'es'}</strong>
        ${latest ? ` · current 3h candle starts ${escapeHtml(when(latest.t))} IST` : ''}
      </p>
      ${others}
      <label class="fs-toggle"><input type="checkbox" data-showall="${index}" ${fund.showAll ? 'checked' : ''}/> Show all holdings</label>
      ${
        visible.length === 0
          ? '<p class="hint">No holding meets all four conditions on the latest 3-hour candle. Tick "Show all holdings" to see how close each one is.</p>'
          : `<div class="table-scroll table-scroll-daily"><table>
        <thead><tr>
          <th>Symbol</th><th>Company</th><th>Weight</th><th>Prev O / C</th><th>Prev EMA 9</th><th>Prev ST (100,3)</th><th>High prev → now</th>
          ${FUND_SCAN_RULES.map((r) => `<th>${r.label}</th>`).join('')}<th>Match</th>
        </tr></thead>
        <tbody>${[...visible].sort(order).map(row).join('')}</tbody>
      </table></div>`
      }
    </div>`;
  }

  function render() {
    resultsEl.innerHTML = funds.map(fundCardHtml).join('');
    resultsEl.querySelectorAll('[data-showall]').forEach((box) => {
      box.addEventListener('change', () => {
        funds[Number(box.dataset.showall)].showAll = box.checked;
        render();
      });
    });
    resultsEl.querySelectorAll('[data-alt]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const fund = funds[Number(btn.dataset.fund)];
        runScan([{ pick: fund.otherMatches[Number(btn.dataset.alt)] }]);
      });
    });
  }

  async function scanFund(job, n, total) {
    const prefix = total > 1 ? `Fund ${n} of ${total}` : 'Fund';
    let picked = job.pick;
    let otherMatches = [];
    if (!picked) {
      setStatus('Searching…', [[prefix, escapeHtml(job.term)]]);
      const { funds: found } = await fundProxy(`/fund/search?q=${encodeURIComponent(job.term)}`);
      if (!found.length) throw new Error('No fund found with that name.');
      [picked, ...otherMatches] = found;
    }
    setStatus('Loading holdings…', [[prefix, escapeHtml(picked.name)]]);
    const fund = await fundProxy(`/fund/holdings?id=${encodeURIComponent(picked.id)}`);
    let done = 0;
    const rows = await mapLimit(fund.holdings, 4, async (h) => {
      const result = await scanHolding(h);
      done += 1;
      setStatus('Scanning stocks…', [
        [prefix, escapeHtml(fund.name)],
        ['Progress', `${done} of ${fund.holdings.length}`],
      ]);
      return result;
    });
    return { ...fund, rows, otherMatches, showAll: false };
  }

  async function runScan(jobs) {
    if (running) return;
    running = true;
    funds.length = 0;
    resultsEl.innerHTML = '';
    const errors = [];
    try {
      for (let i = 0; i < jobs.length; i++) {
        try {
          funds.push(await scanFund(jobs[i], i + 1, jobs.length));
          render();
        } catch (err) {
          errors.push(`${escapeHtml(jobs[i].term || jobs[i].pick?.name || '')}: ${escapeHtml(err.message)}`);
        }
      }
      if (errors.length && !funds.length) {
        renderError(statusEl, errors.join('<br>'));
      } else {
        const total = funds.reduce((sum, f) => sum + f.rows.filter((r) => r.match).length, 0);
        setStatus(`${total} stock${total === 1 ? '' : 's'} match`, [
          ['Funds scanned', String(funds.length)],
          ...errors.map((e) => ['Skipped', e]),
        ]);
      }
    } finally {
      running = false;
    }
  }

  $('formFundScan').addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = $('fsFile').files[0];
    try {
      const names = file ? await readFundNamesFromFile(file) : [$('fsName').value.trim()].filter(Boolean);
      if (!names.length) throw new Error(file ? 'No fund names found in the first column of that file.' : 'Enter a fund name.');
      await runScan(names.map((term) => ({ term })));
    } catch (err) {
      renderError(statusEl, escapeHtml(err.message));
    }
  });
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
  initScreener();
  initFundScan();
  runInitialCalculations();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
