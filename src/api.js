import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);

function numberParam(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Query parameter ${name} must be a number`);
  return number;
}

export function readBounds(url) {
  const query = url.searchParams;
  const bbox = query.get('bbox')?.split(',').map((value) => value.trim());
  const values = bbox?.length === 4 ? bbox : [query.get('south'), query.get('west'), query.get('north'), query.get('east')];
  if (values.some((value) => value === null || value === undefined || value === '')) throw new Error('south, west, north, and east are required');
  const [south, west, north, east] = values.map((value, index) => numberParam(value, ['south', 'west', 'north', 'east'][index]));
  if (south > north || west > east) throw new Error('Bounding box minimum must not exceed maximum');
  if (south < -90 || north > 90 || west < -180 || east > 180) throw new Error('Bounding box is outside valid coordinate ranges');
  return { south, west, north, east };
}

function inBounds(latitude, longitude, bounds) {
  return latitude >= bounds.south && latitude <= bounds.north && longitude >= bounds.west && longitude <= bounds.east;
}

function parkFeature(park) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [park.longitude, park.latitude] },
    properties: { pota_ref: park.reference, name: park.name, source: 'pota_csv' },
  };
}

function spotTimeValue(spot) {
  const value = Date.parse(spot.spotTime ?? '');
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function rbnIdentity(spot) {
  if (spot.source !== 'RBN') return null;
  const values = [spot.reference, spot.activator, spot.frequency, spot.mode];
  if (values.some((value) => value === undefined || value === null || String(value).trim() === '')) return null;
  return values.map((value) => String(value).trim().toUpperCase()).join('\u001f');
}

export function deduplicateMappedSpots(spots) {
  const seenSpotIds = new Set();
  const rbnIndexes = new Map();
  const result = [];

  for (const spot of spots) {
    if (spot.spotId !== undefined && spot.spotId !== null) {
      const spotId = String(spot.spotId);
      if (seenSpotIds.has(spotId)) continue;
      seenSpotIds.add(spotId);
    }

    const identity = rbnIdentity(spot);
    if (!identity) {
      result.push(spot);
      continue;
    }

    const existingIndex = rbnIndexes.get(identity);
    if (existingIndex === undefined) {
      rbnIndexes.set(identity, result.length);
      result.push(spot);
    } else if (spotTimeValue(spot) > spotTimeValue(result[existingIndex])) {
      result[existingIndex] = spot;
    }
  }

  return result;
}

async function sendJson(request, response, statusCode, payload, cacheControl = 'no-store') {
  const body = Buffer.from(JSON.stringify(payload));
  response.setHeader('Cache-Control', cacheControl);
  response.setHeader('Vary', 'Accept-Encoding');
  if (request.headers?.['accept-encoding']?.includes('gzip')) {
    response.setHeader('Content-Encoding', 'gzip');
    response.writeHead(statusCode);
    response.end(await gzipAsync(body));
    return;
  }
  response.writeHead(statusCode);
  response.end(body.toString());
}

export function createApi({ store, logger = console.log }) {
  const parkByReference = (parks) => new Map(parks.map((park) => [park.reference, park]));

  return async function handle(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const startedAt = performance.now();
    response.once?.('finish', () => {
      logger(JSON.stringify({
        type: 'access',
        method: request.method,
        path: url.pathname,
        status: response.statusCode,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        requestId: request.headers?.['x-request-id'] ?? null,
      }));
    });
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');

    try {
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        await sendJson(request, response, 405, { error: 'Method not allowed' });
        return;
      }
      if (url.pathname === '/healthz') {
        await sendJson(request, response, 200, { status: 'ok' });
        return;
      }
      if (url.pathname === '/readyz') {
        const status = store.status();
        await sendJson(request, response, status.loaded ? 200 : 503, { status: status.loaded ? 'ready' : 'not_ready', ...status });
        return;
      }

      if (url.pathname === '/api/pota/unmapped') {
        const bounds = readBounds(url);
        const data = await store.getParks();
        const parks = store.queryParks
          ? await store.queryParks(bounds)
          : data.parks.filter((park) => inBounds(park.latitude, park.longitude, bounds));
        const features = parks.map((park) => data.featuresByReference?.get(park.reference) ?? parkFeature(park));
        await sendJson(request, response, 200, { type: 'FeatureCollection', features }, 'private, max-age=60');
        return;
      }

      if (url.pathname === '/api/pota/names') {
        const data = await store.getParks();
        const references = (url.searchParams.get('references') ?? '').split(',').map((reference) => reference.trim()).filter(Boolean);
        const byReference = data.byReference ?? parkByReference(data.parks);
        const names = Object.fromEntries(references.filter((reference) => byReference.has(reference)).map((reference) => [reference, byReference.get(reference).name]));
        await sendJson(request, response, 200, { names, metadata: { csvUpdatedAt: data.updatedAt, stale: store.status().stale } }, 'private, max-age=3600');
        return;
      }

      if (url.pathname === '/api/pota/spot') {
        const spots = await store.getSpots();
        await sendJson(request, response, 200, spots, 'private, max-age=10');
        return;
      }

      if (url.pathname === '/api/pota/spots') {
        const bounds = readBounds(url);
        const data = await store.getParks();
        const byReference = data.byReference ?? parkByReference(data.parks);
        const spots = deduplicateMappedSpots(await store.getSpots());
        const features = spots.flatMap((spot) => {
          const park = byReference.get(spot.reference);
          if (!park || !inBounds(park.latitude, park.longitude, bounds)) return [];
          return [{
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [park.longitude, park.latitude] },
            properties: { ...spot, pota_ref: park.reference, parkName: park.name, source: 'pota_spot' },
          }];
        });
        await sendJson(request, response, 200, { type: 'FeatureCollection', features, metadata: { csvUpdatedAt: data.updatedAt, stale: store.status().stale } }, 'private, max-age=10');
        return;
      }

      await sendJson(request, response, 404, { error: 'Not found' });
    } catch (error) {
      const statusCode = /Query parameter|Bounding box|required|outside valid/.test(error.message) ? 400 : 502;
      await sendJson(request, response, statusCode, { error: error.message });
    }
  };
}
