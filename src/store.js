const DEFAULT_PARKS_URL = 'https://pota.app/all_parks_ext.csv';
const DEFAULT_SPOTS_URL = 'https://api.pota.app/spot';
const DEFAULT_REFRESH_MS = 6 * 60 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 20_000;

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function fetchText(url, timeoutMs) {
  const timeout = withTimeout(timeoutMs);
  try {
    const response = await fetch(url, { signal: timeout.signal, headers: { accept: 'text/csv, application/json' } });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    return await response.text();
  } finally {
    timeout.clear();
  }
}

export function createStore({ parseParkCsv, parksUrl = DEFAULT_PARKS_URL, spotsUrl = DEFAULT_SPOTS_URL, refreshMs = DEFAULT_REFRESH_MS, fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS, fetchImpl = fetch, now = () => new Date() }) {
  let parkData = null;
  let refreshInFlight = null;
  let lastRefreshError = null;

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
        parkData = parseParkCsv(csv, now().toISOString());
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

  async function getSpots() {
    return fetchTextWith(spotsUrl).then((text) => JSON.parse(text));
  }

  function start() {
    const timer = setInterval(() => refreshParks().catch(() => {}), refreshMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  return {
    getParks,
    getSpots,
    refreshParks,
    start,
    status: () => ({
      loaded: Boolean(parkData),
      csvUpdatedAt: parkData?.updatedAt ?? null,
      stale: Boolean(lastRefreshError),
      lastRefreshError: lastRefreshError?.message ?? null,
    }),
  };
}
