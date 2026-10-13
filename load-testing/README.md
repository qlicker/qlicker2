# Qlicker Load Testing Suite

Automated load testing for named and anonymous interactive sessions and quizzes, including activities opened by code by people outside the course.
The suite seeds dedicated users, a course, questions, and one session per run.
The original named interactive scenario follows the real classroom flow:

- one professor launches and drives the session
- hundreds of students authenticate, join, keep WebSockets open, refresh live
  state from websocket deltas when possible, and submit responses
- a professor observer window and a slice of student chat viewers keep the chat
  panel in sync from websocket chat deltas, falling back to `/chat` refreshes
  only when the payload is insufficient
- quick-post requests, student discussion posts, upvotes, and professor replies
  are exercised during the session
- question changes, attempt changes, stats visibility, answer reveals, and
  short-answer / numerical stat refreshes are all exercised

The seed and k6 runners run as Docker images. The target Qlicker stack can be:

- `prod` + `docker` on either a staging or production host, using
  `production_setup/docker-compose.yml` and its deployed application images
- `dev` + `docker`
- `dev` + `native`

Each new seed removes the previous load-test users, course, questions, session,
and responses from the configured database. `--clean` removes those fixtures
after the run.

## Quick Start

```bash
cd load-testing

# 1. One-time interactive setup
./setup.sh

# 2. Disable rate limits on the running stack
./run.sh --prepare

# 3. Run the load test
./run.sh

# 4. Restore rate limits when finished
./run.sh --restore

# 5. Remove load-test fixtures
./run.sh --clean
```

If the target stack is running natively, `--prepare` and `--restore` update the
target `.env` and tell you to restart the server so the change takes effect.

## What `setup.sh` Does

`./setup.sh` asks for:

- target environment: `dev` or `prod`
- runtime: `docker` or `native`
- path to the `.env` file for the stack that is currently running
- number of students to simulate

It then:

- derives the MongoDB connection string used by the seed/cleanup runner
- derives the target base URL used by k6
- detects the Docker network when the stack is containerized
- writes `load-testing/.env`
- builds the local seed image (`qlicker-load-testing-seed:local` by default)

`production_setup/update.sh` updates the application images. The load-test
seed image is built separately. The load runner fingerprints the seed Dockerfile, package files, and
`seed.mjs`; `--seed-only`, a full run, and `--clean` rebuild a missing or stale
seed image automatically after a checkout update. On a Docker target,
`--prepare` checks and rebuilds it before disabling rate limits. `--test-only`
requires a fixture made for the selected scenario and does not rebuild or
reseed it.

### URL Resolution

- `prod`: prefers `ROOT_URL`, then falls back to `https://$DOMAIN`
- `dev`: prefers `VITE_API_URL`, then `API_PORT`, then `PORT`

For dev, the base URL normally points at the API/WebSocket server origin, not
an external domain.

## Run Modes

| Command | Description |
|---------|-------------|
| `./run.sh` | Seed + run the load test |
| `./run.sh --students N` | Override the configured student count |
| `./run.sh --matrix` | Prepare, run all 12 interactive comparisons, restore, and clean automatically |
| `./run.sh --live-stats on\|off` | Override statistics during answers without editing `.env` |
| `./run.sh --scenario NAME` | Choose `live-named` (default), `live-anonymous`, `quiz-named`, `quiz-anonymous`, `live-external-named`, `live-external-anonymous`, `quiz-external-named`, or `quiz-external-anonymous` |
| `./run.sh --session-chat on\|off` | Run `live-named` with chat enabled or disabled; shared and anonymous comparisons require chat off |
| `./run.sh --enrolled-percent N` | Set the enrolled proportion (0–100) for external fixtures; ordinary fixtures require 100 |
| `./run.sh --seed-only` | Seed without running k6 |
| `./run.sh --test-only` | Run k6 with the existing `state/state.json` for the selected scenario |
| `./run.sh --clean` | Delete load-test fixtures and `state/state.json` |
| `./run.sh --prepare` | Disable rate limits on the running stack |
| `./run.sh --restore` | Restore the stack’s original rate-limit setting |

## Identical staging and production runs

