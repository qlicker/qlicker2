# Plan: session access by activity code

Status: the draft follow-up PR implements signed-in code access for quiz and live activities, separate dashboard actions for course enrollment and activity joining, response tracking, WebSocket delivery, and enrolled-only grading for named activities. Final staging and multi-replica load testing remain.

## Goal and product contract

A course instructor first enables the default-off **Allow activities to be shared by code** course setting. An instructor creates a quiz or interactive session inside a course, enables **Access by activity code**, and shares a code. A signed-in person enters that code in the dashboard's existing code field and opens only that activity. Redeeming it never enrolls them in the course. The instructor chooses **Anonymous responses** independently. This yields four combinations: course-only or code-accessible, each with named or anonymous responses; both quiz and interactive delivery must work.

A shared activity code admits multiple people. "One-time quiz" means each signed-in account can submit once, not that the shared code expires after its first use. Anonymous results must retain one stable respondent row across the activity's questions and attempts. Those rows must not contain a real user ID, name, email, IP address, or answer timestamp. Correlating answers is useful for surveys, but can also permit inference from unique or self-identifying answers. The UI and manual must state that limitation plainly.

Use authenticated participants for the first release. Account-free guests need a separate decision: a browser token can limit repeat submissions from that browser, but cannot reliably enforce one response per person. Guest support should not silently reuse the signed-in guarantee.

## Keep the three code types separate

| Code | Purpose | Lifetime and scope |
| --- | --- | --- |
| Existing six-character course enrollment code | Adds an account to a course | Course-wide; existing endpoint and behavior remain intact |
| New prefixed activity code, for example `S-...` | Grants access to one session | Long, random, expiring/revocable; can be redeemed by many accounts |
| Existing short rotating live join code | Controls attendance after a person has activity access | Active only during an instructor-controlled live join period |

Generate activity codes from a random seed and a server-secret HMAC into seven characters of an unambiguous 32-character alphabet (35 bits). Store the seed and a code hash with a unique index; derive the active code for authorized instructor status reads so it survives refresh without plaintext storage. Rate-limit redemption and use the same generic error for unknown, expired, revoked, and inaccessible codes. Do not display course enrollment data during lookup. Draft sessions are not redeemable, even by existing grant holders: return the generic unavailable-code response without session metadata. Reject before creating a grant or locking participation, guard the participation claim against a concurrent return to Draft, and recheck visibility before returning metadata. Codes can be prepared in Draft and become usable when the session is published. The first enable creates the code. Disabling sharing makes it unusable and revokes grants; re-enabling uses the same stored code, while participants must redeem it again. Explicit regeneration replaces the code, invalidates the old one for new redemptions, and keeps existing grants. Expiry stops new redemption while existing grants continue until sharing is disabled or the session lifecycle closes access.

## Data and access model

- Add a session sharing configuration (disabled by default): enabled, code hash, expiration, revoked/rotated state, and optional participation cap. Keep it independent of `quiz`, `practiceQuiz`, `anonymous`, status, reviewability, chat, and live attendance settings. Legacy sessions remain course-only without migration.
- Add a session-scoped grant for a signed-in account, with a unique `(sessionId, userId)` constraint. It conveys only participant rights in that session. It must not modify `Course.students`, `User.profile.courses`, groups, course chat, notifications, course gradebook, or course roster. Instructor APIs must not list grant holders for anonymous sessions.
- Centralize the participant decision as course membership **or** a valid activity grant. Apply it consistently to session metadata, quiz read/autosave/submit, live read/join/respond, own-response review, question images, and any session chat that is deliberately enabled. Keep instructor authorization based on course ownership/instructor membership; possession of a code never grants authoring or results access.
- Return a small activity-specific course header to outside participants, not the full course object or course-level endpoints. Audit every route and WebSocket event that currently assumes `isCourseMember` or uses `course.students`.
- For anonymous activities, derive the same per-session pseudonym from the signed-in account regardless of whether entry was by enrollment or grant. Keep final respondent rows stable across questions. Never put account IDs into `Session.joined`, `submittedQuiz`, `Response.studentUserId`, instructor payloads, or downloadable results for anonymous sessions.
- For named outside participants, define a session results identity record limited to that activity. Keep their answers available to the instructor but do not create grade rows for them. Current enrolled course students receive automatic and manual grading, AI grading, and course gradebook entries, including after guest participation. Enrollment backfills only missing grade rows for finished activities: zeros for missed work, normal scoring of saved guest answers, and manual-grading flags only where a saved answer needs them. Preserve responses, attendance, existing grades, and feedback. Include ordinary enrollment and instructor addition of professor accounts in regression tests. Anonymous activities have no grade rows for anyone.

## Toggle rules and participation boundary

The server is authoritative. Before the first grant is redeemed or any join, answer, or submission record exists, an instructor may choose named or anonymous mode. Once an account has redeemed access, joined, saved an answer, or submitted, the identity mode is immutable. Claim this boundary atomically with the session update, including concurrent redemption, join, autosave, submission, and setting changes. An unused but enabled activity code does not by itself lock anonymity; a redeemed grant does. Revoking a grant or deleting an answer does not unlock it.

