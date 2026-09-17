const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { mountEarthDrive, tileUrl, rewriteTiles } = require('../../lib/earthdrive');

async function harness(t, options = {}) {
  let time = Date.now(), calls = [], active = true;
  const app = express(), secret = 'earthdrive-local-test-only';
  app.use((req, res, next) => {
    try { req.authUser = jwt.verify((req.headers.authorization || '').slice(7), secret); next(); }
    catch { res.status(401).json({ error: 'Login erforderlich' }); }
  });
  mountEarthDrive(app, {
    now: () => time,
    env: { GOOGLE_MAPS_API_KEY: 'test-key-never-send-to-browser' },
    readAuthUser: req => req.authUser,
    getProfile: async name => ({ isPro: active && name === 'pro', proUntil: new Date(options.until || time + 3600000).toISOString() }),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (options.remote) return options.remote(url, init);
      if (String(url).includes('photon')) return Response.json({ features: [{ geometry: { coordinates: [13.4, 52.5] }, properties: { name: 'Berlin', country: 'Deutschland' } }] });
      if (String(url).includes('overpass')) return Response.json({ elements: [] });
      return Response.json({ asset: { version: '1.0', copyright: 'Keep attribution' }, root: { content: { uri: '/v1/3dtiles/datasets/test/tile.glb?key=test-key-never-send-to-browser&session=abc' } } });
    }
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/earthdrive`;
  return {
    calls, advance: ms => time += ms, revoke: () => { active = false; },
    request: (path, name = 'pro', token) => fetch(base + path, { headers: name ? { Authorization: 'Bearer ' + (token || jwt.sign({ username: name }, secret)) } : {} })
  };
}
test('all paid endpoints reject missing, forged, and non-Pro credentials before upstream requests', async t => {
  const h = await harness(t);
  for (const path of ['/config', '/search?q=Berlin', '/world?lat=52.5&lon=13.4', '/tiles?path=/v1/3dtiles/root.json']) {
    assert.equal((await h.request(path, null)).status, 401);
    assert.equal((await h.request(path, 'pro', 'fake')).status, 401);
    assert.equal((await h.request(path, 'free')).status, 403);
  }
  assert.equal(h.calls.length, 0);
});
test('config gives only a short lease and never exposes the Maps key', async t => {
  const h = await harness(t), response = await h.request('/config'), text = await response.text();
  assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(JSON.parse(text).google3d, true); assert.ok(JSON.parse(text).expiresAt <= Date.now() + 121000);
  assert.ok(!text.includes('test-key')); assert.ok(!text.includes('googleapis'));
});
test('expired subscriptions deny tiles even within the cached lookup window', async t => {
  const h = await harness(t, { until: Date.now() + 2000 });
  assert.equal((await h.request('/tiles?path=/v1/3dtiles/root.json')).status, 200);
  h.advance(3000);
  assert.equal((await h.request('/tiles?path=/v1/3dtiles/root.json')).status, 403);
});
test('revoked subscriptions deny config and world immediately', async t => {
  const h = await harness(t);
  assert.equal((await h.request('/config')).status, 200); h.revoke();
  assert.equal((await h.request('/config')).status, 403);
  assert.equal((await h.request('/world?lat=1&lon=2')).status, 403);
});
test('invalid coordinates and injection attempts never reach Overpass', async t => {
  const h = await harness(t);
  for (const path of ['/world', '/world?lat=&lon=', '/world?lat=Infinity&lon=0', '/world?lat=86&lon=0', '/world?lat=52);out;&lon=13', '/world?lat=0&lon=181']) assert.equal((await h.request(path)).status, 400);
  assert.equal(h.calls.length, 0);
});
test('world requests share a bounded nearby cache and partial data fails closed', async t => {
  const h = await harness(t);
  await h.request('/world?lat=52.5&lon=13.4'); await h.request('/world?lat=52.5001&lon=13.4001');
  assert.equal(h.calls.length, 1); assert.match(h.calls[0].init.body, /timeout/);
  const broken = await harness(t, { remote: async () => Response.json({ elements: [], remark: 'timeout' }) });
  assert.equal((await broken.request('/world?lat=52.5&lon=13.4')).status, 503);
});
test('search caches results and validates query length', async t => {
  const h = await harness(t);
  assert.equal((await h.request('/search?q=x')).status, 400);
  const r = await h.request('/search?q=Berlin'); assert.equal((await r.json()).results[0].name, 'Berlin');
  await h.request('/search?q=berlin'); assert.equal(h.calls.length, 1);
});
test('3D manifests retain attribution and rewrite child URLs without API keys', async t => {
  const h = await harness(t), response = await h.request('/tiles?path=/v1/3dtiles/root.json');
  const data = await response.json();
  assert.equal(data.asset.copyright, 'Keep attribution'); assert.match(data.root.content.uri, /^\/api\/earthdrive\/tiles\?path=/);
  assert.ok(!JSON.stringify(data).includes('test-key'));
  assert.match(h.calls[0].url, /key=test-key-never-send-to-browser/);
});
test('tile proxy rejects SSRF/path escapes and overrides caller-provided keys', () => {
  for (const path of ['https://example.com', '//example.com', '/v1/3dtiles/../../../secret', '/v1/3dtiles/%2e%2e/secret']) assert.throws(() => tileUrl(path, 'ours'));
  const url = tileUrl('/v1/3dtiles/root.json?key=attacker&url=https://example.com', 'ours');
  assert.equal(url.searchParams.get('key'), 'ours'); assert.equal(url.searchParams.has('url'), false);
  assert.throws(() => rewriteTiles({ uri: 'https://example.com/steal' }, url));
});
test('binary 3D tiles preserve their bytes and content type', async t => {
  const bytes = Buffer.from('glTF-test-content');
  const h = await harness(t, { remote: async () => new Response(bytes, { headers: { 'content-type': 'model/gltf-binary' } }) });
  const r = await h.request('/tiles?path=/v1/3dtiles/datasets/test/tile.glb');
  assert.equal(r.status, 200); assert.ok(r.headers.get('content-type').includes('model/gltf-binary')); assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes);
});
test('world fallback is limited to outages, and large Unicode responses stream intact', async t => {
  let attempts = 0;
  const elements = [{ type: 'way', id: 1, tags: { name: 'Straße 🌍 '.repeat(12000) }, geometry: [] }];
  const h = await harness(t, { remote: async () => ++attempts === 1 ? new Response('Unavailable', { status: 503 }) : Response.json({ elements }) });
  const r = await h.request('/world?lat=52.5&lon=13.4');
  assert.equal(r.status, 200); assert.equal(attempts, 2); assert.deepEqual((await r.json()).elements, elements);
  assert.equal(r.headers.get('content-length'), null);
  const denied = await harness(t, { remote: async () => new Response('Denied', { status: 403 }) });
  assert.equal((await denied.request('/world?lat=52.5&lon=13.4')).status, 502); assert.equal(denied.calls.length, 1);
});