Both servers use the same `prod` + `docker` load-test configuration and
`production_setup/docker-compose.yml`. Their `production_setup/.env` files set
the host-specific image tags, MongoDB connection, and `ROOT_URL`. If
`load-testing/.env` is already configured with `TARGET_ENV=prod` and
`TARGET_RUNTIME=docker`, a checkout update does not require rerunning setup.
Otherwise, run `./setup.sh` and choose `prod` plus `docker` on either host.

1. If a prior test stopped after `--prepare`, run `./run.sh --restore` and
   `./run.sh --clean` before starting another test. Run these as separate
   commands; a failed command in an `&&` chain skips the later commands.
2. Run `./run.sh --prepare`. This checks or rebuilds the load-test seed image
   before disabling API and Nginx rate limits and recreating the server service.
   The runner verifies that the active Nginx configuration has no `limit_req`
   directives. The original API setting is saved in
   `state/rate-limit-restore.env`.
3. Run each scenario at the same student count and with the same timing knobs:

   ```bash
   JOIN_GRACE_S=30 ./run.sh --scenario live-named --students 100
   JOIN_GRACE_S=30 ./run.sh --scenario live-anonymous --students 100
   ./run.sh --scenario quiz-named --students 100
   ./run.sh --scenario quiz-anonymous --students 100
   JOIN_GRACE_S=30 ./run.sh --scenario live-external-named --students 100
   JOIN_GRACE_S=30 ./run.sh --scenario live-external-anonymous --students 100
   ./run.sh --scenario quiz-external-named --students 100
   ./run.sh --scenario quiz-external-anonymous --students 100
   ```

   Choose `JOIN_GRACE_S` long enough for the student login wave to complete;
   keep it identical across comparison runs. Each command reseeds its own
   fixture. External variants accept `--enrolled-percent` (default 50 for identified activities and 0 for anonymous activities). The seed rounds the enrolled count to the nearest whole participant. Only eligible enrolled participants receive grade rows; guests redeem the code without enrolling. Anonymous variants remain ungraded for everyone. All external variants check code redemption, response tracking, and live delivery. Run `./run.sh --test-only --scenario NAME` only if the current
   fixture was seeded for that name and has not been consumed by a previous
   run. Quiz submissions and live session endings make a completed fixture
   unsuitable for another full pass.
4. Run `./run.sh --restore` and `./run.sh --clean` as separate commands when
   testing ends, including after a failed run. Keep result logs and summaries
   before cleanup. The prod/docker runner refuses a full or test-only run if
   `--prepare` has not left a restore record and `DISABLE_RATE_LIMITS=true`.
   `--clean` removes fixtures but keeps the restore record.

If `--restore` reports that its record is missing, it cannot know the previous
API setting. Check `DISABLE_RATE_LIMITS` in `production_setup/.env` and inspect
the active Nginx `limit_req` directives before another run. If the API setting
is still `true`, restore the intended value and recreate the server service;
restart Nginx if its active rate-limit directives were disabled. Do not run
`--prepare` again until that state is understood.

Before each main workload, the runner sends twelve empty login requests
through the configured public `BASE_URL`. They should all reach API validation
and return 400. A 503 or any other response stops the run before student VUs
start; the diagnostic is saved in `results/preflight-NAME-TIMESTAMP.log`.
Check Nginx and any proxy in front of it if the preflight fails. The probe
uses no account credentials and does not change the application database.

`results/k6-NAME-TIMESTAMP.log` contains the complete k6 output and
`results/summary-NAME-TIMESTAMP.json` contains machine-readable metrics. Match
student count, timing knobs, and image versions for baseline and PR runs.
Compare error rate, p95/p99 HTTP duration, login and join, WebSocket event
delivery, answer submission, quiz autosave, and final results duration. Run
`quiz-anonymous` and `live-anonymous` once with three students to confirm that
result rows remain withheld below four respondents, then with at least four
students to verify correlated rows appear. A threshold failure or a missing
summary is a failed run; investigate it before comparing latency. All four live variants use the same browser-like delta workload in
`scenarios/live-session.js`; anonymous variants check identity-free statistics in groups of at least four new respondents and exercise live word clouds/histograms when at least four participants respond. `anonymous_batch_stats_success` requires a released cache with fewer than four unreleased answers at the end of each question (or no cache below four participants).

Test on the lower-stakes host first, then use the same commands on production.
`load-testing/.env`, state, and results contain test credentials and remain
local to each host. Confirm each host's configuration points at its intended
stack before seeding.

