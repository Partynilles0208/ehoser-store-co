'use strict';

// Mounted after the existing JWT middleware. No client-supplied plan flags are trusted.
const GOOGLE_ORIGIN = 'https://tile.googleapis.com';
const WORLD_RADIUS = 1000;
const USER_AGENT = 'ehoser-EarthDrive/1.0 (+https://www.ehoser.de)';
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

async function sendJson(res, value) {
  // Stream larger OSM/manifests instead of exceeding Vercel's buffered body limit.
  const json = Buffer.from(JSON.stringify(value), 'utf8');
  res.type('application/json');
  async function* chunks() { for (let i = 0; i < json.length; i += 32768) yield json.subarray(i, i + 32768); }
  await pipeline(Readable.from(chunks()), res);
}

function fault(status, message) { return Object.assign(new Error(message), { status }); }
function coordinates(query) {
  if (typeof query.lat !== 'string' || typeof query.lon !== 'string' || !query.lat.trim() || !query.lon.trim()) {
    throw fault(400, 'Bitte einen Ort auf der Karte auswählen.');
  }
  const lat = Number(query.lat), lon = Number(query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) {
    throw fault(400, 'Dieser Kartenausschnitt wird nicht unterstützt.');
  }
  return { lat, lon };
}

function tileUrl(value, key) {
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('/v1/3dtiles/')) {
    throw fault(400, 'Ungültige 3D-Kachel.');
  }
  const url = new URL(value, GOOGLE_ORIGIN);
  if (url.origin !== GOOGLE_ORIGIN || !/^\/v1\/3dtiles\/[\w/.-]+$/.test(url.pathname) || url.hash) {
    throw fault(400, 'Ungültige 3D-Kachel.');
  }
  for (const name of [...url.searchParams.keys()]) {
    if (!['key', 'session'].includes(name)) url.searchParams.delete(name);
  }
  url.searchParams.set('key', key);
  return url;
}

function rewriteTiles(value, base) {
  if (Array.isArray(value)) return value.map(item => rewriteTiles(item, base));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [name, item] of Object.entries(value)) {
    if ((name === 'uri' || name === 'url') && typeof item === 'string' && !item.startsWith('data:')) {
      const url = new URL(item, base);
      if (url.origin !== GOOGLE_ORIGIN || !url.pathname.startsWith('/v1/3dtiles/')) {
        throw fault(502, 'Unbekannte 3D-Datenquelle.');
      }
      // Child manifests can omit the session inherited from the root request.
      if (!url.searchParams.has('session') && base.searchParams.has('session')) {
        url.searchParams.set('session', base.searchParams.get('session'));
      }
      url.searchParams.delete('key');
      output[name] = `/api/earthdrive/tiles?path=${encodeURIComponent(url.pathname + url.search)}`;
    } else output[name] = rewriteTiles(item, base);
  }
  return output;
}

