# Qlicker User Manuals

These manuals are organized around real tasks rather than screen inventories. Begin with [Getting started](getting-started.md), then use the guide for your role.

| Role | Manual | Common tasks |
| --- | --- | --- |
| Student | [Student manual](student.md) | Join a course, participate live, take a quiz, review work, use course/session chat and AI study help, create practice sessions, and check grades |
| Professor or TA | [Professor manual](professor.md) | Build a course, manage people/groups, author content, teach live, control admission with join codes, run chat, configure and use AI, assess, grade, and reuse material |
| Administrator | [Admin manual](admin.md) | Configure the service, support accounts/courses, monitor use, and protect recoverability |
| Professor/student | [Grading guide](grading.md) | Understand score calculation, reviewability, manual overrides, feedback, and visibility |

## How to use the manuals

- Follow numbered procedures for a task you are doing now.
- Read **What students see** or **What instructors see** notes before changing visibility.
- Use scenario and troubleshooting sections when the normal procedure does not match what is on screen.
- Labels are written as they appear in the English interface. Other locales follow the same page structure.

For personal study, see [Create your own practice sessions](student.md#8-create-your-own-practice-sessions). For live-class check-in, see [Join codes and attendance](professor.md#use-a-join-code-to-control-attendance), [Manual admission](professor.md#manually-admit-a-student-or-handle-a-late-arrival), and [Leaving and rejoining](professor.md#leaving-and-rejoining-does-not-require-another-code).

## In-app manual

Signed-in users can select **User Manual** from the avatar menu. The in-app version is localized and restricts admin/professor material according to role. These Markdown guides are the deeper reference and include more scenarios and browser captures.

## Screenshot policy

Every image under `docs/assets/manuals/` is a Chromium capture of the current application populated with synthetic example data. No production accounts or courses are used.

Regenerate the set after a material UI change:

```bash
cd client
REDIS_URL= QCLICKER_CAPTURE_MANUALS=1 npx playwright test e2e/manual-screenshots.spec.js --project=chromium
```

The opt-in capture test also copies the same files to `client/public/manuals/` for the in-app manual. Review every generated image before committing it.

To refresh only selected images while exercising the same workflow, set `QCLICKER_MANUAL_IMAGES=professor-course.png,student-course.png` for the capture command. Omit it to regenerate all images.

The notification composers have a separate desktop/mobile regression test. Run `REDIS_URL= QCLICKER_CAPTURE_MANUALS=1 npx playwright test e2e/notifications.spec.js --project=chromium` from `client/` to refresh `admin-notifications.png` and `professor-notifications.png` in both image directories.
