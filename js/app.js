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
import { aggregateBars, groupByPeriod, evaluateRules, DEFAULT_RULES, RULE_OPERATORS } from './indicators.js';

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

// ---- Fund Holdings Scan: a fund's stocks checked against conditions the user edits ----

const RULE_STORAGE_KEY = 'fundScanRules';
const SAVED_SCANS_KEY = 'fundScanSaved';
const MAX_SAVED_SCANS = 50;
const MAX_RULES = 10;
const RULE_BARS = ['Current', 'Previous', '2 candles ago'];
const RULE_KINDS = {
  open: 'Open',
  high: 'High',
  low: 'Low',
  close: 'Close',
  ema: 'EMA',
  sma: 'SMA',
  supertrend: 'Supertrend',
  value: 'Number',
};
const KIND_DEFAULTS = { ema: { p1: 9 }, sma: { p1: 20 }, supertrend: { p1: 100, p2: 3 }, value: { value: 0 } };

function operandLabel(o) {
  if (o.kind === 'value') return formatNumber(o.value, 2);
  const what =
    o.kind === 'ema'
      ? `EMA ${o.p1}`
      : o.kind === 'sma'
        ? `SMA ${o.p1}`
        : o.kind === 'supertrend'
          ? `Supertrend (${o.p1}, ${o.p2})`
          : RULE_KINDS[o.kind].toLowerCase();
  return `${RULE_BARS[o.bar].toLowerCase()} ${what}`;
}

function ruleLabel(rule) {
  const text = `${operandLabel(rule.left)} ${RULE_OPERATORS[rule.op]} ${operandLabel(rule.right)}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Checks one operand from storage or the editor; returns a clean copy or throws a readable error. */
function cleanOperand(o, where) {
  if (!o || !RULE_KINDS[o.kind]) throw new Error(`${where}: choose a value.`);
  const bar = Number(o.bar);
  if (![0, 1, 2].includes(bar)) throw new Error(`${where}: choose a candle.`);
  if (o.kind === 'value') {
    const value = Number(o.value);
    if (o.value === '' || !Number.isFinite(value)) throw new Error(`${where}: enter a number.`);
    return { bar: 0, kind: 'value', value };
  }
  const out = { bar, kind: o.kind };
  if (['ema', 'sma', 'supertrend'].includes(o.kind)) {
    const p1 = Number(o.p1);
    if (!Number.isInteger(p1) || p1 < 1 || p1 > 300) throw new Error(`${where}: the period must be a whole number from 1 to 300.`);
    out.p1 = p1;
  }
  if (o.kind === 'supertrend') {
    const p2 = Number(o.p2);
    if (!Number.isFinite(p2) || p2 <= 0 || p2 > 20) throw new Error(`${where}: the multiplier must be above 0 and at most 20.`);
    out.p2 = p2;
  }
  return out;
}

function cleanRules(rules) {
  if (!Array.isArray(rules) || rules.length === 0) throw new Error('Add at least one condition.');
  if (rules.length > MAX_RULES) throw new Error(`Use at most ${MAX_RULES} conditions.`);
  return rules.map((rule, i) => {
    const where = `Condition ${i + 1}`;
    if (!RULE_OPERATORS[rule?.op]) throw new Error(`${where}: choose a comparison.`);
    const left = cleanOperand(rule.left, where);
    const right = cleanOperand(rule.right, where);
    if (left.kind === 'value' && right.kind === 'value') throw new Error(`${where}: compare a price or indicator, not two numbers.`);
    return { left, op: rule.op, right };
  });
}

// ---- Screeners: up to 3 groups of conditions. A row matches a group when all its conditions are true,
// and is listed when it matches any group (Screener 1 OR 2 OR 3). ----

const MAX_SCREENERS = 3;
const NEW_SCREENER_RULES = [{ left: { bar: 0, kind: 'close' }, op: 'gt', right: { bar: 0, kind: 'ema', p1: 9 } }];

/** Checks a list of screeners (or an older single list of conditions); returns clean copies or throws. */
function cleanScreeners(list) {
  if (Array.isArray(list) && list.length && !Array.isArray(list[0])) list = [list];
  if (!Array.isArray(list) || !list.length) throw new Error('Add at least one screener.');
  if (list.length > MAX_SCREENERS) throw new Error(`Use at most ${MAX_SCREENERS} screeners.`);
  return list.map((rules, i) => {
    try {
      return cleanRules(rules);
    } catch (err) {
      throw new Error(list.length > 1 ? `Screener ${i + 1}, ${err.message.charAt(0).toLowerCase()}${err.message.slice(1)}` : err.message);
    }
  });
}

function loadScreeners(key = RULE_STORAGE_KEY) {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (saved) return cleanScreeners(saved);
  } catch {
    // Missing, blocked or outdated storage: fall back to the default conditions.
  }
  return [structuredClone(DEFAULT_RULES)];
}

function storeScreeners(screeners, key = RULE_STORAGE_KEY) {
  try {
    localStorage.setItem(key, JSON.stringify(screeners));
  } catch {
    // Storage can be blocked (private mode); the screeners just won't be remembered.
  }
}

/**
 * Checks every screener on the candles.
 * Returns { groups: [evaluateRules result per screener], matched: [screener indexes], match, current } or { error }.
 * A screener that cannot be checked (too little history) counts as not matching.
 */
function evaluateScreeners(candles, screeners) {
  const groups = screeners.map((rules) => evaluateRules(candles, rules));
  const checked = groups.filter((g) => !g.error);
  if (!checked.length) return { error: groups[0].error };
  const matched = groups.flatMap((g, i) => (!g.error && g.match ? [i] : []));
  return { groups, matched, match: matched.length > 0, current: checked[0].current };
}

/** True when a row should be listed for the chosen filter ('any' or a screener index). */
function rowPasses(r, filter = 'any') {
  if (r.error) return false;
  return filter === 'any' ? r.match : r.matched.includes(Number(filter));
}

const checkMark = (ok) => (ok ? '<span class="pnl-profit">✓</span>' : '<span class="pnl-loss">✗</span>');

/** Table header cells for every condition of every screener, plus the Match column. */
function screenerHeadHtml(screeners) {
  const multi = screeners.length > 1;
  return (
    screeners
      .map(
        (rules, g) =>
          rules.map((rule, i) => `<th title="${escapeHtml(ruleLabel(rule))}">${multi ? `S${g + 1}·${i + 1}` : `#${i + 1}`}</th>`).join('') +
          (multi ? `<th title="All conditions of Screener ${g + 1}">S${g + 1}</th>` : '')
      )
      .join('') + '<th>Match</th>'
  );
}

function screenerColumnCount(screeners) {
  return screeners.reduce((n, rules) => n + rules.length + (screeners.length > 1 ? 1 : 0), 0) + 1;
}

/** Result cells for one scanned row (see screenerHeadHtml). */
function screenerCellsHtml(r, screeners) {
  const multi = screeners.length > 1;
  const num = (v) => (v === null ? '—' : formatNumber(v, 2));
  const groups = r.groups
    .map((g, gi) => {
      const rules = screeners[gi];
      if (g.error) return `<td colspan="${rules.length + (multi ? 1 : 0)}" class="fs-skip"><small>${escapeHtml(g.error)}</small></td>`;
      return (
        g.results
          .map((res, i) => `<td class="fs-check" title="${escapeHtml(ruleLabel(rules[i]))}">${checkMark(res.ok)}<small class="fs-vals">${num(res.left)} vs ${num(res.right)}</small></td>`)
          .join('') + (multi ? `<td class="fs-check">${g.match ? '<strong class="pnl-profit">✓</strong>' : '—'}</td>` : '')
      );
    })
    .join('');
  const label = multi ? r.matched.map((i) => `S${i + 1}`).join(', ') : 'Yes';
  return `${groups}<td class="fs-check">${r.match ? `<strong class="pnl-profit">${label}</strong>` : '—'}</td>`;
}

/** The screeners written out above a results table. */
function screenerListHtml(screeners) {
  const list = (rules) => `<ol class="hint fs-rules">${rules.map((rule) => `<li>${escapeHtml(ruleLabel(rule))}</li>`).join('')}</ol>`;
  if (screeners.length === 1) return list(screeners[0]);
  return `<div class="fs-screener-list">${screeners
    .map((rules, g) => `<div class="hint"><strong>Screener ${g + 1}</strong>${g ? ' <small>(or)</small>' : ''}${list(rules)}</div>`)
    .join('')}</div>`;
}

/** "Show: Any screener / Screener 1 / …" for a results table; empty with a single screener. */
function screenerFilterHtml(screeners, attr, value) {
  if (screeners.length === 1) return '';
  const options = ['any', ...screeners.map((_, i) => String(i))]
    .map((v) => `<option value="${v}"${String(value) === v ? ' selected' : ''}>${v === 'any' ? 'Any screener' : `Screener ${Number(v) + 1}`}</option>`)
    .join('');
  return `<label class="fs-toggle fs-filter">Show matches of <select ${attr}>${options}</select></label>`;
}

function noMatchText(screeners, filter, what, tfLabel) {
  if (screeners.length > 1) {
    const which = filter === 'any' ? 'any screener' : `Screener ${Number(filter) + 1}`;
    return `No ${what} matches ${which} on the latest ${tfLabel} candle.`;
  }
  const n = screeners[0].length;
  return `No ${what} meets ${n === 1 ? 'the condition' : `all ${n} conditions`} on the latest ${tfLabel} candle.`;
}

// Candle sizes for the scan. `series` is what the proxy fetches (hourly or daily bars); the page groups them.
const FUND_SCAN_TIMEFRAMES = {
  '1h': { label: '1-hour', series: 'hour', build: (bars) => aggregateBars(bars, 1), tv: '60' },
  '2h': { label: '2-hour', series: 'hour', build: (bars) => aggregateBars(bars, 2), tv: '120' },
  '3h': { label: '3-hour', series: 'hour', build: (bars) => aggregateBars(bars, 3), tv: '180' },
  '4h': { label: '4-hour', series: 'hour', build: (bars) => aggregateBars(bars, 4), tv: '240' },
  '1d': { label: 'daily', series: 'day', build: (bars) => bars, tv: 'D' },
  '1w': { label: 'weekly', series: 'week', build: (bars) => groupByPeriod(bars, 'week'), tv: 'W' },
  '1M': { label: 'monthly', series: 'month', build: (bars) => groupByPeriod(bars, 'month'), tv: 'M' },
};

// The address typed or saved on this device is tried first; if it cannot be reached (an old or local address),
// the built-in address is tried next, and the one that answered is used for the rest of the session.
let workingProxy = '';

async function fundProxy(path) {
  const chosen = ($('scProxy').value.trim() || readStoredProxy()).replace(/\/+$/, '');
  const candidates = [...new Set([workingProxy, chosen, DEFAULT_CHARTINK_PROXY].filter((b) => /^https?:\/\//i.test(b)))];
  if (!candidates.length) throw new Error('Paste your proxy server address first (Chartink Screener tab → "Proxy server address").');

  const unreachable = [];
  for (const base of candidates) {
    let response;
    try {
      response = await fetch(`${base}${path}`);
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
      unreachable.push(base);
      continue;
    }
    workingProxy = base;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Proxy error (${response.status}).`);
    return body;
  }
  throw new Error(
    `Could not reach the proxy (${unreachable.join(', ')}). Check your internet connection; ` +
      'if it works on Wi-Fi but not mobile data, your mobile network may be blocking it.'
  );
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

