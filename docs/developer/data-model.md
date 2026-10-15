# Database and Data Model

Qlicker stores its persistent application state in MongoDB through Mongoose models. The current app remains compatible with the legacy Meteor data model where required, while adding clearer route and service layers around that data.

## Primary models

### Operational monitoring collections

`SystemMetricSample` (`systemMetricSamples`) stores timestamp, collector ID, sample interval, host CPU/load, memory, network counters/rates, and aggregate recent-user counts by role. `SystemMonitorEvent` (`systemMonitorEvents`) stores timestamp, collector ID, severity, event code/message, and diagnostic details. Both are new independent collections with ObjectId identifiers and no legacy-document references or changes. Each has a timestamp query index and an `expiresAt` TTL index with `expireAfterSeconds: 0`. The collector creates these indexes explicitly because application connections disable automatic index creation.

Retention is seven days, subject to MongoDB TTL scheduling, with periodic cleanup as a fallback. Default sampling produces roughly 10,080 records per week. MongoDB samples contain counts, not user IDs. Redis sorted sets under `qlicker:activity:*` temporarily contain user IDs and last authenticated-request timestamps; the collector removes entries outside the activity window, and the keys expire after eight idle days if collection stops. These operational records are not attendance or grading data. Normal full-database backups may include them.

### User

Represents students, professors, and admins.

Key concerns:

- email addresses and verification state
- profile names and roles
- SSO-created account flags
- password-login allowance for SSO users
- refresh token versioning
- failed-login counters and temporary lockout state
- per-user locale and profile image data
- disabled state, login activity, notification dismissals, and course memberships

## Course

Represents a teachable course space.

Key concerns:

- course name, department code, number, section, semester
- enrollment code
- owner and instructors
- enrolled students
- course topics / tags
- whether the course is active
- video options and question-submission permissions
- course/session chat policy, AI policy, tags, and reusable AI rubrics

## Session

Represents an activity flow belonging to a course.

Key concerns:

- interactive session vs quiz vs practice quiz behavior
- ordered `questions` array, which can include slides
- current question during live delivery
- join code / passcode settings
- reviewability and visibility
- quiz windows and extensions
- submission and participation tracking
- join-code lifecycle, chat settings, and multi-select scoring policy
- anonymity (`anonymous`), which changes how participation is stored

### Activity code access

`Course.allowSharedActivities` defaults to false, including for legacy documents without the field. Turning it off revokes active shares and outside grants; participant access checks also require the course setting to be on. `ActivityShare` (`activityShares`) holds one share configuration per session: a SHA-256 code hash, a random 128-bit seed for a keyed 35-bit `S-` code, enable state, expiry for new redemptions, and an `accessEpoch`. Course instructors can retrieve the active code on later status reads by deriving it from the seed and `JWT_SECRET`; the code itself is never stored in plaintext. Rotating `JWT_SECRET` likewise requires rotating affected activity codes for display. `ActivityGrant` (`activityGrants`) holds a signed-in user's session-scoped grant, the epoch when it was redeemed, and whether the user was a guest at first redemption. The first-redemption flag is retained as history only. Current course enrollment determines grading eligibility and participant badges. Later enrollment can create missing grades from identified guest responses without rewriting grants, responses, or attendance; anonymous participation remains ungraded. Both collections use Meteor-style string IDs. Unique indexes on share `sessionId`, share `codeHash`, and grant `(sessionId, userId)` are created explicitly at API startup because production disables Mongoose automatic index creation. They are new collections; existing session documents require no migration.

A redeemed grant sets `Session.participationStarted` through a conditional update using the current anonymity mode. This prevents later identity-mode changes even if a grant is revoked. Code rotation replaces the stored hash and seed, leaving the share epoch unchanged and preserving current grants. Disabling sharing keeps the hash and seed but marks the share disabled and increments the epoch. Re-enabling uses that same code and renews its expiry; old grants stay revoked until each participant redeems it again. Only explicit regeneration replaces the code. Code expiry stops new redemption but does not evict accounts that already redeemed; those accounts can use the expired code again while their grant remains valid. `Session.activityAccessEnabled` provides a fast path for ordinary sessions, and `activityEverShared` permanently excludes a shared activity from individual quiz extensions. Named shared activities grade current course students, including former guests; guest answers remain in `Response` and session results without grade rows. Anonymous activities remain ungraded for everyone. New session copies and imports start with both flags false. Grant checks apply only to participant routes for that session; they do not alter course enrollment or authorize course-level APIs. Named outside responses use account IDs only within that session. Anonymous outside responses use the same per-session pseudonym as enrolled students, yielding one stable respondent row across questions. Live fan-out resolves current grant holders per shared event; ordinary sessions retain their course-roster path. Joined guests can use enabled live-session chat through their current activity grant. Chat fan-out resolves current guests and preserves anonymous identity filtering; course chat remains restricted to course members.

