# Qlicker Documentation

This is the documentation hub for the current React + Fastify version of Qlicker.

## Use Qlicker

Start with the shared [getting-started guide](user-manual/getting-started.md), then choose the manual that matches your role:

| Guide | Covers |
| --- | --- |
| [Student manual](user-manual/student.md) | Enrollment, live sessions, quizzes, review, grades, chat, practice, and account settings |
| [Professor and TA manual](user-manual/professor.md) | Course setup, rosters, groups, questions, sessions, live delivery, review, grading, chat, video, and AI |
| [Admin manual](user-manual/admin.md) | Global settings, accounts, courses, usage, backup, storage, SSO, video, AI, and support |
| [Grading guide](user-manual/grading.md) | End-to-end grading rules and instructor/student visibility |

The web app also provides a localized, role-aware manual under the account menu. The Markdown manuals are the detailed reference and include a wider set of browser illustrations.

## Develop Qlicker

| Guide | Covers |
| --- | --- |
| [Developer index](developer/README.md) | Reading order, repository map, and validation checklist |
| [Development guide](developer/development-guide.md) | Local setup, implementation workflow, tests, and documentation expectations |
| [Architecture](developer/architecture.md) | Client, API, authentication, realtime, storage, and deployment boundaries |
| [Data model](developer/data-model.md) | Main MongoDB models and legacy compatibility rules |
| [Grading internals](developer/grading.md) | Grade lifecycle, calculations, manual overrides, and relevant code |
| [API reference](api-reference.md) | Generated OpenAPI docs, route families, WebSocket events, and verification |
| [Coding standards](../CODING_STANDARDS.md) | Required engineering conventions |
| [Agent guide](../AGENTS.md) | Repository-specific instructions for coding agents |

## Operate Qlicker

- [Production deployment and operations](../production_setup/README.md)
- [Load testing](../load-testing/README.md)
- [Local SAML test environment](../ssoserver/README.md)
- [Legacy database reference](../meteorjs_migration/LEGACY_DB.md)
- [Migrating an existing Meteor installation](../meteorjs_migration/MIGRATION.md)

The migration guide covers backups, restore, authentication, storage cutover, validation, and rollback. The legacy database reference records the compatibility contract.

## Maintaining these docs

- Use relative commands and paths. Never copy a contributor's absolute checkout path into documentation.
- Check UI labels, settings, and role permissions against the current client before documenting them.
- Keep route documentation grounded in Fastify schemas and the generated OpenAPI output.
- Update both user manuals and the localized in-app manual when visible behavior changes.
- Capture manual images from the real Chromium app with the opt-in Playwright workflows in `client/e2e/manual-screenshots.spec.js` and `client/e2e/admin-system-monitoring.spec.js` (the monitoring illustration uses example data in the isolated test database).
- Store identical screenshot copies in `docs/assets/manuals/` and `client/public/manuals/`; inspect them for personal or secret data before committing.
