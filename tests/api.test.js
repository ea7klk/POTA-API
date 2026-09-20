import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { parseParkCsv } from '../src/csv.js';
import { createApi } from '../src/api.js';
import { createStore } from '../src/store.js';

const csv = `"reference","name","active","entityId","locationDesc","latitude","longitude","grid"\n"GB-0001","Test Park, North","1","1","GB-SCT","55.9","-3.1","IO85"\n"GB-0002","Other Park","1","2","GB-SCT","56.1","-3.2","IO85"\n`;
const parks = parseParkCsv(csv, '2026-09-20T02:00:01.921Z');

function makeStore(spots = []) {
  return {
    getParks: async () => parks,
    getSpots: async () => spots,
    status: () => ({ loaded: true, csvUpdatedAt: parks.updatedAt, stale: false }),
  };
}

async function request(handler, path, headers = {}) {
  const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, once(event, listener) { if (event === 'finish') this.onFinish = listener; }, writeHead(status) { this.status = status; this.statusCode = status; }, end(body) { this.body = body; this.onFinish?.(); } };
  await handler({ method: 'GET', url: path, headers }, response);
  const decodedBody = response.headers['Content-Encoding'] === 'gzip' ? gunzipSync(response.body).toString() : response.body;
  return { ...response, json: JSON.parse(decodedBody) };
}

test('parses quoted CSV fields and coordinates', () => {
  assert.equal(parks.parks[0].name, 'Test Park, North');
  assert.equal(parks.parks[0].longitude, -3.1);
});

test('returns Potamap-compatible unmapped GeoJSON', async () => {
  const response = await request(createApi({ store: makeStore() }), '/api/pota/unmapped?south=55.8&west=-3.2&north=56&east=-3');
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.features[0].properties, { pota_ref: 'GB-0001', name: 'Test Park, North', source: 'pota_csv' });
  assert.deepEqual(response.json.features[0].geometry.coordinates, [-3.1, 55.9]);
});

test('returns requested park names and metadata', async () => {
  const response = await request(createApi({ store: makeStore() }), '/api/pota/names?references=GB-0001,GB-4040');
  assert.deepEqual(response.json, { names: { 'GB-0001': 'Test Park, North' }, metadata: { csvUpdatedAt: parks.updatedAt, stale: false } });
});

test('returns raw spots without changing the proxy payload', async () => {
  const spots = [{ spotId: 1, reference: 'GB-0001', name: 'Test Park, North' }];
  const response = await request(createApi({ store: makeStore(spots) }), '/api/pota/spot');
  assert.deepEqual(response.json, spots);
});

test('cross-references spots into bbox-filtered GeoJSON', async () => {
  const spots = [{ spotId: 1, reference: 'GB-0001', activator: 'EA7KLK' }, { spotId: 2, reference: 'GB-0002' }, { spotId: 3, reference: 'GB-9999' }];
  const response = await request(createApi({ store: makeStore(spots) }), '/api/pota/spots?bbox=55.8,-3.2,56,-3');
  assert.equal(response.json.features.length, 1);
  assert.equal(response.json.features[0].properties.parkName, 'Test Park, North');
  assert.equal(response.json.features[0].properties.activator, 'EA7KLK');
});

test('rejects incomplete bounding boxes', async () => {
  const response = await request(createApi({ store: makeStore() }), '/api/pota/unmapped?south=55&west=-3');
  assert.equal(response.status, 400);
});

test('logs a structured access event after each response', async () => {
  const events = [];
  await request(createApi({ store: makeStore(), logger: (event) => events.push(JSON.parse(event)) }), '/healthz');
  assert.deepEqual(events[0], { type: 'access', method: 'GET', path: '/healthz', status: 200, durationMs: events[0].durationMs, requestId: null });
  assert.equal(typeof events[0].durationMs, 'number');
});

test('compresses JSON when the client accepts gzip', async () => {
  const response = await request(createApi({ store: makeStore() }), '/api/pota/unmapped?south=55.8&west=-3.2&north=56&east=-3', { 'accept-encoding': 'gzip' });
  assert.equal(response.headers['Content-Encoding'], 'gzip');
  assert.equal(response.headers.Vary, 'Accept-Encoding');
  assert.equal(response.status, 200);
});

test('deduplicates spot refreshes and serves the in-memory cache', async () => {
  let fetches = 0;
  const spots = [{ spotId: 1, reference: 'GB-0001' }];
  const store = createStore({
    parseParkCsv,
    spotsCacheTtlMs: 60_000,
    fetchImpl: async () => ({ ok: true, text: async () => { fetches += 1; return JSON.stringify(spots); } }),
  });

  const results = await Promise.all([store.getSpots(), store.getSpots()]);
  assert.deepEqual(results[0], spots);
  assert.deepEqual(results[1], spots);
  assert.equal(fetches, 1);
  assert.deepEqual(await store.getSpots(), spots);
  assert.equal(fetches, 1);
});

test('loads a fresh spot payload from Redis before using the upstream API', async () => {
  let fetches = 0;
  const cachedSpots = [{ spotId: 9, reference: 'GB-0001' }];
  const redisCache = {
    get: async () => JSON.stringify({ spots: cachedSpots, updatedAt: new Date().toISOString() }),
    set: async () => {},
  };
  const store = createStore({
    parseParkCsv,
    redisCache,
    spotsCacheTtlMs: 60_000,
    fetchImpl: async () => { fetches += 1; throw new Error('upstream should not be called'); },
  });

  assert.deepEqual(await store.getSpots(), cachedSpots);
  assert.equal(fetches, 0);
});

test('uses the spatial index for bounding-box park queries', async () => {
  const store = createStore({ parseParkCsv, fetchImpl: async () => ({ ok: true, text: async () => csv }) });
  await store.refreshParks();
  const result = await store.queryParks({ south: 55.8, west: -3.2, north: 56, east: -3 });
  assert.deepEqual(result.map((park) => park.reference), ['GB-0001']);
});
