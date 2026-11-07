// Cloudflare Worker: lets the Finance Suite site read Chartink screeners from the browser.
// Chartink does not send CORS headers, so the browser cannot call it directly.
//
//   GET /search?q=<screener name>  -> { screeners: [{ name, slug, updatedAt }] }
//   GET /run?slug=<screener slug>  -> { name, slug, count, stocks: [{ sr, nsecode, name, close, per_chg, volume }] }
//
// Fund holdings scan (data from Groww and Yahoo Finance):
//   GET /fund/search?q=<fund name>      -> { funds: [{ id, name }] }
//   GET /fund/lists                    -> { sif: [{ id, name, type, aum }], top: [...200 largest equity and hybrid funds],
//                                          etf: [...every equity ETF, ids start with "etf:"] }
//   GET /fund/holdings?id=<fund id>     -> { id, name, portfolioDate, holdings: [{ name, searchId, instrument, weight }] }
//                                          (an "etf:<id>" id reads the ETF's holdings)
//   GET /candles?sid=<stock id>&name=..&tf=min1|min5|min15|min30|hour|day|week|month
//       -> { symbol, exchange, displayName, bars: [{ t, o, h, l, c }] }
//       min1: 1-minute bars for 7 days; min5: 5-minute for 30 days; min15/min30: 60 days; hour: 1 year;
//       day/week/month: daily bars for 2/5/10 years (the page groups them)
//
// Index options scan (data from Groww). index = nifty | banknifty | finnifty | midcpnifty | sensex
//   GET /options/chain?index=..&expiry=YYYY-MM-DD -> { index, spot, spotTime, step, expiries, expiry, lotSize, strikes: [{ strike, ce: { id, ltp }, pe }] }
//   GET /options/candles?index=..&id=<contract>&m=1|3|5|30|60 -> { id, bars: [{ t, o, h, l, c }] }

const CHARTINK = 'https://chartink.com';
const USER_AGENT = 'Mozilla/5.0 (compatible; FinanceSuiteProxy/1.0)';

// Sites allowed to call this Worker. Add your own domain here if you host the page elsewhere.
// Any http://localhost:<port> is also allowed, for local development.
const ALLOWED_ORIGINS = ['https://dileephp.github.io'];

function isAllowedOrigin(origin) {
  return ALLOWED_ORIGINS.includes(origin) || /^http:\/\/localhost:\d+$/.test(origin || '');
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

function json(request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(request),
    },
  });
}

function decodeEntities(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attribute(html, pattern) {
  const match = html.match(pattern);
  return match ? decodeEntities(match[1]) : null;
}

async function searchScreeners(term) {
  const res = await fetch(`${CHARTINK}/screeners/search?searchTerm=${encodeURIComponent(term)}`, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) throw new Error(`Chartink search failed (${res.status})`);
  const html = await res.text();
  const page = attribute(html, /data-page="([^"]+)"/);
  if (!page) throw new Error('Could not read Chartink search results.');
  const scans = JSON.parse(page).props?.paginatedScans?.data ?? [];
  return scans.map((scan) => ({ name: scan.name, slug: scan.slug, updatedAt: scan.updated_at }));
}

async function runScreener(slug) {
  const pageUrl = `${CHARTINK}/screener/${slug}`;
  const pageRes = await fetch(pageUrl, { headers: { 'User-Agent': USER_AGENT } });
  if (pageRes.status === 404) return { error: 'Screener not found.', status: 404 };
  if (!pageRes.ok) throw new Error(`Chartink screener page failed (${pageRes.status})`);

  const html = await pageRes.text();
  const csrf = attribute(html, /name="csrf-token"[^>]*content="([^"]+)"/);
  const scanJson = attribute(html, /:scan-json="([^"]+)"/);
  if (!csrf || !scanJson) return { error: 'Could not read this screener (it may be private).', status: 422 };

  const scan = JSON.parse(scanJson);
  if (!scan.atlas_query) return { error: 'This screener has no query to run (it may be private).', status: 422 };

  const cookie = pageRes.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

  const processRes = await fetch(`${CHARTINK}/screener/process`, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'X-CSRF-TOKEN': csrf,
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: pageUrl,
      Cookie: cookie,
    },
    body: new URLSearchParams({ scan_clause: scan.atlas_query }),
  });
  if (!processRes.ok) throw new Error(`Chartink could not run the screener (${processRes.status})`);

  const result = await processRes.json();
  const stocks = (result.data ?? []).map(({ sr, nsecode, name, bsecode, close, per_chg, volume }) => ({
    sr,
    nsecode,
    name,
    bsecode,
    close,
    per_chg,
    volume,
  }));
  return { body: { name: scan.name, slug, count: stocks.length, stocks } };
}

