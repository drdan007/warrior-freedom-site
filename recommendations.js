/**
 * Warrior Freedom AI — Recommendations API
 *
 * GET /api/recommendations
 *
 * Vercel serverless function. Pulls SPX + RUT chains from Alpha Vantage,
 * applies the standing put-credit-spread rules, runs a Black-Scholes QC
 * pass, and returns JSON.
 *
 * Caching strategy:
 *   The response is cacheable until the next "refresh window" — defined
 *   as 11:30 AM America/New_York each day. Vercel's edge CDN holds the
 *   response for that duration via Cache-Control s-maxage. Subsequent
 *   visitors get instant CDN hits within the same window.
 *
 * Required env var (set in Vercel dashboard → Settings → Environment Variables):
 *   ALPHA_VANTAGE_KEY
 *
 * Optional:
 *   RISK_FREE_RATE   default 0.05
 *   VIX_OVERRIDE     default = fetch via API; fallback 20.0
 *   SYMBOLS          default "SPX,RUT"
 *   DTES             default "7,14,28,45"
 */

// ─── Config (mirrors Master Prompt v6.0) ───────────────────────────────
const SPREAD_WIDTH    = 25;
const MAX_DELTA_ABS   = 0.10;
const MIN_YOR         = 0.04;
const PROFIT_TGT_LOW  = 0.50;
const PROFIT_TGT_HIGH = 0.70;
const STOP_LOSS_X     = 2.0;
const QC_TOLERANCE    = 0.30;

// ─── Black-Scholes ────────────────────────────────────────────────────
function normCdf(x) {
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741;
  const a4=-1.453152027, a5=1.061405429, p=0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1) * t * Math.exp(-ax*ax);
  return 0.5 * (1 + sign * y);
}
function bsPutPrice(S, K, T, r, sigma) {
  if (T <= 0 || sigma <= 0) return Math.max(K - S, 0);
  const d1 = (Math.log(S/K) + (r + 0.5*sigma*sigma)*T) / (sigma*Math.sqrt(T));
  const d2 = d1 - sigma*Math.sqrt(T);
  return K*Math.exp(-r*T)*normCdf(-d2) - S*normCdf(-d1);
}

// ─── Cache window ─────────────────────────────────────────────────────
/**
 * Return seconds until the next 11:30 AM America/New_York refresh.
 * Falls back to 1 hour if computation fails (defensive).
 */
function secondsUntilNextRefresh() {
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour12: false,
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
    const nyHour = parseInt(parts.hour, 10);
    const nyMin  = parseInt(parts.minute, 10);
    const nySec  = parseInt(parts.second, 10);
    const cutoffSeconds = 11 * 3600 + 30 * 60; // 11:30:00 AM ET
    const nowSecondsIntoDay = nyHour * 3600 + nyMin * 60 + nySec;

    const secondsUntil = nowSecondsIntoDay < cutoffSeconds
      ? cutoffSeconds - nowSecondsIntoDay
      : (24 * 3600 - nowSecondsIntoDay) + cutoffSeconds;

    return Math.max(60, secondsUntil);
  } catch {
    return 3600;
  }
}

// ─── Alpha Vantage ────────────────────────────────────────────────────
async function avFetch(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'WarriorFreedomAI/1.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function fetchOptionsChain(symbol, apiKey) {
  const rt = await avFetch(
    `https://www.alphavantage.co/query?function=REALTIME_OPTIONS&symbol=${symbol}&require_greeks=true&apikey=${apiKey}`
  );
  if (Array.isArray(rt?.data) && rt.data.length > 0) {
    return { source: 'REALTIME_OPTIONS', data: rt.data, asOf: rt.data[0]?.date || 'now' };
  }
  const hist = await avFetch(
    `https://www.alphavantage.co/query?function=HISTORICAL_OPTIONS&symbol=${symbol}&apikey=${apiKey}`
  );
  if (Array.isArray(hist?.data) && hist.data.length > 0) {
    return { source: 'HISTORICAL_OPTIONS', data: hist.data, asOf: hist.data[0]?.date || 'unknown' };
  }
  const msg = rt?.Information || rt?.['Error Message'] || rt?.Note ||
              hist?.Information || hist?.['Error Message'] || hist?.Note ||
              'No data returned';
  throw new Error(msg);
}

