import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { parseParkCsv } from '../src/csv.js';
import { createApi, deduplicateMappedSpots } from '../src/api.js';
import { createStore } from '../src/store.js';

const csv = `"reference","name","active","entityId","locationDesc","latitude","longitude","grid"\n"GB-0001","Test Park, North","1","1","GB-SCT","55.9","-3.1","IO85"\n"GB-0002","Other Park","1","2","GB-SCT","56.1","-3.2","IO85"\n`;
const parks = parseParkCsv(csv, '2026-09-20T02:00:01.921Z');

function makeStore(spots = []) {
  return {
    getParks: async () => parks,
    getParkStatuses: async (references) => Object.fromEntries([...new Set(references.map((reference) => reference.trim().toUpperCase()))].filter((reference) => ['GB-0001', 'GB-0002'].includes(reference)).map((reference) => [reference, { active: reference === 'GB-0001' }])),
    queryUnmappedParks: async (bounds) => parks.parks.filter((park) => park.latitude >= bounds.south && park.latitude <= bounds.north && park.longitude >= bounds.west && park.longitude <= bounds.east),
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

test('returns active status for requested parks from the CSV-backed store', async () => {
  const response = await request(createApi({ store: makeStore() }), '/api/pota/status?references=gb-0001,GB-0002,GB-4040');
  assert.deepEqual(response.json, { parks: { 'GB-0001': { active: true }, 'GB-0002': { active: false } } });
  assert.equal(response.headers['Cache-Control'], 'private, max-age=300');
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

test('uses the compact park list for bounding-box park queries', async () => {
  const store = createStore({
    parseParkCsv,
    fetchImpl: async (url) => url.includes('overpass')
      ? { ok: true, json: async () => ({ elements: [{ tags: { 'communication:amateur_radio:pota': 'GB-0001' } }] }) }
      : { ok: true, text: async () => csv },
  });
  await store.refreshParks();
  const result = await store.queryParks({ south: 55.8, west: -3.2, north: 56, east: -3 });
  assert.deepEqual(result.map((park) => park.reference), ['GB-0001']);
});

test('retries Overpass lock acquisition after a stale shared lock timeout', async () => {
  let lockAttempts = 0;
  const store = createStore({
    parseParkCsv,
    redisCache: {
      get: async () => null,
      setIfAbsent: async () => {
        lockAttempts += 1;
        return lockAttempts > 1;
      },
      set: async () => {},
      del: async () => {},
    },
    overpassLockWaitMs: 0,
    overpassLockWaitAttempts: 1,
    fetchImpl: async (url) => url.includes('overpass')
      ? { ok: true, json: async () => ({ elements: [{ tags: { 'communication:amateur_radio:pota': 'GB-0001' } }] }) }
      : { ok: true, text: async () => csv },
  });

  await store.refreshParks();
  assert.equal(lockAttempts, 2);
  assert.equal(store.status().loaded, true);
});

test('builds unmapped data from active CSV parks absent from the OSM reference index', async () => {
  const store = createStore({
    parseParkCsv,
    fetchImpl: async (url) => url.includes('overpass')
      ? { ok: true, json: async () => ({ elements: [{ tags: { 'communication:amateur_radio:pota': 'GB-0001' } }] }) }
      : { ok: true, text: async () => csv },
  });
  await store.refreshParks();
  const result = await store.queryUnmappedParks({ south: 55, west: -4, north: 57, east: -2 });
  assert.deepEqual(result.map((park) => park.reference), ['GB-0002']);
  assert.equal(store.status().osmReferencesCount, 1);
});

test('does not become ready when Overpass returns no POTA references', async () => {
  const store = createStore({
    parseParkCsv,
    fetchImpl: async (url) => url.includes('overpass')
      ? { ok: true, json: async () => ({ elements: [] }) }
      : { ok: true, text: async () => csv },
  });
  await assert.rejects(store.refreshParks(), /empty POTA reference index/);
  assert.equal(store.status().loaded, false);
});

test('deduplicates mapped RBN spots by activity and keeps the newest report', () => {
  const spots = [
    { spotId: 1, spotTime: '2026-09-21T05:00:00', activator: 'EA7KLK', frequency: '7034.0', mode: 'CW', reference: 'GB-0001', source: 'RBN', spotter: 'OLD-#' },
    { spotId: 2, spotTime: '2026-09-21T06:00:00', activator: 'EA7KLK', frequency: '7034.0', mode: 'CW', reference: 'GB-0001', source: 'RBN', spotter: 'NEW-#' },
    { spotId: 3, spotTime: '2026-09-21T05:30:00', activator: 'EA7KLK', frequency: '14074.0', mode: 'FT8', reference: 'GB-0001', source: 'RBN' },
    { spotId: 4, spotTime: '2026-09-21T05:00:00', activator: 'EA7KLK', frequency: '7034.0', mode: 'CW', reference: 'GB-0001', source: 'Web' },
    { spotId: 5, spotTime: '2026-09-21T05:01:00', activator: 'EA7KLK', frequency: '7034.0', mode: 'CW', reference: 'GB-0001', source: 'Web' },
    { spotId: 6, spotTime: '2026-09-21T05:02:00', activator: 'EA7KLK', frequency: '7034.0', mode: 'CW', reference: 'GB-0001', source: 'GT' },
    { spotId: 7, spotTime: '2026-09-21T05:03:00', activator: 'EA7KLK', frequency: '7034.0', mode: 'CW', reference: 'GB-0001', source: 'RBN' },
    { spotId: 7, spotTime: '2026-09-21T06:03:00', activator: 'DIFFERENT', frequency: '144300', mode: 'FM', reference: 'GB-0002', source: 'Web' },
  ];

  const result = deduplicateMappedSpots(spots);
  assert.deepEqual(result.map((spot) => spot.spotId), [2, 3, 4, 5, 6]);
  assert.equal(result[0].spotter, 'NEW-#');
});

test('mapped spots apply deduplication while raw proxy remains unchanged', async () => {
  const spots = [
    { spotId: 1, spotTime: '2026-09-21T05:00:00', activator: 'EA7KLK', frequency: '7034.0', mode: 'CW', reference: 'GB-0001', source: 'RBN' },
    { spotId: 2, spotTime: '2026-09-21T06:00:00', activator: 'EA7KLK', frequency: '7034.0', mode: 'CW', reference: 'GB-0001', source: 'RBN' },
    { spotId: 3, spotTime: '2026-09-21T05:30:00', activator: 'EA7KLK', frequency: '7034.0', mode: 'CW', reference: 'GB-0001', source: 'Web' },
  ];
  const handler = createApi({ store: makeStore(spots) });
  const mapped = await request(handler, '/api/pota/spots?bbox=55.8,-3.2,56,-3');
  const raw = await request(handler, '/api/pota/spot');
  assert.deepEqual(mapped.json.features.map((feature) => feature.properties.spotId), [2, 3]);
  assert.deepEqual(raw.json, spots);
});