const GROWW = 'https://groww.in';
const YAHOO = 'https://query1.finance.yahoo.com';

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Data request failed (${res.status})`);
  return res.json();
}

async function growwSearch(entityType, query, size = 8) {
  const url = `${GROWW}/v1/api/search/v3/query/global/st_query?entity_type=${entityType}&page=0&size=${size}&query=${encodeURIComponent(query)}`;
  const body = await getJson(url);
  return body.data?.content ?? [];
}

async function searchFunds(term) {
  const results = await growwSearch('scheme', term);
  return results.map((r) => ({ id: r.search_id, name: r.title }));
}

async function fundHoldings(id) {
  const fund = await getJson(`${GROWW}/v1/api/data/mf/web/v4/scheme/search/${encodeURIComponent(id)}`);
  const all = fund.holdings ?? [];
  const holdings = all
    .filter((h) => h.nature_name === 'EQUITY')
    .map((h) => ({
      name: h.company_name,
      searchId: h.stock_search_id || '',
      instrument: h.instrument_name,
      weight: h.corpus_per,
    }));
  return {
    id,
    name: fund.scheme_name || fund.fund_name || id,
    portfolioDate: all[0]?.portfolio_date || null,
    holdings,
  };
}

// Ready-made fund lists for the page: every SIF (Groww files them under "Long-Short" categories) and the
// 200 largest equity and hybrid mutual funds by assets. Fund-of-funds are left out (they hold funds, not stocks).
const FUND_LIST_TTL_MS = 6 * 60 * 60 * 1000;
const TOP_FUND_COUNT = 200;
const TOP_FUND_CATEGORIES = ['Equity', 'Hybrid'];
let fundListCache = null;

const cleanFundName = (name) => String(name || '').replace(/\s+/g, ' ').trim();

// ---- ETFs (Groww's ETF screener and ETF pages) ----
// The screener returns at most 100 ETFs per request and ignores paging, so the list is collected by fund size
// (AUM in Rs crore): any size range that comes back full is split in two and asked again.
const ETF_SCREENER = `${GROWW}/bff/web/stocks/screener/web-pages/screener_stocks?screenerId=etf`;
const ETF_SCREENER_CAP = 100;
const ETF_MAX_REQUESTS = 40; // Cloudflare's free plan allows 50 outgoing requests per call
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

async function etfScreener(lo, hi) {
  const data = {
    filterCriteria: {
      category: [{ value: 'EQUITY', key: 'assetClass', operator: 'EQUALS', label: 'Equity' }],
      aum: [{ key: 'aum', operator: 'BETWEEN', value: `${lo},${hi}`, label: 'AUM' }],
    },
    sortCriteria: { key: 'aum', order: 'DESCENDING' },
  };
  const res = await fetch(ETF_SCREENER, {
    method: 'POST',
    headers: {
      'User-Agent': BROWSER_UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'x-platform': 'web',
      'X-APP-ID': 'growwWeb',
    },
    body: new URLSearchParams({ data: JSON.stringify(data) }),
  });
  if (!res.ok) throw new Error(`ETF list request failed (${res.status})`);
  return (await res.json()).data?.screenerList ?? [];
}

/** Every equity ETF (gold, silver, debt and liquid ETFs hold no stocks, so they are left out). */
async function equityEtfs() {
  let requests = 0;
  async function range(lo, hi) {
    requests += 1;
    const rows = await etfScreener(lo, hi);
    if (rows.length < ETF_SCREENER_CAP || hi - lo <= 1 || requests >= ETF_MAX_REQUESTS) return rows;
    const mid = Math.floor((lo + hi) / 2);
    const [low, high] = await Promise.all([range(lo, mid), range(mid, hi)]);
    return [...low, ...high];
  }
  const byId = new Map();
  for (const e of await range(0, 1000000)) {
    if (!e.searchId || byId.has(e.searchId)) continue;
    byId.set(e.searchId, {
      id: `etf:${e.searchId}`,
      name: cleanFundName(e.companyData?.shortName || e.nseScriptCode || e.searchId),
      type: e.nseScriptCode ? `NSE: ${e.nseScriptCode}` : e.bseScriptCode ? `BSE: ${e.bseScriptCode}` : 'ETF',
      aum: typeof e.aum === 'number' ? e.aum : 0,
    });
  }
  return [...byId.values()].sort((a, b) => b.aum - a.aum);
}

async function etfHoldings(searchId) {
  const res = await fetch(`${GROWW}/etfs/${encodeURIComponent(searchId)}`, { headers: { 'User-Agent': BROWSER_UA } });
  if (!res.ok) throw new Error(`Could not open this ETF (${res.status}).`);
  const html = await res.text();
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('Could not read this ETF.');
  const page = JSON.parse(match[1]).props?.pageProps || {};
  const companies = page.companyHeadersByIsin || {};
  const holdings = (page.etfHoldingsData?.holdings || []).map((h) => {
    const company = companies[h.isin] || {};
    return { name: company.displayName || h.isin, searchId: company.searchId || '', instrument: 'Equity', weight: h.holdingSharePercentage };
  });
  return {
    id: `etf:${searchId}`,
    name: page.etfData?.header?.displayName || searchId,
    portfolioDate: null,
    holdings,
  };
}

async function fundLists() {
  if (fundListCache && Date.now() - fundListCache.at < FUND_LIST_TTL_MS) return fundListCache.body;
  // The ETF list is a bonus: if Groww's ETF screener fails, the fund lists still load.
  const [body, etf] = await Promise.all([
    getJson(`${GROWW}/v1/api/search/v1/derived/scheme?available_for_investment=true&doc_type=scheme&page=0&plan_type=Direct&q=&size=3000&sort_by=2`),
    equityEtfs().catch(() => []),
  ]);
  const all = (body.content || []).map((f) => ({
    id: f.direct_search_id || f.id,
    name: cleanFundName(f.direct_scheme_name || f.scheme_name),
    category: f.category,
    subCategory: f.sub_category || '',
    aum: typeof f.aum === 'number' ? f.aum : 0,
  }));
  const isSif = (f) => /long-short/i.test(f.subCategory);
  const isFof = (f) => /\b(fof|fund of funds?)\b/i.test(f.name);
  const pick = ({ id, name, subCategory, aum }) => ({ id, name, type: subCategory, aum });
  const result = {
    sif: all.filter(isSif).sort((a, b) => a.name.localeCompare(b.name)).map(pick),
    top: all
      .filter((f) => TOP_FUND_CATEGORIES.includes(f.category) && !isSif(f) && !isFof(f))
      .sort((a, b) => b.aum - a.aum)
      .slice(0, TOP_FUND_COUNT)
      .map(pick),
    etf,
  };
  if (!result.sif.length && !result.top.length) throw new Error('Could not load the fund lists.');
  fundListCache = { at: Date.now(), body: result };
  return result;
}

// Holdings of derivatives (futures) come without a stock id, and names can be old ones.
// Renamed companies: cleaned old name -> current NSE symbol.
const NAME_ALIASES = { 'larsen toubro infotech': { nse: 'LTM', displayName: 'LTIMindtree' } };
const NAME_NOISE = /\b(ltd|limited|futures?|fut|equity|eq|the|co|corp|corporation|of|and|india|inc)\b/g;

function nameWords(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(NAME_NOISE, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

async function stockFromName(name) {
  const cleaned = String(name).replace(/\^/g, '').replace(/\bfutures?\b/gi, '').trim();
  const words = nameWords(cleaned);
  const alias = NAME_ALIASES[words.join(' ')];
  if (alias) return { searchId: '', bse: null, ...alias };
  const results = await growwSearch('stocks', cleaned, 5);
  // Every meaningful word of the holding name must appear in the match, so "L&T Infotech" never becomes "L&T".
  const match = results.find((r) => {
    const title = new Set(nameWords(r.title));
    return words.every((w) => title.has(w));
  });
  return match ? { searchId: match.search_id, nse: match.nse_scrip_code, bse: match.bse_scrip_code, displayName: match.title } : null;
}

async function stockFromSearchId(searchId) {
  const body = await getJson(`${GROWW}/v1/api/stocks_data/v1/company/search_id/${encodeURIComponent(searchId)}?page=0&size=1`);
  const h = body.header || {};
  return { searchId, nse: h.nseScriptCode, bse: h.bseScriptCode, displayName: h.displayName || h.shortName };
}

// Candle sizes the page can ask for. Weekly and monthly candles are built in the page from daily ones,
// because Yahoo's own weekly/monthly series can switch interval on long ranges and add a duplicate live bar.
const CANDLE_SERIES = {
  min1: { interval: '1m', range: '7d' },
  min5: { interval: '5m', range: '30d' },
  min15: { interval: '15m', range: '60d' },
  min30: { interval: '30m', range: '60d' },
  hour: { interval: '60m', range: '1y' },
  day: { interval: '1d', range: '2y' },
  week: { interval: '1d', range: '5y' },
  month: { interval: '1d', range: '10y' },
};

const round2 = (v) => Math.round(v * 100) / 100;

async function yahooBars(ticker, { interval, range }) {
  const res = await fetch(`${YAHOO}/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) return null;
  const body = await res.json();
  const result = body.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  if (!result?.timestamp || !quote) return null;
  const bars = [];
  result.timestamp.forEach((t, i) => {
    const o = quote.open[i];
    const h = quote.high[i];
    const l = quote.low[i];
    const c = quote.close[i];
    if ([o, h, l, c].every((v) => typeof v === 'number')) bars.push({ t, o: round2(o), h: round2(h), l: round2(l), c: round2(c) });
  });
  return bars.length ? bars : null;
}