async function fetchVIX(apiKey) {
  if (process.env.VIX_OVERRIDE) return parseFloat(process.env.VIX_OVERRIDE);
  for (const sym of ['VIX', 'VIXY']) {
    try {
      const r = await avFetch(
        `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${sym}&apikey=${apiKey}`
      );
      const px = parseFloat(r?.['Global Quote']?.['05. price']);
      if (px > 0 && px < 200) return px;
    } catch { /* fall through */ }
  }
  return null;
}

// ─── Spread analysis ──────────────────────────────────────────────────
function inferSpot(chain) {
  const puts = chain.filter(o => (o.type || '').toLowerCase() === 'put' && o.delta != null);
  if (!puts.length) return null;
  puts.sort((a, b) =>
    Math.abs(Math.abs(parseFloat(a.delta)) - 0.50) -
    Math.abs(Math.abs(parseFloat(b.delta)) - 0.50)
  );
  return parseFloat(puts[0].strike);
}

function findBestSpread(puts, targetDTE, spot, vixBufferPct, todayStr) {
  const byExp = new Map();
  for (const p of puts) {
    if (!byExp.has(p.expiration)) byExp.set(p.expiration, []);
    byExp.get(p.expiration).push(p);
  }
  const today = new Date(todayStr + 'T00:00:00Z');
  let bestExp = null, bestDiff = Infinity, bestDte = 0;
  for (const exp of byExp.keys()) {
    const dte = Math.round((new Date(exp + 'T00:00:00Z') - today) / 86400000);
    if (dte < 1) continue;
    const diff = Math.abs(dte - targetDTE);
    if (diff < bestDiff) { bestDiff = diff; bestExp = exp; bestDte = dte; }
  }
  if (!bestExp) return { error: 'No future expirations in chain' };

  const expPuts = byExp.get(bestExp);
  const minStrikeBelowSpot = spot * (1 - vixBufferPct / 100);

  const candidates = expPuts
    .filter(p => {
      const d = Math.abs(parseFloat(p.delta || 0));
      return d > 0 && d <= MAX_DELTA_ABS && parseFloat(p.strike) <= minStrikeBelowSpot;
    })
    .sort((a, b) => parseFloat(b.strike) - parseFloat(a.strike));

  if (!candidates.length) {
    return {
      error: `No short strike satisfies |Δ|≤${MAX_DELTA_ABS} AND ≥${vixBufferPct}% below spot`,
      dte: bestDte, expiry: bestExp,
    };
  }

  for (const sLeg of candidates) {
    const sK = parseFloat(sLeg.strike);
    const lK = sK - SPREAD_WIDTH;
    const lLeg = expPuts.find(p => parseFloat(p.strike) === lK);
    if (!lLeg) continue;

    const sBid = parseFloat(sLeg.bid || 0);
    const lAsk = parseFloat(lLeg.ask || 0);
    if (sBid <= 0 || lAsk <= 0) continue;

    const credit = +(sBid - lAsk).toFixed(2);
    if (credit <= 0) continue;
    const maxLoss = +(SPREAD_WIDTH - credit).toFixed(2);
    const yor = credit / maxLoss;
    if (yor < MIN_YOR) continue;

    return {
      dte: bestDte, expiry: bestExp,
      shortStrike: sK, longStrike: lK,
      shortBid: sBid, longAsk: lAsk,
      shortDelta: parseFloat(sLeg.delta || 0),
      shortIV: parseFloat(sLeg.implied_volatility || 0),
      longIV:  parseFloat(lLeg.implied_volatility  || 0),
      credit, maxLoss, yor,
      profitTgtLow:  +(credit * PROFIT_TGT_LOW).toFixed(2),
      profitTgtHigh: +(credit * PROFIT_TGT_HIGH).toFixed(2),
      stopLossDebit: +(credit + credit * STOP_LOSS_X).toFixed(2),
    };
  }
  return {
    error: `No spread passes YoR≥${MIN_YOR*100}% with valid quotes`,
    dte: bestDte, expiry: bestExp,
  };
}

function runQC(rec, spot, riskFreeRate) {
  if (rec.error) return null;
  const T = rec.dte / 365;
  const bsShort = bsPutPrice(spot, rec.shortStrike, T, riskFreeRate, rec.shortIV);
  const bsLong  = bsPutPrice(spot, rec.longStrike,  T, riskFreeRate, rec.longIV);
  const bsCredit = bsShort - bsLong;
  const drift = Math.abs(bsCredit - rec.credit) / Math.max(rec.credit, 0.01);
  return {
    bsCredit: +bsCredit.toFixed(2),
    drift: +drift.toFixed(3),
    pass: drift < QC_TOLERANCE
  };
}

