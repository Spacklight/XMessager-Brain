/**
 * X-Messenger-Brain — Cloudflare Worker
 * Sits between the frontend and the Datasets Controller (DC).
 *
 * Bindings expected:
 *   env.BRAIN_DB     - D1 database (binding "BRAIN_DB")
 *   env.DC_BASE_URL  - base URL of the Datasets Controller Worker
 *   env.ADMIN_TOKEN  - password for /admin and /api/admin/*, secret
 */

const VIRAL_VIEW_THRESHOLD = 500;
const FRIENDLY_ERROR = "High Demand, please wait";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const loc = getLocation(request);

    try {
      if (url.pathname === "/api/upload" && request.method === "POST") return await handleUpload(request, env, cors, loc);
      if (url.pathname === "/api/feed" && request.method === "GET") return await handleFeed(request, env, cors, loc);
      if (url.pathname === "/api/search" && request.method === "GET") return await handleSearch(request, env, cors, loc);

      const viewMatch = url.pathname.match(/^\/api\/videos\/([a-f0-9-]+)\/view$/);
      if (viewMatch && request.method === "POST") return await handleView(viewMatch[1], env, cors);

      const likeMatch = url.pathname.match(/^\/api\/videos\/([a-f0-9-]+)\/like$/);
      if (likeMatch && request.method === "POST") return await proxyToDC(request, env, cors, `/api/videos/${likeMatch[1]}/like`, "POST");
      const saveMatch = url.pathname.match(/^\/api\/videos\/([a-f0-9-]+)\/save$/);
      if (saveMatch && request.method === "POST") return await proxyToDC(request, env, cors, `/api/videos/${saveMatch[1]}/save`, "POST");
      const shareMatch = url.pathname.match(/^\/api\/videos\/([a-f0-9-]+)\/share$/);
      if (shareMatch && request.method === "POST") return await proxyToDC(request, env, cors, `/api/videos/${shareMatch[1]}/share`, "POST");
      const commentMatch = url.pathname.match(/^\/api\/videos\/([a-f0-9-]+)\/comments$/);
      if (commentMatch && request.method === "GET") return await proxyToDC(request, env, cors, `/api/videos/${commentMatch[1]}/comments`, "GET");
      if (commentMatch && request.method === "POST") return await proxyToDC(request, env, cors, `/api/videos/${commentMatch[1]}/comments`, "POST");
      if (url.pathname === "/api/videos/follow" && request.method === "POST") return await proxyToDC(request, env, cors, `/api/videos/follow`, "POST");
      if (url.pathname === "/api/my/stats" && request.method === "GET") return await proxyToDC(request, env, cors, `/api/my/stats?${url.searchParams}`, "GET");

      if (url.pathname === "/admin" && request.method === "GET") return adminPage(cors);
      if (url.pathname === "/api/admin/stats" && request.method === "GET") return await withAdmin(request, env, cors, adminStats);

      return json({ error: "Not found" }, 404, cors);
    } catch (err) {
      await logError(env, err.message || "Unknown error", loc);
      return json({ error: FRIENDLY_ERROR }, 503, cors);
    }
  },
};

function getLocation(request) {
  return {
    continent: request.cf?.continent || null,
    country: request.cf?.country || null,
    ip: request.headers.get("CF-Connecting-IP") || "",
  };
}

async function logVisit(env, path, loc) {
  try {
    await env.BRAIN_DB.prepare(
      `INSERT INTO visits (continent, country, ip, path, created_at) VALUES (?,?,?,?,?)`
    ).bind(loc.continent, loc.country, loc.ip, path, Date.now()).run();
  } catch (_) { /* logging must never break the request */ }
}

async function logError(env, message, loc) {
  try {
    await env.BRAIN_DB.prepare(
      `INSERT INTO error_logs (message, continent, country, ip, created_at) VALUES (?,?,?,?,?)`
    ).bind(message, loc.continent, loc.country, loc.ip, Date.now()).run();
  } catch (_) { /* never throw from the logger itself */ }
}

// ---------- upload ----------

async function handleUpload(request, env, cors, loc) {
  await logVisit(env, "/api/upload", loc);

  const incoming = await request.formData();
  const forward = new FormData();
  for (const [key, value] of incoming.entries()) forward.append(key, value);
  forward.set("continent", loc.continent || "AF");
  if (loc.country) forward.set("country", loc.country);

  let dcRes;
  try {
    dcRes = await env.DC.fetch(new Request("https://dc/api/upload", { method: "POST", body: forward }));
  } catch (err) {
    await logError(env, `DC unreachable: ${err.message}`, loc);
    return json({ error: FRIENDLY_ERROR }, 503, cors);
  }

  const data = await dcRes.json();
  if (!dcRes.ok) {
    await logError(env, `DC upload failed: ${JSON.stringify(data)}`, loc);
    return json({ error: FRIENDLY_ERROR }, 503, cors);
  }

  return json(data, 200, cors);
}

// ---------- location-aware feed ----------