async function stockCandles(searchId, name, series) {
  let stock = null;
  if (searchId) stock = await stockFromSearchId(searchId).catch(() => null);
  if (!stock?.nse && !stock?.bse && name) stock = await stockFromName(name);
  if (!stock || (!stock.nse && !stock.bse)) return { error: 'Not listed on NSE/BSE, or could not find its symbol.', status: 404 };

  const tries = [stock.nse && { symbol: stock.nse, exchange: 'NSE', ticker: `${stock.nse}.NS` }, stock.bse && { symbol: stock.bse, exchange: 'BSE', ticker: `${stock.bse}.BO` }].filter(Boolean);
  for (const t of tries) {
    const bars = await yahooBars(t.ticker, series);
    if (bars) return { body: { symbol: t.symbol, exchange: t.exchange, displayName: stock.displayName, bars } };
  }
  return { error: 'No price data found for this stock.', status: 404 };
}

// ---- Index options (Groww: live index value, option chain and contract candles) ----

// Indices the options scan supports. `slug` is Groww's option-chain name, `spot` its live-index symbol,
// `prefix` the start of every contract id (for example BANKNIFTY26NOV57000CE).
const OPTION_INDICES = {
  nifty: { name: 'Nifty 50', slug: 'nifty', exchange: 'NSE', spot: 'NIFTY', prefix: 'NIFTY' },
  banknifty: { name: 'Bank Nifty', slug: 'nifty-bank', exchange: 'NSE', spot: 'BANKNIFTY', prefix: 'BANKNIFTY' },
  finnifty: { name: 'Fin Nifty', slug: 'nifty-financial-services', exchange: 'NSE', spot: 'FINNIFTY', prefix: 'FINNIFTY' },
  midcpnifty: { name: 'Midcap Nifty', slug: 'nifty-midcap-select', exchange: 'NSE', spot: 'NIFTYMIDSELECT', prefix: 'MIDCPNIFTY' },
  sensex: { name: 'Sensex', slug: 'sp-bse-sensex', exchange: 'BSE', spot: 'SENSEX', prefix: 'SENSEX' },
};
const CHAIN_WINDOW = 0.05; // only strikes within 5% of the index value are returned
const OPTION_INTERVALS = { 1: 7, 3: 10, 5: 30, 30: 60, 60: 90 }; // candle minutes -> days of history to ask for

