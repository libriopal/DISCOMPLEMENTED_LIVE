# Tier 3 preview — acceptance transcript

Run 2026-08-30. §3.2 asks for two things to be "proven by transcript": that a
generated app with API routes serves a real request end to end inside the
container, and that a generated app with a dependency outside the four baked
into `Dockerfile.preview` installs and runs. This is that transcript.

## What was actually exercised, and what was not

The image is the real one — `docker build -f apps/web/Dockerfile.preview`, no
modifications. The commands run inside it are the strings the Sandbox DO emits:
`buildWriteFileScript`, `buildDevServerCommand`, `buildBackendCommand` and
`buildInstallCommand`, copied from the source rather than approximated.

It is **not** a Cloudflare Container. This host has `docker` but not
`docker buildx`, so `wrangler` cannot build or deploy the image from here, and
the run below is plain Docker. That means these properties were **not**
measured and are not claimed by this document:

- `enableInternet: false` and the egress phase machine. Plain Docker has open
  networking, so the install below proves the install _command_ works, not that
  the seal holds. `sandbox-egress.ts` is covered by unit tests instead.
- The `NODE_EXTRA_CA_CERTS` / `trustInterceptionCa()` prefix of
  `buildInstallCommand`. Cloudflare's interception CA only exists inside a
  running Cloudflare container; it was dropped for this run.
- The DO's proxy path, capacity ceiling, and reaping. Those are covered by
  `apps/web/tests/integration/preview-*.test.ts`.

## 1. A full-stack generated app, end to end

Files written into `/app` through the real write script: `index.html`,
`src/main.jsx`, and a `server.js` that serves `/api/todos` and 404s everything
else — the shape the Coder agent is told to emit.

Both processes started with the real commands:

```
cd /app && exec /app/node_modules/.bin/vite --host 0.0.0.0 --port 5173 --strictPort > /tmp/vite.log 2>&1
cd /app && PORT=8080 HOST=0.0.0.0 exec node server.js > /tmp/server.log 2>&1
```

```
VITE v6.4.3  ready in 654 ms
➜  Local:   http://localhost:5173/
➜  Network: http://172.17.0.2:5173/
```

Four requests, issued from inside the container:

| #   | port | path         | status | content-type       | body                                         |
| --- | ---- | ------------ | ------ | ------------------ | -------------------------------------------- |
| 1   | 8080 | `/api/todos` | 200    | `application/json` | `[{"id":1,"title":"buy milk","done":false}]` |
| 2   | 5173 | `/`          | 200    | `text/html`        | the Vite index document                      |
| 3   | 5173 | `/api/todos` | 200    | `text/html`        | **the Vite index document**                  |
| 4   | 8080 | `/api/nope`  | 404    | `application/json` | `{"error":"Not Found"}`                      |

**Row 1 is the acceptance criterion**: a route the blueprint declared,
answered by the generated server, with the payload it was written to return.

**Row 3 is why `sandbox-health.ts` exists.** Vite answers an unmatched path
with `index.html` and HTTP 200, so a request that never reached the generated
server is indistinguishable from success by status code alone. This was the
theory the health module was written against; row 3 is it measured. It is also
why `backendRunning` was never adequate — port 8080 accepting a connection says
nothing about which process answers a given path.

The four captured responses were then fed through the shipped judgement
functions unchanged. All four verdicts matched:

- rows 1 + 2 together → `healthy: true, degraded: false`
- row 3 → `unhealthy` (HTML on an API path)
- row 4 → `unhealthy` (the blueprint declares this route)

## 2. A dependency outside the image

`nanoid@5.0.7` — not one of the four baked into `Dockerfile.preview`.

```
cd /app && npm install --ignore-scripts --no-audit --no-fund \
  --no-package-lock --loglevel=error 'nanoid@5.0.7'
```

Exit 0. Resolvable from Node inside the container (`nanoid()` returned
`cfIzuiu6tuE57ikudMcsy`), and — the part that matters, since the founder's app
is served by Vite and not by Node — served through the dev server with the bare
specifier rewritten to a real path:

```
GET :5173/src/ids.js → 200 text/javascript
import { nanoid } from "/node_modules/.vite/deps/nanoid.js?v=579c7793";
export const makeId = () => nanoid();
```

## 3. The failure this replaced, still failing loudly

`lib/preview-runtime.ts` documents a production run where a file importing an
undeclared package returned HTTP 500 while the run was marked deployed and the
founder got a blank page. Reproduced here to confirm the failure is still
loud rather than silent:

```
GET :5173/src/broken.js → 500   (importing markdown-it, never declared)
```

`judgeFrontendResponse` calls a 500 unhealthy, so this now surfaces instead of
being swallowed. What it does **not** do is catch the case at generation time —
that remains `preview-runtime.ts`'s job, checking declared imports before the
container is asked to serve them.