/** A condition editor (rows of "value  comparison  value") inside rulesEl; raw() reads it as typed. */
function createRuleEditor({ rulesEl, addBtn, resetBtn, initialRules }) {
  let editorRules = initialRules;

  function operandHtml(o, side) {
    const isValue = o.kind === 'value';
    const hasPeriod = ['ema', 'sma', 'supertrend'].includes(o.kind);
    const opt = (value, label, selected) => `<option value="${value}"${selected ? ' selected' : ''}>${label}</option>`;
    return `<span class="fs-operand" data-side="${side}">
      <select data-f="bar" aria-label="Candle"${isValue ? ' hidden' : ''}>${RULE_BARS.map((b, i) => opt(i, b, Number(o.bar) === i)).join('')}</select>
      <select data-f="kind" aria-label="Value">${Object.entries(RULE_KINDS).map(([k, label]) => opt(k, label, o.kind === k)).join('')}</select>
      <input data-f="p1" type="number" min="1" max="300" step="1" value="${escapeHtml(o.p1 ?? '')}" aria-label="Period" title="Period"${hasPeriod ? '' : ' hidden'} />
      <input data-f="p2" type="number" min="0.1" max="20" step="0.1" value="${escapeHtml(o.p2 ?? '')}" aria-label="Multiplier" title="Multiplier"${o.kind === 'supertrend' ? '' : ' hidden'} />
      <input data-f="value" type="number" step="any" value="${escapeHtml(o.value ?? '')}" aria-label="Number"${isValue ? '' : ' hidden'} />
    </span>`;
  }

  function renderRuleEditor() {
    rulesEl.innerHTML = editorRules
      .map(
        (rule, i) => `<div class="fs-rule" data-i="${i}">
        <span class="fs-rule-num">${i + 1}</span>
        ${operandHtml(rule.left, 'left')}
        <select data-f="op" aria-label="Comparison">${Object.entries(RULE_OPERATORS)
          .map(([k, label]) => `<option value="${k}"${rule.op === k ? ' selected' : ''}>${label}</option>`)
          .join('')}</select>
        ${operandHtml(rule.right, 'right')}
        <button type="button" class="fs-rule-remove" data-remove="${i}" aria-label="Remove condition ${i + 1}"${editorRules.length === 1 ? ' disabled' : ''}>✕</button>
      </div>`
      )
      .join('');
    addBtn.disabled = editorRules.length >= MAX_RULES;
  }

  /** Reads the editor as typed (not yet checked). */
  function readRuleEditor() {
    return [...rulesEl.querySelectorAll('.fs-rule')].map((row) => {
      const side = (name) => {
        const el = row.querySelector(`.fs-operand[data-side="${name}"]`);
        const field = (f) => el.querySelector(`[data-f="${f}"]`).value;
        return { bar: Number(field('bar')), kind: field('kind'), p1: field('p1'), p2: field('p2'), value: field('value') };
      };
      return { left: side('left'), op: row.querySelector('[data-f="op"]').value, right: side('right') };
    });
  }

  rulesEl.addEventListener('change', (e) => {
    if (e.target.dataset.f !== 'kind') return;
    editorRules = readRuleEditor();
    const row = Number(e.target.closest('.fs-rule').dataset.i);
    const side = e.target.closest('.fs-operand').dataset.side;
    Object.assign(editorRules[row][side], KIND_DEFAULTS[e.target.value] || {});
    renderRuleEditor();
  });

  rulesEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove]');
    if (!btn) return;
    editorRules = readRuleEditor();
    editorRules.splice(Number(btn.dataset.remove), 1);
    renderRuleEditor();
  });

  addBtn.addEventListener('click', () => {
    editorRules = readRuleEditor();
    editorRules.push({ left: { bar: 0, kind: 'close' }, op: 'gt', right: { bar: 0, kind: 'ema', p1: 9 } });
    renderRuleEditor();
  });

  resetBtn.addEventListener('click', () => {
    editorRules = structuredClone(DEFAULT_RULES);
    renderRuleEditor();
  });

  renderRuleEditor();

  return { raw: readRuleEditor };
}

