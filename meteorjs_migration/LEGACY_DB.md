# Qlicker Legacy Database Reference

> **Purpose:** This document describes the legacy MongoDB database schema from the original MeteorJS Qlicker application. It is the authoritative reference for understanding legacy data shapes, compatibility requirements, and migration scripts. Referenced from [MIGRATION.md](MIGRATION.md).

---

## Table of Contents

1. [Database Overview](#database-overview)
2. [Collection Mapping](#collection-mapping)
3. [Legacy Schema Details](#legacy-schema-details)
4. [Legacy Indexes](#legacy-indexes)
5. [Compatibility Layer](#compatibility-layer)
6. [Migration Scripts](#migration-scripts)
7. [Known Legacy Data Issues](#known-legacy-data-issues)

---

## Database Overview

### Legacy Dump Snapshot (Observed 2026-03-02)

The production database (`qlickerdb`) contains the following collections:

| Collection | Document Count | Notes |
|-----------|---------------|-------|
| `users` | 20,901 | Meteor-style user documents |
| `courses` | 472 | Course records |
| `sessions` | 5,766 | Interactive sessions and quizzes |
| `questions` | 63,257 | Questions linked to sessions/courses |
| `responses` | 1,700,441 | Student responses |
| `grades` | 510,617 | Calculated grades |
| `images` | 6,803 | Uploaded image metadata |
| `settings` | 1 | App-wide configuration |
| `meteor_accounts_loginServiceConfiguration` | 0 | Empty; no equivalent model needed |

### Key Conventions

- **Collection IDs:** All use Meteor-style string `_id` fields (17-char random strings), **not** MongoDB ObjectIds. The new app preserves this via `generateMeteorId()`.
- **Dates:** Stored as JavaScript Date objects.
- **Namespaces:** Local dump includes `qlickerdb` (application data) and `admin` (Mongo system collections — `system.users`, `system.version`).

---

## Collection Mapping

| Legacy Collection | Fastify Model | Compatibility | Notes |
|------------------|---------------|---------------|-------|
| `users` | `User` | ✅ Compatible | Core fields align. Password storage: legacy uses `services.password.bcrypt`; new uses `services.password.hash` (argon2id). Legacy bcrypt triggers reset-required flow. |
| `courses` | `Course` | ✅ Compatible | Main fields align. Legacy `groupCategories.groups` uses `groupNumber/groupName/students` shape; normalized on read via `normalizeGroupCategories()`. |
| `sessions` | `Session` | ✅ Compatible | Core fields align (`status`, `quiz`, `questions`, `currentQuestion`, `joined`, `quizStart`, `quizEnd`, `reviewable`). New fields (`practiceQuiz`, `submittedQuiz`, `msScoringMethod`) are additive. `msScoringMethod` is auto-backfilled on first access. |
| `questions` | `Question` | ✅ Compatible | Legacy fields align. New schema fields (`toleranceNumerical`, `correctNumerical`, `solution*`, `imagePath`) are additive. Legacy question types normalized via migration script. |
| `responses` | `Response` | ✅ Compatible | Legacy fields `attempt`, `questionId`, `studentUserId`, `answer`, `createdAt`, `mark` all in model. New fields `correct`, `updatedAt`, `editable`, `answerWysiwyg` are optional with defaults. |
| `grades` | `Grade` | ✅ Compatible | Legacy marks and aggregate grade fields align. Newer fields (`feedback`, `feedbackUpdatedAt`, `feedbackSeenAt`) are additive with null defaults. |
| `images` | `Image` | ✅ Compatible | Legacy documents (`_id`, `url`, `UID`) load without errors. `key`, `type`, `size` are optional with defaults. |
| `settings` | `Settings` | ✅ Compatible | Schema uses both new and legacy field names with virtual getters. `strict: false` preserves extra legacy fields on save. |
| `meteor_accounts_loginServiceConfiguration` | None | N/A | Empty in snapshot. No equivalent model needed. |
| `activityShares`, `activityGrants` | `ActivityShare`, `ActivityGrant` | New additive collections | Session-scoped codes and signed-in grants; legacy course enrollment, session, and response documents need no migration. |

---

## Legacy Schema Details

### Users Collection

```javascript
{
  _id: String,                    // 17-char Meteor random ID
  emails: [{
    address: String,              // May be mixed-case in legacy data (8,081 affected users)
    verified: Boolean
  }],
  services: {
    password: {
      bcrypt: String,             // Legacy: $2a$/$2b$ prefix (1,725 users)
      hash: String                // New: argon2id hash
    },
    sso: {
      id: String,                 // SSO identifier (19,887 users)
      nameID: String,
      nameIDFormat: String,
      email: String,
      SSORole: String,
      studentNumber: String,
      sessions: [{ sessionIndex: String }]
    },
    email: {
      verificationTokens: [{ token: String, address: String, when: Date }]
    },
    resetPassword: {              // New path
      token: String,
      email: String,
      when: Date,
      reason: String
    },
    password: {
      reset: {                    // Legacy path (different from new)
        token: String,
        when: Date
      }
    },
    resume: {
      loginTokens: [{ hashedToken: String, token: String, when: Date }],
      haveLoginTokensToDelete: Boolean
    }
  },
  profile: {
    firstname: String,
    lastname: String,
    roles: [String],              // 'admin', 'professor', 'student'
    profileImage: String,
    profileThumbnail: String,
    studentNumber: String,
    courses: [String]             // Course IDs
  },
  lastLogin: Date,                // New field; optional for legacy users
  locale: String,                 // New field; defaults to '' (app default)
  createdAt: Date
}
```

**Key legacy user stats:**
- Total users with password hashes (`services.password.bcrypt`): 1,725
- Users with SSO identities (`services.sso.id`): 19,887
- Users with mixed-case stored emails: 8,081
- Users with password hashes + mixed-case emails: 188 (51 password-only without SSO fallback)

### Courses Collection

```javascript
{
  _id: String,
  name: String,
  deptCode: String,
  courseNumber: String,
  section: String,
  semester: String,               // e.g., "Fall 2025/2026"
  owner: String,                  // User ID
  enrollmentCode: String,
  inactive: Boolean,
  instructors: [String],          // User IDs
  students: [String],             // User IDs
  requireVerified: Boolean,
  allowStudentQuestions: Boolean,
  groupCategories: [{             // Legacy shape
    categoryNumber: Number,
    categoryName: String,
    groups: [{
      groupNumber: Number,        // Legacy field (→ name)
      groupName: String,          // Legacy field (→ name)
      students: [String]          // Legacy field (→ members)
    }]
  }],
  videoChatOptions: { ... },      // New: Jitsi course-wide video config
  createdAt: Date
}
```

### Sessions Collection

```javascript
{
  _id: String,
  name: String,
  description: String,
  courseId: String,
  status: String,                 // 'hidden', 'visible', 'running', 'done'
  quiz: Boolean,
  practiceQuiz: Boolean,          // New
  anonymous: Boolean,             // New: absent means false; see note below
  participationStarted: Boolean,  // New: monotonic guard against changing identity mode after participation
  quizStart: Date,
  quizEnd: Date,
  questions: [String],            // Ordered question IDs (slides are question docs with type=6)
  currentQuestion: String,        // Current question ID
  joined: [String],               // Legacy: simple user ID array
  joinRecords: [{                 // New: structured join records
    odUserId: String,
    joinedAt: Date,
    joinedWithCode: Boolean
  }],
  submittedQuiz: [String],        // New: student IDs who submitted
  reviewable: Boolean,
  date: Date,
  msScoringMethod: String,        // New: 'right-minus-wrong'|'all-or-nothing'|'correctness-ratio'
  joinCodeEnabled: Boolean,       // New
  joinCodeActive: Boolean,        // New
  currentJoinCode: String,        // New
  createdAt: Date
}
```

`anonymous`, `participationStarted`, `activityAccessEnabled`, and `activityEverShared` are additive and need no migration: legacy sessions are read as non-anonymous, and existing participation arrays and responses still block an anonymity change. Named shared activities grade only enrolled students; outside participant responses do not create grade rows. For anonymous sessions, `joined`, `submittedQuiz`, and `Response.studentUserId` hold per-session `anon_…` pseudonyms instead of user IDs, `joinRecords` stays empty, and no grade rows exist. See [anonymous sessions](../docs/developer/data-model.md#anonymous-sessions).

### Questions Collection

```javascript
{
  _id: String,
  type: Number,                   // Canonical: MC=0, TF=1, SA=2, MS=3, NU=4, Slide=6
                                  // Legacy may have type=5 (→ 4) or string types
  content: String,                // HTML content
  plainText: String,              // New: plain text version
  options: [{
    content: String,
    answer: Boolean,              // Is correct option
    wysiwyg: Boolean
  }],
  sessionId: String,              // null for library questions
  courseId: String,
  owner: String,                  // User ID
  public: Boolean,
  tags: [String],
  sessionOptions: {
    points: Number,
    maxAttempts: Number,
    attemptWeights: [Number],
    hidden: Boolean,
    stats: Boolean,
    correct: Boolean,
    attempts: [{ ... }]
  },
  solution: String,               // New
  solutionHtml: String,           // Legacy
  solutionText: String,           // Legacy
  toleranceNumerical: Number,     // New
  correctNumerical: Number,       // New
  imagePath: String,              // New
  createdAt: Date
}
```

### Responses Collection

```javascript
{
  _id: String,
  questionId: String,
  studentUserId: String,          // User ID, or anon_ pseudonym in anonymous sessions
  attempt: Number,
  answer: Mixed,                  // String, Number, or Object depending on question type
  answerWysiwyg: String,          // New: HTML version for SA
  mark: Number,                   // 0-1 score
  correct: Boolean,               // New
  editable: Boolean,              // New
  createdAt: Date,
  updatedAt: Date                 // New
}
```

### Grades Collection

```javascript
{
  _id: String,
  sessionId: String,
  courseId: String,
  odUserId: String,
  value: Number,                  // Percentage (0-100)
  points: Number,
  outOf: Number,
  participation: Number,
  numAnswered: Number,
  numQuestions: Number,
  automatic: Boolean,
  visibleToStudents: Boolean,
  marks: [{
    questionId: String,
    odUserId: String,
    points: Number,
    outOf: Number,
    responseId: String,
    automatic: Boolean,
    feedback: String,             // New
    feedbackUpdatedAt: Date       // New (default null)
  }],
  feedbackSeenAt: Date,           // New (default null)
  createdAt: Date
}
```

---

## Legacy Indexes

| Collection | Index Fields | Type | Notes |
|-----------|-------------|------|-------|
| `users` | `username` | unique, sparse | |
| `users` | `emails.address` | unique, sparse | |
| `users` | `services.resume.loginTokens.hashedToken` | sparse | |
| `users` | `services.resume.loginTokens.token` | sparse | |
| `users` | `services.email.verificationTokens.token` | sparse | |
| `users` | `services.password.reset.token` | sparse | |
| `users` | `services.resume.haveLoginTokensToDelete` | sparse | |
| `users` | `services.resume.loginTokens.when` | sparse | |
| `users` | `services.password.reset.when` | sparse | |
| `questions` | `sessionId` | | |
| `questions` | `courseId` | | |
| `questions` | `owner` | | |
| `responses` | `questionId` | | |
| `responses` | `studentUserId` | | |
| `sessions` | `courseId` | | |
| `grades` | `userId` | | |
| `grades` | `courseId` | | |
| `grades` | `sessionId` | | |
| `images` | `UID` | | |
| `meteor_accounts_loginServiceConfiguration` | `service` | unique | |

**Current model indexes:** Added to User (`emails.address`), Question (`sessionId`, `courseId`, `owner`), Session (`courseId`), Grade (`userId`, `sessionId`, `courseId`, compound `userId+sessionId`), Image (`UID`), and Response (compound indexes on `questionId+studentUserId+attempt` and `questionId+attempt`).

---

## Compatibility Layer

### Defensive Patterns

All code accessing legacy data must use these patterns:

| Pattern | Reason | Example |
|---------|--------|---------|
| `|| []` array fallback | Legacy `.lean()` docs may lack array fields | `(session.joined \|\| [])` |
| `emailRegex()` lookup | 8,081 users have mixed-case emails | `User.findOne({ 'emails.address': emailRegex(email) })` |
| `normalizeGroupCategories()` | Legacy groups use `groupNumber/groupName/students` | Groups API normalizes on read |
| `ensureSessionMsScoringMethod()` | Legacy sessions lack `msScoringMethod` | Auto-backfills default on access |
| `isLegacyBcryptHash()` | Detect `$2a$/$2b$` hashes | Login triggers `PASSWORD_RESET_REQUIRED` |
| `strict: false` on Settings | Preserve extra legacy fields on save | Settings schema option |
| Virtual getters on Settings | Resolve new/legacy field names | `resolvedAdminEmail`, `resolvedAWSAccessKeyId`, etc. |

### Field Name Mappings

| Legacy Field | New Field | Resolution |
|-------------|-----------|------------|
| `settings.email` | `settings.adminEmail` | Virtual getter `resolvedAdminEmail` |
| `settings.AWS_accessKey` | `settings.AWS_accessKeyId` | Virtual getter + upload plugin fallback |
| `settings.AWS_secret` | `settings.AWS_secretAccessKey` | Virtual getter + upload plugin fallback |
| `settings.Azure_accountName` | `settings.Azure_storageAccount` | Virtual getter + upload plugin fallback |
| `settings.Azure_accountKey` | `settings.Azure_storageAccessKey` | Virtual getter + upload plugin fallback |
| `settings.Azure_containerName` | `settings.Azure_storageContainer` | Virtual getter + upload plugin fallback |
| `course.groupCategories.groups[].groupNumber` | `.name` | `normalizeGroupCategories()` |
| `course.groupCategories.groups[].groupName` | `.name` | `normalizeGroupCategories()` |
| `course.groupCategories.groups[].students` | `.members` | `normalizeGroupCategories()` |
| `user.services.password.bcrypt` | `user.services.password.hash` | Bcrypt triggers password reset |

---

## Migration Scripts

### Question Type Cleanup (One-Time)

Normalizes invalid question `type` values into canonical Meteor mapping:
- Canonical: `MC=0`, `TF=1`, `SA=2`, `MS=3`, `NU=4`
- Legacy `type=5` → `4` (Numerical)
- Malformed numerical outliers (`type=4` with multiple options) → option-based canonical type

```bash
cd server
node scripts/migrate-question-types.js          # Dry-run (report only)
node scripts/migrate-question-types.js --apply   # Write updates
```

**Verification:**
```bash
mongosh "mongodb://localhost:27071/qlicker" --quiet --eval \
'db.questions.aggregate([{ $group:{ _id:"$type", count:{ $sum:1 } } }, { $sort:{ _id:1 } }]).forEach(printjson)'
```

After applying in all environments, remove temporary client normalization fallbacks in `client/src/components/questions/constants.js`.

### Password Change Utility

```bash
cd scripts
node changeuserpwd.js <email> <new-password>
# or
./changeuserpwd.sh <email> <new-password>
```

### Database Seed/Reset

```bash
cd scripts
./seed-db.sh                 # Seed with 3 example users
./seed-db.sh --reset         # Reset to empty database
./seed-db-docker.sh          # Docker: seed
./seed-db-docker.sh --reset  # Docker: reset to empty
```

---

## Known Legacy Data Issues

| Issue | Impact | Resolution |
|-------|--------|------------|
| Mixed-case emails (8,081 users) | Login failures with exact-match lookup | `emailRegex()` case-insensitive lookup |
| Legacy bcrypt hashes (1,725 users) | Cannot verify with argon2id | `PASSWORD_RESET_REQUIRED` flow |
| SSO-only users without passwords | No local auth | `PASSWORD_RESET_REQUIRED` with reason `no_local_password` |
| Group shape mismatch | `groupNumber/groupName/students` vs `name/members` | `normalizeGroupCategories()` on read; persisted in new shape on write |
| Missing `msScoringMethod` | Grading uses wrong defaults | `ensureSessionMsScoringMethod()` auto-backfills |
| Missing array fields in `.lean()` | Undefined instead of `[]` | `|| []` fallbacks throughout |
| Legacy question types (`type=5`, string types) | Rendering errors | Migration script + runtime normalization |
| `meteor_accounts_loginServiceConfiguration` | Empty collection, no model | Ignored — not needed |
| Legacy `services.password.reset.*` path | Differs from new `services.resetPassword` path | Not migrated; issue a fresh reset token after cutover if needed |

### Shared question references

Some sessions created through older copy/order workflows may contain duplicate question IDs or references to questions owned by a library or another session. Use the [question reference repair guide](../docs/developer/question-reference-repair.md) to diagnose all sessions by course/session name through the production Bash/Docker launcher. The interactive repair can copy unused questions or remove duplicate positions with an explicit decision to keep or recalculate grades. Existing responses cannot be split by question position or session automatically: their persisted key is `questionId`, not session plus position. The utility preserves legacy fields and string IDs, leaves response rows untouched, and preserves manual grading overrides.

Course documents without `allowSharedActivities` remain in the default-off state for activity-code access; no migration is needed.
