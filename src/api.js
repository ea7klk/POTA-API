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

export function createApi({ store }) {
  const parkByReference = (parks) => new Map(parks.map((park) => [park.reference, park]));

  return async function handle(request, response) {
    const url = new URL(request.url, 'http://localhost');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');

    try {
      if (request.method !== 'GET') {
        response.writeHead(405, { Allow: 'GET' });
        response.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }
      if (url.pathname === '/healthz') {
        response.writeHead(200);
        response.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (url.pathname === '/readyz') {
        const status = store.status();
        response.writeHead(status.loaded ? 200 : 503);
        response.end(JSON.stringify({ status: status.loaded ? 'ready' : 'not_ready', ...status }));
        return;
      }

      if (url.pathname === '/api/pota/unmapped') {
        const bounds = readBounds(url);
        const data = await store.getParks();
        response.writeHead(200);
        response.end(JSON.stringify({ type: 'FeatureCollection', features: data.parks.filter((park) => inBounds(park.latitude, park.longitude, bounds)).map(parkFeature) }));
        return;
      }

      if (url.pathname === '/api/pota/names') {
        const data = await store.getParks();
        const references = (url.searchParams.get('references') ?? '').split(',').map((reference) => reference.trim()).filter(Boolean);
        const byReference = parkByReference(data.parks);
        const names = Object.fromEntries(references.filter((reference) => byReference.has(reference)).map((reference) => [reference, byReference.get(reference).name]));
        response.writeHead(200);
        response.end(JSON.stringify({ names, metadata: { csvUpdatedAt: data.updatedAt, stale: store.status().stale } }));
        return;
      }

      if (url.pathname === '/api/pota/spot') {
        const spots = await store.getSpots();
        response.writeHead(200);
        response.end(JSON.stringify(spots));
        return;
      }

      if (url.pathname === '/api/pota/spots') {
        const bounds = readBounds(url);
        const data = await store.getParks();
        const byReference = parkByReference(data.parks);
        const spots = await store.getSpots();
        const features = spots.flatMap((spot) => {
          const park = byReference.get(spot.reference);
          if (!park || !inBounds(park.latitude, park.longitude, bounds)) return [];
          return [{
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [park.longitude, park.latitude] },
            properties: { ...spot, pota_ref: park.reference, parkName: park.name, source: 'pota_spot' },
          }];
        });
        response.writeHead(200);
        response.end(JSON.stringify({ type: 'FeatureCollection', features, metadata: { csvUpdatedAt: data.updatedAt, stale: store.status().stale } }));
        return;
      }

      response.writeHead(404);
      response.end(JSON.stringify({ error: 'Not found' }));
    } catch (error) {
      const statusCode = /Query parameter|Bounding box|required|outside valid/.test(error.message) ? 400 : 502;
      response.writeHead(statusCode);
      response.end(JSON.stringify({ error: error.message }));
    }
  };
}