/**
 * Up to 3 condition editors (Screener 1, 2, 3) inside containerEl, remembered on the device under storageKey.
 * raw() reads them as typed, set() fills them, commit() checks them, remembers them and returns clean screeners.
 */
function createScreenerEditor({ containerEl, addBtn, storageKey, initial = null }) {
  let screeners = initial || loadScreeners(storageKey);
  let editors = [];

  const readAll = () => editors.map((e) => e.raw());

  function render() {
    containerEl.innerHTML = screeners
      .map(
        (_, g) => `<div class="fs-screener" data-g="${g}">
        <div class="fs-screener-head">
          ${g ? '<span class="fs-screener-or">OR</span>' : ''}<strong>Screener ${g + 1}</strong>
          ${screeners.length > 1 ? `<button type="button" class="btn btn-secondary fs-screener-remove" data-remove-screener="${g}">Remove screener</button>` : ''}
        </div>
        <div class="fs-screener-rules"></div>
        <div class="fs-rule-actions">
          <button type="button" class="btn btn-secondary" data-add-rule>+ Add condition</button>
          <button type="button" class="btn btn-secondary" data-reset-rules>Reset to default</button>
        </div>
      </div>`
      )
      .join('');
    editors = screeners.map((rules, g) => {
      const el = containerEl.querySelector(`[data-g="${g}"]`);
      return createRuleEditor({
        rulesEl: el.querySelector('.fs-screener-rules'),
        addBtn: el.querySelector('[data-add-rule]'),
        resetBtn: el.querySelector('[data-reset-rules]'),
        initialRules: rules,
      });
    });
    addBtn.disabled = screeners.length >= MAX_SCREENERS;
  }

  containerEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-screener]');
    if (!btn) return;
    screeners = readAll();
    screeners.splice(Number(btn.dataset.removeScreener), 1);
    render();
  });

  addBtn.addEventListener('click', () => {
    screeners = readAll();
    if (screeners.length >= MAX_SCREENERS) return;
    screeners.push(structuredClone(NEW_SCREENER_RULES));
    render();
  });

  render();

  return {
    raw: readAll,
    set(list) {
      screeners = list;
      render();
    },
    commit() {
      const clean = cleanScreeners(readAll());
      screeners = clean;
      storeScreeners(clean, storageKey);
      return clean;
    },
  };
}

// ---- Fund picker shared by the Fund Holdings Scan and Common Stocks: tick funds from the SIF list and/or the
// top 200 list. Element ids are the prefix + ListType, Picker, PickFilter, PickAll, PickNone, PickList, PickCount. ----

const MAX_PICKED = 200;
let loadedFundLists = null;
let fundListsRequest = null;

/** Loads the SIF and top 200 lists once per page (shared by every picker). */
async function getFundLists() {
  if (loadedFundLists) return loadedFundLists;
  fundListsRequest ||= fundProxy('/fund/lists').finally(() => {
    fundListsRequest = null;
  });
  loadedFundLists = await fundListsRequest;
  return loadedFundLists;
}

