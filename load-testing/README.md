# Qlicker load testing

The k6 suite checks interactive sessions, quizzes, shared activities, and anonymous response privacy. It seeds dedicated accounts and a course, drives the deployed application over HTTP/WebSockets, and checks saved answers, instructor delivery, result rows, and grades.

## Setup

From the repository root:

```bash
cd load-testing
./setup.sh
```

Use **prod + docker** for either a staging or production installation deployed from `production_setup/`. Both use the same images, Compose topology, and public proxy path; staging is a lower-stakes copy, not a different runtime mode. The wizard asks for the target `.env`, student count, and runtime, derives `BASE_URL`/MongoDB/network settings, and builds the seed image. Dev Docker and native targets are also supported for individual runs; the load generators themselves require Docker.

The seed image is separate from the application images. `run.sh` automatically rebuilds a missing or stale seed image after a checkout update. Deploy application changes through the normal image/update workflow before measuring them. Keep `.env`, credentials, seed state, and generated results out of Git.

## Quick start

On a configured production-equivalent Docker stack:

```bash
./load-testing/run.sh --regression --students 500
```

Run from the repository root, or use `./run.sh` from this directory. The command prepares the stack, runs one classroom session, restores the original rate-limit settings, and removes fixtures. No manual `.env` edits or separate cleanup commands are needed on normal completion, threshold failure, or Ctrl+C.

Preparation temporarily disables API/Nginx rate limits and recreates the API services. Run during an agreed test window, on staging first. The test measures application capacity with those limits disabled, not public rate-limit behavior. Each seed replaces prior load-test fixtures; do not run workloads concurrently against the same database.

## Choose a workload

| Goal | Command | Approximate workload |
| --- | --- | --- |
| Ordinary classroom regression | `./run.sh --regression --students 500` | One session, about five minutes plus setup/cleanup |
| Statistics hidden/visible comparison | `./run.sh --ordinary --students 500` | Two sessions, about eleven minutes plus setup/cleanup |
| Statistics-visible stress case only | `./run.sh --ordinary --students 500 --live-stats on` | One session |
| Full shared/anonymous comparison | `./run.sh --matrix --students 500` | Twelve sessions; allow about an hour plus setup/cleanup |
| A quiz or a specific participant mix | Individual scenario commands below | One seeded activity per run |

The automatic profiles use Bash, Docker, Linux host resource sampling, and `flock`. They record application image tags/IDs, host resources, runner revision, timing configuration, and scenario results. A missing/failed diagnostic is reported; it does not convert a failed workload to a pass.

## Classroom regression check

`--regression` checks the normal teaching sequence: one instructor and observer, enrolled students, five question types, chat, and WebSockets. Sharing and anonymity are off. Statistics stay hidden while students answer; the instructor still receives updates. After responses close, statistics and answers are revealed before the next question.

It requires all answers and student completions, per-question instructor coverage, final result rows, and grades. With 500 students and five questions that means 2,500 answers. The profile fixes chat on, 100% enrolled, and statistics hidden during answering, regardless of older matrix settings in `.env`. Only `--students` overrides the profile; configured timings still apply.

This is the recommended starting point for ordinary-session regressions. It does not cover guest access, anonymity, quizzes, or broadcasting statistics during answer bursts. Use those scenarios when the changed code affects those paths.

## Compare shared interactive latency

`--matrix` runs each of these with statistics during answering **off**, then **on**:

1. Course-only, identified, all enrolled.
2. Shared, identified, 100% enrolled.
3. Shared, identified, 50% enrolled / 50% guests.
4. Shared, identified, all guests.
5. Shared, anonymous, all guests.
6. Course-only, anonymous, all enrolled.

Chat is off in the matrix. All participants in shared runs redeem an activity code, including enrolled students. Initial code redemption has its own latency metric; ongoing participation is measured separately. Identified shared activities grade eligible enrolled students only. Anonymous activities never create grades.

The matrix continues after k6 threshold failures to collect comparisons, but stops on infrastructure/interruption failures. Any failed scenario or failed cleanup produces a nonzero exit. The statistics-visible half is a heavier fan-out workload than the classroom regression; inspect generator loop lag before attributing its latency to the application.

## Individual scenarios and quizzes

Individual `./run.sh` invocations seed and test but require manual preparation/restoration. Use these when a full matrix is unnecessary or to cover quizzes, which are not in the automatic matrix:

