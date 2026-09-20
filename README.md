# POTA API

Internal cluster service for Potamap. It maintains a local in-memory copy of the POTA park master CSV, refreshes it every six hours, proxies live POTA spots, and exposes Potamap-compatible park endpoints.

## Endpoints

- `GET /healthz` — liveness check.
- `GET /readyz` — readiness check; returns `503` until the first park CSV has loaded.
- `GET /api/pota/unmapped?south=<lat>&west=<lon>&north=<lat>&east=<lon>` — Potamap-compatible GeoJSON `FeatureCollection` of parks in the bounding box.
- `GET /api/pota/names?references=GB-3333,GB-3329` — Potamap-compatible park-name map with CSV metadata.
- `GET /api/pota/spot` — transparent proxy of `https://api.pota.app/spot`.
- `GET /api/pota/spots? south=<lat>&west=<lon>&north=<lat>&east=<lon>` — enriched spot GeoJSON. The space in this example is for readability only; omit it in a real URL. The endpoint also accepts `bbox=south,west,north,east`.

The enriched spot endpoint cross-references each spot's `reference` against the local park CSV, adds park coordinates and names to feature properties, and applies the bbox to the matched park location. Spots with a reference not present in the CSV are omitted from the mapped GeoJSON response.

## Local development

```sh
npm test
npm start
```

Configuration is available through environment variables:

- `PORT` (default `3000`)
- `POTA_PARKS_URL` (default `https://pota.app/all_parks_ext.csv`)
- `POTA_SPOTS_URL` (default `https://api.pota.app/spot`)
- `PARK_REFRESH_MS` (default `21600000`, six hours)
- `FETCH_TIMEOUT_MS` (default `20000`)

## Deployment

The Kubernetes manifests deploy a `ClusterIP` service in the `potamap` namespace. There is no Ingress, LoadBalancer, or NodePort, so the API is reachable only from inside the cluster unless another existing internal component explicitly proxies it.