### Anonymous sessions

`anonymous: true` (absent or `false` on existing documents) marks a quiz or interactive session whose stored responses have no direct instructor-visible account identity. Practice and student-created sessions cannot be anonymous. Individual quiz extensions are unavailable because a named access window could identify an answer. The helper `server/src/utils/anonymousSession.js` owns the rules:

- The participant id is `anon_` plus a truncated HMAC-SHA256 of the session id and user id. The key is `ANONYMOUS_SESSION_SECRET`, or `JWT_SECRET` when that is unset. It is stored in `Response.studentUserId`, `Session.joined`, and `Session.submittedQuiz` in place of the user id. The server recomputes it for the signed-in student to find their own responses, enforce one answer per question and attempt, and prevent resubmission. The database alone cannot map it back to a user.
- No `joinRecords` are written, and `Response.submittedIpAddress` is empty. The instructor-readable Question attempt cache contains only released batches: statistics and unlinked answers sorted by content, without participant IDs or answer timestamps. Exact response times remain in the Response collection for internal ordering, but are omitted from instructor-facing payloads.
- Live events for joined students are routed by recomputing pseudonyms for the course roster and current activity grant holders in memory (`resolveSessionParticipantUserIds`); the mapping is never persisted or sent to clients.
- Instructor payloads replace `joined`, `joinRecords`, and `submittedQuiz` with `joinedCount` and `submittedCount`. Live views and events show counts immediately and statistics/unlinked answers in groups of at least four new respondents per question and attempt; final results and AI response tools become available after the session ends. Results keep one `respondent-N` row across questions and attempts, ordered by pseudonym, with no answer timestamps. Student names are not attached to responses, chat posts, or AI tool output.
- Instructor answer rows are held until the session ends and at least four distinct respondents have answered each question and attempt that has responses. This final-row release check applies to the results API, AI question-response tool, and question-review word-cloud/histogram generation. Live session visualizations use only the published attempt cache. It leaves the required stable respondent row across questions intact once released.
- Anonymous live cache publication reuses `sessionOptions.attemptStats` and the existing statistics builders. `lastAttemptAggregateCount` reserves rebuilds in groups of at least four response documents across replicas; an atomic compare-and-set on the cached total enforces a gap of four distinct respondents between publications. Reservations do not expose answers. The publication write also advances `lastAttemptResponseCount` with `$max` to cover any additional answers included since the reservation query, keeping the event count consistent with its statistics without another query. Most submissions update only the existing response count; the winning batch writer loads projected responses once. An instructor live snapshot can repair an interrupted publication using its already-loaded responses and broadcasts the same safe delta. No schema migration is required; missing caches start empty and are repaired with the same release check. Closing/reopening an implicit first attempt preserves released batches, and new attempts append their cache without overwriting earlier publications or reusing their numbers. Ordinary session cache updates are unchanged.
- Grades are never created. Anonymous sessions are excluded from the course gradebook, grade edits return `409`, and AI grading is refused.
- `anonymous` can change only before anyone joins, submits, or responds. A monotonic `Session.participationStarted` marker is claimed before joining or writing an answer; an atomic session update prevents a concurrent mode change. Legacy `joined`, `joinRecords`, `submittedQuiz`, response, and response-tracking fields are also checked. Quiz versus interactive mode is locked after participation in anonymous sessions. Enabling anonymity deletes existing grade rows for the session, which exist only if it had ended with no participation.

Rotating the key used by active anonymous sessions detaches students from their earlier responses: they could answer again, and their own review would appear empty. Set `ANONYMOUS_SESSION_SECRET` to the previous key value before rotating `JWT_SECRET`; `production_setup/setup.sh` does this automatically when it regenerates the secret. A server operator who holds the key and the course roster can recompute the mapping. The design removes direct account linkage from instructor payloads. Correlation across questions is intentional; a unique or self-identifying answer, a small respondent group, or an instructor who controls who can answer may still allow inference. The server operator can recompute pseudonyms using the key and roster.

### Session status and quiz access

Interactive sessions are instructor-paced; quizzes (including practice quizzes) are student-paced. Both status dropdowns write the same persisted `status` field. Starting an interactive session opens its live controls; setting a quiz to Live keeps the editor open with a link to live results.