// ─── Module-level memoization (survives between warm invocations) ────
let memCache = { key: null, payload: null };

function currentRefreshKey() {
  // Identifier for the current refresh window — changes daily at 11:30 AM ET.
  // Before 11:30 AM ET → key is yesterday's date.
  // At/after 11:30 AM ET → key is today's date.
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  const nyMinutesIntoDay = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
  const past1130 = nyMinutesIntoDay >= (11 * 60 + 30);

  const todayNy = `${parts.year}-${parts.month}-${parts.day}`;
  if (past1130) return todayNy;

  // Yesterday in NY tz: subtract one day from the NY-date midnight (treated
  // as UTC for safe arithmetic — NY date never crosses a UTC boundary at
  // mid-morning, so this is unambiguous).
  const anchor = new Date(`${todayNy}T00:00:00Z`);
  anchor.setUTCDate(anchor.getUTCDate() - 1);
  return anchor.toISOString().slice(0, 10);
}

// ─── Handler ──────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  const apiKey = process.env.ALPHA_VANTAGE_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'ALPHA_VANTAGE_KEY env var not set in Vercel.' });
    return;
  }

  const symbols = (process.env.SYMBOLS || 'SPX,RUT').split(',').map(s => s.trim());
  const dtes = (process.env.DTES || '7,14,28,45').split(',').map(s => parseInt(s.trim(), 10));
  const riskFreeRate = parseFloat(process.env.RISK_FREE_RATE || '0.05');

  // Cache headers — CDN holds response until next 11:30 AM ET
  const ttl = secondsUntilNextRefresh();
  res.setHeader('Cache-Control', `public, s-maxage=${ttl}, stale-while-revalidate=300`);
  res.setHeader('X-Cache-TTL-Seconds', String(ttl));

  // Module-level memo (avoids re-fetching if the same warm instance handles
  // multiple requests within the window)
  const key = currentRefreshKey();
  if (memCache.key === key && memCache.payload) {
    res.setHeader('X-Memo', 'hit');
    res.status(200).json(memCache.payload);
    return;
  }

  try {
    const todayStr = new Date().toISOString().slice(0,10);
    let vix = await fetchVIX(apiKey);
    let vixSource = 'api';
    if (vix == null) { vix = 20.0; vixSource = 'fallback'; }
    const vixBufferPct = vix >= 25 ? 20 : 15;

    const recommendations = [];
    const meta = { symbols: {}, vix, vixSource, vixBufferPct, riskFreeRate, generatedAt: new Date().toISOString() };

    for (const symbol of symbols) {
      let chain;
      try {
        chain = await fetchOptionsChain(symbol, apiKey);
      } catch (e) {
        meta.symbols[symbol] = { error: e.message };
        for (const dte of dtes) recommendations.push({ symbol, targetDTE: dte, error: e.message });
        continue;
      }
      const puts = chain.data.filter(o => (o.type || '').toLowerCase() === 'put');
      const spot = inferSpot(chain.data);
      meta.symbols[symbol] = { source: chain.source, asOf: chain.asOf, contracts: chain.data.length, spot };
      if (!spot) {
        for (const dte of dtes) recommendations.push({ symbol, targetDTE: dte, error: 'Spot not inferable' });
        continue;
      }
      for (const targetDTE of dtes) {
        const rec = findBestSpread(puts, targetDTE, spot, vixBufferPct, todayStr);
        const qc  = runQC(rec, spot, riskFreeRate);
        recommendations.push({ symbol, targetDTE, spot, ...rec, qc });
      }
    }

    const payload = {
      generatedAt: meta.generatedAt,
      refreshKey: key,
      nextRefreshInSeconds: ttl,
      rules: {
        spreadWidth: SPREAD_WIDTH,
        maxDeltaAbs: MAX_DELTA_ABS,
        minYieldOnRisk: MIN_YOR,
        profitTargetRange: [PROFIT_TGT_LOW, PROFIT_TGT_HIGH],
        stopLossMultiple: STOP_LOSS_X,
        vixBufferLow: 0.15,
        vixBufferHigh: 0.20,
      },
      meta,
      recommendations,
    };

    memCache = { key, payload };
    res.status(200).json(payload);
  } catch (e) {
    res.status(502).json({ error: e.message || 'Upstream failure' });
  }
};
