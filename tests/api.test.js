import test from 'node:test';
import assert from 'node:assert/strict';
import { parseParkCsv } from '../src/csv.js';
import { createApi } from '../src/api.js';

const csv = `"reference","name","active","entityId","locationDesc","latitude","longitude","grid"\n"GB-0001","Test Park, North","1","1","GB-SCT","55.9","-3.1","IO85"\n"GB-0002","Other Park","1","2","GB-SCT","56.1","-3.2","IO85"\n`;
const parks = parseParkCsv(csv, '2026-09-20T02:00:01.921Z');

function makeStore(spots = []) {
  return {
    getParks: async () => parks,
    getSpots: async () => spots,
    status: () => ({ loaded: true, csvUpdatedAt: parks.updatedAt, stale: false }),
  };
}

async function request(handler, path) {
  const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
  await handler({ method: 'GET', url: path }, response);
  return { ...response, json: JSON.parse(response.body) };
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