function createFundPicker(prefix, { slowNote = false } = {}) {
  const el = (name) => $(`${prefix}${name}`);
  const picked = new Map(); // fund id -> name, kept across both lists

  function updatePickCount() {
    const n = picked.size;
    el('PickCount').textContent = n ? `${n} fund${n === 1 ? '' : 's'} ticked${slowNote && n > 20 ? ' (many funds can take several minutes)' : ''}.` : '';
  }

  function renderPickList() {
    const type = el('ListType').value;
    el('Picker').hidden = !type;
    if (!type) return;
    const listEl = el('PickList');
    const fundLists = loadedFundLists;
    if (!fundLists) {
      listEl.innerHTML = '<div class="fs-pick-empty">Loading…</div>';
      return;
    }
    const words = el('PickFilter').value.toLowerCase().split(/\s+/).filter(Boolean);
    if (!fundLists[type]?.length) {
      listEl.innerHTML = '<div class="fs-pick-empty">This list could not be loaded right now. Try again later.</div>';
      return;
    }
    const shown = fundLists[type]
      .map((f, i) => ({ ...f, rank: i + 1 }))
      .filter((f) => words.every((w) => f.name.toLowerCase().includes(w)));
    listEl.innerHTML = shown.length
      ? shown
          .map(
            (f) => `<label class="fs-pick-item"><input type="checkbox" data-pick="${escapeHtml(f.id)}"${picked.has(f.id) ? ' checked' : ''} />
            <span>${type === 'sif' ? '' : `${f.rank}. `}${escapeHtml(f.name)}<small>${escapeHtml(f.type)} · ₹${formatNumber(f.aum, 0)} Cr</small></span></label>`
          )
          .join('')
      : '<div class="fs-pick-empty">Nothing in this list matches that name.</div>';
  }

  function shownPickFunds() {
    const byId = new Map(Object.values(loadedFundLists || {}).flat().map((f) => [f.id, f]));
    return [...el('PickList').querySelectorAll('[data-pick]')].map((box) => byId.get(box.dataset.pick)).filter(Boolean);
  }

  el('ListType').addEventListener('change', async () => {
    renderPickList();
    if (!el('ListType').value || loadedFundLists) return;
    try {
      await getFundLists();
    } catch (err) {
      el('PickList').innerHTML = `<div class="fs-pick-empty">Could not load the list: ${escapeHtml(err.message)}</div>`;
      return;
    }
    renderPickList();
  });

  el('PickFilter').addEventListener('input', renderPickList);

  el('PickList').addEventListener('change', (e) => {
    const box = e.target.closest('[data-pick]');
    if (!box) return;
    const fund = shownPickFunds().find((f) => f.id === box.dataset.pick);
    if (box.checked && picked.size >= MAX_PICKED) {
      box.checked = false;
      el('PickCount').textContent = `You can tick up to ${MAX_PICKED} funds at a time.`;
      return;
    }
    if (box.checked && fund) picked.set(fund.id, fund.name);
    else picked.delete(box.dataset.pick);
    updatePickCount();
  });

  el('PickAll').addEventListener('click', () => {
    for (const f of shownPickFunds()) {
      if (picked.size >= MAX_PICKED) break;
      picked.set(f.id, f.name);
    }
    renderPickList();
    updatePickCount();
  });

  el('PickNone').addEventListener('click', () => {
    picked.clear();
    renderPickList();
    updatePickCount();
  });

  /** Puts ticked funds back (from a saved or shared scan). */
  function set(list) {
    picked.clear();
    if (Array.isArray(list)) {
      list
        .filter((f) => f && /^(etf:)?[a-z0-9-]{1,200}$/.test(f.id) && typeof f.name === 'string')
        .slice(0, MAX_PICKED)
        .forEach((f) => picked.set(f.id, f.name.slice(0, 150)));
    }
    renderPickList();
    updatePickCount();
  }

  return { picked, set, refresh: renderPickList };
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

  const ruleEditor = createScreenerEditor({ containerEl: $('fsScreeners'), addBtn: $('fsAddScreener'), storageKey: RULE_STORAGE_KEY });

  // ---- Fund picker: tick funds from the SIF list and/or the top 200 list ----
  const fundPicker = createFundPicker('fs', { slowNote: true });
  const picked = fundPicker.picked;
  const setPicked = (list) => fundPicker.set(list);

  // ---- Saved scans: name + conditions + timeframe + fund, kept on this device; "Copy link" shares one ----
  const savedEl = $('fsSaved');
  const savedMsgEl = $('fsSavedMsg');

  function loadSavedScans() {
    try {
      const list = JSON.parse(localStorage.getItem(SAVED_SCANS_KEY) || '[]');
      return Array.isArray(list) ? list.filter((s) => s && typeof s.name === 'string') : [];
    } catch {
      return [];
    }
  }

  function storeSavedScans(list) {
    try {
      localStorage.setItem(SAVED_SCANS_KEY, JSON.stringify(list));
      return true;
    } catch {
      return false;
    }
  }

  function renderSavedList(selected = '') {
    const list = loadSavedScans().sort((a, b) => a.name.localeCompare(b.name));
    savedEl.innerHTML =
      `<option value="">${list.length ? 'Choose a saved scan' : 'No saved scans yet'}</option>` +
      list.map((s) => `<option value="${escapeHtml(s.name)}"${s.name === selected ? ' selected' : ''}>${escapeHtml(s.name)}</option>`).join('');
    $('fsDeleteScan').disabled = !selected;
  }

  /** The scan as it is in the form now; throws if a condition is invalid. */
  function currentScan(name) {
    const screeners = cleanScreeners(ruleEditor.raw());
    return {
      name,
      screeners,
      rules: screeners[0], // read by older versions of the page
      timeframe: $('fsTimeframe').value,
      fund: $('fsName').value.trim().slice(0, 150),
      picks: [...picked].map(([id, name]) => ({ id, name })),
    };
  }

  /** Puts a scan into the form; throws if it is malformed. */
  function applyScan(scan) {
    ruleEditor.set(cleanScreeners(scan.screeners || scan.rules));
    if (FUND_SCAN_TIMEFRAMES[scan.timeframe]) $('fsTimeframe').value = scan.timeframe;
    if (typeof scan.fund === 'string' && scan.fund) $('fsName').value = scan.fund.slice(0, 150);
    setPicked(scan.picks);
  }

  function say(message) {
    savedMsgEl.textContent = message;
  }

  savedEl.addEventListener('change', () => {
    const scan = loadSavedScans().find((s) => s.name === savedEl.value);
    $('fsDeleteScan').disabled = !scan;
    if (!scan) return;
    try {
      applyScan(scan);
      say(`Loaded "${scan.name}".`);
    } catch (err) {
      say(`Could not load "${scan.name}": ${err.message}`);
    }
  });

  $('fsSaveScan').addEventListener('click', () => {
    let scan;
    try {
      scan = currentScan('');
    } catch (err) {
      say(err.message);
      return;
    }
    const name = (window.prompt('Name this scan', savedEl.value || '') || '').trim().slice(0, 60);
    if (!name) return;
    const list = loadSavedScans();
    const existing = list.findIndex((s) => s.name.toLowerCase() === name.toLowerCase());
    if (existing >= 0 && !window.confirm(`Replace the saved scan "${list[existing].name}"?`)) return;
    if (existing < 0 && list.length >= MAX_SAVED_SCANS) {
      say(`You can keep up to ${MAX_SAVED_SCANS} saved scans. Delete one first.`);
      return;
    }
    scan.name = existing >= 0 ? list[existing].name : name;
    if (existing >= 0) list[existing] = scan;
    else list.push(scan);
    if (!storeSavedScans(list)) {
      say('This browser is not allowing the page to save (private mode?). Use "Copy link" to keep the scan instead.');
      return;
    }
    renderSavedList(scan.name);
    say(`Saved "${scan.name}" on this device.`);
  });

  $('fsDeleteScan').addEventListener('click', () => {
    const name = savedEl.value;
    if (!name || !window.confirm(`Delete the saved scan "${name}"?`)) return;
    storeSavedScans(loadSavedScans().filter((s) => s.name !== name));
    renderSavedList();
    say(`Deleted "${name}".`);
  });

  $('fsShareScan').addEventListener('click', async () => {
    let link;
    try {
      const scan = currentScan(savedEl.value || 'Shared scan');
      const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(scan))))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      link = `${location.origin}${location.pathname}#scan=${encoded}`;
    } catch (err) {
      say(err.message);
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      say('Link copied. Open it on another device, or send it to someone, to load this scan.');
    } catch {
      window.prompt('Copy this link:', link);
    }
  });

  /** Loads a scan shared through "Copy link" (#scan=... in the address). */
  function loadSharedScan() {
    const match = location.hash.match(/^#scan=([A-Za-z0-9_-]+)$/);
    if (!match) return;
    history.replaceState(null, '', location.pathname + location.search);
    try {
      const base64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
      const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
      const scan = JSON.parse(new TextDecoder().decode(bytes));
      applyScan(scan);
      switchCalculator('fundscan');
      say(`Loaded the shared scan "${String(scan.name || '').slice(0, 60)}". Click Save to keep it on this device.`);
    } catch {
      switchCalculator('fundscan');
      say('That scan link is broken or incomplete.');
    }
  }

  renderSavedList();
  loadSharedScan();


  async function scanHolding(h, tf, rules) {
    const key = `${tf.series}|${h.searchId || `name:${h.name}`}`;
    if (!candleCache.has(key)) {
      const q = h.searchId ? `sid=${encodeURIComponent(h.searchId)}&name=${encodeURIComponent(h.name)}` : `name=${encodeURIComponent(h.name)}`;
      candleCache.set(key, fundProxy(`/candles?${q}&tf=${tf.series}`).catch((err) => ({ error: err.message })));
    }
    const data = await candleCache.get(key);
    if (data.error) return { ...h, error: data.error };
    const scan = evaluateScreeners(tf.build(data.bars), rules);
    return { ...h, symbol: data.symbol, exchange: data.exchange, ...scan };
  }

  function fundCardHtml(fund, index) {
    const scanned = fund.rows.filter((r) => !r.error);
    const matches = scanned.filter((r) => r.match);
    const visible = fund.showAll ? fund.rows : fund.rows.filter((r) => rowPasses(r, fund.filter));
    const tf = FUND_SCAN_TIMEFRAMES[fund.tfKey];
    const intraday = tf.series === 'hour';
    const when = (t) =>
      new Date(t * 1000).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: 'short',
        ...(intraday ? { hour: '2-digit', minute: '2-digit' } : { year: 'numeric' }),
      }) + (intraday ? ' IST' : '');
    const latest = scanned.find((r) => r.current)?.current;
    const others = fund.otherMatches.length
      ? `<details class="fs-other"><summary>Not the right fund?</summary><div class="screener-list">${fund.otherMatches
          .map((f, i) => `<button type="button" class="screener-option" data-fund="${index}" data-alt="${i}"><span>${escapeHtml(f.name)}</span></button>`)
          .join('')}</div></details>`
      : '';

    const row = (r) => {
      const link = r.symbol
        ? `<a href="https://www.tradingview.com/chart/?symbol=${encodeURIComponent(`${r.exchange}:${r.symbol}`)}&interval=${tf.tv}" target="_blank" rel="noopener"><strong>${escapeHtml(r.symbol)}</strong></a>`
        : '—';
      const side =
        r.weight < 0
          ? ' <small class="pnl-loss">short</small>'
          : r.instrument !== 'Equity'
            ? ` <small>${escapeHtml(r.instrument)}</small>`
            : '';
      if (r.error) {
        return `<tr class="fs-muted"><td>${link}</td><td>${escapeHtml(r.name)}${side}</td><td>${formatNumber(r.weight, 2)}%</td><td colspan="${screenerColumnCount(fund.rules) + 1}">${escapeHtml(r.error)}</td></tr>`;
      }
      return `<tr${rowPasses(r, fund.filter) ? ' class="fs-match"' : ''}>
        <td>${link}</td><td>${escapeHtml(r.name)}${side}</td><td>${formatNumber(r.weight, 2)}%</td>
        <td>${formatNumber(r.current.c, 2)}</td>
        ${screenerCellsHtml(r, fund.rules)}
      </tr>`;
    };
    const order = (a, b) =>
      (rowPasses(b, fund.filter) ? 1 : 0) - (rowPasses(a, fund.filter) ? 1 : 0) || (a.error ? 1 : 0) - (b.error ? 1 : 0) || b.weight - a.weight;

    return `<div class="card table-card fs-fund">
      <h3>${escapeHtml(fund.name)}</h3>
      <p class="hint screener-summary">
        Portfolio as of ${escapeHtml(String(fund.portfolioDate || '').slice(0, 10) || 'latest disclosure')} ·
        ${fund.rows.length} stock holdings · ${scanned.length} scanned ·
        <strong class="${matches.length ? 'pnl-profit' : ''}">${matches.length} match${matches.length === 1 ? '' : 'es'}</strong>
        · ${tf.label} candles${latest ? `, current one starts ${escapeHtml(when(latest.t))}` : ''}
      </p>
      ${screenerListHtml(fund.rules)}
      ${others}
      ${screenerFilterHtml(fund.rules, `data-fs-filter="${index}"`, fund.filter)}
      <label class="fs-toggle"><input type="checkbox" data-showall="${index}" ${fund.showAll ? 'checked' : ''}/> Show all holdings</label>
      ${
        visible.length === 0
          ? `<p class="hint">${noMatchText(fund.rules, fund.filter, 'holding', tf.label)} Tick "Show all holdings" to see how close each one is.</p>`
          : `<div class="table-scroll table-scroll-daily"><table>
        <thead><tr>
          <th>Symbol</th><th>Company</th><th>Weight</th><th>Close</th>
          ${screenerHeadHtml(fund.rules)}
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
    resultsEl.querySelectorAll('[data-fs-filter]').forEach((sel) => {
      sel.addEventListener('change', () => {
        funds[Number(sel.dataset.fsFilter)].filter = sel.value;
        render();
      });
    });
    resultsEl.querySelectorAll('[data-alt]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const fund = funds[Number(btn.dataset.fund)];
        runScan([{ pick: fund.otherMatches[Number(btn.dataset.alt)] }], fund.tfKey, fund.rules);
      });
    });
  }

  async function scanFund(job, n, total, tfKey, rules) {
    const tf = FUND_SCAN_TIMEFRAMES[tfKey];
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
      const result = await scanHolding(h, tf, rules);
      done += 1;
      setStatus('Scanning stocks…', [
        [prefix, escapeHtml(fund.name)],
        ['Progress', `${done} of ${fund.holdings.length}`],
      ]);
      return result;
    });
    return { ...fund, rows, otherMatches, showAll: false, filter: 'any', tfKey, rules };
  }

  async function runScan(jobs, tfKey, rules) {
    if (running) return;
    running = true;
    funds.length = 0;
    resultsEl.innerHTML = '';
    const errors = [];
    try {
      for (let i = 0; i < jobs.length; i++) {
        try {
          funds.push(await scanFund(jobs[i], i + 1, jobs.length, tfKey, rules));
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
      const rules = ruleEditor.commit();
      const fileNames = file ? await readFundNamesFromFile(file) : [];
      if (file && !fileNames.length) throw new Error('No fund names found in the first column of that file.');
      const jobs = [...[...picked].map(([id, name]) => ({ pick: { id, name } })), ...fileNames.map((term) => ({ term }))];
      if (!jobs.length) {
        const name = $('fsName').value.trim();
        if (!name) throw new Error('Enter a fund name, choose a file, or tick funds from a list.');
        jobs.push({ term: name });
      }
      await runScan(
        jobs,
        $('fsTimeframe').value,
        rules
      );
    } catch (err) {
      renderError(statusEl, escapeHtml(err.message));
    }
  });
}

