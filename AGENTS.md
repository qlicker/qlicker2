# Repository Guide for Coding Agents

This file applies to the entire repository. More specific `AGENTS.md` files may override it if they are added below a subdirectory.

## Project overview

Qlicker is a classroom response system. The active application is a React single-page client backed by a Fastify API, MongoDB, and optional Redis fan-out. It retains compatibility with data created by the legacy Meteor application.

| Area | Location | Notes |
| --- | --- | --- |
| Web client | `client/` | React 19, Vite, Material UI, react-i18next |
| API server | `server/` | Fastify 5, Mongoose, JWT/cookie auth, WebSockets |
| Development helpers | `scripts/` | Native and Docker setup, service control, seeding |
| Production operations | `production_setup/` | Docker Compose, Nginx, TLS, backup/restore, upgrades |
| Documentation | `docs/` | User manuals, developer guides, API overview |
| Load tests | `load-testing/` | k6 classroom and chat scenarios |
| SSO test environment | `ssoserver/` | Local SimpleSAMLphp integration environment |
| Migration archive | `meteorjs_migration/` | Legacy schema and operator migration guide |

Start with `README.md`, `CODING_STANDARDS.md`, and `docs/developer/README.md`. Read `meteorjs_migration/LEGACY_DB.md` before changing persisted data shapes. Keep completed plans out of the active documentation; record current behavior in the user/API/developer guides.

## Working rules

- Preserve unrelated changes in a dirty worktree. Do not reset, delete, or reformat files outside the task.
- Prefer the existing route, service, component, and test patterns over introducing parallel abstractions.
- Treat legacy string IDs and MongoDB field shapes as compatibility requirements unless a migration is explicitly part of the task.
- Never commit secrets, `.env` files, database dumps, backup archives, uploaded user data, or generated test artifacts.
- Keep user-visible behavior accessible, responsive, and localized.
- Update the relevant documentation in the same change as behavior, configuration, or operational workflows.

## Setup and common commands

The supported runtime is Node.js 22.13 or newer. Each JavaScript workspace has its own lockfile.

```bash
# Guided native setup and service control
./scripts/setup-native.sh
./scripts/qlicker.sh start
./scripts/qlicker.sh status
./scripts/qlicker.sh stop

# Guided Docker development setup
./scripts/setup-docker.sh
docker compose up -d --build

# Install directly when setup has already been completed
npm ci --prefix server
npm ci --prefix client
```

Use the smallest relevant validation first, then broaden it before handoff:

```bash
npm test --prefix server
npm test --prefix client
npm run build --prefix client
./scripts/qlicker.sh e2e
node scripts/check-doc-links.mjs
node --test load-testing/test/*.test.mjs
```

For a focused Vitest file, pass the path after the workspace command. For example:

```bash
npm test --prefix server -- test/routes/courses.test.js
npm test --prefix client -- src/pages/student/CourseDetail.test.jsx
```

## Backend conventions

- Put route modules in `server/src/routes/`, reusable business logic in `server/src/services/`, models in `server/src/models/`, and small cross-cutting helpers in `server/src/utils/`.
- Use route schemas for request validation and OpenAPI output. Verify API changes in the generated Swagger UI at `/docs` when `ENABLE_API_DOCS=true`.
- Reuse the registered authentication and role pre-handlers. Check both global roles and course instructor membership where applicable.
- Match established status codes and the `{ error, message }` error body. Do not expose secrets or internal exception detail.
- Use lean queries, projections, batching, and targeted WebSocket deltas on frequent live-session paths.
- Keep rate limits, CSRF checks, upload validation, HTML sanitization, and SSRF protections intact.
- When a schema change is unavoidable, document compatibility and provide an idempotent migration or repair path.

### Shared and anonymous activity invariants

- A session grant admits a signed-in account only to that activity; it never grants course enrollment, rosters, course chat, AI tools, or question-library access.
- Anonymous sessions have no grade items. Named guests have tracked responses but no grades until they enroll. Missing marks are absent, not zero.
- Preserve anonymity locks after participation, the four-respondent release rules, and instructor payload filtering across HTTP, WebSockets, AI, and exports.
- Keep ordinary course-member access on its existing fast path. Performance changes need comparable workload/image evidence, not just passing unit tests.

## Frontend conventions

- Put route-level pages in `client/src/pages/`, reusable UI in `client/src/components/`, and shared behavior in contexts, hooks, or utilities.
- Use the shared API client and existing auth/navigation helpers.
- Reuse Material UI and the established theme. Avoid adding a second component or styling system.
- Preserve keyboard behavior, focus management, semantic headings, form labels, table headers, and live-region announcements.
- Design for narrow screens as well as desktop. Course and admin tab sets use the shared responsive tabs component.
- Keep live pages delta-driven. Do not replace targeted WebSocket updates with broad polling or full-payload reloads without a measured reason.

## Localization

Every user-facing string must use `t()`. Locale files live in `client/src/i18n/locales/`.

- Add every new key to all locale JSON files so key sets remain synchronized.
- Write the English source string clearly and preserve interpolation variables such as `{{count}}` in every locale.
- Do not silently copy English into translated locales. If a translation cannot be completed in the change, call it out explicitly for review.
- Run JSON parsing and the client tests after changing locale files.

## Tests

- Server tests live in `server/test/`; client unit/component tests generally live beside the code; browser tests live in `client/e2e/`.
- Add regression coverage for fixes and permission checks for new server behavior.
- Prefer accessible Playwright locators (`getByRole`, `getByLabel`) over CSS selectors.
- Keep E2E data self-contained through `client/e2e/helpers.js` and the in-memory E2E server.
- Do not weaken an assertion just to make a test pass. Determine whether the product, fixture, or expectation is wrong.

## Documentation contract

Keep documentation aligned as follows:

| Change | Documentation to review |
| --- | --- |
| Setup or repository layout | `README.md`, `docs/developer/development-guide.md` |
| User workflow or UI label | `docs/user-manual/` and the in-app manual translations |
| Route or payload | route schema, `docs/api-reference.md`, relevant developer guide |
| Model or grading rule | `docs/developer/data-model.md`, `docs/developer/grading.md` |
| Deployment, environment, backup, or upgrade | `production_setup/README.md` and its `.env.example` |
| Legacy compatibility | `meteorjs_migration/LEGACY_DB.md` or migration status docs |

Manual screenshots are real Chromium captures. Regenerate them after material UI changes with:

```bash
cd client
REDIS_URL= QCLICKER_CAPTURE_MANUALS=1 npx playwright test e2e/manual-screenshots.spec.js e2e/admin-system-monitoring.spec.js --project=chromium
```

The capture writes matching files to `docs/assets/manuals/` and `client/public/manuals/`. Inspect the images before committing them. Do not hand-edit one copy independently.

The landing-page and anonymous-review illustrations are captured by `client/e2e/public-overview.spec.js` with the same `QCLICKER_CAPTURE_MANUALS=1` opt-in. `QCLICKER_MANUAL_IMAGES` selects filenames in the main manual capture. Screenshots must use isolated fixtures, never production data.

## Before handoff

1. Review `git diff` and `git status --short`; exclude unrelated and generated local files.
2. Run targeted tests, then the broader checks appropriate to the risk.
3. Verify Markdown links and locale JSON if either changed.
4. Summarize behavior, validation, and any remaining operational step clearly.
