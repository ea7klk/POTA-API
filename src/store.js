const DEFAULT_PARKS_URL = 'https://pota.app/all_parks_ext.csv';
const DEFAULT_SPOTS_URL = 'https://api.pota.app/spot';
const DEFAULT_REFRESH_MS = 6 * 60 * 60 * 1000;
const DEFAULT_SPOTS_REFRESH_MS = 30 * 1000;
const DEFAULT_SPOTS_CACHE_TTL_MS = 45 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
const GRID_SIZE_DEGREES = 1;

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function parkCell(latitude, longitude) {
  return `${Math.floor(latitude / GRID_SIZE_DEGREES)}:${Math.floor(longitude / GRID_SIZE_DEGREES)}`;
}

function buildParkData(parsed) {
  const byReference = new Map();
  const featuresByReference = new Map();
  const spatialIndex = new Map();

  for (const park of parsed.parks) {
    byReference.set(park.reference, park);
    featuresByReference.set(park.reference, {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [park.longitude, park.latitude] },
      properties: { pota_ref: park.reference, name: park.name, source: 'pota_csv' },
    });
    const key = parkCell(park.latitude, park.longitude);
    const cell = spatialIndex.get(key) ?? [];
    cell.push(park);
    spatialIndex.set(key, cell);
  }

  return { ...parsed, byReference, featuresByReference, spatialIndex };
}

function querySpatialIndex(data, bounds) {
  const southCell = Math.floor(bounds.south / GRID_SIZE_DEGREES);
  const northCell = Math.floor(bounds.north / GRID_SIZE_DEGREES);
  const westCell = Math.floor(bounds.west / GRID_SIZE_DEGREES);
  const eastCell = Math.floor(bounds.east / GRID_SIZE_DEGREES);
  const cellCount = (northCell - southCell + 1) * (eastCell - westCell + 1);
  const candidates = [];

  if (cellCount > 100_000) return data.parks;
  for (let latitude = southCell; latitude <= northCell; latitude += 1) {
    for (let longitude = westCell; longitude <= eastCell; longitude += 1) {
      const cell = data.spatialIndex.get(`${latitude}:${longitude}`);
      if (cell) candidates.push(...cell);
    }
  }
  return candidates.filter((park) => park.latitude >= bounds.south && park.latitude <= bounds.north && park.longitude >= bounds.west && park.longitude <= bounds.east);
}

export function createStore({
  parseParkCsv,
  parksUrl = DEFAULT_PARKS_URL,
  spotsUrl = DEFAULT_SPOTS_URL,
  refreshMs = DEFAULT_REFRESH_MS,
  spotsRefreshMs = DEFAULT_SPOTS_REFRESH_MS,
  spotsCacheTtlMs = DEFAULT_SPOTS_CACHE_TTL_MS,
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  redisCache = null,
  spotsCacheKey = 'pota:spots:v1',
  fetchImpl = fetch,
  now = () => new Date(),
}) {
  let parkData = null;
  let refreshInFlight = null;
  let spotsData = null;
  let spotsRefreshInFlight = null;
  let redisLoadAttempted = false;
  let lastRefreshError = null;
  let lastSpotsRefreshError = null;

  async function fetchTextWith(fetchUrl) {
    const timeout = withTimeout(fetchTimeoutMs);
    try {
      const response = await fetchImpl(fetchUrl, { signal: timeout.signal, headers: { accept: 'text/csv, application/json' } });
      if (!response.ok) throw new Error(`${fetchUrl} returned HTTP ${response.status}`);
      return await response.text();
    } finally {
      timeout.clear();
    }
  }

  async function refreshParks() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      try {
        const csv = await fetchTextWith(parksUrl);
        parkData = buildParkData(parseParkCsv(csv, now().toISOString()));
        lastRefreshError = null;
        return parkData;
      } catch (error) {
        lastRefreshError = error;
        if (!parkData) throw error;
        return parkData;
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  }

  async function getParks() {
    if (!parkData) await refreshParks();
    return parkData;
  }

  function spotsAreFresh() {
    return spotsData && (now().getTime() - spotsData.updatedAt.getTime()) < spotsCacheTtlMs;
  }

  async function loadSpotsFromRedis() {
    if (redisLoadAttempted || !redisCache) return;
    redisLoadAttempted = true;
    try {
      const cached = await redisCache.get(spotsCacheKey);
      if (!cached) return;
      const parsed = JSON.parse(cached);
      if (!Array.isArray(parsed.spots) || !parsed.updatedAt) return;
      const updatedAt = new Date(parsed.updatedAt);
      if (!Number.isFinite(updatedAt.getTime())) return;
      spotsData = { spots: parsed.spots, updatedAt };
      lastSpotsRefreshError = null;
    } catch (error) {
      lastSpotsRefreshError = error;
    }
  }

  async function refreshSpots() {
    if (spotsRefreshInFlight) return spotsRefreshInFlight;
    spotsRefreshInFlight = (async () => {
      try {
        const text = await fetchTextWith(spotsUrl);
        const spots = JSON.parse(text);
        if (!Array.isArray(spots)) throw new Error(`${spotsUrl} returned a non-array spot payload`);
        const updatedAt = now();
        spotsData = { spots, updatedAt };
        lastSpotsRefreshError = null;
        if (redisCache) {
          Promise.resolve(redisCache.set(spotsCacheKey, JSON.stringify({ spots, updatedAt: updatedAt.toISOString() }), spotsCacheTtlMs)).catch(() => {});
        }
        return spots;
      } catch (error) {
        lastSpotsRefreshError = error;
        if (spotsData) return spotsData.spots;
        throw error;
      } finally {
        spotsRefreshInFlight = null;
      }
    })();
    return spotsRefreshInFlight;
  }

  async function getSpots() {
    if (spotsAreFresh()) return spotsData.spots;
    await loadSpotsFromRedis();
    if (spotsAreFresh()) return spotsData.spots;
    return refreshSpots();
  }

  function start() {
    const timer = setInterval(() => refreshParks().catch(() => {}), refreshMs);
    const spotsTimer = setInterval(() => refreshSpots().catch(() => {}), spotsRefreshMs);
    timer.unref?.();
    spotsTimer.unref?.();
    getSpots().catch(() => {});
    return () => {
      clearInterval(timer);
      clearInterval(spotsTimer);
    };
  }

  return {
    getParks,
    getSpots,
    queryParks: async (bounds) => querySpatialIndex(await getParks(), bounds),
    refreshParks,
    refreshSpots,
    start,
    status: () => ({
      loaded: Boolean(parkData),
      csvUpdatedAt: parkData?.updatedAt ?? null,
      stale: Boolean(lastRefreshError),
      lastRefreshError: lastRefreshError?.message ?? null,
      spotsLoaded: Boolean(spotsData),
      spotsUpdatedAt: spotsData?.updatedAt?.toISOString() ?? null,
      spotsStale: Boolean(lastSpotsRefreshError),
      lastSpotsRefreshError: lastSpotsRefreshError?.message ?? null,
      redis: Boolean(redisCache),
    }),
  };
}