// ---- Index Options Scan: calls and puts around a live index (Nifty, Bank Nifty, Sensex…), checked against its own conditions ----

const OPT_SETTINGS_KEY = 'sensexOptionScan'; // names kept from when only Sensex was supported
const OPT_RULE_STORAGE_KEY = 'sensexOptionRules';
const MARKET_OPEN_MIN = 9 * 60 + 15; // 09:15 IST
const MARKET_CLOSE_MIN = 15 * 60 + 30; // 15:30 IST
const REFRESH_DELAY_MS = 20000; // wait after a candle closes so the data source has the finished candle

// `m` is the candle size the proxy fetches; `build` groups those candles into the chosen timeframe.
const OPT_TIMEFRAMES = {
  '1m': { label: '1-minute', m: 1, every: 1, build: (bars) => bars },
  '3m': { label: '3-minute', m: 3, every: 3, build: (bars) => bars },
  '5m': { label: '5-minute', m: 5, every: 5, build: (bars) => bars },
  '30m': { label: '30-minute', m: 30, every: 30, build: (bars) => bars },
  '1h': { label: '1-hour', m: 60, every: 60, build: (bars) => bars },
  '3h': { label: '3-hour', m: 60, every: 180, build: (bars) => aggregateBars(bars, 3) },
};

const IST_MS = 19800000;

/** Minutes since midnight and weekday (0 = Sunday) in IST for a time in ms. */
function istParts(ms) {
  const d = new Date(ms + IST_MS);
  return { minutes: d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60, weekday: d.getUTCDay() };
}

