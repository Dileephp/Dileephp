# Chartink proxy

Chartink does not allow other websites to read its data from the browser (no CORS). This
small Cloudflare Worker fetches screener results for the **Chartink Screener** tab.

## Deploy (free, about 10 minutes)

1. Create a free account at <https://dash.cloudflare.com/sign-up>.
2. Go to **Workers & Pages** -> **Create** -> **Create Worker**, name it (for example `chartink-proxy`) and click **Deploy**.
3. Click **Edit code**, replace everything with the contents of `chartink-proxy.js`, and click **Deploy**.
4. Copy the Worker address, for example `https://chartink-proxy.your-name.workers.dev`.
5. Open the site, go to **Stocks -> Chartink Screener**, open **Proxy server address**, paste the address and search.
   The address is remembered on that device.

To avoid pasting it on every device, set `DEFAULT_CHARTINK_PROXY` near the top of the screener code in `js/app.js` to your address.

## Endpoints

- `GET /search?q=<screener name>` returns matching public screeners.
- `GET /run?slug=<screener slug>` returns the stocks the screener lists right now.
- `GET /fund/search?q=<fund name>` returns matching mutual funds / SIFs (from Groww).
- `GET /fund/lists` returns every SIF and the 200 largest equity and hybrid mutual funds by assets (from Groww), for the fund picker.
- `GET /fund/holdings?id=<fund id>` returns the fund's latest disclosed stock holdings, including futures and short positions.
- `GET /candles?sid=<stock id>&name=<company name>` returns about one year of 1-hour candles (from Yahoo Finance) for the
  **Fund Holdings Scan** tab, which builds 3-hour candles from them.
- `GET /options/chain?index=<index>&expiry=<YYYY-MM-DD>` returns the live index value, its option expiries and the option
  contracts near it (from Groww). `index` is `nifty`, `banknifty`, `finnifty`, `midcpnifty` or `sensex`.
- `GET /options/candles?index=<index>&id=<contract>&m=1|3|5|30|60` returns candles for one option contract, for the
  **Index Options Scan** section of the Fund Holdings Scan tab.

After updating the Worker code, redeploy it so the Fund Holdings Scan tab and the Index Options Scan can use these endpoints.

## Notes

- Only public screeners work. Private screeners return an error.
- Only `https://dileephp.github.io` and `http://localhost:<port>` may call the Worker. Add your own domain to `ALLOWED_ORIGINS` if you host the site elsewhere.
- Results come from Chartink's live data, so a screener can return no stocks outside market hours.
- This reads Chartink's website, not an official API. Chartink can change its pages, and its terms of use apply, so keep usage light and personal.
