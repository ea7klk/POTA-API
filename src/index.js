import http from 'node:http';
import { parseParkCsv } from './csv.js';
import { createRedisCache } from './redis.js';
import { createStore } from './store.js';
import { createApi } from './api.js';

const port = Number(process.env.PORT ?? 3000);
const redisCache = createRedisCache({
  url: process.env.REDIS_URL,
  timeoutMs: Number(process.env.REDIS_TIMEOUT_MS ?? 2000),
});
const store = createStore({
  parseParkCsv,
  parksUrl: process.env.POTA_PARKS_URL,
  spotsUrl: process.env.POTA_SPOTS_URL,
  refreshMs: Number(process.env.PARK_REFRESH_MS ?? 6 * 60 * 60 * 1000),
  spotsRefreshMs: Number(process.env.SPOTS_REFRESH_MS ?? 30 * 1000),
  spotsCacheTtlMs: Number(process.env.SPOTS_CACHE_TTL_MS ?? 45 * 1000),
  overpassUrl: process.env.OVERPASS_URL,
  overpassTimeoutMs: Number(process.env.OVERPASS_TIMEOUT_MS ?? 180 * 1000),
  overpassCacheTtlMs: Number(process.env.OVERPASS_CACHE_TTL_MS ?? 12 * 60 * 60 * 1000),
  overpassLockTtlMs: Number(process.env.OVERPASS_LOCK_TTL_MS ?? 5 * 60 * 1000),
  redisCache,
  fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS ?? 20_000),
});
const handler = createApi({ store });
const server = http.createServer(handler);

server.listen(port, '0.0.0.0', async () => {
  try {
    await store.refreshParks();
    store.start();
    console.log(`POTA API listening on ${port}; parks updated at ${store.status().csvUpdatedAt}`);
  } catch (error) {
    console.error(`Unable to load POTA parks at startup: ${error.message}`);
    process.exitCode = 1;
  }
});

function shutdown(signal) {
  console.log(`${signal}: shutting down`);
  server.close(async () => {
    await redisCache?.close();
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