async function handleFeed(request, env, cors, loc) {
  await logVisit(env, "/api/feed", loc);
  const url = new URL(request.url);
  const continent = url.searchParams.get("continent") || loc.continent || "AF";
  const country = url.searchParams.get("country") || loc.country;
  const userId = url.searchParams.get("user_id");
  const category = url.searchParams.get("category");

  let localRes, viralRes;
  try {
    const localParams = new URLSearchParams({ continent, limit: "15" });
    if (country) localParams.set("country", country);
    if (userId) localParams.set("user_id", userId);
    if (category) localParams.set("category", category);
    localRes = await env.DC.fetch(new Request(`https://dc/api/videos?${localParams}`));

    const viralParams = new URLSearchParams({ min_views: String(VIRAL_VIEW_THRESHOLD), limit: "10" });
    if (userId) viralParams.set("user_id", userId);
    viralRes = await env.DC.fetch(new Request(`https://dc/api/videos?${viralParams}`));
  } catch (err) {
    await logError(env, `DC unreachable on feed: ${err.message}`, loc);
    return json({ error: FRIENDLY_ERROR }, 503, cors);
  }

  if (!localRes.ok) {
    await logError(env, `DC feed failed: ${await localRes.text()}`, loc);
    return json({ error: FRIENDLY_ERROR }, 503, cors);
  }

  const local = (await localRes.json()).videos || [];
  const viral = viralRes.ok ? (await viralRes.json()).videos || [] : [];

  const seen = new Set(local.map((v) => v.id));
  const merged = [...local, ...viral.filter((v) => !seen.has(v.id)).map((v) => ({ ...v, viral: true }))];

  return json({ videos: merged }, 200, cors);
}

// ---------- smart search ----------

async function handleSearch(request, env, cors, loc) {
  await logVisit(env, "/api/search", loc);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const userId = url.searchParams.get("user_id");
  if (!q) return json({ videos: [] }, 200, cors);

  let dcRes;
  try {
    const searchParams = new URLSearchParams({ q, limit: "60" });
    if (userId) searchParams.set("user_id", userId);
    dcRes = await env.DC.fetch(new Request(`https://dc/api/search?${searchParams}`));
  } catch (err) {
    await logError(env, `DC unreachable on search: ${err.message}`, loc);
    return json({ error: FRIENDLY_ERROR }, 503, cors);
  }
  if (!dcRes.ok) {
    await logError(env, `DC search failed: ${await dcRes.text()}`, loc);
    return json({ error: FRIENDLY_ERROR }, 503, cors);
  }

  const candidates = (await dcRes.json()).videos || [];
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);

  const scored = candidates.map((v) => {
    const title = (v.title || "").toLowerCase();
    const desc = (v.description || "").toLowerCase();
    let score = 0;
    for (const w of words) {
      if (title === w) score += 5;
      if (title.includes(w)) score += 3;
      if (desc.includes(w)) score += 1;
    }
    score += Math.min(2, (v.view_count || 0) / 1000); // small popularity boost
    return { ...v, _score: score };
  });

  scored.sort((a, b) => b._score - a._score);
  const results = scored.filter((v) => v._score > 0).slice(0, 30).map(({ _score, ...v }) => v);

  return json({ videos: results }, 200, cors);
}

// ---------- view counting (proxy) ----------

async function handleView(id, env, cors) {
  try {
    await env.DC.fetch(new Request(`https://dc/api/videos/${id}/view`, { method: "POST" }));
  } catch (_) { /* non-critical, don't fail the request over this */ }
  return json({ ok: true }, 200, cors);
}

// ---------- admin ----------

async function withAdmin(request, env, cors, handler) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return json({ error: "Unauthorized" }, 401, cors);
  return handler(env, cors);
}

async function adminStats(env, cors) {
  const totalVisits = await env.BRAIN_DB.prepare(`SELECT COUNT(*) as c FROM visits`).first();
  const totalErrors = await env.BRAIN_DB.prepare(`SELECT COUNT(*) as c FROM error_logs`).first();
  const { results: byCountry } = await env.BRAIN_DB.prepare(
    `SELECT country, COUNT(*) as c FROM visits WHERE country IS NOT NULL GROUP BY country ORDER BY c DESC LIMIT 20`
  ).all();

  // last 14 days, bucketed by day
  const since = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const { results: visitRows } = await env.BRAIN_DB.prepare(
    `SELECT created_at FROM visits WHERE created_at >= ?`
  ).bind(since).all();
  const { results: errorRows } = await env.BRAIN_DB.prepare(
    `SELECT created_at, message FROM error_logs WHERE created_at >= ? ORDER BY created_at DESC`
  ).bind(since).all();

  const dailyVisits = bucketByDay(visitRows.map((r) => r.created_at));
  const dailyErrors = bucketByDay(errorRows.map((r) => r.created_at));
  const recentErrors = errorRows.slice(0, 30);

  return json({ totalVisits, totalErrors, byCountry, dailyVisits, dailyErrors, recentErrors }, 200, cors);
}

