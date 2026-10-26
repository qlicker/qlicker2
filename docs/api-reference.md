# API and Realtime Reference

Qlicker's Fastify route schemas are the authoritative machine-readable API reference. This page explains how to access them and maps the major API/realtime areas; it is not a hand-maintained list of all 200+ operations.

## Generated OpenAPI documentation

Set `ENABLE_API_DOCS=true` for a trusted development/administration environment, start the server, then use:

- Swagger UI: `http://localhost:3001/docs`
- OpenAPI JSON: `http://localhost:3001/docs/json`

The Swagger UI is admin-protected. Production defaults keep it disabled on internet-facing installations. Do not enable it publicly just for convenience.

Fastify schemas supply parameters, request bodies, response shapes, tags, and bearer-auth metadata. If generated documentation and a prose example disagree, fix the route schema and implementation together.

## Conventions

- Versioned REST routes use `/api/v1`.
- Authenticated API requests generally use `Authorization: Bearer <access-token>`.
- State-changing browser requests also carry `X-Requested-With: XMLHttpRequest` for the CSRF policy.
- Access tokens are short-lived; the browser uses an HTTP-only refresh cookie to obtain a new token within the configured session hard expiry.
- Normal API errors use `{ "error": "...", "message": "..." }`.
- Legacy SAML aliases remain outside the versioned prefix for identity-provider compatibility.
- Uploaded images are read through authenticated `/uploads/<key>` paths.

## Route families

| Prefix/area | Responsibilities |
| --- | --- |
| `/api/v1/auth` and legacy SAML paths | Registration, login/logout, refresh, email verification, reset, SAML metadata/callback/logout |
| `/api/v1/users` | Current profile/avatar/password plus admin account search, creation, role, state, properties, and password support |
| `/api/v1/settings` | Public settings, admin configuration, backup health, storage, SAML, video, and AI policy |
| `/api/v1/courses` | Course CRUD, enrollment, rosters, sessions, groups, grades, and course video endpoints |
| `/api/v1/sessions` | Session CRUD/copy/import/export, live state/actions, quiz saves/submission, review, grading integration, and session chat |
| `/api/v1/activity-codes` and session activity-share paths | Instructor code management, signed-in redemption, and session-scoped quiz/live participation |
| `/api/v1/questions` and course/session question paths | Question CRUD, visibility, library search/copy/import/export, aggregates, and ordering |
| `/api/v1/grades` and course/session grade paths | Grade tables, recalculation, point/feedback/manual overrides, visibility, and CSV data |
| `/api/v1/.../chat` | Course/session posts, comments, votes, quick posts, moderation, settings, summaries, and review payloads |
| `/api/v1/notifications` | System/course notice management, active notices, dismissal, and feedback notifications |
| `/api/v1/ai` and `/ai` media proxy | Admin/course AI configuration, chats, tool-backed operations, histories, rubrics, and allowlisted media |
| `/api/v1/images` and `/uploads/*` | Validated image write/delete and authenticated reads across local/S3/Azure storage |
| `/api/v1/health` | Process health timestamp plus WebSocket/Redis availability |

Permission checks vary by operation. A global professor role and course instructor membership are not interchangeable; API tests should cover unauthenticated, wrong-role, and non-member access.

## Quiz extensions and review access

