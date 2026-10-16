# Qlicker Coding Standards

These standards describe the current Fastify/React application. They apply to new code and to code materially changed by a pull request; unrelated legacy code does not need wholesale restyling.

## 1. Core principles

- Make the smallest coherent change that solves the problem and is easy to review.
- Preserve the legacy MongoDB contract unless an explicit, documented migration accompanies the change.
- Extend existing routes, services, components, hooks, and utilities before creating a competing pattern.
- Treat live-class latency, accessibility, localization, privacy, and security as product requirements.
- Keep code, tests, generated API schemas, operational instructions, and user manuals in sync.

## 2. Supported stack

| Layer | Current standard |
| --- | --- |
| Runtime | Node.js 22.13 or newer; ES modules |
| Client | React 19, Vite 8, Material UI, Axios, react-i18next |
| Server | Fastify 5, Mongoose 9, JWT access tokens and refresh cookies |
| Realtime | Fastify WebSockets; optional Redis pub/sub across instances |
| Data | MongoDB 7-compatible schemas using legacy string IDs |
| Tests | Vitest, Testing Library, Playwright, axe-core |
| Production | Docker Compose, Nginx, MongoDB, Redis, backup manager |

Dependencies and exact versions are authoritative in `client/package.json`, `server/package.json`, and their lockfiles.

## 3. JavaScript style and structure

- Use ES modules (`import`/`export`) and the style already used in the file.
- Choose descriptive names. Avoid unexplained abbreviations and boolean names that hide their polarity.
- Prefer early returns and small, testable helpers over deeply nested handlers.
- Keep constants near their owning feature unless they are genuinely shared.
- Do not mix broad formatting or mechanical cleanup into a behavioral change.
- Comments should explain constraints or intent, not restate the code.
- Log operationally useful context without tokens, passwords, storage keys, raw certificates, or unnecessary personal data.

## 4. Backend standards

### Routes and services

- Add feature routes under `server/src/routes/` and register them through the existing app wiring.
- Put reusable business rules in `server/src/services/`; keep route handlers focused on validation, authorization, orchestration, and response shaping.
- Use Fastify JSON schema on new or changed endpoints. Schemas are both validation and the source for generated OpenAPI documentation.
- Reuse registered auth and role pre-handlers. Course access must distinguish global roles from course owner/instructor membership.
- Use the established error body: `{ error, message }`. Select status codes deliberately (`400` validation, `401` unauthenticated, `403` unauthorized, `404` missing, `409` conflict).

### Data and compatibility

- Preserve Meteor-compatible string `_id` values and existing persisted field shapes.
- Validate IDs and user-controlled filters before using them in queries.
- Prefer projections and `.lean()` for read-only responses. Avoid per-row queries when batching or aggregation is practical.
- Add indexes only with a documented query need and consider production build cost.
- Make migrations and repair scripts idempotent, dry-run by default when destructive, and explicit about backups.

### Realtime and performance

- Send narrow WebSocket deltas for session, response, chat, visibility, and grading updates.
- Include enough state in events for clients to patch locally; retain a safe refresh fallback for old or incomplete events.
- Avoid full session refetches on every response or chat event.
- Do not add unbounded arrays, queries, or broadcasts to a path used by hundreds of connected students.
- Use the k6 suite when a change could affect classroom-scale concurrency. Start with `run.sh --regression`; add shared/anonymous scenarios for those paths. Treat the statistics-visible matrix as a separate stress workload. Record application image versions and compare the same runner, timings, replica count, and host resources; a passing feature run alone does not establish unchanged latency.

## 5. Frontend standards

- Route pages belong in `client/src/pages/`; reusable feature UI belongs in `client/src/components/`.
- Reuse the shared API client, authentication context, course-title utilities, responsive tabs, back-link controls, and session-status helpers.
- Use Material UI and the shared theme. Prefer `sx` for local styling and extract repeated style objects or components when repetition becomes material.
- Keep server state authoritative. Make optimistic updates only when rollback and error messaging are clear.
- Cancel or ignore stale requests when route changes and rapid searches can race.
- Preserve query parameters such as course tab/return context when navigation helpers already support them.