```bash
cd load-testing
./run.sh --prepare
./run.sh --scenario live-external-named --students 500 --enrolled-percent 50 --session-chat off --live-stats off
./run.sh --scenario live-external-anonymous --students 500 --enrolled-percent 0 --session-chat off --live-stats off
./run.sh --scenario live-anonymous --students 500 --session-chat off --live-stats off
./run.sh --scenario quiz-named --students 500
./run.sh --scenario quiz-anonymous --students 500
./run.sh --scenario quiz-external-named --students 500 --enrolled-percent 50
./run.sh --scenario quiz-external-anonymous --students 500 --enrolled-percent 0
./run.sh --restore
./run.sh --clean
```

Choose the scenarios you need. Run restoration and cleanup even after a failed workload; do not join them to the test with `&&`, which would skip cleanup on failure. For native targets, preparation/restoration updates the target environment and instructs you to restart the server manually.

For the privacy boundary, run an anonymous scenario with three participants (rows withheld), then at least four (linked rows released after the activity ends). Live anonymous aggregates update in groups of at least four new respondents; an individual count change without a statistics change is expected. Keep anonymous payloads free of identities and precise per-response timestamps.

### Additional commands

| Command | Purpose |
| --- | --- |
| `./run.sh --seed-only --scenario NAME` | Create fixtures only |
| `./run.sh --test-only --scenario NAME` | Use an unconsumed matching fixture |
| `./run.sh --clean` | Remove load fixtures; retain restoration record |
| `./run.sh --restore` | Restore the saved original rate-limit configuration |
| `./run.sh --session-chat on\|off` | Chat workload; shared/anonymous live comparisons require off |
| `./run.sh --live-stats on\|off` | Statistics during answering for individual/ordinary runs |
| `./run.sh --enrolled-percent N` | External participant mix, 0–100; ordinary scenarios require 100 |

A completed quiz/session fixture must be reseeded before another full pass. `--test-only` validates scenario and enrollment mix. API load-test fixtures have local login enabled so institution-wide SSO-only policy does not prevent their authentication.

## Results and comparison

Automatic profiles write `results/regression-TIMESTAMP`, `ordinary-TIMESTAMP`, or `matrix-TIMESTAMP` artifacts:

- `.log`: complete preparation, workload, and restoration output;
- `.tsv`: scenario, enrolled percentage, statistics mode, exit code;
- `-resources.jsonl`: host/container utilization samples;
- `-resources-errors.log`: diagnostic collection failures, if any.

Every workload also writes `k6-NAME-TIMESTAMP.log` and `summary-NAME-TIMESTAMP.json`. Keep these with the profile files; the TSV alone does not explain a failed WebSocket, login, or timing threshold.