`GET /api/v1/courses/:courseId/sessions`, `GET /api/v1/sessions/:id`, and `PATCH /api/v1/sessions/:id` return the same user-specific effective `session.status` and extension flags. PATCH accepts the stored status: `hidden` hides access, `visible` enables the quiz schedule, `running` explicitly opens access regardless of dates, and `done` closes general access while honoring individual extensions. A successful PATCH to `visible` can therefore return `running` or `done`. Clients must use the returned status rather than recalculate it from dates. See the [session lifecycle](developer/data-model.md#session-status-and-quiz-access).

`PATCH /api/v1/sessions/:id/extensions` assigns individual quiz windows to enrolled students, including when the stored session status is `done`. Students with an active extension receive effective status `running` and their own `quizStart`/`quizEnd` in session payloads; an upcoming extension is `visible`. The instructor still sees the ended status. Saving and submitting enforce the individual window, enrollment, and existing submission locks.

Session payloads expose `quizHasActiveExtensions`, `activeExtensionsCount`, and `quizHasRemainingExtensions` (active or upcoming). Remaining extensions block review publication through generic session updates, `/reviewable`, and `/end`. Granting a remaining extension clears reviewability and student-visible grades. Expiry or removal does not automatically republish results.

Publishing `reviewable: true` through `PATCH /sessions/:id`, `PATCH /sessions/:id/reviewable`, or `POST /sessions/:id/end` recalculates automatic grades, including existing grade rows, and preserves manual overrides. The grading summary reports outstanding manual grading.

## Interactive live status

Setting an interactive session to `running` with `PATCH /sessions/:id` initializes `currentQuestion` to the first ordered question or slide when no item is active, matching `POST /sessions/:id/start`. The newly selected item starts hidden; existing selections and their visibility remain intact. Empty sessions have no item to select. Quiz status patches retain their existing behavior.

For participants, `GET /sessions/:id/live` returns a metadata-only snapshot when an interactive session is not `running`: question, attempt, own response, statistics, word cloud, and histogram are null. `hidden` (Draft) redirects the participant to their course or, for outside guests, dashboard; `visible` (Upcoming) shows a waiting screen; `done` shows the ended screen. Existing metadata/status events refresh these states and restore questions when the session resumes. Instructor access, saved responses, and quiz endpoints retain their existing behavior.

## Instructor quiz results

For regular quizzes whose stored status is not `done`, `GET /sessions/:id/results` includes only participants listed in `submittedQuiz` and their saved answers. This includes guests in shared quizzes. Autosaves remain editable and stored but are excluded from result rows, CSV exports, review statistics, word clouds, histograms, and AI response summaries. At `done`, all saved answers become available, including answers from participants who never submitted. This visibility rule does not change response storage, submission records, grading rules, or extension locks. Practice quizzes retain per-question submission behavior; interactive sessions retain their existing results behavior. Anonymous quizzes retain the end-of-session and minimum-respondent requirements below.

Final quiz submission sends an identity-free `session:quiz-submitted` notification to course instructors for non-anonymous quizzes. The review page coalesces these events, loads the submitted-only snapshot, and refreshes fully on status/settings changes or reconnect. It does not fetch on every autosave. `quizResultsRefreshAt` is the final scheduled deadline in epoch milliseconds for date-controlled quizzes, or `null`; it schedules a single review refresh when the quiz expires. Forced-Live quizzes still require the instructor to end them.

## Anonymous sessions

`POST /api/v1/courses/:courseId/sessions` and `PATCH /api/v1/sessions/:id` accept `anonymous: boolean`. It returns `400` for practice sessions or when enabling anonymity with existing individual quiz extensions. A PATCH that changes anonymity or an anonymous session's quiz/interactive mode after participation returns `409`. The participation check and setting update are atomic. Session export, import, and copy keep the flag. Storage rules are described in the [data model](developer/data-model.md#anonymous-sessions).

For anonymous sessions:

- Instructor session payloads have `joinedCount` and `submittedCount` instead of `joined`, `joinRecords`, and `submittedQuiz`. `GET /sessions/:id/live` ignores `includeStudentNames` and `includeJoinedStudents`. The `session:participant-joined` event carries only `joinedCount` and `anonymous: true`. Anonymous live response events carry `anonymous: true` and counts on each submission and a cached `responseStats` snapshot only after at least four new distinct respondents can be included for that question and attempt. Snapshots include distributions, numerical summaries, or unlinked answer lists without participant IDs, response IDs, names, or answer timestamps. Refreshing, navigating, and toggling statistics reuse the released cache; they do not reveal the remaining one to three answers. `allResponses` stays empty. The final results endpoint returns `409` until the anonymous session ends. Individual quiz extensions return `400` for anonymous quizzes. Live session word clouds and histograms use only the released cache (empty below four); question-review word clouds and histograms still return `409` until the session ends and every question/attempt with responses meets the four-respondent minimum, since those analysis routes read across attempts.
- `GET /sessions/:id/results` lists respondents with released answers only. Each row has `studentId: "respondent-N"`, `anonymousIndex`, and empty name, email, and photo fields. Answers stay linked across eligible questions and attempts, without timestamps or IP addresses. Each question has `anonymousResponseAttempts: [{ attempt, respondentCount, responsesWithheld, minimumRespondents: 4 }]`: counts are distinct respondents and remain visible even below four. Answers are filtered independently per question/attempt; a sparse group does not hide eligible groups. Zero responses means unanswered, not withheld. The response includes `anonymousSummary: { respondentCount, joinedCount, enrolledCount, responsesWithheld, minimumRespondents: 4 }`; its respondent count includes people whose answers are all withheld. Such people have no individual row. While any answers are withheld, per-row participation is `null`, and the client hides overall percentages and marks withheld attempts in the table and CSV without revealing who answered them. Chat posts have no author names. This metadata is computed for review; it is not persisted.
- `POST /sessions/:id/join/:studentId` (manual admission) returns `400`, because its result would show whether a named student had joined.
- Students use the same quiz, live, and review endpoints; their own responses are found through the session pseudonym.

## Activity code access

Instructor roster entries in `/sessions/:id/live?includeJoinedStudents=true`, identified `session:participant-joined` events, and identified result rows include `participantRole` (`student`, `guest`, or `instructor`) and `isProfessor`. Membership in this activity and the account’s professor role are separate: an outside professor remains a guest for grading. A guest who later enrolls is shown as a student; a professor account can also be a course student. Anonymous instructor payloads omit these identity fields.

Course `POST /api/v1/courses` and `PATCH /api/v1/courses/:id` accept `allowSharedActivities: boolean`, defaulting to `false`. When disabled, code issuance and redemption are denied; turning it off revokes existing codes and grants for the course. Existing course-member access is unaffected. `GET /api/v1/sessions/:id/activity-share` returns `{ enabled, code, expiresAt }` to a course instructor or admin. `POST /api/v1/sessions/:id/activity-share` enables sharing and returns `{ code, expiresAt }`; it creates a code on first enable and reuses the stored code on subsequent enables. Pass `regenerate: true` to replace it and invalidate the old code. An optional `expiresAt` must be within the next year, with 30 days as the default; re-enabling renews expiry without changing the code. The current code is also available to course instructors on later status reads while sharing is enabled. `DELETE /api/v1/sessions/:id/activity-share` disables sharing and revokes existing grants. It keeps the code stored but unusable until sharing is enabled again; previous participants must redeem it again. Practice quizzes, student-created sessions, inactive courses, sessions with individual quiz extensions, anonymous sessions with existing grades, and named sessions with existing guest grades cannot issue codes. Existing enrolled-student grades are allowed on named sessions. Once a code has been issued, individual quiz extensions remain unavailable even if sharing is disabled. Named shared sessions create and expose grades for current course students; outside guests have responses without grade items. `POST /courses/enroll` and `POST /courses/:id/students` backfill missing grades for the joining student in completed or expired scheduled, non-anonymous course activities, including prior guest answers. Missed activities receive zeros without manual-grading flags; written guest answers may need grading. Existing grades and responses are preserved. Running/future activities, outstanding extensions, practice quizzes, and student-created activities are excluded. Repeated enrollment retries this repair before returning the existing 409 already-enrolled response. Anonymous shared sessions never create grades, including for enrolled students.

`POST /api/v1/activity-codes/redeem` accepts `{ code }` from an authenticated user and returns `{ sessionId, courseId, name, quiz, anonymous }`. New codes are `S-` plus seven characters from an unambiguous 32-character alphabet (35 bits of code space). Unknown, disabled, and unavailable codes receive the same 404 response. Draft (`hidden`) sessions also return this generic 404, even for existing grant holders, without revealing session metadata. An instructor may prepare a code in Draft; attempting redemption while the session is already in Draft creates no grant or participation lock. Publishing the session makes the same code redeemable. Visibility is rechecked when claiming participation and before returning metadata. An expired code cannot admit a new account, but an account with a still-valid grant may enter it again. Redemption is limited to 10 attempts per minute per authenticated account per API process. All attempts count, including unavailable codes; exceeding the limit returns 429 with Retry-After. A successful redemption records a session-scoped grant and locks the session's anonymity mode; it does not enroll the user in the course or create a grade. Rotating a code preserves existing grants; disabling sharing revokes them, including after a later reissue.

A valid grant authorizes only that session’s participant metadata, quiz read/autosave/submit, live read/join/respond, session chat, telemetry, and own-response review. It does not authorize course rosters, course chat, grades, question libraries, or other sessions. The dashboard routes prefixed activity codes to redemption and ordinary enrollment codes to `/courses/enroll`. An outside participant uses `/activity/:courseId/session/:sessionId/quiz` or `/live`; the route ID is display/navigation context and the server checks the grant by session ID. Live join-code settings still apply after grant redemption. WebSocket question, visibility, attempt, status, join-code, and response events resolve current grant holders; anonymous recipient mapping remains server-only.

Session chat accepts enrolled members and current activity-grant holders, but participants must have joined the running session (including its live join-code requirement). The grant covers only that session’s chat, never course chat or another session. Guest posts, comments, votes, and quick posts obey the same chat settings and ownership checks as enrolled participants. Course instructors retain moderation rights; a guest with a professor account does not gain them. Anonymous chat payloads and deltas hide participant names and account IDs from other viewers and never expose response pseudonyms. Chat messages are live discussion, separate from batched answer statistics; message content can still identify its author. Chat settings and content use the existing targeted WebSocket deltas and vote coalescing. Session-chat snapshots, deltas, and review posts sort by `updatedAt` (falling back to `createdAt`), newest first, with dismissed discussions last. Posting, commenting, and voting already maintain this timestamp; no additional queries or writes are needed for sorting. Ordinary enrolled chat adds no activity-grant queries.

## Question copies and ordering

`POST /questions/:id/copy-to-session` always creates a fresh question ID. `POST /sessions/:sessionId/questions` attaches a newly created question belonging to that session if it is not yet listed; otherwise it copies the source. Library insertion uses the explicit copy endpoint. Session copies and practice-question selection also create independent question documents. `PATCH /sessions/:sessionId/questions/order` rejects duplicate IDs and newly added references to questions belonging outside the session with HTTP 400.

## Admin system-monitoring query

`GET /api/v1/users/admin/system-monitoring?range=24h` requires an authenticated administrator. `range` accepts `6h`, `24h` (default), or `7d`; invalid values return 400. The response includes `status` (`healthy`, `stale`, `unavailable`), `latest`, downsampled `history`, up to five `peakPeriods`, up to 50 seven-day collector `events`, `generatedAt`, `retentionDays`, and `bucketSeconds` (60, 300, or 1800).

Missing measurements are `null`. Resource history fields are bucket averages; activity fields are bucket maxima. The endpoint caches each range for 30 seconds per API process, coalesces concurrent reads, and caps database queries at 20,161 samples and two seconds. This is a single-host collector contract; see [metric definitions](user-manual/admin.md#understand-the-measurements). There is no metric-ingestion or arbitrary-log-reading HTTP endpoint: the collector writes directly to MongoDB.

`latest.memory` includes `usedBytes`, `totalBytes`, `availableBytes`, and `usedPercent` for the whole host. `latest.network.interfaces` identifies the selected measurement interfaces; rate fields are bytes per second, not bits. Automatic selection prefers non-tunnel default routes to avoid counting a VPN and its uplink together. A missing explicitly selected interface reports unavailable network counters/rates rather than substituting other interfaces. The sample timestamp uses wall-clock time, while new collector snapshots use monotonic elapsed time to calculate rates.

## WebSocket connection

The browser connects to:

```text
ws://localhost:3001/ws?token=<access-token>
```

The native browser WebSocket API cannot set an Authorization header, so the access token is passed in the query string. Do not log or share the full URL. The server verifies the token, limits incoming messages, closes the socket at token expiry, and clients reconnect after refresh. Production uses `wss://` behind TLS.

Server messages have an event name and data payload. Important event families include:

- `session:question-changed`, `session:question-updated`, and `session:status-changed`
- `session:response-added`, `session:attempt-changed`, and aggregate/statistics updates
- `session:participant-joined`, join-code, visibility, and quiz-submission updates
  - `session:join-code-changed` carries admission flags when settings change. Code rotations send only `currentJoinCode` and routing metadata to instructors; they send nothing to participants. Clients retain absent fields, so a delayed rotation cannot reopen a closed join period.
- `session:chat-settings-changed` and `session:chat-updated`
- `session:feedback-updated`
- course question/library and course-chat updates
- notification updates
- `video:updated`

Clients should patch local state when the delta is sufficient and perform a targeted refresh for legacy/incomplete payloads. Do not respond to a high-frequency event with an unconditional full-session refetch.

`session:response-added` carries the single submitted response when the viewer
may see it. Multiple-choice statistics include the small option distribution;
short-answer and numerical statistics include updated totals or summary fields
without repeating the accumulated answer/value arrays. Clients append the new
response to their existing snapshot.

Instructor `session:question-changed`, `session:visibility-changed`,
`session:question-updated` (for the current question), and `session:response-added`
events also include an `audience` payload for presentation windows authenticated
as the instructor. This uses the same public question/statistics projection as
student events; `audience: null` on a response event means statistics are not
shared. Presentation clients must consume this projection, or refresh
`GET /sessions/:id/live?view=presentation` when an older event omits it. That
endpoint returns the student visibility flags and sanitized question/statistics,
alongside presentation session details such as the join code. It omits student
names and hidden response lists.

Redis publishes user-targeted/broadcast events between API replicas. Without Redis, WebSockets work only within a single server process.

## Adding or changing an endpoint

1. Define/update Fastify request and response schema.
2. Apply authentication, global role, and resource-membership checks.
3. Validate imported content, external URLs, IDs, paging, and limits.
4. Keep errors/status codes consistent.
5. Add success, validation, and authorization tests.
6. Update the client and any WebSocket delta/fallback contract.
7. Start with `ENABLE_API_DOCS=true` and inspect `/docs` and `/docs/json`.
8. Update this overview only when the route family or integration contract changes.
9. Update user/developer/operations manuals when behavior is visible outside the API.

## Local verification

```bash
npm test --prefix server
npm test --prefix client
npm run build --prefix client
./scripts/qlicker.sh e2e
```

For authentication, SSO, uploads, AI URL policy, grading, or WebSocket changes, add focused security/permission cases rather than relying only on the broad suite.

## Grading readiness

`GET /api/v1/sessions/:id/grades` reads existing grades without creating missing rows. Instructor responses include `gradingLockReason`: `not-ended`, `extensions`, `missing-grades`, `anonymous`, or `null`. Anonymous sessions always return `anonymous: true` with no grades, reject grade edits, recalculation, and AI grading with `409`, and are excluded from `GET /courses/:courseId/grades`. Active and upcoming extensions prevent grading even when the stored session status is `done`.

`POST /api/v1/sessions/:id/grades/recalculate` with `{ "missingOnly": true }` explicitly creates missing grade items. Recalculation, manual mark/value updates (including bulk updates and resetting automatic scoring), and starting AI grading return `409` until the session and all extension windows have ended. Existing instructor authorization checks still apply. Grade reads derive pending manual work from current responses; a confirmed manual zero remains graded.

### Course grade averages

`GET /api/v1/courses/:courseId/grades` returns `rows[].avgGrade` alongside
`avgParticipation` (percentage means, one decimal place, or `null` without applicable
items). Both use actual grade items for the returned sessions, excluding missing
placeholders and not-applicable entries while retaining recorded zeros. Student
queries require visible grade items in ended sessions without remaining extensions and exclude anonymous sessions and other
students' private practice sessions. Instructor `sessionIds` determines the averaging
scope. `sessions[].hasGradeItems` and `rows[].grades[].hasGradeItem` are derived
booleans; student availability refers only to that student's published items.


### Independent grade publication

`PATCH /api/v1/sessions/:id/grades/visibility` accepts `{ "visibleToStudents": true | false }`.
Only course instructors and admins may use it. It returns `success`,
`visibleToStudents`, and a partial `session` containing `_id`, `reviewable`, and
`gradesVisible`; clients merge this metadata. Publication creates missing grade rows
without overwriting existing scores. The route returns `409` for anonymous or
student-created sessions, sessions not ended or with remaining extensions, and
requests to hide grades while review is enabled. It emits `session:metadata-changed`.

Reviewable transitions through all session mutation routes synchronize grade
visibility, including hiding grades when review is disabled. Independent grade
publication never changes `reviewable`. Restarts and remaining extensions clear
both settings. Recalculation and enrollment preserve independent release.

The student course grade table includes all visible grade items. For a
non-reviewable session it returns aggregate grade scores and basic session metadata
without marks, feedback, question metadata, or class grading summaries. Reviewable
sessions retain their normal review navigation; grade-only cells and headers must
not link to review. Review, results, session-grade detail, feedback, and student AI
review endpoints still enforce reviewability.

## Account appearance

The authenticated `PATCH /api/v1/users/me` endpoint accepts `themeMode: "light" | "dark"` and returns the updated sanitized user. This account preference is also returned by login and `GET /api/v1/users/me`. Missing legacy values mean light mode. Invalid modes receive `400`; the endpoint updates only the authenticated user, and SSO-managed accounts can change appearance without unlocking their name or password.