| Stored status | Interactive session | Quiz |
| --- | --- | --- |
| `hidden` | Draft, hidden from students | Draft, closed even during scheduled windows |
| `visible` | Upcoming | Date-controlled: effective status follows the base window and applicable extensions |
| `running` | Live instructor controls | Explicitly open, regardless of base dates; remains open until changed |
| `done` | Ended | Ended for instructors; individual extensions can still grant student access |

For date-controlled quizzes, instructors see Live while the base window or any extension is active, Upcoming while a window remains in the future, and Ended after all windows expire. Students see the status for their own access. With stored `done`, instructors always see Ended even during an extension; only the assigned student's effective status changes. Active or upcoming extensions block review publication.

The server derives the effective status in `buildSessionForUser` / `getQuizRuntimeState`. Course lists, session detail, and session PATCH responses use that same calculation. Clients display the returned status; they must not infer a different status from base dates. Expired scheduled quizzes are persisted as `done` on access, after every extension window has ended. Manual Live is not automatically closed by an old deadline.

## Question

Represents a question or slide.

Key concerns:

- type, content, options, solution
- creator, owner, course linkage, session linkage
- visibility flags (private, course-visible, broader visibility)
- tags
- session-specific option data such as points, attempts, and scoring settings
- aggregate data such as word cloud or histogram data where applicable

## Response

Represents a student's response to a question.

Key concerns:

- who answered (`studentUserId`, a user id or, in anonymous sessions, a per-session pseudonym)
- which question and session the response belongs to
- answer data structure by question type
- attempt handling
- quiz save vs live-response workflows

## Grade

Represents course/session/question grading state.

Key concerns:

- overall grade value
- per-question marks
- automatic vs manual override state
- feedback text
- grade visibility
- feedback timestamps and recalculation conflict handling

## Group

Represents course group categories and memberships.

Key concerns:

- group category definitions
- named groups inside a category
- student membership within a category
- import and export workflows

## Settings

Represents singleton, database-backed application policy.

Key concerns:

- registration, allowed domains, verification, locale, date/time, and token expiry
- backup schedule/retention and latest backup-manager status
- local/S3/Azure storage configuration and upload sizing
- SAML routes, certificates, attribute mappings, and advanced signing behavior
- global Jitsi and AI backend/model policy

Sensitive settings must be redacted from responses. Runtime environment remains authoritative for infrastructure/security boundaries such as database/Redis connectivity, JWT secrets, trusted proxies, and private-network AI allowlists.

## Notifications and chat

System/course notifications record audience, visibility window, creator, and per-user dismissal state. Course and session chat records store posts, comments, votes, moderation/dismissal state, and retention context. Server responses deliberately present student authors differently by viewer role.

## AI configuration and rubrics

Global settings authorize backend/model definitions. Courses opt in, choose model policy and student access, and store instructor-authored guidance/rubrics. Chat histories and tool results are course/user scoped. Backend API tokens must never appear in public or course payloads.

## Current-model behavior that matters in development

### Session questions are copied

When a library question is added to a session, the session gets its own copied question document with a new `_id`. Code and tests must use the copied session-question id when interacting with session-specific APIs. The original and copy can have different points, attempts, aggregates, tags, and visibility.

### Slides are first-class session items

Slides are represented as question documents with `type: 6`, which allows one ordered session flow containing both content-only and answerable items.

### Session-specific aggregates live with the question/session combination

Features such as word clouds and histograms are stored with question/session data so clients do not need to recompute expensive aggregates on every view.

## Indexing and performance notes

Performance-sensitive lookups are supported by indexes such as:

- Course indexes on owner, instructors, and students
- Session composite index on `courseId + status`

These matter because student dashboards, instructor course lookups, and live-session queries are frequent.

Additional route-specific indexes exist on high-volume response, grade, chat, and notification lookups. Check the actual schemas before describing or changing an index; this page is a conceptual guide rather than a generated index inventory.

## Legacy compatibility

Legacy compatibility requirements are documented in [`../../meteorjs_migration/LEGACY_DB.md`](../../meteorjs_migration/LEGACY_DB.md). Use that document when a change risks reshaping existing MongoDB fields.

Compatibility rules to preserve include:

- Meteor-style string `_id` values rather than MongoDB ObjectIds
- older user email/password and role shapes accepted by auth normalization
- historical question type values normalized to the canonical client mapping
- duplicate or partial legacy rows handled safely by maintenance/grading code
- old public image URLs migrated only through the documented storage cutover

Schema defaults do not automatically rewrite older documents. Readers must tolerate absent legacy fields; backfills should be explicit, idempotent, tested, and preceded by a backup.
