# Developer Documentation

This documentation covers the active React + Fastify application.

## Recommended reading order

1. [Repository README](../../README.md) for setup and commands.
2. [Coding standards](../../CODING_STANDARDS.md) and [agent guide](../../AGENTS.md) for contribution requirements.
3. [Architecture](architecture.md) for system boundaries and request/realtime flow.
4. [Development guide](development-guide.md) for implementation and verification workflows.
5. [Data model](data-model.md) before changing persisted data.
6. [API reference](../api-reference.md) for OpenAPI and WebSocket documentation.
7. [Grading internals](grading.md) when changing scores, attempts, reviewability, or feedback.

Read the [legacy database reference](../../meteorjs_migration/LEGACY_DB.md) before changing schemas, IDs, or migration/repair utilities. The other migration files are primarily historical/status context, not day-to-day architecture guidance.

## Validation baseline

From the repository root:

```bash
npm test --prefix server
npm test --prefix client
npm run build --prefix client
./scripts/qlicker.sh e2e
```

Not every change needs every suite during iteration, but the final validation should match the risk. Route/model/auth/grading work normally needs server tests; React behavior needs client tests/build; cross-role workflows need Playwright.

## Documentation map

| Change | Update/check |
| --- | --- |
| Visible workflow or label | `docs/user-manual/` and in-app manual locale content |
| New/changed API | Fastify schema, generated `/docs`, `docs/api-reference.md` |
| Model/compatibility | `data-model.md`, legacy DB reference, migration script docs |
| Grading | user grading guide and `grading.md` |
| Deployment/env/backup | `production_setup/README.md` and `.env.example` |
| Screenshot-visible UI | opt-in `client/e2e/manual-screenshots.spec.js` capture |

## Data repair

See [Repairing shared question references](question-reference-repair.md) for the production Bash/Docker diagnostic, independent question copies, and interactive grading decisions for answered quizzes.

The [session access by activity code](external-session-access-plan.md) plan covers outside-course quiz and interactive participation. The follow-up PR implements code redemption, session-scoped quiz/live delivery, and mixed grading for named activities (enrolled students graded, guests ungraded); use its acceptance matrix for final staging tests.