## Compare shared interactive latency

Use the existing `prod` + `docker` configuration, `production_setup` images,
public `BASE_URL`, replica count, and timing settings. From `load-testing/`, run:

```bash
./run.sh --matrix
```

The matrix uses the configured student count (normally 500); override it with
`./run.sh --matrix --students 500`. It automatically:

1. Restores an interrupted previous preparation, then prepares the configured stack.
2. Runs ordinary, shared (100% / 50% / 0% enrolled), shared anonymous (all guests),
   and course anonymous interactive scenarios, with chat off.
3. Repeats all six with statistics during answers off, then on. Command-line
   settings override `.env`; no editing of `.env` is required.
4. Continues through k6 threshold failures, but stops on preparation, ingress,
   or other execution failures. Privacy and performance thresholds stay strict.
5. Restores rate limits and removes test fixtures on completion, failure, or
   Ctrl+C. A restoration failure is reported and its recovery record retained.

The command returns nonzero if any scenario or cleanup step fails. An exclusive
lock prevents concurrent matrices from overwriting each other's fixtures; do not
run separate manual seed/test commands while a matrix is active. The driver uses
Bash, Docker, and `flock` (normally included with Linux `util-linux`). It does not
feed commands through stdin, so Docker Compose cannot consume the remaining script.

Outputs under `results/` share a `matrix-TIMESTAMP` prefix:

- `.log`: complete console output, including preparation and restoration failures.
- `.tsv`: scenario, enrollment percentage, statistics setting, and exit status.
- `-resources.jsonl`: UTC sample headers with host load and Docker container
  CPU, memory, network I/O and process counts, sampled approximately every seven
  seconds. All running containers are included so front-proxy and other host
  workloads can be distinguished. k6 containers have `qlicker-load-…` names.
- `-resources-errors.log`: resource sampling errors, if any.

Keep these together with the per-scenario k6 logs and JSON summaries. Resource
samples contain container names/utilization, not environment variables or user
payloads. Do not commit generated results.

For one prepared scenario, `--live-stats on|off` overrides the setting without
editing configuration:

```bash
./run.sh --scenario live-external-anonymous --enrolled-percent 0 --students 500 --session-chat off --live-stats on
```

Run matching matrices more than once on baseline and PR images before claiming
unchanged latency. Retain the ordinary chat-enabled workload as a separate
regression. The matrix does not include quizzes or the below-four-respondent
privacy case; those remain separate scenarios.

All participants in a shared run redeem the code once, including enrolled
students. `activity_redeem_duration` reports that initial step separately from
ongoing participation. The run log records participant counts and settings;
external result filenames include `enrolled-N`, and answer-burst runs include
`live-stats`. `--test-only` rejects a fixture with a different enrollment mix.
Reseed after updating the seed image or consuming a fixture.

Compare p95 and p99 for `respond_duration`, `join_duration`,
`live_refresh_duration`, `event_sync_duration`, and
`response_delivery_to_professor_duration`, together with error and completion
counts. Student metrics include separate `participant:enrolled` and
`participant:guest` summaries so one group cannot conceal the other's delay.
`event_sync_duration{role:student}` includes processing question/visibility
updates from their server emission through applying the local snapshot. It
measures the simulated client, not React rendering in a browser. Identified
runs also report `response_to_professor_duration` and
`response_server_processing_duration`. Anonymous events deliberately omit the
per-response timestamp, so those two measurements are unavailable; HTTP answer
time and count-event delivery remain measured. Do not expose identities or
response timestamps just to obtain an anonymous latency metric.

Every run checks answer counts, completed participants, instructor response
event counts, correlated result rows, and enrolled-only grades. Anonymous runs
also check that live events and final results do not expose identities and
that rows remain withheld below four respondents. Anonymous payloads and
available result features intentionally differ, so compare them against the
ordinary anonymous run as well as the identified runs.

When finished, run `./run.sh --restore` and `./run.sh --clean` separately,
including after a failed workload. Keep summaries for the staging comparison.

## Workloads