async function boundedBody(response, limit = 12 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > limit) throw fault(502, 'Kartendaten sind zu groß.');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw fault(502, 'Kartendaten sind zu groß.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function mountEarthDrive(app, { readAuthUser, getProfile, env = process.env, fetchImpl = fetch, now = Date.now }) {
  const cache = new Map(), pending = new Map(), limits = new Map(), profiles = new Map();
  const mapsKey = typeof env.GOOGLE_MAPS_API_KEY === 'string' ? env.GOOGLE_MAPS_API_KEY.trim() : '';
  // Vercel's short first-request window can expire while a Google root tileset
  // is fetched through this function. Direct browser loading is the default;
  // set EARTHDRIVE_DIRECT_TILES=false to keep using the authenticated proxy.
  const directTiles = env.EARTHDRIVE_DIRECT_TILES !== 'false';
  const trim = (map, max) => { while (map.size > max) map.delete(map.keys().next().value); };
  async function cached(key, ttl, loader) {
    const entry = cache.get(key);
    if (entry && entry.expires > now()) return entry.value;
    if (pending.has(key)) return pending.get(key);
    const promise = loader().then(value => {
      cache.set(key, { value, expires: now() + ttl });
      trim(cache, 48);
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  }
  function limit(user, kind, count) {
    const key = `${user}:${kind}`, time = now();
    let entry = limits.get(key);
    if (!entry || entry.expires <= time) entry = { count: 0, expires: time + 60000 };
    entry.count += 1;
    limits.set(key, entry);
    trim(limits, 4000);
    if (entry.count > count) throw fault(429, 'Zu viele Kartenanfragen. Bitte kurz warten.');
  }
  async function remote(url, options = {}, timeout = 18000) {
    const response = await fetchImpl(url, {
      ...options, redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: { 'User-Agent': USER_AGENT, ...options.headers }
    });
    if (!response.ok) throw Object.assign(fault(502, 'Der Kartendienst ist gerade nicht verfügbar. Bitte erneut versuchen.'), { upstreamStatus: response.status });
    return response;
  }

  app.use('/api/earthdrive', async (req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Vary', 'Authorization');
    const auth = readAuthUser(req, res);
    if (!auth) return;
    if (!auth.username) return res.status(401).json({ error: 'Bitte erneut anmelden.' });
    try {
      // Only tile bursts share a short server-side lookup. The subscription deadline
      // still applies to every request; config/world/search always recheck the account.
      let entry = req.path === '/tiles' && profiles.get(auth.username);
      if (!entry || entry.expires <= now()) {
        const profile = await getProfile(auth.username);
        const until = Math.max(Date.parse(profile.proUntil) || 0, Date.parse(profile.premiumUntil) || 0);
        entry = { allowed: profile.isPro === true && until > now(), expires: Math.min(now() + 15000, until), until };
        profiles.set(auth.username, entry);
        trim(profiles, 2000);
      }
      if (!entry.allowed || entry.until <= now()) {
        return res.status(403).json({ code: 'PRO_REQUIRED', error: 'EarthDrive ist für ehoser Pro und Premium verfügbar.' });
      }
      req.earthDrive = { username: auth.username, expiresAt: Math.min(entry.until, now() + 120000) };
      next();
    } catch { res.status(503).json({ error: 'Dein Pro-Zugang konnte gerade nicht geprüft werden.' }); }
  });

  const route = (url, handler) => app.get(`/api/earthdrive/${url}`, async (req, res) => {
    try { await handler(req, res); }
    catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      if (error.status === 429) res.setHeader('Retry-After', '60');
      res.status(error.status || 502).json({ error: error.status ? error.message : 'Kartendienst nicht erreichbar. Bitte erneut versuchen.' });
    }
  });

  route('config', async (req, res) => {
    limit(req.earthDrive.username, 'config', 20);
    res.json({
      google3d: Boolean(mapsKey), expiresAt: req.earthDrive.expiresAt,
      tileUrl: directTiles && mapsKey
        ? `${GOOGLE_ORIGIN}/v1/3dtiles/root.json?key=${encodeURIComponent(mapsKey)}`
        : '/api/earthdrive/tiles?path=%2Fv1%2F3dtiles%2Froot.json',
      osmTileUrl: env.EARTHDRIVE_OSM_TILES || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      worldRadius: WORLD_RADIUS
    });
  });

  route('search', async (req, res) => {
    limit(req.earthDrive.username, 'search', 12);
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length < 2 || q.length > 160) throw fault(400, 'Bitte einen Ortsnamen mit 2 bis 160 Zeichen eingeben.');
    const results = await cached(`search:${q.toLowerCase()}`, 3600000, async () => {
      const url = new URL(env.EARTHDRIVE_GEOCODER_URL || 'https://photon.komoot.io/api/');
      url.searchParams.set('q', q);
      url.searchParams.set('limit', '6');
      url.searchParams.set('lang', 'de');
      const response = await remote(url, {}, 10000);
      const data = JSON.parse((await boundedBody(response, 1024 * 1024)).toString('utf8'));
      return (data.features || []).map(feature => {
        const p = feature.properties || {}, [lon, lat] = feature.geometry?.coordinates || [];
        const name = p.name || p.street || p.city || 'Ort';
        return { name, label: [...new Set([name, p.city, p.state, p.country].filter(Boolean))].join(', '), lat, lon };
      }).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 85);
    });
    res.json({ results });
  });

  route('world', async (req, res) => {
    limit(req.earthDrive.username, 'world', 24);
    const point = coordinates(req.query);
    const lat = Number((Math.round(point.lat / .004) * .004).toFixed(3));
    const lon = Number((Math.round(point.lon / .004) * .004).toFixed(3));
    const world = await cached(`world:${lat}:${lon}`, 900000, async () => {
      const area = `(around:${WORLD_RADIUS},${lat},${lon})`;
      const query = `[out:json][timeout:18];(way[building]${area};relation[building][type=multipolygon]${area};way[highway][area!=yes]${area};way[barrier~"^(wall|fence|retaining_wall)$"]${area};way[natural=water]${area};relation[natural=water][type=multipolygon]${area};);out geom;`;
      const endpoints = env.EARTHDRIVE_OVERPASS_URL ? [env.EARTHDRIVE_OVERPASS_URL]
        : ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
      let lastError;
      for (const endpoint of endpoints) {
        try {
          const response = await remote(endpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ data: query }).toString()
          }, 22000);
          const data = JSON.parse((await boundedBody(response)).toString('utf8'));
          if (!Array.isArray(data.elements) || data.remark) throw fault(503, 'Dieser Ausschnitt konnte nicht vollständig geladen werden. Bitte erneut versuchen.');
          return { center: { lat, lon }, radius: WORLD_RADIUS, elements: data.elements, attribution: '© OpenStreetMap contributors' };
        } catch (error) {
          // No retry for an explicit denial/rate limit or a malformed request.
          if (error.upstreamStatus && error.upstreamStatus < 500) throw error;
          lastError = error;
        }
      }
      throw lastError;
    });
    await sendJson(res, world);
  });

  route('tiles', async (req, res) => {
    limit(req.earthDrive.username, 'tiles', 1200);
    if (!mapsKey) throw fault(503, 'Die fotorealistische Welt ist noch nicht eingerichtet.');
    const url = tileUrl(req.query.path, mapsKey);
    const response = await remote(url);
    const mime = response.headers.get('content-type') || 'application/octet-stream';
    if (mime.includes('json') || url.pathname.endsWith('.json')) {
      const body = await boundedBody(response);
      await sendJson(res, rewriteTiles(JSON.parse(body.toString('utf8')), url));
    } else {
      res.type(mime);
      // No Content-Length: streamed responses avoid buffering large 3D meshes.
      await pipeline(Readable.fromWeb(response.body), res);
    }
  });
}

module.exports = { mountEarthDrive, coordinates, tileUrl, rewriteTiles, WORLD_RADIUS };
