// Cloudflare Worker: lets the Finance Suite site read Chartink screeners from the browser.
// Chartink does not send CORS headers, so the browser cannot call it directly.
//
//   GET /search?q=<screener name>  -> { screeners: [{ name, slug, updatedAt }] }
//   GET /run?slug=<screener slug>  -> { name, slug, count, stocks: [{ sr, nsecode, name, close, per_chg, volume }] }

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

      return json(request, { error: 'Not found.' }, 404);
    } catch (err) {
      return json(request, { error: err.message || 'Something went wrong.' }, 502);
    }
  },
};