| Scenario | Student journey | Instructor and privacy checks |
| --- | --- | --- |
| `live-named` | Join, hold WebSocket, answer five questions, and exercise chat and live deltas | Professor drives visibility, attempts, aggregates, chat, and response delivery |
| `live-anonymous` | Join, hold WebSocket, and answer five questions | Counts update immediately; anonymous statistics update in groups of at least four; final results show correlated respondent rows after the session ends and the four-person minimum is met |
| `quiz-named` | Load course sessions, open the quiz, autosave five answers, and submit | Final results preserve one row and five answers per student |
| `quiz-anonymous` | Same quiz journey | Final results show one correlated row per respondent after the four-person minimum, without identities |

The new quiz and anonymous live workloads record success rates, response times,
answer counts, and final result checks. The original named live workload retains
its detailed WebSocket and chat metrics.

## Why the Seed Data Matters

The seed script now matches the current auth/session schema more closely than
before. In particular, load-test users are created with `allowEmailLogin=true`,
so they can authenticate even when institution-wide SSO is enabled and local
email login is normally blocked for non-admin accounts.

## Scenario Coverage

All live scenarios track the same live-session update path used by the browser. The ordinary `live-named` defaults remain unchanged:

1. Professor logs in, explicitly selects and hides the first question, and
   starts the session. Every later transition also hides the previous question
   before navigation, then exposes the next question only after its attempt is
   open. This makes fresh and repeated runs deterministic and prevents students
   from responding to intermediate snapshots.
2. Students log in and fetch `/sessions/:id/live`.
3. Students join the running session.
4. Students open `/ws?token=...`.
5. On `session:*` deltas, students patch local live state when the payload is
   sufficient—including question, attempt, visibility, stats, correct-answer,
   word-cloud, and histogram snapshots—and re-fetch `/sessions/:id/live` only
   for legacy/fallback payloads.
6. Students submit responses only when the current attempt is open and visible.
7. The professor closes responses, shows stats, generates short-answer word
   clouds and numerical histograms, reveals correct answers, and advances to the
   next question.
8. Chat is enabled, student quick-post waves fire after selected questions,
   random student posts are created and upvoted, and the professor replies to a
   few of the visible posts.
9. The session ends and connected clients observe the final state transition.

## Scenario Knobs

These optional environment variables let you tune the realism profile without
editing the script. Export them before `./run.sh`, or prefix them on the
command line.

Timing and sync variables:

- `LIVE_STATS_DURING_ANSWERS`: default `false`. Set `true` to keep statistics enabled while answers arrive and exercise per-answer delivery to participants. Anonymous answer content is delivered only in batches of at least four new respondents. Compare both stats-on and stats-off runs; the ordinary workload and production rate-limit configuration are unchanged.

- `SESSION_CHAT_ENABLED`: set to `true`/`false` (or use
  `./run.sh --session-chat on\|off`) to run the interactive session with session
  chat enabled or disabled.
- `ANSWER_WINDOW_S`: how long each question stays open for answers. Keep this
  comfortably above `RESPONSE_JITTER_MS` so the scenario is testing a normal
  response window rather than intentionally cancelling scheduled answers.
- `STATS_PAUSE_S`: how long stats stay visible before the correct-answer phase.
- `CORRECT_PAUSE_S`: how long the correct-answer phase remains visible.
- `JOIN_GRACE_S`: delay after the professor starts the session before the
  question loop begins, giving students time to join.
- `RESPONSE_JITTER_MS`: maximum deterministic delay before each student
  responds. The delay is derived from student, question, and attempt identifiers
  so equivalent runs create the same submission wave (default `2000`). A value
  of `0` uses k6's minimum valid one-millisecond WebSocket timer.
- `RESPONSE_ADDED_REFRESH_MS`: fallback debounce used before refreshing `/live`
  after a `session:response-added` websocket event when the delta does not
  carry enough state to patch locally.
- `STUDENT_LOGIN_SPREAD_S`: maximum login jitter applied across student VUs.
  `0` means everyone hits `/auth/login` immediately; higher values spread the
  startup wave and usually produce a more realistic class arrival pattern.
- `K6_NOFILE_LIMIT`: file-descriptor limit applied to the k6 container
  (default `16384`). Keep this above the combined number of long-lived
  WebSockets and concurrent HTTP/TLS connections. The upstream k6 image
  defaults to 1,024 descriptors, which is insufficient for the default
  500-student scenario once sockets and requests overlap.

Chat-behavior variables:

- `CHAT_ACTIVITY_EVERY_N_QUESTIONS`: after every Nth question starting at
  question 2, the scenario schedules a chat activity wave.
