# Grading Guide

This guide explains how Qlicker turns participation and responses into visible grades. It supplements the [Professor manual](professor.md) and [Student manual](student.md).

## The grading lifecycle

```text
Students respond → instructor ends session → grade rows are created/recalculated
                  → manual work is completed → reviewability releases results
```

These states are intentionally separate:

- **Running/visible** controls participation.
- **Ended** creates or refreshes grade items. Grading unlocks once all active or upcoming extensions have expired or been removed and grade items exist.
- **Reviewable** recalculates automatic grades and releases the session/results to students. Manual overrides are preserved. Review any warnings about responses that still require manual grading.
- Grade visibility can be managed while corrections or manual work are underway.

Scheduled quizzes close automatically when accessed after the final time window, including any extensions. If a quiz was ended early and then returned to its schedule, the final closure refreshes automatic marks for later responses while preserving confirmed manual grades.

An instructor can review live response data while an interactive session is running, but cannot edit/recalculate grades until it ends.

Anonymous sessions skip this lifecycle entirely: they never create grade items, stay out of the course grade table, and reject recalculation and AI grading. Their review offers a read-only **Responses by question** tab instead of **Grading**. See [Run an anonymous survey](professor.md#run-an-anonymous-survey).

## Instructor workflow

1. End the activity.
2. Open session **Review → Grading**, or open course **Grades**.
3. If the grading panel reports missing grade items, choose **Create grade items**. Use **Re-calculate all grades** when scoring/content changed or an earlier closure left stale automatic grades.
4. Resolve warnings and manually grade short-answer responses.
5. Add actionable feedback.
6. Confirm question points, total points, percentages, and participation.
7. Make the session reviewable/visible when release is intended.
8. Export CSV and inspect the selected columns before importing elsewhere.

![Course grade table with one completed quiz selected](../assets/manuals/professor-grades.png)

In the course table, select sessions through **Show Grade Table**. Select a percentage to inspect one student's grade, then select a question label such as `Q1(MC)` or `Q2(SA)` for the response and mark editor.

## Automatic scoring

Qlicker automatically grades:

- multiple choice
- true/false
- multi-select
- numerical responses (using the configured correct value/tolerance)

Short answer normally requires manual grading. If points are not set, short answer defaults to `0` while other answerable types default to `1`; instructors should set deliberate point values before delivery.

When a student has multiple responses, grading uses that student's latest attempt for the question, based on attempt number and response update time.

### Multi-select methods

The session editor selects one method:

| Method | Meaning |
| --- | --- |
| Right minus wrong | Rewards correct selections, subtracts for incorrect selections, and never goes below zero |
| All or nothing | Awards credit only for the exact correct set |
| Correctness ratio | Awards a proportional score based on correctly classified options |

Explain the selected policy before students begin. A learner may make different choices when wrong selections are penalized.

### Low-participation exclusion

For a single-attempt question, if unique responders are fewer than 10% of the students who joined, the question is treated as `outOf = 0`. This prevents a nearly unused question from distorting grades. Check joined/responded counts when a question unexpectedly contributes no points.

### Blank short answers

A submitted blank short answer counts as participation but is automatically worth zero and does not remain in the manual-grading queue. Missing responses also receive zero. Whitespace and empty rich-text paragraphs count as blank; an answer stored only as rich text still counts as a response.

A nonblank short answer worth points remains **Needs grading** until its score is saved. To award zero, leave or enter `0` and choose **Save** to confirm it. A displayed automatic zero is not a completed manual grade. Saved responses are graded even if the student did not press the final quiz submission button.

## Manual marks and feedback

Open the question detail from the course grade table or session grading view:

1. Read the exact prompt, response, and attempt.
2. Enter manual points within the allowed total.
3. Write feedback that identifies the next useful action.
4. Save and verify that the overall grade updates.

A manually edited question mark is an override. Recalculation preserves it and reports a conflict if the new automatic value differs. You can explicitly restore automatic scoring for an autogradeable mark or the overall value.

Good feedback is brief and specific: “Your setup is correct; explain why the membrane is selectively permeable” is more useful than “needs work.” Publishing new feedback creates a student notification.

## AI-assisted grading

When AI is authorized and enabled for the course, **Review → Grading → AI Grading Assistant** can process selected eligible questions. It is an optional batch assistant, not a separate grading policy.

Before starting:

1. Select only the questions that should be processed.
2. For every selected question, choose or create a **grading instruction** describing how points should be assigned.
3. Choose or create a separate **feedback-to-student instruction** describing useful feedback.
4. Select an approved model and confirm the instructions match the current question and point value.

While the job runs, Qlicker shows progress. You can halt it and inspect a partial report if the instructions, provider, or output look wrong. Completed, halted, and failed runs retain a report and detailed log so you can see which work finished.

Afterward, sample responses across strong, borderline, and weak answers; verify every selected question's point range; read student-facing feedback; and correct individual marks before release. AI grading does not remove the instructor's responsibility for the final grade, and students should have a human route to question the result.

Reusable grading and feedback instructions are managed in course **AI Settings** and can be copied from another course. Recheck copied criteria before use. For response summaries, AI Chat, and student AI configuration, see [Use AI for teaching and course management](professor.md#10-use-ai-for-teaching-and-course-management).

## Changing points after delivery

Changing a question's point value from session review prompts for confirmation and recalculates the whole session. Existing manual marks remain preserved, but the total/percentage may change.

Before confirming:

- verify that the new point value is intentional
- tell the teaching team that percentages may change
- review conflicts after recalculation
- re-export any grade file created earlier

Avoid changing the meaning/correct answer of a question after students have responded. Some edits are restricted for this reason.

## Student visibility

Students see only their own grades and only activities released through the current reviewability/visibility rules. They may see:

- their submitted answer and attempt
- released correct answer and solution
- earned/possible points
- instructor feedback
- participation information

They do not see instructor-only grading conflicts or other students' identities/marks. A non-reviewable activity can be present in instructor grade data while absent from the student's course/grade view.

## Recalculation scenarios

### New completed session

End the session and recalculate if the grade rows are not already available. Resolve any short-answer/manual warnings before release.

### Correct answer or scoring rule changed

Recalculate, inspect conflict/warning summaries, sample several students, and communicate material grade changes.

### Late manual grade

Open the specific student/question, save the mark and feedback, and confirm the overall percentage. A full recalculation is not normally needed just to save a manual mark.

### Manual mark conflicts with automatic score

Keep the manual mark if it represents an intentional academic decision. Accept/restore automatic only after confirming the configured answer/scoring rule is correct.

### A zero-point question says it needs grading

Zero-point items should not require grading even if an older record contains a stale flag. Check the actual point value and current visual cue before doing unnecessary manual work.

## Export checklist

Before using **Export grades to CSV**:

- select the intended sessions/columns
- confirm manual grading is complete
- confirm reviewability/visibility separately (export does not publish)
- open the CSV and spot-check names, session headings, and percentages
- store the file according to institutional privacy policy

CSV is a transfer/report file, not a Qlicker database backup.

## Troubleshooting

### Grading controls are locked

The session is probably still running/visible rather than ended. End it first.

### A student has no grade

Anonymous sessions never have grades. Otherwise, confirm enrollment, participation/submission, session ended state, and whether grade recalculation completed. For a quiz, confirm final submission and availability rules.

### A grade changed after recalculation

Check the correct answer, point value, multi-select method, numerical tolerance, latest attempt, and low-participation rule. Manual overrides should be preserved and listed as conflicts rather than silently replaced.

### A student cannot see a grade

Confirm the activity is reviewable and its grade is visible to students. Manual grading can exist instructor-side before release.

The **Reviewable** control automatically synchronizes grade visibility; there is no separate grade-visibility control in the interface. If no sessions are reviewable, the student's course table has no grades to average and shows **Not applicable**, even when the instructor sees grades. Student averages use released grade items from reviewable sessions; instructor averages use grade items from the sessions selected for their table. Missing grade items are excluded and recorded zeros count.

### Duplicate or inconsistent legacy rows appear

Do not fix production data manually in MongoDB. Operators/developers should back up first and use the documented maintenance scripts and current server protections; see [developer grading notes](../developer/grading.md).
