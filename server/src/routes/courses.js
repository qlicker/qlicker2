import ActivityShare from '../models/ActivityShare.js';
import Course from '../models/Course.js';
import Session from '../models/Session.js';
import User from '../models/User.js';
import { createMissingEnrollmentGrades } from '../services/grading.js';
import { normalizeTags } from '../services/questionImportExport.js';
import { emailRegex } from '../utils/email.js';
import { escapeForRegex } from '../utils/regex.js';
import { getUserAccessFlags, invalidateAccessCache } from '../utils/userAccess.js';
import { getOrCreateSettingsDocument } from '../utils/settingsSingleton.js';
import { isCourseInstructorOrAdmin } from '../utils/courseAccess.js';

function generateEnrollmentCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function generateUniqueEnrollmentCode() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateEnrollmentCode();
    const existing = await Course.findOne({ enrollmentCode: code }).lean();
    if (!existing) return code;
  }
  const err = new Error('Failed to generate a unique enrollment code');
  err.statusCode = 500;
  throw err;
}

function buildUserEmailLookup(identifier = '') {
  const normalizedIdentifier = String(identifier || '').trim().toLowerCase();
  if (!normalizedIdentifier) return null;
  const emailMatch = emailRegex(normalizedIdentifier);
  return {
    $or: [
      { 'emails.address': emailMatch },
      { 'services.sso.email': emailMatch },
    ],
  };
}

function isProfessorOrAdminUser(user = {}) {
  const roles = user.roles || [];
  return roles.includes('professor') || roles.includes('admin');
}

const createCourseSchema = {
  body: {
    type: 'object',
    required: ['name', 'deptCode', 'courseNumber', 'section', 'semester'],
    properties: {
      name: { type: 'string', minLength: 1 },
      deptCode: { type: 'string', minLength: 1 },
      courseNumber: { type: 'string', minLength: 1 },
      section: { type: 'string', minLength: 1 },
      semester: { type: 'string', minLength: 1 },
      inactive: { type: 'boolean' },
      requireVerified: { type: 'boolean' },
      allowStudentQuestions: { type: 'boolean' },
      allowSharedActivities: { type: 'boolean' },
      quizTimeFormat: { type: 'string', enum: ['inherit', '24h', '12h'] },
      courseChatEnabled: { type: 'boolean' },
      courseChatRetentionDays: { type: 'integer', minimum: 1, maximum: 365 },
      tags: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            value: { type: 'string' },
            label: { type: 'string' },
            className: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
  },
};

const updateCourseSchema = {
  body: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1 },
      deptCode: { type: 'string', minLength: 1 },
      courseNumber: { type: 'string', minLength: 1 },
      section: { type: 'string', minLength: 1 },
      semester: { type: 'string', minLength: 1 },
      inactive: { type: 'boolean' },
      requireVerified: { type: 'boolean' },
      allowStudentQuestions: { type: 'boolean' },
      allowSharedActivities: { type: 'boolean' },
      quizTimeFormat: { type: 'string', enum: ['inherit', '24h', '12h'] },
      courseChatEnabled: { type: 'boolean' },
      courseChatRetentionDays: { type: 'integer', minimum: 1, maximum: 365 },
      aiEnabled: { type: 'boolean' },
      aiApiUrl: { type: 'string', maxLength: 2048 },
      aiApiToken: { type: 'string', maxLength: 4096 },
      tags: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            value: { type: 'string' },
            label: { type: 'string' },
            className: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
};

const listCoursesSchema = {
  querystring: {
    type: 'object',
    properties: {
      search: { type: 'string' },
      page: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      view: { type: 'string', enum: ['student', 'instructor', 'all'] },
    },
    additionalProperties: false,
  },
};