- `CHAT_VIEWER_STUDENT_FRACTION`: fraction of students who keep the chat panel
  open and apply `session:chat-updated` deltas locally, falling back to
  `/chat` only when needed.
- `CHAT_QUICK_POST_STUDENT_FRACTION`: fraction of students in each chat wave
  who request more explanation for an earlier question.
- `CHAT_RANDOM_POST_STUDENT_FRACTION`: fraction of students in each chat wave
  who create a regular discussion post.
- `CHAT_RANDOM_UPVOTE_STUDENT_FRACTION`: fraction of students in each chat wave
  who upvote a visible regular discussion post.
- `CHAT_ACTION_JITTER_MS`: max delay before a scheduled student chat action
  fires, to avoid an unrealistic same-millisecond burst. A value of `0` uses a
  one-millisecond timer.
- `CHAT_REPLY_PROFESSOR_LIMIT`: maximum number of professor replies during a
  run.
- `PROFESSOR_REPLY_DELAY_MS`: delay before the professor reviews and replies to
  chat during a question wave.

Example:

```bash
STUDENT_LOGIN_SPREAD_S=20 \
CHAT_VIEWER_STUDENT_FRACTION=0.25 \
CHAT_QUICK_POST_STUDENT_FRACTION=0.18 \
./run.sh --students 300
```

To compare the same session with and without chat:

```bash
./run.sh --students 300 --session-chat on
./run.sh --test-only --session-chat off
```

## Metrics

The scenario tracks and thresholds these key signals:

- `login_success{role:student}`
- `login_success{role:professor}`
- `join_success`
- `respond_success`
- `respond_attempts`
- `respond_successful_submissions`
- `professor_response_events`
- `professor_driver_completions`
- `professor_viewer_completions`
- `student_flow_completions`
- `live_refresh_success{role:student}`
- `live_refresh_success{role:professor}`
- `event_sync_success{role:student}`
- `event_sync_success{role:professor}`
- `ws_connect_success{role:student}`
- `ws_connect_success{role:professor}`
- `session_completion`
- `chat_action_success`
- `chat_refresh_success{role:student}`
- `chat_refresh_success{role:professor}`
- `chat_event_sync_success{role:student}`
- `chat_event_sync_success{role:professor}`
- `login_duration{role:student}`
- `login_duration{role:professor}`
- `login_blocked_duration`, `login_connecting_duration`,
  `login_tls_handshaking_duration`, and `login_waiting_duration`, tagged by role
- `join_duration`
- `respond_duration`
- `professor_action_duration`
- `response_to_professor_duration`
- `response_server_processing_duration`
- `response_delivery_to_professor_duration`
- `professor_observer_loop_lag`
- `live_refresh_duration{role:student}`
- `live_refresh_duration{role:professor}`
- `event_sync_duration{role:student}`
- `event_sync_duration{role:professor}`
- `event_delivery_duration{role:student|professor}`
- `event_apply_duration{role:student|professor}`
- `chat_refresh_duration{role:student}`
- `chat_refresh_duration{role:professor}`
- `chat_event_sync_duration{role:student}`
- `chat_event_sync_duration{role:professor}`
- `chat_event_delivery_duration{role:student|professor}`
- `chat_event_apply_duration{role:student|professor}`

`response_to_professor_duration` measures from the response submission
timestamp embedded in the server event until the professor observer receives
it. Unlike generic event-sync timing, it includes response persistence and
aggregate-statistics work performed before the websocket event is emitted.
`response_server_processing_duration` reports that pre-emit portion, while
`response_delivery_to_professor_duration` reports the emit-to-observer portion.
This split shows whether a slow professor update came from response/statistics
processing or from transport/observer backlog.

`anonymous_privacy_failures{reason:…}` separates identity/timestamp exposure,
small batches, publication gaps, and published totals larger than their accompanying
response counts. Every reason must stay at zero. Bounded warnings show only role,
question position, attempt and numeric counts—never answers, user IDs or raw payloads.
The original `anonymous_privacy_success` check remains in force. Final batch-size
checks alone cannot establish that intermediate publications were safe.

