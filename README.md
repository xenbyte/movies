# movies

Minimal self-hosted media site at https://movies.xenbyte.dev

- Backend: Jellyfin (handles library scanning, transcoding, subtitle extraction from MKV)
- Frontend: custom minimal SPA (`frontend/`) served by nginx, which also reverse-proxies all
  non-static requests to the internal Jellyfin service so the whole thing is exposed as one site/ingress.
- `k8s/` holds the nginx config + manifests for the frontend deployment.