export default async function courseRoutes(app) {
  const { authenticate, requireRole } = app;
  const courseWriteRateLimitPreHandler = app.rateLimit({
    max: 30,
    timeWindow: '1 minute',
  });

  // POST / - Create a course (professor or admin only)
  app.post(
    '/',
    {
      preHandler: requireRole(['professor', 'admin']),
      schema: createCourseSchema,
    },
    async (request, reply) => {
      const {
        name,
        deptCode,
        courseNumber,
        section,
        semester,
        inactive,
        requireVerified,
        allowStudentQuestions,
        allowSharedActivities,
        quizTimeFormat,
        courseChatEnabled,
        courseChatRetentionDays,
        tags,
      } = request.body;
      const userId = request.user.userId;
      const roles = request.user.roles || [];
      const addCreatorAsInstructor = roles.includes('professor') || !roles.includes('admin');

      const enrollmentCode = await generateUniqueEnrollmentCode();

      const course = await Course.create({
        name,
        deptCode,
        courseNumber,
        section,
        semester,
        inactive: inactive === undefined ? undefined : !!inactive,
        requireVerified: requireVerified === undefined ? undefined : !!requireVerified,
        allowStudentQuestions: allowStudentQuestions === undefined ? undefined : !!allowStudentQuestions,
        allowSharedActivities: allowSharedActivities === undefined ? undefined : !!allowSharedActivities,
        quizTimeFormat: quizTimeFormat === undefined ? undefined : quizTimeFormat,
        courseChatEnabled: courseChatEnabled === undefined ? undefined : !!courseChatEnabled,
        courseChatRetentionDays: courseChatRetentionDays === undefined ? undefined : courseChatRetentionDays,
        tags: tags === undefined ? undefined : normalizeTags(tags),
        owner: userId,
        enrollmentCode,
        instructors: addCreatorAsInstructor ? [userId] : [],
      });

      if (addCreatorAsInstructor) {
        await User.findByIdAndUpdate(userId, {
          $addToSet: { 'profile.courses': course._id },
        });
      }

      return reply.code(201).send({ course });
    }
  );

  // GET / - List courses for current user
  app.get(
    '/',
    { preHandler: authenticate, schema: listCoursesSchema },
    async (request, reply) => {
      const { search, page: pageParam, limit: limitParam, view } = request.query;
      const page = Math.max(1, parseInt(pageParam, 10) || 1);
      const limit = Math.min(500, Math.max(1, parseInt(limitParam, 10) || 20));

      const roles = request.user.roles || [];
      const userId = request.user.userId;
      const isAdmin = roles.includes('admin');
      const resolvedView = view || (isAdmin ? 'all' : (roles.includes('professor') ? 'instructor' : 'student'));

      const filter = {};
      if (resolvedView === 'all') {
        if (!isAdmin) {
          return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
        }
      } else if (resolvedView === 'instructor') {
        if (!isAdmin && !roles.includes('professor')) {
          const { hasInstructorCourses } = await getUserAccessFlags({
            _id: userId,
            profile: { roles },
          }, { forceInstructorLookup: true });
          if (!hasInstructorCourses) {
            return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
          }
        }
        if (isAdmin) {
          filter.$or = [
            { instructors: userId },
            { owner: userId },
          ];
        } else {
          filter.instructors = userId;
        }
      } else {
        filter.students = userId;
        filter.inactive = { $ne: true };
      }

      if (search) {
        const regex = new RegExp(escapeForRegex(search), 'i');
        const searchFilter = [
          { name: regex },
          { deptCode: regex },
          { courseNumber: regex },
          { section: regex },
          { semester: regex },
        ];
        if (filter.$or) {
          filter.$and = [
            { $or: filter.$or },
            { $or: searchFilter },
          ];
          delete filter.$or;
        } else {
          filter.$or = searchFilter;
        }
      }

      // Course cards do not use backend/model configuration. Keeping it out of
      // every list response reduces payload size and prevents students from
      // learning internal AI service details.
      const projection = {
        students: 0,
        groupCategories: 0,
        aiApiToken: 0,
        aiApiUrl: 0,
        aiBackends: 0,
        aiDefaultBackendId: 0,
        aiDefaultModelId: 0,
        aiSelectedBackendId: 0,
        aiSelectedModelId: 0,
        aiModelPolicies: 0,
        aiInstructorChatMaxToolRounds: 0,
        aiStudentChatGuidance: 0,
        aiStudentDefaultBackendId: 0,
        aiStudentDefaultModelId: 0,
        aiStudentChatMaxToolRounds: 0,
      };

      const [courses, total] = await Promise.all([
        Course.find(filter, projection)
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        Course.countDocuments(filter),
      ]);

      const courseIds = courses.map((course) => String(course._id)).filter(Boolean);
      const sessionActivity = courseIds.length > 0
        ? await Session.aggregate([
          { $match: { courseId: { $in: courseIds } } },
          {
            $group: {
              _id: '$courseId',
              lastSessionAt: { $max: '$createdAt' },
            },
          },
        ])
        : [];
      const activityByCourseId = new Map(
        sessionActivity.map((entry) => [String(entry._id), entry.lastSessionAt])
      );
      const coursesWithActivity = courses.map((course) => {
        const lastSessionAt = activityByCourseId.get(String(course._id));
        const courseCreatedAt = course.createdAt || null;
        const lastActivityAt = [lastSessionAt, courseCreatedAt]
          .filter(Boolean)
          .map((value) => new Date(value))
          .sort((a, b) => b.getTime() - a.getTime())[0] || null;
        return {
          ...course,
          lastActivityAt: lastActivityAt ? lastActivityAt.toISOString() : null,
        };
      });

      return {
        courses: coursesWithActivity,
        total,
        page,
        pages: Math.ceil(total / limit),
      };
    }
  );

  // GET /:id - Get a single course by ID
  app.get(
    '/:id',
    { preHandler: authenticate },
    async (request, reply) => {
      const roles = request.user.roles || [];
      const userId = request.user.userId;
      const isAdmin = roles.includes('admin');

      const course = await Course.findById(request.params.id).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      const isInstructor = isCourseInstructorOrAdmin(course, request.user);
      const isStudent = (course.students || []).includes(userId);

      if (!isAdmin && !isInstructor && !isStudent) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Not enrolled in this course' });
      }
      if (!isAdmin && isStudent && !isInstructor && course.inactive) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Course is inactive for students' });
      }

      const obj = { ...course };
      const aiApiTokenSet = String(obj.aiApiToken || '').trim().length > 0;
      delete obj.aiApiToken;
      if (isAdmin || isInstructor) obj.aiApiTokenSet = aiApiTokenSet;
      if (Array.isArray(obj.aiBackends)) {
        obj.aiBackends = obj.aiBackends.map((backend) => {
          const apiTokenSet = String(backend?.apiToken || '').trim().length > 0;
          const safeBackend = { ...backend };
          delete safeBackend.apiToken;
          return { ...safeBackend, apiTokenSet };
        });
      }

      // Populate instructor data for any authenticated viewer
      if (obj.instructors && obj.instructors.length > 0) {
        const instructorUsers = await User.find({ _id: { $in: obj.instructors } })
          .select('_id profile emails').lean();
        obj.instructors = instructorUsers.map(u => ({ _id: u._id, profile: u.profile, emails: u.emails }));
      }

      // Students only see course info, not other students' details
      if (!isAdmin && !isInstructor) {
        delete obj.students;
        delete obj.aiApiUrl;
        delete obj.aiBackends;
        delete obj.aiDefaultBackendId;
        delete obj.aiDefaultModelId;
        delete obj.aiSelectedBackendId;
        delete obj.aiSelectedModelId;
        delete obj.aiModelPolicies;
        delete obj.aiInstructorChatMaxToolRounds;
        delete obj.aiStudentChatGuidance;
        delete obj.aiStudentDefaultBackendId;
        delete obj.aiStudentDefaultModelId;
        delete obj.aiStudentChatMaxToolRounds;
        // For students: provide limited video-relevant group data
        if (obj.groupCategories) {
          obj.groupCategories = obj.groupCategories.map((cat) => ({
            categoryNumber: cat.categoryNumber,
            categoryName: cat.categoryName,
            catVideoChatOptions: cat.catVideoChatOptions ? {
              urlId: cat.catVideoChatOptions.urlId,
              apiOptions: cat.catVideoChatOptions.apiOptions,
            } : undefined,
            groups: (cat.groups || []).map((g, idx) => ({
              name: g.name,
              members: (g.members || []).includes(userId) ? [userId] : [],
              joinedVideoChat: g.joinedVideoChat || [],
              helpVideoChat: g.helpVideoChat || false,
            })),
          }));
        }
        obj.currentUserId = userId;
      } else if (obj.students && obj.students.length > 0) {
        // Populate student data for instructors and admins
        const studentUsers = await User.find({ _id: { $in: obj.students } })
          .select('_id profile emails').lean();
        obj.students = studentUsers.map(u => ({ _id: u._id, profile: u.profile, emails: u.emails }));
      }

      return { course: obj };
    }
  );

  // PATCH /:id - Update a course (instructor/admin only)
  app.patch(
    '/:id',
    {
      preHandler: authenticate,
      schema: updateCourseSchema,
    },
    async (request, reply) => {
      const roles = request.user.roles || [];
      const userId = request.user.userId;
      const isAdmin = roles.includes('admin');

      const course = await Course.findById(request.params.id).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      if (!isCourseInstructorOrAdmin(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      const allowed = ['name', 'deptCode', 'courseNumber', 'section', 'semester', 'inactive', 'requireVerified', 'allowStudentQuestions', 'allowSharedActivities', 'quizTimeFormat', 'courseChatEnabled', 'courseChatRetentionDays', 'tags'];
      const updates = {};
      for (const key of allowed) {
        if (request.body[key] !== undefined) {
          updates[key] = request.body[key];
        }
      }

      if (updates.tags !== undefined) {
        updates.tags = normalizeTags(updates.tags);
      }

      const aiFieldsRequested = ['aiEnabled', 'aiApiUrl', 'aiApiToken'].some((key) => request.body[key] !== undefined);
      if (aiFieldsRequested) {
        const settings = await getOrCreateSettingsDocument({ lean: true });
        const courseAllowed = !!settings?.AI_Enabled
          && (settings?.AI_EnabledCourses || []).map(String).includes(String(course._id));
        if (!courseAllowed) {
          return reply.code(403).send({ error: 'Forbidden', message: 'AI helper is not enabled for this course by the administrator' });
        }
        const allowCourseBackend = (settings?.AI_AllowCourseBackendCourses || []).map(String).includes(String(course._id));
        if (request.body.aiEnabled !== undefined) updates.aiEnabled = !!request.body.aiEnabled;
        if (request.body.aiApiUrl !== undefined || request.body.aiApiToken !== undefined) {
          if (!allowCourseBackend) {
            return reply.code(403).send({ error: 'Forbidden', message: 'This course must use the AI backend configured by the administrator' });
          }
          if (request.body.aiApiUrl !== undefined) updates.aiApiUrl = String(request.body.aiApiUrl || '').trim();
          // Blank tokens preserve an existing token, matching admin settings semantics.
          if (String(request.body.aiApiToken || '').trim()) updates.aiApiToken = request.body.aiApiToken;
        }
      }

      const updated = await Course.findByIdAndUpdate(
        request.params.id,
        { $set: updates },
        { returnDocument: 'after' }
      );

      if (updates.allowSharedActivities === false) {
        // Turning off sharing revokes every outside grant, including when the
        // setting is later re-enabled. Existing course members keep access.
        const sharedSessionIds = await Session.find({ courseId: String(course._id), activityAccessEnabled: true })
          .distinct('_id');
        if (sharedSessionIds.length > 0) {
          await ActivityShare.updateMany(
            { sessionId: { $in: sharedSessionIds } },
            { $set: { enabled: false, updatedAt: new Date() }, $inc: { accessEpoch: 1 } }
          );
          await Session.updateMany(
            { _id: { $in: sharedSessionIds } },
            { $set: { activityAccessEnabled: false } }
          );
        }
      }

      const result = updated.toObject();
      result.aiApiTokenSet = String(result.aiApiToken || '').trim().length > 0;
      delete result.aiApiToken;
      if (Array.isArray(result.aiBackends)) {
        result.aiBackends = result.aiBackends.map((backend) => {
          const safeBackend = { ...backend };
          const apiTokenSet = String(safeBackend.apiToken || '').trim().length > 0;
          delete safeBackend.apiToken;
          return { ...safeBackend, apiTokenSet };
        });
      }
      return { course: result };
    }
  );

  // DELETE /:id - Delete a course (owner or admin only)
  app.delete(
    '/:id',
    { preHandler: authenticate },
    async (request, reply) => {
      const roles = request.user.roles || [];
      const userId = request.user.userId;
      const isAdmin = roles.includes('admin');

      const course = await Course.findById(request.params.id).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      if (!isAdmin && course.owner !== userId) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Only the course owner or an admin can delete this course' });
      }

      // Remove course from all users' profile.courses
      await User.updateMany(
        { 'profile.courses': course._id },
        { $pull: { 'profile.courses': course._id } }
      );

      await Course.findByIdAndDelete(request.params.id);

      return { success: true };
    }
  );

  // POST /enroll - Enroll by enrollment code
  app.post(
    '/enroll',
    {
      preHandler: authenticate,
      rateLimit: { max: 30, timeWindow: '1 minute' },
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
      schema: {
        body: {
          type: 'object',
          required: ['enrollmentCode'],
          properties: {
            enrollmentCode: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { enrollmentCode } = request.body;
      const userId = request.user.userId;
      const roles = request.user.roles || [];

      const course = await Course.findOne({ enrollmentCode }).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Invalid enrollment code' });
      }
      if (course.inactive) {
        return reply.code(403).send({
          error: 'Forbidden',
          code: 'COURSE_INACTIVE',
          message: 'Course is inactive for students',
        });
      }

      if (course.requireVerified) {
        const settings = await getOrCreateSettingsDocument({
          select: 'SSO_enabled',
          lean: true,
        });
        if (!settings?.SSO_enabled) {
          const enrollingUser = await User.findById(userId).lean();
          if (!enrollingUser?.emails?.[0]?.verified) {
            return reply.code(403).send({ error: 'Forbidden', message: 'Email verification required to enroll in this course' });
          }
        }
      }

      if ((course.instructors || []).includes(userId)) {
        return reply.code(409).send({ error: 'Conflict', message: 'Already enrolled as an instructor in this course' });
      }

      if ((course.students || []).includes(userId)) {
        await createMissingEnrollmentGrades({ courseId: course._id, userId });
        return reply.code(409).send({ error: 'Conflict', message: 'Already enrolled in this course' });
      }

      await Course.findByIdAndUpdate(course._id, {
        $addToSet: { students: userId },
      });

      await User.findByIdAndUpdate(userId, {
        $addToSet: { 'profile.courses': course._id },
      });

      invalidateAccessCache(userId);
      await createMissingEnrollmentGrades({ courseId: course._id, userId });

      return { course };
    }
  );

  // DELETE /:id/students/:studentId - Remove student from course (instructor/admin or self-unenroll)
  app.delete(
    '/:id/students/:studentId',
    { preHandler: authenticate },
    async (request, reply) => {
      const roles = request.user.roles || [];
      const userId = request.user.userId;
      const isAdmin = roles.includes('admin');
      const { studentId } = request.params;

      const course = await Course.findById(request.params.id).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      // Allow: admin, instructor, or the student removing themselves
      const isSelfUnenroll = studentId === userId && (course.students || []).includes(userId);
      if (!isCourseInstructorOrAdmin(course, request.user) && !isSelfUnenroll) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      await Course.findByIdAndUpdate(course._id, {
        $pull: { students: studentId },
      });

      await User.findByIdAndUpdate(studentId, {
        $pull: { 'profile.courses': course._id },
      });

      invalidateAccessCache(studentId);

      return { success: true };
    }
  );

  // POST /:id/students - Add student to course by email (instructor/admin)
  app.post(
    '/:id/students',
    {
      preHandler: authenticate,
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', format: 'email' },
          },
        },
      },
    },
    async (request, reply) => {
      const roles = request.user.roles || [];
      const userId = request.user.userId;
      const isAdmin = roles.includes('admin');

      const course = await Course.findById(request.params.id).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      if (!isCourseInstructorOrAdmin(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      const { email } = request.body;
      const student = await User.findOne(buildUserEmailLookup(email));
      if (!student) {
        return reply.code(404).send({ error: 'Not Found', message: 'User not found with that email' });
      }

      const studentRoles = student.profile?.roles || [];
      if (studentRoles.includes('admin')) {
        return reply.code(403).send({ error: 'Forbidden', message: "Admins cannot be added as students" });
      }

      const studentId = String(student._id);
      if ((course.instructors || []).includes(studentId)) {
        return reply.code(409).send({ error: 'Conflict', message: 'Instructor already assigned to this course' });
      }

      if ((course.students || []).includes(studentId)) {
        await createMissingEnrollmentGrades({ courseId: course._id, userId: studentId });
        return reply.code(409).send({ error: 'Conflict', message: 'Student already enrolled' });
      }

      await Course.findByIdAndUpdate(course._id, {
        $addToSet: { students: student._id },
      });

      await User.findByIdAndUpdate(student._id, {
        $addToSet: { 'profile.courses': course._id },
      });

      invalidateAccessCache(studentId);
      await createMissingEnrollmentGrades({ courseId: course._id, userId: studentId });

      return { success: true };
    }
  );

  // POST /:id/instructors - Add instructor/TA (owner/admin only)
  app.post(
    '/:id/instructors',
    {
      preHandler: [authenticate, courseWriteRateLimitPreHandler],
      schema: {
        body: {
          type: 'object',
          required: ['userId'],
          properties: {
            userId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const roles = request.user.roles || [];
      const callerUserId = request.user.userId;
      const isAdmin = roles.includes('admin');

      const course = await Course.findById(request.params.id).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      if (!isAdmin && course.owner !== callerUserId) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Only the course owner or an admin can add instructors' });
      }

      const instructorIdentifier = String(request.body.userId || '').trim();
      const instructor = await User.findOne({
        $or: [
          { _id: instructorIdentifier },
          ...(buildUserEmailLookup(instructorIdentifier)?.$or || []),
        ],
      }).lean();
      if (!instructor) {
        return reply.code(404).send({ error: 'Not Found', message: 'User not found' });
      }

      const newInstructorId = String(instructor._id);

      if ((course.students || []).includes(newInstructorId)) {
        return reply.code(409).send({ error: 'Conflict', message: 'Student already enrolled in this course' });
      }

      await Course.findByIdAndUpdate(course._id, {
        $addToSet: { instructors: newInstructorId },
      });

      invalidateAccessCache(newInstructorId);

      await User.findByIdAndUpdate(newInstructorId, {
        $addToSet: { 'profile.courses': course._id },
      });

      return { success: true };
    }
  );

  // DELETE /:id/instructors/:instructorId - Remove instructor (owner/admin only)
  app.delete(
    '/:id/instructors/:instructorId',
    { preHandler: authenticate },
    async (request, reply) => {
      const roles = request.user.roles || [];
      const callerUserId = request.user.userId;
      const isAdmin = roles.includes('admin');

      const course = await Course.findById(request.params.id).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      if (!isAdmin && course.owner !== callerUserId) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Only the course owner or an admin can remove instructors' });
      }

      const { instructorId } = request.params;

      if ((course.instructors || []).length <= 1 && (course.instructors || []).includes(instructorId)) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Cannot remove the last instructor from a course' });
      }

      await Course.findByIdAndUpdate(course._id, {
        $pull: { instructors: instructorId },
      });

      invalidateAccessCache(instructorId);

      await User.findByIdAndUpdate(instructorId, {
        $pull: { 'profile.courses': course._id },
      });

      return { success: true };
    }
  );

  // POST /:id/regenerate-code - Regenerate enrollment code (instructor/admin)
  app.post(
    '/:id/regenerate-code',
    { preHandler: authenticate },
    async (request, reply) => {
      const roles = request.user.roles || [];
      const userId = request.user.userId;
      const isAdmin = roles.includes('admin');

      const course = await Course.findById(request.params.id).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      if (!isCourseInstructorOrAdmin(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      const enrollmentCode = await generateUniqueEnrollmentCode();
      const updated = await Course.findByIdAndUpdate(
        course._id,
        { $set: { enrollmentCode } },
        { returnDocument: 'after' }
      );

      return { enrollmentCode: updated.enrollmentCode };
    }
  );

  // PATCH /:id/active - Toggle active/inactive (instructor/admin)
  app.patch(
    '/:id/active',
    {
      preHandler: authenticate,
      schema: {
        body: {
          type: 'object',
          required: ['inactive'],
          properties: {
            inactive: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const roles = request.user.roles || [];
      const userId = request.user.userId;
      const isAdmin = roles.includes('admin');

      const course = await Course.findById(request.params.id).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      if (!isCourseInstructorOrAdmin(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      const updated = await Course.findByIdAndUpdate(
        course._id,
        { $set: { inactive: request.body.inactive } },
        { returnDocument: 'after' }
      );

      return { course: updated.toObject() };
    }
  );
}