The k6 response-list simulator maintains already-sorted histories incrementally
for individual response events. It preserves the same ordering, deduplication,
updates and immutable snapshots as the previous full-sort implementation, but
avoids repeatedly parsing every response timestamp and sorting the whole list
on each of hundreds of simulated clients. HTTP snapshots and entries without IDs
retain the canonical merge path. This changes simulation bookkeeping only; it does
not reduce requests, recipients, events, or strict completion/privacy thresholds.
Browser rendering performance still requires browser telemetry.

`response_event_chars` reports response-event JSON string lengths (characters,
not encoded network bytes), tagged by role. Combine it with `ws_msgs_received`,
network traffic, resource samples and observer lag to distinguish larger payloads,
higher fan-out volume and load-generator contention. No per-event console logging
or unbounded raw k6 sample export is enabled.

`professor_observer_loop_lag` samples a 250 ms timer in the professor k6 VU.
High loop lag alongside high delivery latency means the shared load generator
is struggling to schedule the observer and may overstate browser latency. Low
loop lag with high delivery latency points instead to Redis/WebSocket/network
fan-out in the deployed path.

The event metrics use the same split: `event_delivery_duration` measures server
emit to WebSocket receipt and `event_apply_duration` measures receipt to a
validated local patch or completed fallback refresh. Their sum corresponds to
the end-to-end `event_sync_duration` for timestamped events. Chat has matching
delivery/apply metrics.

Live and chat event-duration samples are tagged by event/reason so exported k6
data can distinguish question changes, visibility changes, attempts, responses,
and refresh fallbacks.

When `SESSION_CHAT_ENABLED=false`, the chat-specific thresholds are skipped so
the report focuses on core live-session responsiveness.

Additional counters include:

- `ws_connections`
- `ws_errors`
- `ws_handshake_failures`: failed upgrades, including timeouts that occur before
  the WebSocket opens and therefore may never trigger a socket error event
- `response_added_refreshes`
- `respond_attempts`: every `/respond` request issued by the scenario
- `respond_successful_submissions`: every accepted response
- `professor_response_events`: accepted responses observed by the professor
  WebSocket client
- `professor_driver_completions`, `professor_viewer_completions`, and
  `student_flow_completions`: exact counts of scenario flows that reached their
  normal end; unlike a success rate, these expose callbacks aborted by a runner
  exception
- `respond_conflict_failures`: `/respond` returned `409` because a response
  already existed for that student and attempt
- `respond_rejected_failures`: `/respond` returned another `4xx` response,
  such as a closed or hidden attempt
- `respond_server_failures`: `/respond` returned a `5xx` response or failed at
  the transport layer
- `respond_stale_timer_skips`: a delayed simulated response was safely skipped
  because the professor had already changed the question or attempt
- `invalid_server_timestamps`: server timestamps could not be ordered against
  load-runner receipt times, making cross-process latency samples unreliable
- `chat_quick_post_toggles`
- `chat_posts_created`
- `chat_votes_applied`
- `chat_replies_created`

## Interpreting Progress Output

While the run is active, k6 may show `0 complete` for several minutes. That is
expected for this scenario. Each VU runs one full-class iteration:

- one professor driver iteration lasts for the entire session
- one professor viewer iteration tracks websocket-driven UI freshness for the
  instructor side
- each student iteration lasts from login through session end

The default timing profile is roughly:

- `JOIN_GRACE_S=5`
- `ANSWER_WINDOW_S=30`
- `STATS_PAUSE_S=15`
- `CORRECT_PAUSE_S=15`
- 5 questions total

That adds up to a little over 5 minutes before iterations begin completing.

## Threshold Units and Targets

k6 reports custom `Trend` metrics in milliseconds.

- `p(95)<3000` means 95% of samples finished in under 3000 ms, or 3 seconds
- `p(99)<3000` means 99% of samples finished in under 3 seconds
- `p(95)<5000` would mean 95% finished in under 5 seconds
- `rate==1` means a `Rate` metric must be 100%
- `rate==0` means no failures at all
- `count==0` means the counter must stay at zero

Many thresholds are role-tagged, for example
`chat_refresh_duration{role:student}` or `login_success{role:professor}`. Those
sub-metrics let the report distinguish student-facing latency from
professor-facing latency without needing separate metric names.

The current acceptance bar is intentionally strict for classroom use:

- `http_req_failed` must stay at `0%`
- `ws_errors` must stay at `0`
- `respond_attempts`, `respond_successful_submissions`, and
  `professor_response_events` must each equal the seeded student count times
  the number of response-capable questions. This prevents a clean percentage
  from hiding missing, duplicate, or unobserved responses.