async function indexSpot(index) {
  const body = await getJson(`${GROWW}/v1/api/stocks_data/v1/accord_points/exchange/${index.exchange}/segment/CASH/latest_indices_ohlc/${index.spot}`);
  if (typeof body.value !== 'number') throw new Error(`Could not read the live ${index.name}.`);
  return { spot: round2(body.value), spotTime: body.tsInMillis };
}

async function optionChain(index, expiry) {
  const query = expiry ? `?expiry=${expiry}` : '';
  const [body, { spot, spotTime }] = await Promise.all([
    getJson(`${GROWW}/v1/api/option_chain_service/v1/option_chain/derivatives/${index.slug}${query}`),
    indexSpot(index),
  ]);
  const chain = body.optionChain;
  if (!chain?.optionChains) throw new Error(`Could not read the ${index.name} option chain.`);
  const leg = (o) => (o?.growwContractId ? { id: o.growwContractId, ltp: o.ltp ?? null } : null);
  const strikes = chain.optionChains
    .map((row) => {
      const strike = (row.callOption?.strikePrice ?? row.putOption?.strikePrice ?? 0) / 100;
      return { strike, ce: leg(row.callOption), pe: leg(row.putOption) };
    })
    .filter((s) => s.strike && Math.abs(s.strike - spot) <= spot * CHAIN_WINDOW)
    .sort((x, y) => x.strike - y.strike);
  // Strike gap near the index value (far strikes can be listed further apart).
  let step = null;
  for (let i = 1; i < strikes.length; i++) {
    const gap = round2(strikes[i].strike - strikes[i - 1].strike);
    if (gap > 0 && (step === null || gap < step)) step = gap;
  }
  const details = chain.expiryDetailsDto || {};
  return {
    index: index.name,
    spot,
    spotTime,
    step,
    expiries: details.expiryDates || [],
    expiry: expiry || details.currentExpiry || null,
    lotSize: details.expiryLotSize || null,
    strikes,
  };
}

