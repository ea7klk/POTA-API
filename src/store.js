const DEFAULT_PARKS_URL = 'https://pota.app/all_parks_ext.csv';
const DEFAULT_SPOTS_URL = 'https://api.pota.app/spot';
const DEFAULT_REFRESH_MS = 6 * 60 * 60 * 1000;
const DEFAULT_SPOTS_REFRESH_MS = 30 * 1000;
const DEFAULT_SPOTS_CACHE_TTL_MS = 45 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_OVERPASS_URL = 'https://api.spainip.es/v1/overpass/interpreter';
const DEFAULT_OVERPASS_TIMEOUT_MS = 180_000;
const DEFAULT_OVERPASS_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_OVERPASS_LOCK_TTL_MS = 5 * 60 * 1000;
const DEFAULT_OVERPASS_LOCK_WAIT_MS = 500;
const DEFAULT_OVERPASS_LOCK_WAIT_ATTEMPTS = 30;
const POTA_OSM_TAG = 'communication:amateur_radio:pota';

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function normalizeReference(value) {
  return String(value ?? '').trim().toUpperCase();
}

function isActivePark(park) {
  return ['1', 'true', 'yes', 'active'].includes(String(park.active ?? '').trim().toLowerCase());
}

function activeValue(park) {
  const value = String(park.active ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'active'].includes(value)) return true;
  if (['0', 'false', 'no', 'inactive'].includes(value)) return false;
  return null;
}

function buildParkData(parsed, osmReferences, osmReferencesUpdatedAt) {
  const byReference = new Map();

  for (const park of parsed.parks) {
    byReference.set(normalizeReference(park.reference), park);
  }

  return { parks: parsed.parks, updatedAt: parsed.updatedAt, byReference, osmReferences, osmReferencesUpdatedAt };
}

function queryParksInBounds(parks, bounds, predicate = () => true) {
  return parks.filter((park) => (
    park.latitude >= bounds.south
    && park.latitude <= bounds.north
    && park.longitude >= bounds.west
    && park.longitude <= bounds.east
    && predicate(park)
  ));
}