- `professor_driver_completions` and `professor_viewer_completions` must each
  equal `1`, and `student_flow_completions` must equal the seeded student count.
  A JavaScript exception or early return therefore cannot disappear from a
  percentage whose denominator only contains completed callbacks.
- `respond_conflict_failures`, `respond_rejected_failures`,
  `respond_server_failures`, `respond_stale_timer_skips`, and
  `invalid_server_timestamps` must stay at `0`.
- `login_success{role:student}`, `login_success{role:professor}`,
  `join_success`, `respond_success`,
  `live_refresh_success{role:student}`,
  `live_refresh_success{role:professor}`,
  `event_sync_success{role:student}`,
  `event_sync_success{role:professor}`,
  `ws_connect_success{role:student}`,
  `ws_connect_success{role:professor}`,
  `professor_action_success`, `chat_action_success`, and `session_completion`
  must all be `100%`
- `professor_action_duration` and `response_to_professor_duration` must have
  `p(95)<3000`
- `login_duration{role:student}`, `login_duration{role:professor}`,
  `join_duration`, and `respond_duration` must have
  `p(95)<3000`
- `live_refresh_duration{role:student}`,
  `live_refresh_duration{role:professor}`,
  `event_sync_duration{role:student}`,
  `event_sync_duration{role:professor}`,
  `chat_refresh_duration{role:student}`,
  `chat_refresh_duration{role:professor}`,
  `chat_event_sync_duration{role:student}`, and
  `chat_event_sync_duration{role:professor}` must have `p(99)<3000`

This means the pass/fail summary is checking both correctness and a classroom
freshness target of "essentially everyone stays under 3 seconds" for the
key live-sync paths.

## How To Read A Finished Run

Read the summary in this order:

1. `THRESHOLDS`
2. `CUSTOM`
3. `HTTP`
4. `WEBSOCKET`

What each section means:

- `THRESHOLDS` is the contract. If any line fails, the run should be treated as
  a failed acceptance test.
- `CUSTOM` shows the metrics that map most directly to classroom behavior.
- `HTTP` shows overall request timing across all endpoints, which is useful but
  less specific than the custom metrics.
- `WEBSOCKET` shows connection health and how long students stayed connected.

For live-session correctness, the most important lines are:

- `login_success{role:student}`
- `login_success{role:professor}`
- `join_success`
- `respond_attempts`
- `respond_successful_submissions`
- `professor_response_events`
- `student_flow_completions`
- `ws_connect_success{role:student}`
- `ws_connect_success{role:professor}`
- `professor_action_success`
- `chat_action_success`
- `session_completion`
- `live_refresh_success{role:student}`
- `live_refresh_success{role:professor}`
- `event_sync_success{role:student}`
- `event_sync_success{role:professor}`
- `http_req_failed`
- `ws_errors`

For "do student screens stay fresh enough?", focus on:

- `live_refresh_duration{role:student}`: time to fetch `/sessions/:id/live`
- `event_sync_duration{role:student}`: time from the server-emitted websocket
  event (`emittedAt`) to validating the patched local state or completing the
  fallback live refresh; if `emittedAt` is unavailable, it falls back to
  receive-to-sync time
- `chat_refresh_duration{role:student}`: time to fetch `/sessions/:id/chat`
- `chat_event_sync_duration{role:student}`: time from a
  `session:chat-updated` emit to the patched local chat state or fallback chat
  refresh completing

For "does the instructor side stay current too?", focus on:

- `live_refresh_duration{role:professor}`
- `event_sync_duration{role:professor}`
- `chat_refresh_duration{role:professor}`
- `chat_event_sync_duration{role:professor}`
- `response_to_professor_duration`: complete submit-to-observer latency
- `response_server_processing_duration`: submit-to-server-emit latency
- `response_delivery_to_professor_duration`: server-emit-to-observer latency
- `professor_observer_loop_lag`: delay scheduling the professor observer within
  k6 itself

Use `event_delivery_duration{role:professor}` and
`event_apply_duration{role:professor}` to split any slow end-to-end event sample.
If delivery is slow, the delay happened before the observer callback. If apply
is slow, the delta processing or fallback HTTP refresh caused it. This avoids
mislabeling load-generator work as server or WebSocket latency.