## 6. Localization

- All user-visible text, accessible names, validation messages, empty states, and dialog copy must go through `t()`.
- Add each key to every file in `client/src/i18n/locales/`; current locales are English, French, German, Spanish, Italian, Pirate, Russian, and Chinese.
- Preserve interpolation names, markup assumptions, and plural behavior across locales.
- Do not ship untranslated English placeholders in non-English files without documenting the translation debt.
- When UX wording changes, update screenshots and user manuals that refer to the old label.

## 7. Accessibility and responsive behavior

- Every control needs an accessible name; icon-only buttons require an `aria-label`.
- Use semantic headings in order, real buttons/links, form labels, table headers, and descriptive alternative text.
- Dialogs must manage focus and remain operable with the keyboard. Do not remove focus indicators.
- Announce asynchronous state changes through the established alerts, snackbars, or live regions.
- Test dense tab sets and tables at narrow widths. Avoid horizontal page overflow and inaccessible hover-only actions.
- Run the existing axe-backed E2E checks for changed workflows.

## 8. Security and privacy

- Do not weaken authentication, refresh-token expiry, CSRF/CORS checks, rate limits, account disabling, or permission filters without an explicit security review.
- Treat rich text, uploads, filenames, external URLs, AI endpoints, SSO metadata, and imported JSON/CSV as hostile input.
- Keep DOM sanitization and Content Security Policy constraints in mind when rendering HTML.
- Never return storage credentials, password hashes, refresh tokens, SAML private keys, or AI API tokens to clients.
- Production private-network AI access must remain allowlisted by exact trusted host.
- Session-scoped guest access must not imply course access. Preserve the separation between enrolled-student grades and ungraded guest/anonymous responses.
- Anonymous results must preserve stable pseudonyms, participation locks, release thresholds, and identity filtering in every output channel. Do not introduce identity/answer timing correlation through incremental updates.
- Show a zero mark only when an explicit mark is zero. Missing grade items and missing question marks are not incorrect answers.
- Prefer disabling user accounts to deleting historical academic records unless deletion is explicitly required.

## 9. Testing standards

Every bug fix should include a regression test where practical. New server behavior needs success, validation, and authorization coverage; UI work needs the important loading, empty, success, and error states.

```bash
# Full server suite
npm test --prefix server

# Full client unit/component suite
npm test --prefix client

# Production client build
npm run build --prefix client

# Browser workflows (starts isolated local services)
./scripts/qlicker.sh e2e

# Local Markdown files and heading anchors
node scripts/check-doc-links.mjs
```

Examples of focused tests:

```bash
npm test --prefix server -- test/routes/sessions.test.js
npm test --prefix client -- src/pages/student/CourseDetail.test.jsx
```

Use deterministic fixtures. Do not make tests depend on production services, wall-clock races, or execution order. Prefer role/label-based Playwright locators so tests exercise the accessible UI.

## 10. Documentation and operations

- Update `README.md` for setup, supported runtime, or repository-level changes.
- Update `docs/user-manual/` and the localized in-app manual for visible workflows.
- Update `docs/developer/` for architecture, model, grading, or maintenance changes.
- Update route schemas and `docs/api-reference.md` for API changes.
- Update `production_setup/README.md` and `.env.example` together for deployment settings.
- Remove superseded plans once their useful details are incorporated into current guides. Keep the legacy schema contract and operator migration/rollback instructions; Git history retains the implementation history.

Browser screenshots must come from the repeatable Playwright capture documented in `AGENTS.md`. Check that they contain no real personal data or credentials.

## 11. Git and review hygiene

- Use a focused branch and commit only files that belong to the change.
- Do not commit `.env`, test results, database directories, uploads, backup archives, or editor state.
- Review the final diff for accidental generated files and stale absolute paths.
- A pull request should explain the user impact, compatibility considerations, tests run, and any deployment or data migration step.

See `AGENTS.md` for the repository map and agent workflow, and `docs/developer/README.md` for deeper technical documentation.