export function createStore({
  parseParkCsv,
  parksUrl = DEFAULT_PARKS_URL,
  spotsUrl = DEFAULT_SPOTS_URL,
  refreshMs = DEFAULT_REFRESH_MS,
  spotsRefreshMs = DEFAULT_SPOTS_REFRESH_MS,
  spotsCacheTtlMs = DEFAULT_SPOTS_CACHE_TTL_MS,
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  overpassUrl = DEFAULT_OVERPASS_URL,
  overpassTimeoutMs = DEFAULT_OVERPASS_TIMEOUT_MS,
  overpassCacheTtlMs = DEFAULT_OVERPASS_CACHE_TTL_MS,
  overpassLockTtlMs = DEFAULT_OVERPASS_LOCK_TTL_MS,
  overpassLockWaitMs = DEFAULT_OVERPASS_LOCK_WAIT_MS,
  overpassLockWaitAttempts = DEFAULT_OVERPASS_LOCK_WAIT_ATTEMPTS,
  redisCache = null,
  spotsCacheKey = 'pota:spots:v1',
  osmReferencesCacheKey = 'pota:osm:pota-references:v1',
  osmReferencesLockKey = 'pota:osm:pota-references:refresh-lock:v1',
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
  let osmReferences = null;
  let osmRefreshInFlight = null;
  let lastOsmRefreshError = null;

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

  async function fetchJsonWith(fetchUrl, timeoutMs, headers = {}) {
    const timeout = withTimeout(timeoutMs);
    try {
      const response = await fetchImpl(fetchUrl, { signal: timeout.signal, headers: { accept: 'application/json', ...headers } });
      if (!response.ok) throw new Error(`${fetchUrl} returned HTTP ${response.status}`);
      return await response.json();
    } finally {
      timeout.clear();
    }
  }

  function parseOsmReferences(payload) {
    if (!payload || !Array.isArray(payload.elements) || payload.remark || payload.error) {
      throw new Error('Overpass returned an invalid reference index');
    }
    const references = new Set();
    for (const element of payload.elements) {
      const value = element?.tags?.[POTA_OSM_TAG];
      if (!value) continue;
      for (const reference of String(value).split(/[;,]/).map(normalizeReference).filter(Boolean)) references.add(reference);
    }
    if (references.size === 0) throw new Error('Overpass returned an empty POTA reference index');
    return references;
  }

  async function readCachedOsmReferences() {
    if (!redisCache) return null;
    try {
      const cached = await redisCache.get(osmReferencesCacheKey);
      if (!cached) return null;
      const parsed = JSON.parse(cached);
      const updatedAt = new Date(parsed.updatedAt);
      if (!Array.isArray(parsed.references) || !Number.isFinite(updatedAt.getTime())) return null;
      return { references: new Set(parsed.references.map(normalizeReference).filter(Boolean)), updatedAt };
    } catch (error) {
      lastOsmRefreshError = error;
      return null;
    }
  }

  async function waitForOsmReferences(previousUpdatedAt) {
    for (let attempt = 0; attempt < overpassLockWaitAttempts; attempt += 1) {
      const cached = await readCachedOsmReferences();
      if (cached && (!previousUpdatedAt || cached.updatedAt > previousUpdatedAt)) return cached;
      await new Promise((resolve) => setTimeout(resolve, overpassLockWaitMs));
    }
    return null;
  }

  async function fetchOsmReferences() {
    const query = `[out:json][timeout:180];nwr["${POTA_OSM_TAG}"];out tags;`;
    const separator = overpassUrl.includes('?') ? '&' : '?';
    const url = `${overpassUrl}${separator}data=${encodeURIComponent(query)}`;
    const payload = await fetchJsonWith(url, overpassTimeoutMs, { 'accept-encoding': 'gzip' });
    return parseOsmReferences(payload);
  }

  async function refreshOsmReferences() {
    if (osmRefreshInFlight) return osmRefreshInFlight;
    osmRefreshInFlight = (async () => {
      const cachedBefore = await readCachedOsmReferences();
      const previousUpdatedAt = osmReferences?.updatedAt ?? cachedBefore?.updatedAt ?? null;
      for (;;) {
        let lockAcquired = false;
        try {
          if (redisCache?.setIfAbsent) {
            const lockState = await redisCache.setIfAbsent(osmReferencesLockKey, `${process.pid}:${Date.now()}`, overpassLockTtlMs);
            lockAcquired = lockState === undefined || lockState;
            if (!lockAcquired) {
              const shared = await waitForOsmReferences(previousUpdatedAt);
              if (shared) {
                osmReferences = shared;
                lastOsmRefreshError = null;
                return shared;
              }
              if (cachedBefore) {
                osmReferences = cachedBefore;
                lastOsmRefreshError = new Error('Timed out waiting for the shared Overpass reference refresh');
                return cachedBefore;
              }
              continue;
            }
          }

          const references = await fetchOsmReferences();
          const updatedAt = now();
          const value = { references, updatedAt };
          osmReferences = value;
          lastOsmRefreshError = null;
          if (redisCache) {
            Promise.resolve(redisCache.set(osmReferencesCacheKey, JSON.stringify({ references: [...references], updatedAt: updatedAt.toISOString() }), overpassCacheTtlMs)).catch(() => {});
          }
          return value;
        } catch (error) {
          lastOsmRefreshError = error;
          throw error;
        } finally {
          if (lockAcquired) Promise.resolve(redisCache.del(osmReferencesLockKey)).catch(() => {});
        }
      }
    })().finally(() => {
      osmRefreshInFlight = null;
    });
    return osmRefreshInFlight;
  }

  async function refreshParks() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      try {
        const csv = await fetchTextWith(parksUrl);
        const parsed = parseParkCsv(csv, now().toISOString());
        const references = await refreshOsmReferences();
        parkData = buildParkData(parsed, references.references, references.updatedAt.toISOString());
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
    queryParks: async (bounds) => {
      const data = await getParks();
      return queryParksInBounds(data.parks, bounds);
    },
    queryUnmappedParks: async (bounds) => {
      const data = await getParks();
      return queryParksInBounds(data.parks, bounds, (park) => isActivePark(park) && !data.osmReferences.has(normalizeReference(park.reference)));
    },
    getParkStatuses: async (references) => {
      const data = await getParks();
      const parks = {};
      for (const reference of [...new Set(references.map(normalizeReference).filter(Boolean))]) {
        const park = data.byReference.get(reference);
        const active = park ? activeValue(park) : null;
        if (active !== null) parks[reference] = { active };
      }
      return parks;
    },
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
      osmReferencesLoaded: Boolean(osmReferences),
      osmReferencesUpdatedAt: osmReferences?.updatedAt?.toISOString() ?? null,
      osmReferencesCount: osmReferences?.references.size ?? 0,
      osmReferencesStale: Boolean(lastOsmRefreshError),
      lastOsmRefreshError: lastOsmRefreshError?.message ?? null,
    }),
  };
}