If these stay under 3 seconds at `p(99)`, the load-test contract is saying the
tail of the class still stayed within the sync target.

## Browser Telemetry

The live student page, professor control page, and presentation window now send
batched browser-side telemetry to the app during real sessions:

- `live_fetch_request_ms`: `/sessions/:id/live` request time in the browser
- `live_fetch_apply_ms`: time from starting a live refresh to the updated UI
  being painted
- `ws_event_delivery_ms`: time from the server emitting a websocket event to the
  browser receiving it
- `ws_event_to_dom_ms`: time from the browser receiving a websocket event to the
  updated UI being painted
- `server_emit_to_dom_ms`: end-to-end time from server emit to painted UI

Instructors can inspect the aggregated summary at:

- `GET /api/v1/sessions/:id/live-telemetry`

That summary includes separate rollups for `student`, `professor`, and
`presentation` views, plus approximate `p50`, `p95`, and `p99` values. For the
real interface experience, `server_emit_to_dom_ms` is the most important line.
That is the closest measurement to "the professor changed something, and the
student screen visibly caught up."

## Interpreting Slow Runs

Different metrics point to different bottlenecks:

- A `login_duration` near 60 seconds with a much smaller `http_req_duration`
  points to connection establishment. k6 excludes DNS, TCP connection, and TLS
  setup from `http_req_duration`. Inspect `login_blocked_duration` (the phase
  before sending, including connection setup), `login_connecting_duration`,
  and `login_tls_handshaking_duration`; these overlap and must not be added
  together. `login_waiting_duration` measures time to the first response byte.
  See the [k6 metric definitions](https://grafana.com/docs/k6/latest/using-k6/metrics/reference/).
  Failed logins and WebSocket handshakes also log the role, HTTP status, k6
  error code, and available timing phases. These diagnostic records omit
  credentials, request URLs, and raw error messages.
- Failed WebSocket handshakes can coexist with `ws_errors=0`: that counter
  records socket error events, whereas `ws_handshake_failures` counts failed
  upgrades. Check both alongside `ws_connect_success`.
- Slow `login_duration{role:student}` with healthy in-session metrics usually
  means startup authentication load is the bottleneck, not the live session
  itself. If this is the only recurring failure, check whether
  `STUDENT_LOGIN_SPREAD_S` is too low for the class size you are simulating.
  This metric measures the `/auth/login` request itself, not the full browser
  boot sequence.
- Slow `live_refresh_duration{role:student}` or
  `event_sync_duration{role:student}` means students may see stale screens
  after professor actions.
- Slow `chat_refresh_duration{role:student}` or
  `chat_event_sync_duration{role:student}` means the chat panel is lagging
  behind the live conversation even if question-state refreshes still look
  healthy.
- A healthy `p(95)` with a much larger `max` means the system is usually fast
  enough but still has tail-latency spikes worth investigating.

## Notes

- The runners use Docker even for native dev targets. Localhost-based URLs are
  rewritten to `host.docker.internal` so the containers can reach the host
  stack.
- The k6 runner raises its file-descriptor limit to `K6_NOFILE_LIMIT`. Without
  this, connection attempts can time out before reaching Nginx while
  `http_req_duration` still looks healthy because it excludes connection setup.
- `run.sh` re-checks the target `.env` and Docker network at execution time, so
  `--clean` is less likely to use a stale Mongo hostname after the stack has
  moved or been restarted.
- The seed / cleanup runner retries MongoDB connections with a small pool, which
  helps after a heavy test when Mongo is still draining or briefly recovering.
- Production Docker targets still support rate-limit disabling at both the
  Fastify and nginx layers.
- Results are written to `load-testing/results/`.

## Troubleshooting

- If `--clean` reports `MongoNetworkError: connection ... closed` right after a
  large test, wait a few seconds and rerun it once. The runner now retries
  automatically, but the underlying issue is usually a stack that is still
  recovering from burst load.
- If the running app itself starts failing until Docker is restarted, the
  deployment is likely under-provisioned. On smaller Docker hosts, lower
  `MONGO_WIREDTIGER_CACHE_SIZE_GB` and keep `MONGO_MAX_POOL_SIZE` conservative
  so MongoDB is not pushed into an unhealthy state during live-session bursts.
