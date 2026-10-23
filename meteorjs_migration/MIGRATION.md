# Migrating from Meteor to Qlicker

The active application is React + Fastify. This directory retains the [legacy database contract](LEGACY_DB.md) and instructions for operators bringing an existing Meteor installation to the current application. It is not a development roadmap. New installations can use the [Docker quick start](../README.md#try-it-with-docker) without importing legacy data.

## Before restoring data

1. Build the current server/client images and configure a separate target using the [production guide](../production_setup/README.md#quick-start). Point its MongoDB, Redis, storage, and mail settings at the intended environment.
2. Take a verified database backup and preserve the uploaded files or object storage. Retain the original Meteor configuration and an independent rollback copy. The initialization script uses `mongorestore --drop`; it is not an incremental import or a merge of two installations.
3. Rehearse on an isolated copy. Restored settings may contain live email, SSO, AI, and storage credentials; configure them for the test environment before allowing users or external services to interact with it.
4. Ensure your dump includes the intended application database. Inspect the script's proposed source/target database list, especially if the dump also includes MongoDB system databases.

The initializer attempts a pre-restore backup but currently only warns if that attempt fails. Have a successful, independently verified backup before confirming the restore.

## Restore and normalize

Follow [Initializing from Legacy Database](../production_setup/README.md#initializing-from-legacy-database) for the full dump/transfer/restore procedure. From the configured `production_setup/` directory:

```bash
./init-from-legacy.sh --dump-dir ./legacydb/qlicker
```

The script shows the database mapping and asks for confirmation before replacing data. It reconciles the settings singleton and offers the question-type migration after a dry-run report. Review that report before applying it. Keep the compatibility fallbacks in the application: other restored/imported records may still use legacy formats.

Use the [question reference repair guide](../docs/developer/question-reference-repair.md) if copied sessions share question documents or contain duplicate references. Historical responses cannot be split reliably by session when their only reference is the same question ID.

## Accounts and authentication

- Existing Meteor string IDs, course memberships, responses, and grades are retained; do not replace IDs with MongoDB ObjectIds.
- Legacy bcrypt passwords require a reset to the current password format. Configure mail delivery and test the reset flow, or use `./manage-user.sh change-password --email user@example.com` for an operator-assisted reset.
- Old Meteor login sessions and pending password-reset tokens do not carry over. Users sign in again and request fresh reset links when needed.
- Verify mixed-case email lookup, SSO identity matching, callback/logout URLs, certificates, and role mappings against your institution's current IdP.
- Review migrated global settings in the administrator UI. The application uses its current settings model; it does not import Meteor login-service configuration as an authentication provider.

## Images and object storage

Configure the storage backend in **Admin → Storage**, then test old and new uploads. If moving legacy public S3 URLs to authenticated `/uploads/<key>` access, follow [S3 Private-Bucket Migration](../production_setup/README.md#s3-private-bucket-migration):

```bash
./sanitize-s3.sh          # Inspect proposed rewrites
./sanitize-s3.sh --apply  # Apply after reviewing the report and backups
```

Applying the rewrite changes the restored database's image URLs and can change object ACLs. Meteor does not serve the new upload paths. Rehearsals must use copied objects or isolated storage if their ACLs will change. Validate image access before restricting the bucket; do not run both applications against the rewritten database.

## Acceptance and cutover

Verify on the restored copy:

- local login, password reset, SSO login/logout, and role access;
- course rosters and instructor membership;
- historical questions (including all question types), images, and solutions;
- one complete live session, quiz save/submit/review, grades, participation, and CSV export;
- grade visibility and manual marks on representative historical sessions;
- backup creation and a restore rehearsal;
- the [classroom regression load test](../load-testing/README.md#classroom-regression-check) using the same images and proxy topology as the intended deployment.

During the final maintenance window, stop Meteor writes, take a fresh final backup, repeat the rehearsed restore, validate, and then switch traffic. Keep the old service stopped. A rollback restores the pre-cutover database/configuration and any changed object permissions; changing DNS alone does not undo a database or storage rewrite. Reconcile any data entered after cutover before rolling back.

## Current additive features

Legacy sessions remain identified and course-only. Anonymous/shared activities are opt-in; missing `anonymous` and `allowSharedActivities` fields mean false. Existing participation prevents changing anonymity. Shared activities use new grant/share collections without rewriting historical enrollment or response records. See [the current data model](../docs/developer/data-model.md#activity-code-access) for privacy, grading, and secret-retention rules.