function bucketByDay(timestamps) {
  const days = {};
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    days[d.toISOString().slice(0, 10)] = 0;
  }
  for (const t of timestamps) {
    const key = new Date(t).toISOString().slice(0, 10);
    if (key in days) days[key]++;
  }
  return Object.entries(days).map(([date, count]) => ({ date, count }));
}

function adminPage(cors) {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Brain Admin</title>
<style>
body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:16px}
h1{font-size:1.2rem} h2{font-size:1rem;margin-top:2rem;color:#9fd3ff}
input,button{padding:8px;margin:4px 0;border-radius:6px;border:1px solid #333;background:#1b1e26;color:#eee;width:100%;box-sizing:border-box}
button{background:#3468e0;border:none;cursor:pointer;font-weight:600}
table{width:100%;border-collapse:collapse;margin-top:8px;font-size:.85rem}
td,th{border-bottom:1px solid #2a2d36;padding:6px;text-align:left}
.hidden{display:none}
svg{background:#1b1e26;border-radius:8px}
</style></head>
<body>
<div id="login">
<h1>X-Messenger-Brain Admin</h1>
<input id="tok" type="password" placeholder="Admin token">
<button onclick="doLogin()">Enter</button>
</div>
<div id="dash" class="hidden">
<h1>Brain Admin Dashboard</h1>
<h2>Overview</h2>
<div id="overview"></div>
<h2>Visits per day (last 14 days)</h2>
<div id="visitsChart"></div>
<h2>Errors per day (last 14 days)</h2>
<div id="errorsChart"></div>
<h2>Top countries</h2>
<table id="countryTable"><thead><tr><th>Country</th><th>Visits</th></tr></thead><tbody></tbody></table>
<h2>Recent errors</h2>
<table id="errorTable"><thead><tr><th>When</th><th>Message</th></tr></thead><tbody></tbody></table>
</div>
<script>
let TOKEN = localStorage.getItem('brain_admin_token') || '';
async function api(path, opts={}) {
  const res = await fetch(path, { ...opts, headers: { ...(opts.headers||{}), Authorization: 'Bearer '+TOKEN } });
  if (res.status === 401) { localStorage.removeItem('brain_admin_token'); document.getElementById('login').classList.remove('hidden'); document.getElementById('dash').classList.add('hidden'); throw new Error('Unauthorized'); }
  return res.json();
}
async function doLogin(){
  TOKEN = document.getElementById('tok').value;
  try { await api('/api/admin/stats'); localStorage.setItem('brain_admin_token', TOKEN);
    document.getElementById('login').classList.add('hidden'); document.getElementById('dash').classList.remove('hidden'); loadAll();
  } catch(e) { alert('Wrong token'); }
}
function lineChart(data, color){
  const w = 320, h = 120, pad = 10;
  const max = Math.max(1, ...data.map(d=>d.count));
  const stepX = (w - pad*2) / (data.length - 1 || 1);
  const points = data.map((d,i)=> \`\${pad + i*stepX},\${h - pad - (d.count/max)*(h-pad*2)}\`).join(' ');
  return \`<svg viewBox="0 0 \${w} \${h}" width="100%" height="140">
    <polyline points="\${points}" fill="none" stroke="\${color}" stroke-width="2"/>
  </svg>\`;
}
async function loadAll(){
  const s = await api('/api/admin/stats');
  document.getElementById('overview').innerHTML = \`<p>\${s.totalVisits.c} total visits, \${s.totalErrors.c} total errors logged.</p>\`;
  document.getElementById('visitsChart').innerHTML = lineChart(s.dailyVisits, '#3468e0');
  document.getElementById('errorsChart').innerHTML = lineChart(s.dailyErrors, '#e04834');
  document.querySelector('#countryTable tbody').innerHTML = s.byCountry.map(c=>\`<tr><td>\${c.country}</td><td>\${c.c}</td></tr>\`).join('') || '<tr><td colspan="2">No data yet.</td></tr>';
  document.querySelector('#errorTable tbody').innerHTML = s.recentErrors.map(e=>\`<tr><td>\${new Date(e.created_at).toLocaleString()}</td><td>\${e.message}</td></tr>\`).join('') || '<tr><td colspan="2">No errors logged.</td></tr>';
}
if (TOKEN) { document.getElementById('login').classList.add('hidden'); document.getElementById('dash').classList.remove('hidden'); loadAll().catch(()=>{}); }
</script>
</body></html>`;
  return new Response(html, { headers: { ...cors, "Content-Type": "text/html;charset=utf-8" } });
}

async function proxyToDC(request, env, cors, path, method) {
  try {
    const init = { method };
    if (method === "POST") {
      init.body = await request.text();
      init.headers = { "Content-Type": "application/json" };
    }
    const dcRes = await env.DC.fetch(new Request(`https://dc${path}`, init));
    const data = await dcRes.json().catch(() => ({}));
    return json(data, dcRes.status, cors);
  } catch (err) {
    return json({ error: FRIENDLY_ERROR }, 503, cors);
  }
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