/**
 * When the current candle of a timeframe closes (ms), for candles aligned to the 09:15 IST open.
 * Outside market hours it is the first candle close of the next weekday session. Exchange holidays are not known,
 * so a refresh on a holiday just shows the same prices again.
 */
function nextCandleClose(nowMs, every) {
  const midnight = (ms) => ms - ((ms + IST_MS) % 86400000); // IST midnight of that day, in ms
  const at = (dayStart, minutes) => dayStart + minutes * 60000;
  const { minutes, weekday } = istParts(nowMs);
  const today = midnight(nowMs);
  const closeOf = (dayStart, m) => {
    const bucketEnd = MARKET_OPEN_MIN + (Math.floor((m - MARKET_OPEN_MIN) / every) + 1) * every;
    return at(dayStart, Math.min(bucketEnd, MARKET_CLOSE_MIN));
  };
  const weekdayOpen = weekday >= 1 && weekday <= 5;
  if (weekdayOpen && minutes >= MARKET_OPEN_MIN && minutes < MARKET_CLOSE_MIN) return closeOf(today, minutes);
  if (weekdayOpen && minutes < MARKET_OPEN_MIN) return closeOf(today, MARKET_OPEN_MIN);
  let day = today + 86400000;
  while ([0, 6].includes(istParts(day).weekday)) day += 86400000;
  return closeOf(day, MARKET_OPEN_MIN);
}

function istTime(ms, withDate = false) {
  return (
    new Date(ms).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      ...(withDate ? { day: '2-digit', month: 'short' } : {}),
    }) + ' IST'
  );
}

function formatExpiry(date) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });
}

