// Cloudflare Worker: lets the Finance Suite site read Chartink screeners from the browser.
// Chartink does not send CORS headers, so the browser cannot call it directly.
//
//   GET /search?q=<screener name>  -> { screeners: [{ name, slug, updatedAt }] }
//   GET /run?slug=<screener slug>  -> { name, slug, count, stocks: [{ sr, nsecode, name, close, per_chg, volume }] }
//
// Fund holdings scan (data from Groww and Yahoo Finance):
//   GET /fund/search?q=<fund name>      -> { funds: [{ id, name }] }
//   GET /fund/holdings?id=<fund id>     -> { id, name, portfolioDate, holdings: [{ name, searchId, instrument, weight }] }
//   GET /candles?sid=<stock id>&name=..&tf=hour|day|week|month -> { symbol, exchange, displayName, bars: [{ t, o, h, l, c }] }
//       tf=hour: 1-hour bars for 1 year; day/week/month: daily bars for 2/5/10 years (the page groups them)

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

      if (url.pathname === '/fund/holdings') {
        const id = url.searchParams.get('id') || '';
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

      return json(request, { error: 'Not found.' }, 404);
    } catch (err) {
      return json(request, { error: err.message || 'Something went wrong.' }, 502);
    }
  },
};