async function optionCandles(index, id, minutes) {
  const end = Date.now();
  const start = end - OPTION_INTERVALS[minutes] * 86400000;
  const body = await getJson(
    `${GROWW}/v1/api/stocks_fo_data/v1/charting_service/chart/exchange/${index.exchange}/segment/FNO/${id}?endTimeInMillis=${end}&intervalInMinutes=${minutes}&startTimeInMillis=${start}`
  );
  const bars = (body.candles || [])
    .filter((c) => c.slice(0, 5).every((v) => typeof v === 'number'))
    .map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
  return { id, bars };
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });
    if (request.method !== 'GET') return json(request, { error: 'Method not allowed.' }, 405);

    const url = new URL(request.url);
    try {
      if (url.pathname === '/search') {
        const term = (url.searchParams.get('q') || '').trim();
        if (!term || term.length > 100) return json(request, { error: 'Enter a screener name (up to 100 characters).' }, 400);
        return json(request, { screeners: await searchScreeners(term) });
      }

      if (url.pathname === '/run') {
        const slug = url.searchParams.get('slug') || '';
        if (!/^[a-z0-9-]{1,200}$/.test(slug)) return json(request, { error: 'Invalid screener.' }, 400);
        const result = await runScreener(slug);
        return result.error ? json(request, { error: result.error }, result.status) : json(request, result.body);
      }

      if (url.pathname === '/fund/search') {
        const term = (url.searchParams.get('q') || '').trim();
        if (!term || term.length > 150) return json(request, { error: 'Enter a fund name (up to 150 characters).' }, 400);
        return json(request, { funds: await searchFunds(term) });
      }

      if (url.pathname === '/fund/lists') {
        return json(request, await fundLists());
      }

      if (url.pathname === '/fund/holdings') {
        const id = url.searchParams.get('id') || '';
        const etf = id.match(/^etf:([a-z0-9-]{1,200})$/);
        if (etf) return json(request, await etfHoldings(etf[1]));
        if (!/^[a-z0-9-]{1,200}$/.test(id)) return json(request, { error: 'Invalid fund.' }, 400);
        return json(request, await fundHoldings(id));
      }

      if (url.pathname === '/candles') {
        const sid = url.searchParams.get('sid') || '';
        const name = (url.searchParams.get('name') || '').slice(0, 150);
        if (sid && !/^[a-z0-9-]{1,200}$/.test(sid)) return json(request, { error: 'Invalid stock.' }, 400);
        if (!sid && !name.trim()) return json(request, { error: 'Give a stock id or name.' }, 400);
        const series = CANDLE_SERIES[url.searchParams.get('tf') || 'hour'];
        if (!series) return json(request, { error: 'Invalid timeframe.' }, 400);
        const result = await stockCandles(sid, name, series);
        return result.error ? json(request, { error: result.error }, result.status) : json(request, result.body);
      }

      if (url.pathname === '/options/chain' || url.pathname === '/options/candles') {
        const index = OPTION_INDICES[url.searchParams.get('index') || ''];
        if (!index) return json(request, { error: 'Unknown index.' }, 400);
        if (url.pathname === '/options/chain') {
          const expiry = url.searchParams.get('expiry') || '';
          if (expiry && !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return json(request, { error: 'Invalid expiry date.' }, 400);
          return json(request, await optionChain(index, expiry));
        }
        const id = url.searchParams.get('id') || '';
        const minutes = Number(url.searchParams.get('m') || 0);
        if (!new RegExp(`^${index.prefix}[0-9A-Z]{4,20}(CE|PE)$`).test(id)) return json(request, { error: 'Invalid option contract.' }, 400);
        if (!OPTION_INTERVALS[minutes]) return json(request, { error: 'Invalid candle size.' }, 400);
        return json(request, await optionCandles(index, id, minutes));
      }

      return json(request, { error: 'Not found.' }, 404);
    } catch (err) {
      return json(request, { error: err.message || 'Something went wrong.' }, 502);
    }
  },
};
