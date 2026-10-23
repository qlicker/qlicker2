# Application Architecture Overview

Qlicker is a React 19 single-page application backed by a Fastify 5 API server. It preserves compatibility with the legacy Meteor database while serving current behavior through REST and WebSocket APIs.

## High-level architecture

```text
Browser (React + MUI + Vite)
  ├─ Auth context + protected routes
  ├─ Role-specific pages (admin / professor / student)
  ├─ Rich text, grading, review, libraries, chat, AI, and live-session UIs
  └─ REST + WebSocket client communication

Fastify server
  ├─ JWT auth, refresh cookies, CSRF/CORS enforcement
  ├─ REST route modules (auth, users, courses, sessions, questions, grades, groups, chat, video, AI, images, settings)
  ├─ WebSocket transport for live-session deltas
  ├─ Services for grading, copying, notifications, AI tools, and aggregate generation
  └─ OpenAPI generation via Fastify Swagger

MongoDB
  ├─ Legacy-compatible documents
  ├─ Mongoose schemas and indexes
  └─ Session, response, grade, and question persistence

Optional infrastructure
  ├─ Redis pub/sub for multi-instance WebSocket fan-out
  ├─ S3 / Azure / local image storage
  ├─ SAML identity-provider and AI-backend integrations
  └─ Docker Compose + Nginx production deployment
```

## Repository layout

```text
qlicker2/
├── client/                # React frontend (pages, components, contexts, i18n)
├── server/                # Fastify backend (routes, models, services, config)
├── docs/                  # User and developer documentation
├── production_setup/      # Production deployment and operations scripts
├── scripts/               # Dev setup, local control, and seed helpers
├── ssoserver/             # Local SimpleSAMLphp smoke-test environment
├── meteorjs_migration/    # Migration archive, status, and legacy DB notes
└── CODING_STANDARDS.md    # Coding conventions and API patterns
```

## Frontend structure

Important frontend entry points:

- `client/src/App.jsx` defines route structure and protected routes.
- `client/src/contexts/AuthContext.jsx` manages current-user auth state.
- `client/src/pages/admin/` contains admin workflows.
- `client/src/pages/professor/` contains instructor workflows such as course detail, session editor, live session, and review.
- `client/src/pages/student/` contains student workflows such as dashboard, course detail, live session, quiz, review, and practice sessions.
- `client/src/components/` contains reusable UI building blocks and feature panels such as grading, question-library, groups, and video.
- `client/src/i18n/` contains locale files and translation configuration.
- `client/e2e/` contains role-oriented Playwright workflows and the opt-in manual screenshot capture.

## Backend structure

Important backend areas:

- `server/src/app.js` wires the Fastify application together.
- `server/src/routes/` contains route modules by feature area.
- `server/src/models/` contains the Mongoose schemas.
- `server/src/services/` contains reusable business logic such as grading and question/session copy behavior.
- `server/src/utils/` contains lower-level helpers such as histogram calculation.
- `server/test/` contains route and service tests.
- `server/scripts/` contains E2E, migration, and data-maintenance entry points.

Live-session response notifications are incremental. Option-based questions
send their small distribution aggregate; short-answer and numerical questions
send the single new response with compact totals or numerical summary fields.
Clients merge the new response into their current snapshot. This keeps a wave
of submissions linear in payload size instead of resending the accumulated
answer list after every response.

### Host monitoring

`server/src/systemMonitor.js` is a separate, resource-limited collector process. It reads Linux host counters once per minute and writes seven-day aggregate history and collector events to MongoDB. Authentication publishes throttled, non-awaited recent-user heartbeats to Redis; no host sampling or monitoring database writes run in request handlers. The admin-only `/users/admin/system-monitoring` endpoint reads bounded history and caches downsampled responses for 30 seconds. The client fetches on tab entry, range selection, or manual refresh. See [deployment and metric limits](../../production_setup/README.md#in-app-system-monitoring).

## Role-oriented page model

The current app is intentionally role-oriented:

- **Admin routes** handle platform configuration and support.
- **Professor routes** handle course management, session authoring, live delivery, review, and grading.
- **Student routes** handle participation, quizzes, review, and practice.

This is useful when adding features because it helps determine:

- where navigation should live
- which permissions apply
- which API payloads can be safely returned to the client

Course instructor membership is distinct from global role. A student-role account assigned as a course instructor can use that course's professor workspace, while unrelated professor/admin pages remain protected by their normal role rules.

## Authentication and authorization

- Access tokens authorize API calls; refresh cookies extend a session up to the configured hard expiry.
- Browser-changing requests use the established CSRF/request headers and CORS policy.
- Local accounts can register/login/reset passwords when policy permits; SAML routes support institution-managed accounts.
- Disabling an account blocks login, refresh, and existing authenticated use without deleting academic history.
- Authorization is enforced server-side even when the client also hides unavailable navigation.

## Real-time behavior

Live-session and dashboard freshness rely on WebSocket events where available, with polling fallback logic for some client views.

Examples of real-time updates include:

- session status changes
- current-question changes
- response-count updates
- visibility changes
- participant joins
- quiz submission refreshes

Redis can fan these events out across multiple app instances in production.

Clients patch local state from sufficiently complete deltas and use targeted refreshes for incomplete/legacy payloads. Maintain that contract on high-volume response and chat paths.

Student live pages and the presentation window share `LiveSessionWebSocketProvider`,
`useLiveSessionData`, and the reducers in `liveSessionUpdates.js`. The provider
delivers every event to subscribers (including messages batched into one React
render), keeps the socket independent of panel changes, and refreshes on connection
or reconnection. The data hook replays deltas received during an HTTP fetch over
that snapshot so an older request cannot undo navigation or visibility changes.

Presentation requests use `view=presentation`, retaining the classroom join code
but using the student question snapshot. Instructor question, visibility, and
response events carry an `audience` projection built with the student serializers;
the presentation consumes that projection through the shared reducers. It never
applies named instructor responses. Presentation chat uses its existing anonymous
API projection. Incomplete events trigger a targeted refresh, with coalescing for
legacy response events.

The browser favicon is `client/public/favicon.svg`: a white Q in the application's
Helvetica font stack on the app bar's primary blue (`#30B0E7`). Keep it aligned
with `client/src/theme/index.js` when changing the branding.

## Storage and external services

Image storage is selected in database-backed admin settings and can use local files, S3-compatible object storage, or Azure Blob. Clients upload through the API; stored images are served through authenticated `/uploads/<key>` paths rather than direct provider URLs.

Optional integrations are policy-gated:

- SAML settings define identity-provider metadata, attributes, signing/encryption behavior, and route mode.
- Jitsi settings expose course/group video destinations.
- AI settings define trusted backends/models globally, with per-course enablement, model policy, student access, and rubrics.

## Production topology

The production Compose stack terminates TLS at Nginx, load-balances API replicas, persists MongoDB/uploads/backups, and uses Redis for WebSocket fan-out. The root `docker-compose.yml` is for development; production operations belong in `production_setup/`.

## Documentation and API generation

The API docs are generated from Fastify route schema definitions and exposed to administrators at `/docs` and `/docs/json` when `ENABLE_API_DOCS=true`.

When adding a new route, the architecture expectation is:

1. define request and response schema
2. enforce permissions in the route
3. keep client code role-aware
4. add tests for the changed behavior
5. verify `/docs` still describes the route correctly
