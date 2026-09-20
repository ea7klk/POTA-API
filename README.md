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

Inside Kubernetes, use `http://pota-api.potamap.svc.cluster.local:80` (or omit `:80`). The Service listens on port 80 and forwards to the Node.js container on port 3000.

Configuration is available through environment variables:

- `PORT` (default `3000`)
- `POTA_PARKS_URL` (default `https://pota.app/all_parks_ext.csv`)
- `POTA_SPOTS_URL` (default `https://api.pota.app/spot`)
- `PARK_REFRESH_MS` (default `21600000`, six hours)
- `FETCH_TIMEOUT_MS` (default `20000`)

## Deployment

Deployment is managed by Rancher Fleet, not by direct application `kubectl apply` calls. The Fleet GitRepo belongs to workspace `ea7klk`, lives in the `ea7klk` Fleet namespace, and watches `fleet/potamap`.

The bootstrap definition is in [`fleet-bootstrap/gitrepo.yaml`](fleet-bootstrap/gitrepo.yaml). It is intended to be added to the cluster's Fleet bootstrap source once; Fleet then reconciles the resources from [`fleet/potamap`](fleet/potamap). The build workflow publishes the image and commits its immutable digest into the Fleet resource, which causes Fleet to roll out each new version.

The resulting Service is `ClusterIP` on port 80 in the `potamap` namespace. There is no Ingress, LoadBalancer, or NodePort, so the API is reachable only from inside the cluster unless another existing internal component explicitly proxies it.
