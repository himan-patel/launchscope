# Performance checks (`launchscope perf`)

`launchscope perf` loads every route of your web app in a real browser, records every request
each page makes, traces how those requests depend on each other, finds the bottlenecks, and
optionally stress tests the routes. It ends with a report directory you can open, share, or feed
into CI.

- [Install](#install)
- [Node.js version](#nodejs-version)
- [Quick start](#quick-start)
- [Recipes](#recipes)
- [How a run works](#how-a-run-works)
- [Reading the report](#reading-the-report)
- [Bottleneck rules](#bottleneck-rules)
- [Comparing with a baseline](#comparing-with-a-baseline)
- [Stress testing](#stress-testing)
- [Options reference](#options-reference)
- [Configuration file](#configuration-file)
- [Budgets](#budgets)
- [Use in CI](#use-in-ci)
- [Measurement notes and limits](#measurement-notes-and-limits)
- [Privacy and safety](#privacy-and-safety)
- [Troubleshooting](#troubleshooting)

## Install

Requirements: **Node.js 22.19 or newer** (see [Node.js version](#nodejs-version)).

```sh
git clone https://github.com/himan-patel/launchscope.git
cd launchscope
npm ci
npm link                          # puts `launchscope` on your PATH
npx playwright install chromium   # the browser LaunchScope drives
```

Already have Chrome or Edge installed? Skip the last step and pass `--browser-channel chrome`
(or `msedge`) to every run instead.

Check the install:

```sh
launchscope doctor          # launches each browser, loads Lighthouse, checks the output folder
launchscope perf --help
```

## Node.js version

LaunchScope needs **Node.js 22.19 or newer**; the project pins **22.23.3** (LTS) in `.nvmrc` and
`.node-version`, and npm refuses to install on an unsupported version (`engine-strict`).

| OS            | Version manager                                           | Command in the project folder                                                    |
| ------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| macOS / Linux | [nvm](https://github.com/nvm-sh/nvm)                      | `nvm install && nvm use` (reads `.nvmrc`)                                        |
| Windows       | [nvm-windows](https://github.com/coreybutler/nvm-windows) | `nvm install 22.23.3` then `nvm use 22.23.3` (it does not read `.nvmrc`)         |
| Any OS        | [fnm](https://github.com/Schniz/fnm)                      | `fnm install && fnm use` (reads `.node-version` / `.nvmrc`; works in PowerShell) |
| Any OS        | [Volta](https://volta.sh)                                 | `volta install node@22.23.3`                                                     |

Then check everything (Node.js, browsers, Lighthouse, output directory) with:

```sh
launchscope doctor
```

## Quick start

Start your app, then point LaunchScope at it:

```sh
launchscope perf http://localhost:3000
```

By default this:

1. reads `/sitemap.xml` and follows links one level deep from the start page (up to 10 routes),
2. loads each route **3 times with a cold cache** in Chromium,
3. traces each route's requests and finds bottlenecks,
4. prints a summary and writes a report directory.

```text
▲ launchscope v0.4.0
  Launch-readiness checks for web apps

Target   http://localhost:3000/ (loopback)
Plan     3 cold run(s) per route, desktop, throttle none, timeout 30.00 s
Routes   up to 10, crawl depth 1, sitemap on

  ✔ /  200 · TTFB 42 ms · LCP 610 ms · 18 requests · 412.0 KB
  ✔ /dashboard  200 · TTFB 120 ms · LCP 1.92 s · 41 requests · 1.12 MB
      ↳ sequential API chain: 3 calls, 840 ms
  ! /admin  401 · TTFB 8 ms · LCP 95 ms · 3 requests · 4.1 KB

Measured 3 route(s), 14 endpoint(s) · skipped: 2 logout, 6 off-origin

Bottlenecks · 1 critical, 3 warning, 2 info
  ● GET /api/projects returns 2,000 items in one response
      Paginate (limit/cursor) and let the client request more on demand.
  ● /dashboard waits on 3 sequential API calls (840 ms)
      Fetch independent data in parallel (Promise.all), return what the page needs from one endpoint, or load it on the server.
  …

✔ Report: ./launchscope-reports/localhost-3000_2026-10-19_04-36-47Z/perf/index.html
```

Open `index.html` in a browser for charts, waterfalls, and hop trees.

## Recipes

### Measure specific routes

```sh
launchscope perf http://localhost:3000 --routes /,/pricing,/app/settings
```

With `--routes`, only those routes are measured (no sitemap, no crawl). Add `--depth 1` to also
follow their links.

### Crawl deeper or exclude sections

```sh
launchscope perf https://staging.example.com --depth 2 --max-routes 40 --exclude '/blog/' --exclude '\.pdf$'
```

Logout links are never followed, whatever you configure.

### Find routes in your source code

```sh
launchscope perf http://localhost:3000 --repo .
```

Pages that nothing links to (onboarding steps, settings screens, admin pages) are easy to miss
when crawling. `--repo` reads routes from the app's source:

| Router                  | How routes are found                                                                                                                             | API routes measured directly                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Next.js App Router      | `app/**/page.*` (route groups, parallel and private folders handled)                                                                             | `app/**/route.*` exporting `GET`                                                          |
| Next.js Pages Router    | `pages/**` (in projects that depend on `next`)                                                                                                   | `pages/api/**`                                                                            |
| SvelteKit               | `src/routes/**/+page.svelte`                                                                                                                     | `+server.(js\|ts)` exporting `GET`                                                        |
| Nuxt / Astro            | `pages/**/*.vue` / `src/pages/**`                                                                                                                | –                                                                                         |
| Remix / React Router v7 | `app/routes/*` flat file routes                                                                                                                  | –                                                                                         |
| Angular (code)          | `provideRouter` / `RouterModule.forRoot` arrays, nested `children`, lazy `loadChildren` (route files and NgModules with `RouterModule.forChild`) | –                                                                                         |
| React Router (code)     | `createBrowserRouter` / `useRoutes` objects, `<Routes>` / `<Route>` trees, index routes, descendant `<Routes>` under `path="x/*"`                | –                                                                                         |
| Express                 | –                                                                                                                                                | `app.get`, `router.get`, `app.route(…).get` with `app.use(prefix, router)` mount prefixes |

Code-based routers are parsed (JavaScript, TypeScript, and JSX syntax trees) and followed across
files through imports and `require()`, so a child route keeps its parent's prefix and a lazily
loaded route file contributes routes under the path that loads it. Only routes reachable from a
router root are reported. Code that cannot be resolved statically is listed in `repo.json` under
`skipped` with the reason, never guessed: a computed path, a `loadChildren` import through a path
alias or package, a router built by a function call, or a router that is never mounted.

Dynamic segments (`[slug]`, `:id`, `$id`) are filled from `perf.routeParams` in the config file,
for example `{ "routeParams": { "slug": "hello-world", "id": "42" } }`. Routes that still need a
value are listed as skipped in `repo.json` and never guessed. Repository pages are measured like
sitemap pages (counted against `--max-routes`, not crawled further), and repository API routes are
measured directly over HTTP (labeled "repository" in the endpoints table).

Every repository route is then **checked against the live app** (`repo.json` → `verification`,
and the "Repository routes" section of the report): `ok` (status below 400; redirects are noted),
`not-found` (404 or 410, also reported as a `repo-route-not-found` finding), `error` (other 4xx/5xx
or a failed load), or `not-measured` (route limit, `--exclude`, or an interrupted run). These are
HTTP outcomes: a single-page app whose server answers every path with `index.html` returns 200 even
for a route its client router renders as "not found".

### Measure API endpoints from an OpenAPI spec

```sh
launchscope perf http://localhost:3000 --openapi auto                   # /openapi.json, /v3/api-docs, …
launchscope perf http://localhost:3000 --openapi ./openapi.json
launchscope perf http://localhost:3000 --openapi ./openapi.yaml
launchscope perf http://localhost:3000 --openapi http://localhost:3000/docs/spec.json
```

LaunchScope reads the OpenAPI 3.x or Swagger 2.0 document (JSON or YAML) and measures every
**GET** operation on the target origin directly over HTTP, `--runs` times each, with the same
headers and session cookies as the browser. That covers endpoints no page calls. Path and required query
parameters need an `example`, `examples`, `default`, or `enum` value; operations without one, and
all non-GET or deprecated operations, are listed as skipped instead of being called with
invented input. Results join the endpoint statistics and findings (the report marks endpoints as
"page", "API spec only", or both), are replayed by `--stress`, and are listed in `openapi.json`.
YAML is read with the YAML 1.2 core schema (no custom tags) and at most 100 aliases. With `auto`,
`/openapi.yaml`, `/openapi.yml`, and `/swagger.yaml` are tried after the JSON locations. See
[New and reused connections](#new-and-reused-connections) for how direct calls are timed.

### Measure an API without a browser

```sh
launchscope api http://localhost:3000 --endpoint /api/health --endpoint "GET /api/items?page=1"
launchscope api http://localhost:3000                          # finds /openapi.json, /v3/api-docs, …
launchscope api http://localhost:3000 --openapi ./openapi.json --runs 10 --stress
launchscope api http://localhost:3000 --repo . --baseline latest --fail-on warning
```

`launchscope api` is the same pipeline as `launchscope perf` without the browser: no pages are
loaded, no sitemap is read, and no screenshots or HAR files are written. Endpoints come from
`--endpoint` (repeatable, or `perf.endpoints` in the config file), an OpenAPI spec, and/or GET API
routes in the repository. With none of those given, it looks for a spec at the usual locations.
Each endpoint is called `--runs` times, one after another, with your `--header` values and
`--storage-state` cookies, and results get the same endpoint statistics, findings, budgets,
`--stress` and `--export-k6` replays, `--baseline` comparison, `--fail-on` exit code, and report
as a page run.

Listed endpoints are paths or URLs on the target origin, optionally prefixed with a method.
`launchscope api` reads the `perf` section of the config file (headers, budgets, stress
settings); page-only settings such as `routes`, `spa`, and `lighthouse` are ignored.
`--baseline latest` only picks earlier `launchscope api` runs, and `launchscope perf` only picks
earlier page runs.

`launchscope perf --endpoint <spec>` measures listed endpoints alongside the pages; the report
marks them "listed".

#### New and reused connections

Every direct call (listed, OpenAPI, or repository endpoints, in both commands) is timed with
Node's HTTP client, so DNS, TCP connect, TLS, sending, server wait, and download are measured
separately. Each run calls an endpoint twice on its own connection: first on a **new
connection** (DNS, TCP, and TLS included), then again on the **same, reused connection**. A
listed write is only sent the first time, so it is still sent once per run. The endpoints table
shows both medians ("New / reused conn. p50"), `endpoints.csv` adds `new_connection_p50_ms` and
`reused_connection_p50_ms`, and a `connection-setup` finding fires when the difference crosses
the `connectionSetupMs` budget, with the DNS, connect, and TLS medians as evidence. Durations,
percentiles, and call counts include both calls. Redirects are followed only on the target
origin, so headers and cookies never go to another host, and certificates are always validated.

#### Import requests from a HAR file

```sh
launchscope api http://localhost:3000 --import session.har                  # GET API calls only
launchscope api http://localhost:3000 --import session.har --import-writes  # plus POST/PUT/PATCH
launchscope perf http://localhost:3000 --import session.har                 # alongside the pages
```

Record a session in your browser (DevTools → Network → "Save all as HAR"), then measure the API
calls it made. Requests to the target origin that are API calls (Chromium's `fetch`/`xhr`
resource types, or JSON, XML, GraphQL, form, or text content in other browsers' HARs) are
imported once each, up to 100. Recorded POST, PUT, and PATCH requests are imported with their
bodies only with `--import-writes`; DELETE never. **Headers and cookies in the file are never
used**, so recorded credentials are not replayed: pass `--header` or `--storage-state` for
signed-in endpoints. Everything that was not imported is listed in `imports.json` with the
reason (other origin, not an API call, write, limit), and the report marks imported endpoints
"imported". Precedence when the same request comes from several sources: `--endpoint`, then
`--import`, then the OpenAPI spec, then `--repo`. Config: `perf.import` (a path or a list) and
`perf.importWrites`.

#### Write endpoints (POST, PUT, PATCH)

```sh
launchscope api http://localhost:3000 --endpoint "POST /api/search @search.json"   # body from a file
launchscope api http://localhost:3000 --endpoint 'POST /api/search {"q":"shoes"}'  # inline body
launchscope api http://localhost:3000 --endpoint "POST /api/search @search.json" \
  --stress --stress-replay '^/api/search$'                                         # also under load
```

In the config file an endpoint can also be an object:

```json
{
  "perf": {
    "endpoints": [
      "/api/health",
      { "method": "POST", "path": "/api/search", "body": { "q": "shoes" } },
      {
        "method": "PUT",
        "path": "/api/notes/1",
        "bodyFile": "note.xml",
        "contentType": "application/xml"
      }
    ]
  }
}
```

A body that parses as JSON is sent as `application/json`, other text as `text/plain`, unless
`contentType` says otherwise; object and array `body` values are sent as JSON. Bodies are at most
1 MB, held in memory only, and never written to any report file (`settings.json` notes only
"with body"). Writes run because you listed them, so the console lists every write it sends.
Under `--stress` a listed write is replayed only when its path also matches `--stress-replay`,
and `--export-k6` lists writes in a comment instead of exporting their bodies. DELETE and other
methods are always refused. Use writes against local or staging environments.

### Measure pages behind a login

Sign in once in a real browser window (SSO and MFA work), then reuse the saved session:

```sh
launchscope login https://staging.example.com/login --save .auth/session.json
launchscope perf https://staging.example.com --storage-state .auth/session.json
```

The session file contains live cookies. It is written with owner-only permissions and is
covered by the project's `.gitignore`; keep it out of version control.

For token-based APIs, send a header to the target origin instead (it is never sent to other
origins and never written to reports):

```sh
launchscope perf https://staging.example.com -H "Authorization: Bearer $STAGING_TOKEN"
```

### Line up backend traces with each page load

```sh
launchscope perf https://staging.example.com --trace-context
launchscope perf https://staging.example.com --trace-url 'https://tracing.example.com/trace/{traceId}'
```

Each measured page load gets its own W3C trace ID. Every request it makes to the target origin
carries a `traceparent` header (sampled, with a fresh span ID per request), so a backend
instrumented with OpenTelemetry or another W3C Trace Context tracer records its database,
cache, and service calls under that trace. The report lists each load's trace ID per route, or
links to it when `--trace-url` is given. Headers are never added to other origins, and the stress
test does not send them (it would flood your tracing backend).

### Measure client-side navigations (single-page apps)

```sh
launchscope perf http://localhost:3000 --routes /,/projects,/settings --spa
```

Full page loads are only half the story in React, Angular, Vue, Svelte, or Next.js apps: users
mostly move between pages without a reload. With `--spa`, for every link from one measured page
to another measured route (up to `--spa-max`, default 20), LaunchScope loads the first page,
clicks the link like a user, and measures from the click until the network and the DOM settle:

- **Duration** (click → last request finished and last DOM change), split into network and render
- **Requests, API calls, and bytes** the transition triggered, and its **sequential API chain**
- **Kind**: `client-side` when the router handled it, `full page load` when the browser loaded a
  new document

Each navigation runs `--runs` times in a fresh browser context. Findings: `slow-navigation`
(budget `navigationMs`), `navigation-api-chain`, `full-reload-navigation` (an internal link that
reloads the whole page in an app that otherwise routes client-side), and `navigation-failed`.
Results are in the report's "Client-side navigations" section and `navigations.json`.

### Compare browsers

```sh
npx playwright install firefox webkit      # once
launchscope perf http://localhost:3000 --browsers chromium,firefox,webkit
```

Chromium is always the primary, fully detailed measurement (hop tracing, timing phases,
throttling). With `--browsers`, every measured route is also loaded `--runs` times in Firefox
and/or WebKit (Safari's engine), and the report's "Cross-browser" section compares load event,
LCP, and errors per browser. Findings: `browser-failed` (loads in Chromium, not in another
browser), `browser-errors` (exceptions or failed requests Chromium does not have), and
`browser-slower` (load ≥ 1.5× and ≥ 500 ms slower than Chromium). Paint metrics a browser does not
report show as "–"; network throttling and CPU slowdown apply to Chromium only. A browser that
is not installed is skipped with a warning.

### Add Lighthouse scores

```sh
npm install lighthouse          # optional peer dependency
launchscope perf http://localhost:3000 --lighthouse
```

Runs one Google Lighthouse performance audit per measured route (Lighthouse's mobile preset, or
its desktop preset with `--device desktop`) against a separate Playwright Chromium, saves each
full report as `routes/<route>/lighthouse.html`, and adds a "Lighthouse" section with the score,
FCP, LCP, TBT, CLS, and Speed Index. Lighthouse applies its own simulated throttling, so its
numbers differ from LaunchScope's measured runs. Scores below the `lighthouseScore` budget (0.9
warning, 0.5 critical; lower is worse) become `lighthouse-score` findings. Signed-in pages work
with `--storage-state` (cookies are loaded and Lighthouse's storage reset is disabled); `--header`
values are not passed to Lighthouse because it would send them to every origin.

### Mobile and slow networks

```sh
launchscope perf https://example.com --device mobile --throttle 4g
```

`--device mobile` emulates a Pixel 7 and slows the CPU 4×. `--throttle 4g` is Lighthouse's
"slow 4G" (150 ms RTT, 1.6 Mbps down); `--throttle 3g` is DevTools' "Fast 3G".

### More stable numbers

```sh
launchscope perf http://localhost:3000 --runs 7 --warm-runs 3
```

More cold runs tighten the p50/p95 figures. Warm runs show repeat-visit performance with a primed
cache.

### Stress test a local or staging server

```sh
launchscope perf http://localhost:3000 --routes /,/dashboard --stress
launchscope perf http://localhost:3000 --stress --stress-stages 1,10,50,100 --stress-duration 20s
```

See [Stress testing](#stress-testing) for what this does and the safety rules.

### Catch regressions against an earlier run

```sh
launchscope perf http://localhost:3000 --baseline latest            # newest earlier run for this host
launchscope perf http://localhost:3000 --baseline ./main-branch-run/perf/summary.json
launchscope perf http://localhost:3000 --baseline latest --fail-on warning   # fail CI on regressions
```

See [Comparing with a baseline](#comparing-with-a-baseline).

### Validate configuration without a browser

```sh
launchscope perf http://localhost:3000 --config launchscope.config.json --dry-run
```

## How a run works

1. **Settings** are merged from CLI flags, then the `perf` section of `launchscope.config.json`,
   then defaults. Everything is validated before any work starts; unknown config keys are errors.
   Stress-test safety, the `--baseline` file, and the optional Lighthouse package are checked
   here too, so problems surface before any page is loaded.
2. **Routes** are discovered breadth-first: explicit routes (or the target), routes found in the
   repository (`--repo`), `sitemap.xml` entries, then links found on measured pages, up to
   `--depth` and `--max-routes`. Links rendered by JavaScript count, because they are read from
   the live page.
3. **Measurement**: each cold run uses a fresh browser context (empty cache, cookies from
   `--storage-state` only, new connections). The Chrome DevTools Protocol records every request:
   timing phases, compressed and decoded sizes, initiator, redirects, cache status, selected
   response headers, GraphQL operations, WebSockets, and iframe requests. Web Vitals are
   collected inside the page. A load ends when the network has been idle for 500 ms (at most
   10 s after the `load` event; long-lived streams do not count), so late API calls are included.
   Each route is folded into the analysis as soon as it is measured.
4. **Tracing**: the run closest to the median is used to build the hop tree, sequential API
   chains, and the critical path.
5. **Direct API measurement** (`--openapi`, `--repo`): GET operations from the spec or the source
   are called over HTTP and join the endpoint statistics.
6. **Navigations** (`--spa`): links between measured routes are clicked like a user and each
   client-side transition is measured.
7. **Other browsers and Lighthouse** (`--browsers`, `--lighthouse`): routes are loaded in Firefox
   or WebKit and audited with Lighthouse.
8. **Analysis**: distributions per route, statistics per endpoint across all routes, bottleneck
   rules against your budgets, and regressions against `--baseline`.
9. **Stress test** (`--stress`): routes are replayed at rising concurrency (closed model) or
   arrival rate (open model); `--export-k6` writes the same scenarios as a k6 script.
10. **Report**: JSON, CSV, Markdown, SVG, HAR, and the HTML report are written.

**Stopping early.** Press Ctrl+C (or send SIGTERM, as CI does when a job is cancelled) at any
point: the route being measured is abandoned, the routes already measured are analyzed and
written as a normal report marked `"interrupted": true` in `summary.json`, and the process exits
with code 130. Press Ctrl+C a second time to quit immediately.

## Reading the report

Each run gets a new directory; earlier runs are never overwritten.

```text
launchscope-reports/<host>[-port]_<UTC timestamp>/perf/
├── index.html          visual report: start here
├── summary.md          Markdown summary for pull requests, tickets, and chat
├── summary.json        everything below in one machine-readable file (schemaVersion 1)
├── bottlenecks.json    ranked findings
├── endpoints.json      per-endpoint statistics
├── routes.json         measured routes and why other URLs were skipped
├── settings.json       the resolved settings (header values redacted)
├── browsers.json       Firefox/WebKit results (with --browsers)
├── navigations.json    client-side navigations (with --spa)
├── repo.json           routes found in the repository, unresolved ones, and live verification
├── openapi.json        operations measured from the OpenAPI spec and why others were skipped
├── routes.csv          one row per route
├── endpoints.csv       one row per endpoint
├── routes/<route>/
│   ├── screenshot.png  the page after load (first cold run)
│   ├── waterfall.svg   request waterfall of the representative run
│   ├── trace.json      hop tree, API chains, critical path
│   ├── trace.txt       the hop tree as text (◆ = critical path)
│   ├── loads.json      every run with every request and its metrics
│   ├── page.har        HAR of the first cold run, redacted, without bodies
│   └── lighthouse.html Lighthouse report (with --lighthouse)
└── stress/             only with --stress
    ├── stress.json     stages, per-hop stats, per-second timeline, insights
    ├── k6-script.js    with --export-k6
    ├── stages.csv · hops.csv
    └── latency.svg · throughput.svg · errors.svg
```

### Route metrics

All route metrics are distributions across cold runs (count, min, max, mean, p50, p75, p90, p95,
p99, standard deviation). Tables show the median unless they say otherwise.

| Metric                 | Meaning                                                                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TTFB                   | Time to the first byte of the page document (includes redirects, DNS, TLS, server time)                                                                                       |
| FCP                    | First Contentful Paint: when the first text or image painted                                                                                                                  |
| LCP                    | Largest Contentful Paint: when the largest element painted                                                                                                                    |
| CLS                    | Cumulative Layout Shift: largest session window of unexpected layout shifts                                                                                                   |
| TTI                    | Time to Interactive: end of the last long task before the first 5 s window with no long tasks and at most two GET requests in flight (Lighthouse's definition; Chromium only) |
| TBT                    | Total Blocking Time: long-task time beyond 50 ms between FCP and TTI (Lighthouse's definition; Chromium only)                                                                 |
| Load                   | The page's `load` event                                                                                                                                                       |
| Requests / Transferred | Requests per load and bytes on the wire (compressed)                                                                                                                          |
| API calls              | fetch/XHR requests per load                                                                                                                                                   |

### Hop tree, API chains, and critical path

- **Hop tree**: every request hangs under what caused it. A stylesheet or script under the
  document that referenced it; an API call under the script on whose call stack it started.
- **Sequential API chain**: API calls where each was issued by the previous call's response
  handler, as in `await fetch(a); await fetch(b)`. A small script installed before the page's
  own code records this as it happens: while a `fetch` response (or its `json()`, `text()`, …)
  or an `XMLHttpRequest` completion handler (`onload`, `onloadend`, `onreadystatechange` at
  `readyState` 4, or their listeners; this covers axios) is running, including the promise
  continuations it triggers, any new fetch/XHR is recorded as caused by that request. Calls
  started from timers, user input, or independently are never linked, even if they happen to
  start right after another call finished.
- **Critical path**: starting from the last meaningful request to finish (beacons excluded), the
  chain of "waited for" and "triggered by" links back to the document. Shortening any step on
  this path makes the page finish sooner; speeding up anything else does not.

### Waterfall

Each row is a request on the representative run (up to 150 rows; the heading says when more
were left out, and every request is always in `trace.json`). The lighter part of a bar is waiting (queueing,
DNS, connect, TLS, and server time until the first byte); the solid part is downloading. Rows on
the critical path are bold and marked ◆. Vertical lines mark FCP and LCP. Hover a bar for the
full URL, status, size, and phase-by-phase timing.

### Endpoints

Every page and API request across all routes is grouped by method and **path template**: numeric
IDs become `:id`, UUIDs `:uuid`, long hex strings `:hash`, and opaque tokens `:token`, so
`/api/items/41` and `/api/items/42` are analyzed together. For each endpoint: calls, routes that
use it, duration/server-wait/download distributions, transferred and decoded sizes, status codes,
compression, cache headers, the largest JSON array in its responses, and the mean of each
`Server-Timing` component.

**Live connections and iframes.** WebSockets (handshake status and time, frames and bytes in
each direction; never frame contents) and server-sent event streams are listed per route under
"Live connections and embedded frames". Streams are excluded from request timing statistics and
the critical path, and they do not stop a page from being considered settled, so pages with live
updates are measured as quickly as any other. Requests made by iframes are counted separately
(frames, requests, bytes, origins).

**GraphQL.** Requests to a path ending in `/graphql` or `/gql` (and GET requests carrying a
GraphQL document) are split by operation, so `POST /graphql (GetViewer)` and
`POST /graphql (SearchProjects)` are separate endpoints with their own numbers and findings. The
operation name and type come from `operationName` or the document itself; persisted queries and
batched requests (`GetUser+GetFlags`) are supported. Request bodies are read in memory only;
reports keep the operation name and a short hash used to tell identical calls (same variables)
from calls with different variables.

## Bottleneck rules

Findings are ranked by severity (critical, warning, info) and then by impact. Every finding
includes the numbers it is based on and a recommendation.

| Rule                                                                          | Severity                   | Fires when                                                                                                       |
| ----------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `route-failed`                                                                | critical                   | every cold run of a route failed to load                                                                         |
| `route-status`                                                                | warning / critical (5xx)   | the page document returned 4xx/5xx                                                                               |
| `vitals-lcpMs`, `vitals-fcpMs`, `vitals-ttfbMs`, `vitals-cls`, `vitals-tbtMs` | budget                     | the median crosses the budget                                                                                    |
| `slow-endpoint`                                                               | budget                     | an API call's p95 duration or median server wait crosses the budget; names the largest `Server-Timing` component |
| `unstable-endpoint`                                                           | info                       | p95 ≥ 2.5× p50 over at least 5 calls (not reported when `connection-setup` explains the spread)                  |
| `connection-setup`                                                            | budget                     | median time on a new connection minus on a reused one crosses `connectionSetupMs` (at least 2 calls each)        |
| `large-payload`                                                               | budget                     | median decoded API response size crosses the budget                                                              |
| `oversized-collection`                                                        | budget                     | a JSON response contains an array longer than the budget                                                         |
| `uncompressed`                                                                | info / warning (≥ 100 KB)  | a text response ≥ 1.4 KB has no content encoding                                                                 |
| `duplicate-calls`                                                             | budget                     | the same method and URL is requested repeatedly in one load                                                      |
| `api-chain`                                                                   | budget                     | the longest sequential API chain has too many calls                                                              |
| `critical-segment`                                                            | warning                    | one request takes ≥ 40% (and ≥ 300 ms) of the critical path                                                      |
| `redirect`                                                                    | warning (documents) / info | a request goes through redirects                                                                                 |
| `repo-route-not-found`                                                        | warning                    | a route defined in the repository (`--repo`) returns 404 or 410 from the live app                                |
| `failing-endpoint`                                                            | warning / critical (5xx)   | an endpoint failed or returned 4xx/5xx                                                                           |
| `page-weight`, `request-count`                                                | budget                     | median bytes or requests per load cross the budget                                                               |
| `third-party`                                                                 | info                       | ≥ 50% of a page's bytes come from other origins                                                                  |
| `js-errors`                                                                   | warning / info             | uncaught exceptions or console errors                                                                            |
| `static-cache`                                                                | info                       | same-origin scripts, styles, fonts, or images lack long-lived `Cache-Control`                                    |
| `stress-knee`, `stress-saturation`, `stress-errors`, `stress-latency`         | see below                  | stress test results                                                                                              |

## Comparing with a baseline

`--baseline` compares this run with an earlier one and reports what got slower or heavier.

- `--baseline latest` uses the newest earlier, completed run for the same host in the output
  directory (interrupted runs are skipped). If there is none yet, the run continues with a warning.
- `--baseline <path>` accepts a `summary.json` file, its `perf/` directory, or the run directory,
  for example a run kept from the main branch.

Routes are matched by path and query, and endpoints by method and path template (plus origin for
third parties), so a baseline from staging can be compared with a run on localhost.

| Compared  | Metrics (medians unless noted) | Minimum change    |
| --------- | ------------------------------ | ----------------- |
| Routes    | TTFB, FCP, LCP, TBT, load      | 50–100 ms         |
| Routes    | CLS                            | 0.02              |
| Routes    | transferred bytes, requests    | 10 KB, 5 requests |
| Endpoints | p50, p95 duration              | 50 ms             |
| Endpoints | decoded size                   | 10 KB             |

A change counts only when it exceeds **10% and** the minimum above, so run-to-run noise on fast
pages is ignored. Regressions become `regression` findings (critical when ≥ 50% and at least 3×
the minimum) and count toward `--fail-on`. The report's "Compared with baseline" section and
`summary.md` list every significant change, improvements included, plus new and removed routes
and endpoints. The full comparison is in `summary.json` under `comparison`.

## Stress testing

`--stress` runs after measurement and reuses what was learned:

- **Real scenarios.** Each route is replayed the way the browser loaded it: the document, then its
  same-origin GET API calls level by level. Calls that waited on another call in the real load
  wait in the replay too; independent calls run in parallel. `--stress-include-assets` also
  replays same-origin scripts, styles, images, and fonts.
- **Closed-loop virtual users.** Each user replays route scenarios back to back. Stages raise the
  number of users (default `1,5,10,25,50`, 10 s each). Latency runs from request start to the
  last byte.
- **What you get per stage**: requests per second, latency percentiles, route replay time,
  errors with samples, a p95 per hop, and a per-second timeline.

**Closed or open model.** By default (`--stress-mode closed`) stages are concurrent virtual users,
and each user starts its next replay when the previous one finishes, so a slower server
automatically receives less load. With `--stress-mode open`, stages are **arrival rates**
(`--stress-rates 2,5,10,25`, replays started per second): replays start on schedule whether or
not earlier ones finished, the way independent visitors arrive. When the server falls behind,
work piles up: the report shows the peak number of replays in flight, the achieved start rate,
and replays dropped once `stress.maxInFlight` (default 1000) are in flight.

The analysis reads it like a capacity test:

| Insight                | Meaning                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Knee**               | first stage where p95 latency at least doubled versus the first stage (and grew ≥ 50 ms), with the hop whose p95 grew most: your likely bottleneck under load |
| **Throughput plateau** | concurrency rose ≥ 1.5× but throughput grew < 10%: current capacity                                                                                           |
| **Breaking point**     | first stage whose error rate crossed the `stressErrorRate` warning budget                                                                                     |

### Replaying POST requests (search, GraphQL)

Pages whose data comes from POST APIs are under-tested by GET-only replays. Allowlist those
requests by path:

```sh
launchscope perf http://localhost:3000 --routes /search --stress --stress-replay '^/api/search$'
launchscope perf http://localhost:3000 --stress --stress-replay '^/graphql$'
```

Matching same-origin **POST, PUT, and PATCH** requests are replayed with the exact body (and
`Content-Type`) captured during measurement. Bodies are held in memory only and never written to
any report file. Non-matching writes are never replayed, DELETE is never replayed, and the
console lists every replayed request type with a warning, because replayed writes can create
data. Use this against local or staging environments.

### Scaling up with k6

LaunchScope's load generator runs in one Node.js process. For larger tests, export the same
scenarios as a [k6](https://k6.io) script:

```sh
launchscope perf http://localhost:3000 --export-k6            # with or without --stress
k6 run launchscope-reports/<run>/perf/stress/k6-script.js
k6 run -e BASE_URL=https://staging.example.com -e LAUNCHSCOPE_HEADER_AUTHORIZATION='Bearer …' k6-script.js
```

The script replays each route's GET requests in the same dependency levels (parallel requests
use `http.batch`), mirrors the stress model (`ramping-vus` for closed, `ramping-arrival-rate`
for open) and stages, and turns `stressP95Ms` and `stressErrorRate` into k6 thresholds. Header
values come from `LAUNCHSCOPE_HEADER_<NAME>` environment variables, and request bodies are never
exported: allowlisted writes are listed in a comment to add by hand.

### Safety rules

Stress tests generate real load, so they are deliberately hard to misuse:

- **Local and private targets only by default.** The target's DNS results must all be loopback or
  private-network addresses (`localhost`, `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, link
  local, `.local`, `.internal`, IPv6 ULA). Anything public is refused unless you pass
  `--allow-remote`, which you should only do for systems you own or are authorized to test.
- **Read-only by default.** Only GET requests, only to the target origin, never third parties.
  Writes are replayed only when you allowlist them (see below); DELETE is never replayed.
- **Circuit breaker.** A stage stops, and no further stages run, once more than
  `stress.maxErrorRate` (default 50%) of its requests fail (after at least 20 requests).
- **Ctrl+C** (or SIGTERM) stops the current stage, keeps what was measured, writes the report, and exits with code 130.
- Requests identify themselves: `User-Agent: launchscope/<version> (stress test; +<repo>)`.

## Options reference

### `launchscope perf <target>`

| Option                         | Default                          | Description                                                                                           |
| ------------------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `-r, --routes <paths>`         | –                                | Comma-separated routes to measure, e.g. `/,/pricing`                                                  |
| `--max-routes <n>`             | 10                               | Maximum routes to measure (1–500)                                                                     |
| `--depth <n>`                  | 1 (0 with `--routes`)            | Link-crawl depth from the seeds (0–5)                                                                 |
| `--no-sitemap`                 | sitemap on (off with `--routes`) | Do not read `/sitemap.xml`                                                                            |
| `--exclude <regex>`            | –                                | Skip URLs matching the pattern (repeatable, case-insensitive)                                         |
| `-n, --runs <n>`               | 3                                | Cold-cache runs per route (1–50)                                                                      |
| `--warm-runs <n>`              | 0                                | Extra warm-cache runs per route (0–20)                                                                |
| `--device <profile>`           | desktop                          | `desktop` (1366×768) or `mobile` (Pixel 7, 4× CPU slowdown)                                           |
| `--throttle <profile>`         | none                             | `none`, `4g`, or `3g`                                                                                 |
| `--timeout <duration>`         | 30s                              | Page load timeout, e.g. `45s`, `2m`, `500ms`                                                          |
| `--browser-channel <name>`     | bundled Chromium                 | Use an installed browser: `chrome`, `msedge`, …                                                       |
| `--headed`                     | off                              | Show the browser window                                                                               |
| `--storage-state <file>`       | –                                | Saved session from `launchscope login`                                                                |
| `--endpoint <spec>`            | –                                | Also measure this endpoint directly, e.g. `/api/health` or `POST /api/x @body.json` (repeatable)      |
| `--import <file>`              | –                                | Also measure the API requests recorded in a HAR file (repeatable)                                     |
| `--import-writes`              | off                              | Also import recorded POST/PUT/PATCH requests, with their bodies                                       |
| `-H, --header <header>`        | –                                | `Name: value` header for the target origin only (repeatable)                                          |
| `--stress`                     | off                              | Stress test after measuring                                                                           |
| `--stress-stages <list>`       | 1,5,10,25,50                     | Concurrent users per stage, strictly increasing (max 10 stages, 1000 users)                           |
| `--stress-duration <duration>` | 10s                              | Duration of each stage                                                                                |
| `--stress-timeout <duration>`  | 10s                              | Per-request timeout under stress                                                                      |
| `--stress-include-assets`      | off                              | Also replay same-origin scripts, styles, images, fonts                                                |
| `--stress-replay <regex>`      | –                                | Also replay same-origin POST/PUT/PATCH requests whose path matches, with recorded bodies (repeatable) |
| `--allow-remote`               | off                              | Allow stress testing a public host you own                                                            |
| `--json`                       | off                              | Print the summary JSON to stdout                                                                      |
| `--dry-run`                    | off                              | Validate options and config, write settings, no browser                                               |
| `--fail-on <level>`            | none                             | Exit 1 if a finding at `warning` or `critical` (or worse) exists                                      |

Global options (`--config`, `--output-dir`, `--no-color`, `--quiet`, `--verbose`) go before the
command name, e.g. `launchscope --verbose perf http://localhost:3000`. `--verbose` prints each
route's hop tree.

### `launchscope api <target>`

Takes `--endpoint <spec>` (repeatable), `--import <file>` (repeatable), `--import-writes`,
`--openapi`, `--repo`, `--runs` (calls per endpoint),
`--timeout` (per request), `--storage-state`, `--header`, the stress options except
`--stress-include-assets` (`--stress-replay` matches listed writes), `--allow-remote`, `--json`, `--dry-run`,
`--export-k6`, `--baseline`, and `--fail-on`, with the same defaults and limits as
`launchscope perf`. See [Measure an API without a browser](#measure-an-api-without-a-browser).

### `launchscope login <url>`

| Option                     | Default              | Description                                   |
| -------------------------- | -------------------- | --------------------------------------------- |
| `-s, --save <file>`        | `.auth/session.json` | Where to save the session                     |
| `--browser-channel <name>` | bundled Chromium     | Use an installed browser                      |
| `--wait <duration>`        | 5m                   | How long to wait for you to finish signing in |

## Configuration file

LaunchScope reads `launchscope.config.json` from the directory you run it in (or the file given
with `--config`). CLI flags override it. Strings may reference environment variables as
`${NAME}`; a missing variable is an error, so a secret never silently becomes empty.

```json
{
  "outputDir": "launchscope-reports",
  "perf": {
    "routes": ["/", "/pricing", "/app/dashboard"],
    "maxRoutes": 25,
    "openapi": "auto",
    "repo": ".",
    "routeParams": { "slug": "hello-world", "id": "42" },
    "depth": 1,
    "sitemap": true,
    "exclude": ["/blog/", "\\.pdf$"],
    "runs": 5,
    "warmRuns": 1,
    "spa": true,
    "device": "desktop",
    "browsers": ["chromium", "firefox"],
    "throttle": "none",
    "timeout": "45s",
    "browserChannel": "chrome",
    "storageState": ".auth/session.json",
    "headers": { "Authorization": "Bearer ${STAGING_API_TOKEN}" },
    "traceContext": { "urlTemplate": "https://tracing.example.com/trace/{traceId}" },
    "failOn": "critical",
    "baseline": "latest",
    "stress": {
      "stages": [1, 10, 25, 50],
      "duration": "15s",
      "timeout": "10s",
      "includeAssets": false,
      "allowRemote": false,
      "maxErrorRate": 0.25,
      "mode": "closed",
      "rates": [2, 5, 10, 25],
      "maxInFlight": 1000,
      "replay": ["^/graphql$"]
    },
    "budgets": {
      "lcpMs": { "warning": 2000, "critical": 3500 },
      "apiP95Ms": 400,
      "chainLength": 2
    }
  }
}
```

A copy lives at [`examples/launchscope.config.json`](../examples/launchscope.config.json).

**Editor support.** A JSON Schema ships with LaunchScope. Add a `$schema` line to get
autocomplete, inline docs, and validation in VS Code and other editors:

```json
{
  "$schema": "https://raw.githubusercontent.com/himan-patel/launchscope/main/schema/launchscope.config.schema.json",
  "perf": { "runs": 5 }
}
```

(When LaunchScope is installed from npm, `./node_modules/launchscope/schema/launchscope.config.schema.json`
works offline.) LaunchScope itself still validates every value at run time.

## Budgets

Budgets turn measurements into findings. Each has a `warning` and a `critical` level; a bare
number sets the warning level and keeps the default critical level. Web Vitals defaults follow
Google's published "good / poor" boundaries.

| Budget              | Measures                          | Warning | Critical |
| ------------------- | --------------------------------- | ------- | -------- |
| `lcpMs`             | median LCP                        | 2500    | 4000     |
| `fcpMs`             | median FCP                        | 1800    | 3000     |
| `ttfbMs`            | median document TTFB              | 800     | 1800     |
| `cls`               | median CLS                        | 0.1     | 0.25     |
| `tbtMs`             | median TBT                        | 200     | 600      |
| `apiP95Ms`          | API call p95 duration             | 500     | 1500     |
| `serverWaitMs`      | API median server wait            | 300     | 1000     |
| `connectionSetupMs` | new minus reused connection, p50  | 200     | 600      |
| `apiPayloadBytes`   | median decoded API response       | 512000  | 2097152  |
| `jsonArrayItems`    | longest JSON array                | 200     | 1000     |
| `chainLength`       | calls in the longest API chain    | 3       | 5        |
| `pageWeightBytes`   | median transferred bytes per load | 2097152 | 5242880  |
| `requestCount`      | median requests per load          | 100     | 200      |
| `duplicateCalls`    | identical calls in one load       | 2       | 4        |
| `stressP95Ms`       | p95 at the last stress stage      | 1000    | 3000     |
| `stressErrorRate`   | error ratio at any stress stage   | 0.01    | 0.05     |

## Use in CI

`--fail-on` turns findings into an exit code (reports are always written first), and `--json`
prints the summary to stdout while progress goes to stderr:

```sh
launchscope perf http://localhost:3000 --runs 3 --fail-on critical --json > perf-summary.json
```

| Exit code | Meaning                                                                              |
| --------- | ------------------------------------------------------------------------------------ |
| 0         | success                                                                              |
| 1         | a finding reached `--fail-on`                                                        |
| 2         | invalid command, option, target, or configuration (including stress-safety refusals) |
| 70        | unexpected internal error                                                            |
| 130       | interrupted with Ctrl+C or SIGTERM; a partial report was still written               |

A complete GitHub Actions workflow that starts your app, runs LaunchScope, and uploads the report
is in [`examples/github-actions.yml`](../examples/github-actions.yml).

## Measurement notes and limits

- **Lab data.** Numbers come from one machine, one browser, and one network profile. They are
  ideal for comparing runs and catching regressions, not a replacement for real-user monitoring.
- **Local is not production.** Against `localhost`, sizes, request counts, chains, and payload
  findings carry over; absolute times usually do not (no real network, often a dev build).
  Measure a production build when you can.
- **TTI and TBT need a quiet window.** Each load stays open until a 5 s window with no long
  tasks and at most two GET requests in flight has actually been observed after FCP (up to
  20 s). A page that never goes quiet (constant polling or animation work) gets no TTI, and its
  TBT is reported as a lower bound (`tbtComplete: false` per load, `tbtLowerBoundRuns` per route,
  noted in the TBT finding). The calculation is tested against Lighthouse's own implementation.
  Long tasks come from the Long Tasks API (tasks over 50 ms), so TTI and TBT are Chromium-only.
- **API chains cover fetch and XMLHttpRequest.** Requests made from a Web Worker, a service
  worker, or WebSocket messages are measured but are not linked as dependencies. A dependency
  that goes through a timer (`setTimeout` after a response) is deliberately not linked.
- **Backend hops** (database, cache, upstream services) are visible in two ways: `Server-Timing`
  response headers (shown per endpoint) and, with `--trace-context`, your own tracing backend,
  where each page load is one trace.
- **Service workers are blocked** during measurement so every request is visible.
- **Stress latency is client-side** and measured by Node.js; at very high request rates the load
  generator itself can become the limit. For large-scale load tests use a dedicated tool; use
  LaunchScope to find the first bottleneck and which hop causes it, and `--export-k6` to scale
  the same scenarios up.

## Privacy and safety

- No account, API key, or telemetry. The only traffic goes to the site you are checking (and
  whatever third parties that site loads in the browser).
- Extra headers are sent to the target origin only and redacted in `settings.json`.
- Response bodies are never stored. JSON bodies are parsed in memory to count array items.
- HAR files are recorded without bodies, and cookies, auth headers, tokens, sensitive query
  parameters, and request bodies are scrubbed before they are written.
- Session files from `launchscope login` are written with owner-only permissions.
- Everything that came from the measured site is escaped in the HTML report, and CSV cells are
  protected against spreadsheet formula injection.

## Troubleshooting

| Problem                                             | Fix                                                                                                         |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `No browser is installed for LaunchScope to drive.` | Run `npx playwright install chromium`, or use `--browser-channel chrome`                                    |
| A route shows `401` / `403`                         | Measure signed in: `launchscope login …` then `--storage-state`                                             |
| `Timeout … exceeded`                                | Raise `--timeout`, or check the route loads in a normal browser                                             |
| Few routes found                                    | Raise `--depth` / `--max-routes`, add a sitemap, or list `--routes` explicitly                              |
| `Could not read sitemap.xml`                        | Harmless: the sitemap is optional. Use `--no-sitemap` to silence it                                         |
| `Refusing to stress test …`                         | The host resolves to a public address. Test a local or staging copy, or pass `--allow-remote` if you own it |
| `Unknown key(s) in config "perf"`                   | A typo in `launchscope.config.json`; the message lists the allowed keys                                     |
| Numbers vary a lot between runs                     | Increase `--runs`, close other heavy apps, and measure a production build                                   |