Check correctness/completion and errors first, then p95/p99 response, control, and event latency. Check professor/student observer loop lag and host CPU before attributing slow delivery to the server. k6 and the app compete for resources when running on the same host. That topology can still provide a comparison if both versions use identical conditions; it is not a measurement of isolated server capacity. Browser rendering latency is measured separately by [browser telemetry](#browser-telemetry).

For before/after measurements, use the same load-testing checkout and k6 image against both application versions. Match class size, timings, replica count, host resources, statistics visibility, chat, and proxy route. A passing candidate run alone does not establish unchanged latency. Do not reduce class size, retry away failures, or relax thresholds to label a failed run a pass.

## Recovery and ingress checks

Automatic profiles restore an interrupted preparation when its record is present. If a machine/container was killed before cleanup, run `./run.sh --restore` and `./run.sh --clean` separately before the next test. Keep `state/rate-limit-restore.env` until restoration succeeds. If it is missing, the runner cannot reconstruct the previous API setting: inspect the target `DISABLE_RATE_LIMITS` and active Nginx limits before preparing again.

Before starting VUs, twelve empty login requests go through the public `BASE_URL`; all must return validation status 400. A TLS error, 503, or other response stops the run and saves a `preflight-NAME-TIMESTAMP.log`. Verify the public health route and front proxy before investigating application latency. An SSL wrong-version/record-too-long error can indicate HTTP on a TLS port or a mismatched PROXY-protocol listener; it is not evidence of a slow application.

The prod/docker runner requires a successful preparation record and disabled rate limits. The automatic profiles handle this themselves. A failed threshold, abort, missing summary, or cleanup failure is not a successful acceptance run.

## Workloads

| Scenario | Student journey | Instructor and privacy checks |
| --- | --- | --- |
| `live-named` | Join, hold WebSocket, answer five questions, and exercise chat and live deltas | Professor drives visibility, attempts, aggregates, chat, and response delivery |
| `live-anonymous` | Join, hold WebSocket, and answer five questions | Counts update immediately; anonymous statistics update in groups of at least four; final results show correlated respondent rows after the session ends and the four-person minimum is met |
| `quiz-named` | Load course sessions, open the quiz, autosave five answers, and submit | Final results preserve one row and five answers per student |
| `quiz-anonymous` | Same quiz journey | Final results show one correlated row per respondent after the four-person minimum, without identities |

The quiz and anonymous live workloads record success rates, response times,
answer counts, and final result checks. The original named live workload retains
its detailed WebSocket and chat metrics.

## Why the Seed Data Matters

Load-test users are created with `allowEmailLogin=true`,
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
- `professor_response_coverage_success`
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
- `student_observer_loop_lag` (tagged by participant type)
- `respond_timer_lag` (actual timer delay beyond the requested answer jitter)
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
and updates as the browser. The protocol simulator owns its lists and updates
them in place; it does not need immutable snapshot histories for React rendering.
An ID index avoids scanning the list for new responses, and binary insertion
preserves timestamp/ID ordering. This removes per-answer list copies and sorts
across hundreds of simulated clients. HTTP snapshots and entries without IDs
retain the canonical merge path. Regression tests compare every intermediate
list with the original implementation, including reordered and repeated answers.
Requests, recipients and events are unchanged. Browser rendering performance
still requires browser telemetry.

Student sockets use the [k6 global-event-loop WebSocket API](https://grafana.com/docs/k6/latest/javascript-api/k6-websockets/),
with [asynchronous answer requests](https://grafana.com/docs/k6/latest/javascript-api/k6-http/asyncrequest/).
They continue consuming updates while their own answer HTTP request is pending,
as a browser does. The former blocking HTTP call inside `k6/ws` artificially
queued incoming events behind the answer request. One in-flight request is allowed
per attempt; its completion cannot overwrite newer question/stats state. Socket
closure cancels timers and waits for pending callbacks before counting completion.
The answer count, jitter, HTTP failure and HTTP latency requirements are unchanged.
Keep the standard k6 image current if using a custom image predating `k6/websockets`.
Initial setup and infrequent fallback/chat calls remain synchronous in the runner;
use the loop-lag gates to spot contamination from those paths.

`response_event_chars` reports response-event JSON string lengths (characters,
not encoded network bytes), tagged by role. Combine it with `ws_msgs_received`,
network traffic, resource samples and observer lag to distinguish larger payloads,
higher fan-out volume and load-generator contention. No per-event console logging
or unbounded raw k6 sample export is enabled.

`professor_observer_loop_lag` samples a 250 ms timer in the professor k6 VU;
`student_observer_loop_lag` samples a one-second timer in every student VU.
Both must have p99 below 250 ms. These are test-client health gates, separate
from the existing three-second application latency limits. A failed health gate
means the run cannot establish browser latency reliably, even if all answers
were saved. Local scheduling delays can come from generator CPU contention or
synchronous HTTP calls within a VU; compare them with container CPU and HTTP
timings before attributing the delay to the server. Low timer lag alone does
not rule out an incoming WebSocket queue backlog.

`respond_timer_lag` measures how late each answer timer fired beyond its requested
jitter. The runner rechecks the current question, attempt, session status, join,
visibility and answer gates after every relevant session event, and again before
submitting. An attempt event after a visibility event cannot leave a stale
separate window flag blocking submission. A timer belonging to another attempt
is skipped, never submitted against the new question. `respond_stale_timer_skips`
still must be zero for this controlled workload; its `reason` tag distinguishes
an attempt change from a closed answer window. Missing answers remain failures.

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
- `professor_response_events`: raw response notifications observed by the professor
  WebSocket client. Anonymous snapshot repair can send an extra aggregate
  notification without inserting an answer; this is not a count of database rows.
- `professor_response_coverage_success`: every question's latest observed attempt
  reaches exactly the seeded participant count. Repeated/out-of-order counts
  cannot inflate this check; excess counts also fail.
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
- `respond_attempts` and `respond_successful_submissions` must each equal the
  seeded student count times the number of response-capable questions.
- `professor_response_events` must equal that count for non-anonymous sessions.
  For anonymous sessions it must be at least that count: instructor `/live`
  snapshot repair can legitimately publish another anonymous aggregate event.
  All sessions must pass `professor_response_coverage_success` for every question,
  the authoritative final question count, and final results with exactly one
  answer per participant per question. Extra notifications cannot substitute
  for missing or duplicate saved responses.
- Professor and student observer loop-lag p99 must be below 250 ms. Keep these
  health gates separate from application latency when interpreting a failure.
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
- `professor_response_coverage_success`
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
