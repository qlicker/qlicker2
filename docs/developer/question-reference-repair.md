# Diagnose and repair shared question references

The library-copy bug could save the same question ID at multiple positions in a session. Older workflows could also attach a library or another session's question directly. Those positions share an answer because responses are keyed by question ID.

## Production diagnostic: start here

Use Bash and Docker from `production_setup`. **Node.js is not needed on the host.** Use an updated server image containing the repair utility and the copy fix.

```bash
cd production_setup
./repair-question-references.sh
```

This scans **all sessions in all courses**, including inactive courses. No session ID is needed. The app can stay running during diagnosis. The command creates a temporary container from your configured server image, uses the existing Compose database configuration, and removes the container afterward. It does not start another app server or change database records, collections, or indexes.

The report lists each affected course and session by name, course code/section/semester, session status, repeated or foreign question positions, and response/grade record counts. IDs are included as secondary information for optional filtering. Student names and answer content are not printed.

Example output:

```text
1. Course: Introductory Mechanics (PHY 101 A Fall 2026)
   Session: Week 3 quiz [done]
   Course ID: ... | Session ID: ...
   Repeated question positions: 2, 3. These positions share an answer with an earlier question.
   History: 25 response records on these questions; 25 linked grade records.
   Review the repair and grading choices before changing this session.

Scanned 120 sessions. Found 1 session needing review.
Diagnostic only: no data was changed.
```

If there are no affected sessions, the report says so. Successful human-readable diagnostics exit `0`, including when issues are found. You can save the report with normal shell redirection:

```bash
./repair-question-references.sh > question-reference-report.txt
```

Optional filters and machine-readable output:

```bash
./repair-question-references.sh --course COURSE_ID
./repair-question-references.sh --session SESSION_ID
./repair-question-references.sh --json
```

Do not commit diagnostic reports or backups to the repository.

## Interactive repair

Review the diagnostic first. Back up MongoDB and test on a restored copy before production repair. Stop all app server replicas and other database writers; leave MongoDB running:

```bash
./backup.sh --label manual
docker compose stop nginx server client
./repair-question-references.sh --repair
```

The launcher refuses to repair while any server replica in this Compose project is running. It requires a terminal and asks you to confirm a current backup and that all application writers are stopped. If other deployments or jobs use the same database, stop those writers too.

The repair command scans the database, shows the named list, then visits affected sessions one at a time. Available choices depend on the data:

| Choice | Effect |
| --- | --- |
| Create independent copies | Available for unused hidden/visible sessions with no participation, responses, or grades. Keeps every question position and its point configuration; each duplicate or foreign reference gets a fresh ID. |
| Remove repeated positions; keep grades | Retains the first occurrence and its existing answers. Leaves all stored grade records, percentages, totals, manual marks, and feedback exactly unchanged. Historical grades may still reflect the old question count; review them deliberately. |
| Remove repeated positions; recalculate | Available for ended sessions. Retains the first question and its answers, then recalculates automatic grades for the reduced question count. Manual marks, their denominators, feedback metadata, and manual overall grades are preserved. Automatic totals and participation can change. |
| Skip / quit | Makes no change to that session. Skipping is the default. |

Each selected change is described again and requires typing `REPAIR` for the named course/session. There is no blanket approval of all assessments.

For example, if the same question appears three times accidentally, removing repeated positions changes three positions into one. Choosing **keep grades** preserves published historical percentages. Choosing **recalculate** makes automatic grading reflect that single question. This is an academic decision, so the tool asks you to choose.

For answered sessions, removal is offered only when the questions belong exclusively to that session and all question documents exist. The tool never fabricates answers, duplicates credit, or moves response rows between sessions. Shared references across sessions require individual review: response rows have no session ID, and the same student may have attended both sessions. Missing content must be restored or recreated separately.

Recalculation is withheld if duplicate grade rows or multiple manual marks for the same question would make choosing a manual override ambiguous. Keeping historical grades is still available when question ownership is otherwise unambiguous.

After completing the wizard:

```bash
./repair-question-references.sh
docker compose up -d server client nginx
```

Review the repaired quiz and grade totals in the app. Exit `2` from the repair wizard means some sessions were skipped or a conflict needs attention; exit `1` means an execution failure. Successfully completed repairs remain applied if you later quit or skip another session.

## Consistency and interrupted repairs

- Repairs preserve Meteor-compatible string IDs and legacy question fields. Creating copies resets live response/statistics state, preserves order and point/attempt configuration, and updates the current-question pointer if needed.
- Removing duplicate positions retains the original question documents and responses. The session's response-tracking keys are restricted to the retained questions.
- A successful repair is idempotent: running the diagnostic again will not flag those repaired references.
- Session snapshot checks reject conflicting changes, but cannot lock response/grade collections. All application writers must stay stopped throughout repair.
- With recalculation, grades are calculated for the proposed unique order **before** replacing the session's question array. If grading fails, duplicates remain detectable for an offline retry. Some automatic grades or duplicate mark arrays may already have been updated. Keep the app offline, diagnose, and retry recalculation or restore the backup; do not treat that failure as a completed repair.
- Failed copy insertions and rejected session updates clean up known unattached copies. A process crash or uncertain database acknowledgement can leave unattached question documents. They are retained if deletion might break an update that actually succeeded. Inspect the backup and session before deleting anything.

There is no automatic rollback of completed decisions. Restore the backup with application writers stopped if a full rollback is required.

## Developer entry point

The Bash launcher runs `server/scripts/repair-question-references.js` inside the server image. Developers with local server dependencies can run the same CLI directly. `--interactive` starts the decision loop; `--json` emits JSON lines; these cannot be combined. The legacy `--apply` option remains restricted to unattended copying in unused hidden drafts and does not make historical grading decisions.

The CLI reads `MONGO_URI` or `MONGO_PORT` from the environment or root/server `.env` without printing connection credentials. JSON diagnostic exit code `2` indicates blocked cases or an empty selection, preserving the original machine-readable contract. No new environment variables are required.