| Scenario | Rule |
| --- | --- |
| Course sharing setting on ↔ off | Off is the default. Turning it off revokes codes and grants for that course and stops outside access; ordinary course access continues. |
| Course-only ↔ code-accessible before redemption | Allow; existing course members keep access. |
| Disable, re-enable, or rotate code after redemption | Disabling makes the code unusable and revokes grants through a monotonic access epoch. Re-enabling uses the same code, but previous participants must redeem it again. Explicit regeneration stops old-code redemption and preserves current grants. None unlocks anonymity. Enforce the epoch at every request and WebSocket delivery. |
| Named ↔ anonymous before participation | Allow only if there are no grants, joins, submissions, answers, or individual extensions. Revalidate atomically. |
| Named ↔ anonymous after participation | Reject with `409` on both the API and UI, including a first quiz autosave that bypasses the quiz landing page. |
| Anonymous ↔ quiz/interactive after participation | Reject mode changes that could reinterpret stored answer or attendance records. Ordinary named sessions retain existing behavior unless deliberately changed in a separate compatibility review. |
| Anonymous + practice quiz | Reject on create, update, import, and copy; practice exposes per-person feedback and is not part of the survey contract. |
| Anonymous + individual quiz extension or manual admission | Reject. A named access window or admission decision can identify a respondent. Allow clearing an old invalid extension configuration before enabling anonymity. |
| Code-accessible quiz + individual extensions | Reject code issuance while extensions exist, and reject new extensions after a code has ever been issued, even if sharing is disabled. Keep the ordinary course quiz extension flow. |
| Code-accessible activity + existing grades | Reject enabling sharing until existing grade state is resolved explicitly; never silently delete grades. Once sharing is enabled, block grade creation and editing for all participants. |
| Quiz window/status/reviewability | Apply current open/closed rules to all valid grants. Anonymous answers and respondent rows appear only when the session has ended, subject to the four-respondent release rule for every answered question and attempt. No anonymous grades. |
| Interactive join code | Activity code grants session access; the rotating join code may still be required to enter a running session. Neither code enrolls the person in the course. |
| Chat | Joined guests can use enabled live-session chat with the same settings and ownership rules as students. Current grants, active sharing, and a running session are required. Anonymous chat hides participant names and account IDs and exposes no response pseudonyms; self-identifying message content remains possible. Course chat stays restricted to course members. |

## Participant flow

1. The instructor creates the session using existing course question and session tools, then enables sharing and copies the activity code or link. The editor has an explicit access switch and shows the current code, expiry, and regenerate control while enabled. Switching off revokes outside grants.
2. The dashboard's code form accepts both the existing course code and the new prefixed activity code. Route by code type on the server; preserve `/courses/enroll` for course codes. A valid activity code creates or reuses the account's grant and returns only the session ID, delivery type, and safe display metadata.
3. Navigate to a dedicated activity route, such as `/activity/:sessionId/quiz` or `/activity/:sessionId/live`, guarded by authentication and the grant. Reuse the existing quiz/live components and API client through a shared session access service. Avoid copying the full pages into a parallel implementation.
4. Quiz: show the current window, save answers, and submit once per account. Use an atomic uniqueness/idempotency rule for response attempts and final submission. Review only that participant's answers when permitted.
5. Interactive: use the existing instructor-controlled question progression and optional rotating join code. Live delivery must include granted participants as well as enrolled students. Resolve anonymous pseudonyms to connected recipients server-side without sending that map to instructors. Support multiple API replicas and Redis fan-out.
6. On expiry or revocation, access checks and WebSocket delivery stop according to the stated grant policy. Existing ordinary course-member sessions continue to use their current routes and response format.

## Implementation sequence

1. Completed in merged PR #46: anonymous-session privacy and toggle guards, the four-respondent release minimum for every answered question and attempt, and stable cross-question respondent rows.
2. Add sharing models, code generation/redemption, grant checks, rate limits, and route schemas in a focused backend change. The absence of an `ActivityShare` means course-only access. Test legacy sessions and course codes unchanged. This foundation is implemented in the draft PR and grants are accepted by session participant routes.
3. Enforce enrolled-only grading for a named code-accessible activity, and no grading for an anonymous one. Permit existing enrolled grades when sharing a named activity, but reject guest grades and individual extensions. Extend quiz and review routes, then add the dashboard code dispatch and activity route. Signed-in outside quizzes/surveys in both named and anonymous mode are implemented in the draft PR.
4. Live joins, targeted WebSocket delivery, and presentation behavior are implemented. Outside session chat uses the same admission checks, identity filtering, targeted deltas, and vote coalescing as enrolled chat; measure classroom-scale fan-out and test multiple replicas on staging.
5. Update all locales, user manuals, API/data-model docs, and real screenshots. Roll out behind the sharing flag; no migration of existing enrollment or response records is required. Complete final staging tests before merge.

## Acceptance checks

- Run a matrix of course-only/code-accessible × named/anonymous × quiz/interactive, including enrolled and outside accounts.
- Verify that a code grants exactly one session, never course membership or other sessions, and that an outsider cannot read course rosters, grades, chat, AI tools, or question libraries through the grant. Uploaded image URLs currently use an authenticated, non-course-scoped read route; verify this pre-existing behavior separately and do not treat a grant as permission to enumerate uploads.
- Exercise first redemption/join/autosave/submit concurrently with anonymity, delivery-mode, and extension changes. Test retries, duplicate requests, code rotation, revocation, and expired windows.
- Compare instructor HTTP, WebSocket, AI, CSV, and question-authoring payloads for anonymous sessions. Confirm stable respondent rows after release and no real IDs, exact answer times, or per-person extension paths.
- Run existing ordinary session/quiz, course enrollment, gradebook, and course chat suites; verify named shared sessions grade enrolled students without grading guests, while anonymous sessions never create grade rows. Add browser flows for code redemption and live delivery with and without Redis. Use the load test for the new recipient resolution path.

## PR scope decision

The access-by-code work touches authorization, navigation, and WebSocket delivery. This draft follow-up PR starts from the merged anonymous-session work and includes code issuance, grants, quiz/live access, mixed grading for named activities, dashboard entry, privacy checks, and live fan-out. Keep it in draft until final staging testing confirms the multi-replica recipient path and ordinary course flows.