function initOptionScan() {
  const statusEl = $('optScanStatus');
  const resultsEl = $('optScanResults');
  const fields = ['osIndex', 'osCurrent', 'osNext', 'osCE', 'osPE', 'osBelow', 'osAbove', 'osTimeframe', 'osAuto'];
  let running = false;
  let timer = null;
  let nextRefreshAt = null;
  let last = null; // { spot, spotTime, atm, tfKey, rules, cards, at }
  const showAll = {};
  const filters = {}; // expiry -> 'any' or a screener index

  // Its own conditions; the first time, it starts from the fund scan's conditions.
  let hasOwnRules = false;
  try {
    hasOwnRules = Boolean(localStorage.getItem(OPT_RULE_STORAGE_KEY));
  } catch {
    // Storage blocked: start from the fund scan's conditions.
  }
  const ruleEditor = createScreenerEditor({
    containerEl: $('osScreeners'),
    addBtn: $('osAddScreener'),
    storageKey: OPT_RULE_STORAGE_KEY,
    initial: hasOwnRules ? null : loadScreeners(RULE_STORAGE_KEY),
  });

  // ---- Settings remembered on this device ----
  try {
    const saved = JSON.parse(localStorage.getItem(OPT_SETTINGS_KEY) || 'null');
    if (saved) {
      fields.forEach((id) => {
        if (!(id in saved)) return;
        const el = $(id);
        if (el.type === 'checkbox') el.checked = Boolean(saved[id]);
        else if (el.tagName !== 'SELECT' || [...el.options].some((o) => o.value === saved[id])) el.value = saved[id];
      });
    }
  } catch {
    // Storage blocked or unreadable: keep the defaults.
  }

  function saveSettings() {
    try {
      const out = {};
      fields.forEach((id) => {
        const el = $(id);
        out[id] = el.type === 'checkbox' ? el.checked : el.value;
      });
      localStorage.setItem(OPT_SETTINGS_KEY, JSON.stringify(out));
    } catch {
      // Not remembered; the scan still works.
    }
  }

  function readSettings() {
    const count = (id, label) => {
      const n = Number($(id).value);
      if (!Number.isInteger(n) || n < 0 || n > 10) throw new Error(`${label} must be a whole number from 0 to 10.`);
      return n;
    };
    const weeks = [$('osCurrent').checked && 0, $('osNext').checked && 1].filter((w) => w !== false);
    const types = [$('osCE').checked && 'ce', $('osPE').checked && 'pe'].filter(Boolean);
    if (!weeks.length) throw new Error('Tick Current expiry, Next expiry or both.');
    if (!types.length) throw new Error('Tick CE, PE or both.');
    return {
      index: $('osIndex').value,
      weeks,
      types,
      below: count('osBelow', 'Strikes below ATM'),
      above: count('osAbove', 'Strikes above ATM'),
      tfKey: $('osTimeframe').value,
    };
  }

  // ---- Auto refresh ----
  function stopAuto() {
    clearTimeout(timer);
    timer = null;
    nextRefreshAt = null;
  }

  function scheduleAuto() {
    stopAuto();
    if (!$('osAuto').checked) return;
    const tf = OPT_TIMEFRAMES[$('osTimeframe').value];
    nextRefreshAt = nextCandleClose(Date.now(), tf.every) + REFRESH_DELAY_MS;
    // Browsers delay long timers in background tabs, so check every 30 s instead of one long wait.
    const tick = () => {
      if (Date.now() >= nextRefreshAt) run(true);
      else timer = setTimeout(tick, Math.min(30000, nextRefreshAt - Date.now()));
    };
    timer = setTimeout(tick, Math.min(30000, Math.max(0, nextRefreshAt - Date.now())));
    renderStatus();
  }

  // ---- Rendering ----
  function renderStatus(title) {
    const lines = [];
    if (last) {
      lines.push([escapeHtml(last.indexName), `${formatNumber(last.spot, 2)} <small>(${istTime(last.spotTime * 1000, true)})</small>`]);
      lines.push(['ATM strike', `${formatNumber(last.atm, 0)} <small>(strikes ${formatNumber(last.step, 0)} apart)</small>`]);
      lines.push(['Last refreshed', istTime(last.at, true)]);
    }
    lines.push(['Auto refresh', nextRefreshAt ? `On · next at ${istTime(nextRefreshAt - REFRESH_DELAY_MS, true)}` : 'Off']);
    const matches = last ? last.cards.reduce((sum, c) => sum + c.rows.filter((r) => r.match).length, 0) : 0;
    renderResultCard(
      statusEl,
      title || (last ? `${matches} option${matches === 1 ? '' : 's'} match` : 'Index options'),
      '',
      lines.map(([label, value]) => ({ label, value }))
    );
  }

  function cardHtml(card) {
    const tf = OPT_TIMEFRAMES[last.tfKey];
    const rules = last.rules;
    const all = showAll[card.expiry];
    const filter = filters[card.expiry] || 'any';
    const scanned = card.rows.filter((r) => !r.error);
    const matches = scanned.filter((r) => r.match);
    const visible = all ? card.rows : card.rows.filter((r) => rowPasses(r, filter));
    const order = (a, b) => (rowPasses(b, filter) ? 1 : 0) - (rowPasses(a, filter) ? 1 : 0) || a.type.localeCompare(b.type) || a.strike - b.strike;
    const row = (r) => {
      const name = `<strong>${formatNumber(r.strike, 0)} ${r.type.toUpperCase()}</strong>${r.strike === last.atm ? ' <small class="os-atm">ATM</small>' : ''}`;
      if (r.error) return `<tr class="fs-muted"><td>${name}</td><td colspan="${screenerColumnCount(rules) + 1}">${escapeHtml(r.error)}</td></tr>`;
      return `<tr${rowPasses(r, filter) ? ' class="fs-match"' : ''}>
        <td>${name}</td><td>${formatNumber(r.current.c, 2)}</td>
        ${screenerCellsHtml(r, rules)}
      </tr>`;
    };
    return `<div class="card table-card fs-fund">
      <h3>${escapeHtml(last.indexName)} · ${card.week === 0 ? 'current' : 'next'} expiry ${escapeHtml(formatExpiry(card.expiry))}</h3>
      <p class="hint screener-summary">
        ${card.rows.length} contracts · ${scanned.length} scanned ·
        <strong class="${matches.length ? 'pnl-profit' : ''}">${matches.length} match${matches.length === 1 ? '' : 'es'}</strong>
        · ${tf.label} candles${card.lotSize ? ` · lot size ${card.lotSize}` : ''}
      </p>
      ${screenerListHtml(rules)}
      ${screenerFilterHtml(rules, `data-os-filter="${escapeHtml(card.expiry)}"`, filter)}
      <label class="fs-toggle"><input type="checkbox" data-os-all="${escapeHtml(card.expiry)}" ${all ? 'checked' : ''}/> Show all strikes</label>
      ${
        visible.length === 0
          ? `<p class="hint">${noMatchText(rules, filter, 'option', tf.label)} Tick "Show all strikes" to see how close each one is.</p>`
          : `<div class="table-scroll table-scroll-daily"><table>
        <thead><tr><th>Option</th><th>Price</th>${screenerHeadHtml(rules)}</tr></thead>
        <tbody>${[...visible].sort(order).map(row).join('')}</tbody>
      </table></div>`
      }
    </div>`;
  }

  function renderCards() {
    if (!last) return;
    resultsEl.innerHTML = last.cards.map(cardHtml).join('');
    resultsEl.querySelectorAll('[data-os-filter]').forEach((sel) => {
      sel.addEventListener('change', () => {
        filters[sel.dataset.osFilter] = sel.value;
        renderCards();
      });
    });
    resultsEl.querySelectorAll('[data-os-all]').forEach((box) => {
      box.addEventListener('change', () => {
        showAll[box.dataset.osAll] = box.checked;
        renderCards();
      });
    });
  }

  // ---- Scan ----
  async function scanContract(index, contract, strike, type, tf, rules) {
    const base = { strike, type };
    if (!contract) return { ...base, error: 'This strike is not listed for this expiry.' };
    try {
      const data = await fundProxy(`/options/candles?index=${index}&id=${encodeURIComponent(contract.id)}&m=${tf.m}`);
      if (!data.bars.length) return { ...base, error: 'No trades yet.' };
      const result = evaluateScreeners(tf.build(data.bars), rules);
      return { ...base, ...result };
    } catch (err) {
      return { ...base, error: err.message };
    }
  }

  async function run(fromTimer = false) {
    if (running) return;
    let settings;
    let rules;
    try {
      settings = readSettings();
      rules = ruleEditor.commit();
    } catch (err) {
      renderError(statusEl, escapeHtml(err.message));
      return;
    }
    running = true;
    $('osRun').disabled = true;
    const tf = OPT_TIMEFRAMES[settings.tfKey];
    try {
      const indexName = $('osIndex').selectedOptions[0].textContent;
      renderStatus(fromTimer ? 'Auto refreshing…' : `Loading the live ${indexName}…`);
      const first = await fundProxy(`/options/chain?index=${settings.index}`);
      const step = first.step;
      if (!step) throw new Error(`Could not work out the ${indexName} strike gap.`);
      const atm = Math.round(first.spot / step) * step;
      const strikes = [];
      for (let k = -settings.below; k <= settings.above; k++) strikes.push(atm + k * step);

      const cards = [];
      for (const week of settings.weeks) {
        const expiry = first.expiries[week];
        if (!expiry) continue;
        const chain = week === 0 && first.expiry === expiry ? first : await fundProxy(`/options/chain?index=${settings.index}&expiry=${expiry}`);
        const byStrike = new Map(chain.strikes.map((s) => [s.strike, s]));
        const jobs = strikes.flatMap((strike) => settings.types.map((type) => ({ strike, type, contract: byStrike.get(strike)?.[type] })));
        let done = 0;
        const rows = await mapLimit(jobs, 4, async (job) => {
          const r = await scanContract(settings.index, job.contract, job.strike, job.type, tf, rules);
          done += 1;
          renderResultCard(statusEl, 'Scanning options…', '', [
            { label: 'Expiry', value: escapeHtml(formatExpiry(expiry)) },
            { label: 'Progress', value: `${done} of ${jobs.length}` },
          ]);
          return r;
        });
        cards.push({ week, expiry, lotSize: chain.lotSize, rows });
      }
      if (!cards.length) throw new Error('No expiry found for the selected option.');
      last = { indexName, step, spot: first.spot, spotTime: first.spotTime, atm, tfKey: settings.tfKey, rules, cards, at: Date.now() };
      renderCards();
      renderStatus();
    } catch (err) {
      renderError(statusEl, escapeHtml(err.message));
    } finally {
      running = false;
      $('osRun').disabled = false;
      scheduleAuto();
    }
  }

  $('formOptScan').addEventListener('submit', (e) => {
    e.preventDefault();
    saveSettings();
    run();
  });
  $('formOptScan').addEventListener('change', (e) => {
    saveSettings();
    if (e.target.id === 'osAuto' || e.target.id === 'osTimeframe') {
      if ($('osAuto').checked && !last) run();
      else scheduleAuto();
    }
  });
  if ($('osAuto').checked) scheduleAuto();
}

// ---- Common Stocks: the stocks that two or more ticked funds hold, with each fund's weight ----

const COMMON_NAME_NOISE = /\b(ltd|limited|futures?|fut|the|and|co|corp|corporation|inc|india)\b/g;
// Expiry months on futures lines ("October 2026 Future", "Dec24"); only whole words, so "Maruti" is kept.
const COMMON_NAME_EXPIRY =
  /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)(\d{2,4})?\b|\b\d{2,4}\b/g;

/** A company name reduced to its main words, so "Infosys Ltd" and "Infosys Limited October 2026 Future" meet. */
function stockNameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\(i\)/g, ' india ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(COMMON_NAME_EXPIRY, ' ')
    .replace(COMMON_NAME_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Groups the funds' holdings by stock. Returns [{ key, name, searchId, weights: [per fund or null], count, total }]. */
function commonHoldings(funds) {
  const idByName = new Map();
  funds.forEach((f) => f.holdings.forEach((h) => h.searchId && idByName.set(stockNameKey(h.name), h.searchId)));
  const stocks = new Map();
  funds.forEach((f, fi) =>
    f.holdings.forEach((h) => {
      const nameKey = stockNameKey(h.name);
      const searchId = h.searchId || idByName.get(nameKey) || '';
      const key = searchId || `name:${nameKey}`;
      let stock = stocks.get(key);
      if (!stock) {
        stock = { key, name: h.name, searchId, weights: new Array(funds.length).fill(null) };
        stocks.set(key, stock);
      }
      // Prefer the plain company name over a futures line ("Infosys Ltd" over "Infosys Futures").
      if (/\bfut/i.test(stock.name) && !/\bfut/i.test(h.name)) stock.name = h.name;
      stock.weights[fi] = (stock.weights[fi] ?? 0) + (Number(h.weight) || 0);
    })
  );
  return [...stocks.values()].map((st) => {
    const held = st.weights.filter((w) => w !== null);
    return { ...st, count: held.length, total: held.reduce((sum, w) => sum + w, 0) };
  });
}

function initCommonStocks() {
  const picker = createFundPicker('cs');
  const statusEl = $('commonStatus');
  const resultsEl = $('commonResults');
  const holdingsCache = new Map();
  let state = null; // { funds, stocks, minCount, query }
  let running = false;

  function setStatus(title, lines) {
    renderResultCard(statusEl, title, '', lines.map(([label, value]) => ({ label, value })));
  }

  function visibleStocks() {
    const words = state.query.toLowerCase().split(/\s+/).filter(Boolean);
    return state.stocks
      .filter((st) => st.count >= state.minCount && words.every((w) => st.name.toLowerCase().includes(w)))
      .sort((a, b) => b.count - a.count || b.total - a.total || a.name.localeCompare(b.name));
  }

  const pct = (w) => `${formatNumber(w, 2)}%`;

  function tableHtml() {
    const n = state.funds.length;
    const rows = visibleStocks();
    if (!rows.length) return '<p class="hint">No stock matches. Lower "held by" or clear the name filter.</p>';
    const weightCell = (w) => {
      if (w === null) return '<td class="fs-skip">—</td>';
      // Bought and shorted (arbitrage): the net weight rounds to zero.
      if (Math.abs(w) < 0.005) return '<td title="Long and short positions cancel out">0% <small>hedged</small></td>';
      return `<td class="${w < 0 ? 'pnl-loss' : ''}">${pct(w)}${w < 0 ? ' <small>short</small>' : ''}</td>`;
    };
    return `<p class="hint">${rows.length} stock${rows.length === 1 ? '' : 's'} shown.</p>
      <div class="table-scroll table-scroll-daily"><table>
      <thead><tr><th>Stock</th><th>Held by</th><th title="Average weight in the funds that hold it">Avg weight</th>
        ${state.funds.map((f, i) => `<th title="${escapeHtml(f.name)}">F${i + 1}</th>`).join('')}</tr></thead>
      <tbody>${rows
        .map(
          (st) => `<tr${st.count === n ? ' class="fs-match"' : ''}>
        <td>${st.searchId ? `<a href="https://groww.in/stocks/${encodeURIComponent(st.searchId)}" target="_blank" rel="noopener"><strong>${escapeHtml(st.name)}</strong></a>` : `<strong>${escapeHtml(st.name)}</strong>`}</td>
        <td><strong>${st.count}</strong> of ${n}</td>
        <td>${pct(st.total / st.count)}</td>
        ${st.weights.map(weightCell).join('')}
      </tr>`
        )
        .join('')}</tbody></table></div>`;
  }

  function renderTable() {
    $('csTable').innerHTML = tableHtml();
  }

  function render() {
    const n = state.funds.length;
    const options = Array.from({ length: n }, (_, i) => i + 1)
      .map((k) => `<option value="${k}"${k === state.minCount ? ' selected' : ''}>${k === n ? `all ${n} funds` : `at least ${k} of ${n} funds`}</option>`)
      .join('');
    resultsEl.innerHTML = `<div class="card table-card fs-fund">
      <h3>Common stocks across ${n} funds</h3>
      <ol class="hint cs-legend">${state.funds
        .map((f, i) => `<li><strong>F${i + 1}</strong> ${escapeHtml(f.name)} <small>(${f.holdings.length} stocks, as of ${escapeHtml(String(f.portfolioDate || '').slice(0, 10) || 'latest disclosure')})</small></li>`)
        .join('')}</ol>
      <div class="cs-controls">
        <label class="fs-toggle fs-filter">Held by <select id="csMin">${options}</select></label>
        <input id="csQuery" type="search" placeholder="Filter by stock name" aria-label="Filter by stock name" value="${escapeHtml(state.query)}" />
        <button type="button" id="csExcel" class="btn btn-secondary">Download Excel</button>
      </div>
      <div id="csTable"></div>
    </div>`;
    renderTable();
    $('csMin').addEventListener('change', (e) => {
      state.minCount = Number(e.target.value);
      renderTable();
    });
    $('csQuery').addEventListener('input', (e) => {
      state.query = e.target.value;
      renderTable();
    });
    $('csExcel').addEventListener('click', () => {
      try {
        downloadExcel({
          title: 'Common stocks',
          headers: ['Stock', 'Held by', 'Avg weight %', ...state.funds.map((f) => f.name)],
          rows: visibleStocks().map((st) => [
            st.name,
            `${st.count} of ${n}`,
            formatNumber(st.total / st.count, 2),
            ...st.weights.map((w) => (w === null ? '' : formatNumber(w, 2))),
          ]),
          filename: 'common-stocks.xlsx',
        });
      } catch (err) {
        renderError(statusEl, escapeHtml(err.message));
      }
    });
  }

  $('formCommon').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (running) return;
    const chosen = [...picker.picked].map(([id, name]) => ({ id, name }));
    if (chosen.length < 2) {
      renderError(statusEl, 'Tick at least two funds.');
      return;
    }
    running = true;
    resultsEl.innerHTML = '';
    const skipped = [];
    let done = 0;
    try {
      const loaded = await mapLimit(chosen, 4, async (f) => {
        if (!holdingsCache.has(f.id)) {
          holdingsCache.set(f.id, fundProxy(`/fund/holdings?id=${encodeURIComponent(f.id)}`).catch((err) => ({ error: err.message })));
        }
        const fund = await holdingsCache.get(f.id);
        if (fund.error) holdingsCache.delete(f.id);
        done += 1;
        setStatus('Loading holdings…', [['Progress', `${done} of ${chosen.length} funds`]]);
        if (fund.error || !fund.holdings?.length) {
          skipped.push(`${escapeHtml(f.name)}: ${escapeHtml(fund.error || 'no stock holdings disclosed')}`);
          return null;
        }
        return { ...fund, name: f.name };
      });
      const funds = loaded.filter(Boolean);
      if (funds.length < 2) throw new Error(`Need holdings for at least two funds.${skipped.length ? `<br>${skipped.join('<br>')}` : ''}`);
      const stocks = commonHoldings(funds);
      state = { funds, stocks, minCount: 2, query: '' };
      const inAll = stocks.filter((st) => st.count === funds.length).length;
      const inTwo = stocks.filter((st) => st.count >= 2).length;
      setStatus(`${inTwo} common stock${inTwo === 1 ? '' : 's'}`, [
        ['Funds compared', String(funds.length)],
        ['Held by all of them', String(inAll)],
        ['Held by 2 or more', String(inTwo)],
        ['Different stocks in total', String(stocks.length)],
        ...skipped.map((m) => ['Skipped', m]),
      ]);
      render();
    } catch (err) {
      renderError(statusEl, err.message.includes('<br>') ? err.message : escapeHtml(err.message));
    } finally {
      running = false;
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
  initOptionScan();
  initCommonStocks();
  runInitialCalculations();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
