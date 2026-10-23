import Course from '../models/Course.js';
import Notification from '../models/Notification.js';
import NotificationDismissal from '../models/NotificationDismissal.js';
import User from '../models/User.js';

function hasAdminRole(roles = []) {
  return roles.includes('admin');
}

function normalizeCourseIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((courseId) => String(courseId || '')).filter(Boolean))];
}

function getNotificationUserRoles(user = {}) {
  if (Array.isArray(user.roles)) return user.roles;
  if (Array.isArray(user.profile?.roles)) return user.profile.roles;
  return [];
}

function normalizeRecipientType(value = 'all') {
  const recipientType = String(value || 'all').trim() || 'all';
  if (!['all', 'students', 'instructors'].includes(recipientType)) {
    const err = new Error('Notification recipient type is invalid');
    err.statusCode = 400;
    throw err;
  }
  return recipientType;
}

function parseIsoDate(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function buildNotificationDates(startAt, endAt) {
  const parsedStartAt = parseIsoDate(startAt);
  const parsedEndAt = parseIsoDate(endAt);

  if (!parsedStartAt || !parsedEndAt) {
    const err = new Error('Notification dates must be valid date-time values');
    err.statusCode = 400;
    throw err;
  }

  if (parsedEndAt.getTime() <= parsedStartAt.getTime()) {
    const err = new Error('Notification end date must be after the start date');
    err.statusCode = 400;
    throw err;
  }

  return {
    startAt: parsedStartAt,
    endAt: parsedEndAt,
  };
}

function normalizeNotificationBody(body = {}) {
  const title = String(body.title || '').trim();
  const message = String(body.message || '').trim();
  if (!title || !message) {
    const err = new Error('Notification title and message are required');
    err.statusCode = 400;
    throw err;
  }

  return {
    title,
    message,
    recipientType: normalizeRecipientType(body.recipientType),
    persistUntilDismissed: body.persistUntilDismissed === true,
    ...buildNotificationDates(body.startAt, body.endAt),
  };
}

async function loadViewerCourseIds(userId) {
  const user = await User.findById(userId)
    .select('profile.courses')
    .lean();
  return normalizeCourseIds(user?.profile?.courses);
}

async function loadViewerNotificationAccess(user = {}) {
  const userId = String(user.userId || user._id || '');
  const roles = getNotificationUserRoles(user);
  const courseIds = userId ? await loadViewerCourseIds(userId) : [];

  if (!userId || courseIds.length === 0) {
    return {
      courseIds,
      hasProfessorRole: roles.includes('professor'),
      hasStudentRole: roles.includes('student'),
      instructorCourseIds: [],
      roles,
      studentCourseIds: [],
      userId,
    };
  }

  const [studentMemberships, instructorMemberships] = await Promise.all([
    Course.find({
      _id: { $in: courseIds },
      students: userId,
    })
      .select('_id')
      .lean(),
    Course.find({
      _id: { $in: courseIds },
      instructors: userId,
    })
      .select('_id')
      .lean(),
  ]);

  const studentCourseIds = studentMemberships
    .map((course) => String(course._id || ''))
    .filter(Boolean);
  const instructorCourseIds = instructorMemberships
    .map((course) => String(course._id || ''))
    .filter(Boolean);

  return {
    courseIds,
    hasProfessorRole: roles.includes('professor'),
    hasStudentRole: roles.includes('student'),
    instructorCourseIds,
    roles,
    studentCourseIds,
    userId,
  };
}

function buildVisibleNotificationsFilter(access, now = new Date()) {
  const scopeFilters = [
    { scopeType: 'system', recipientType: 'all' },
  ];

  if (access.hasStudentRole) {
    scopeFilters.push({ scopeType: 'system', recipientType: 'students' });
  }
  if (access.hasProfessorRole) {
    scopeFilters.push({ scopeType: 'system', recipientType: 'instructors' });
  }
  if (access.courseIds.length > 0) {
    scopeFilters.push({ scopeType: 'course', courseId: { $in: access.courseIds }, recipientType: 'all' });
  }
  if (access.studentCourseIds.length > 0) {
    scopeFilters.push({ scopeType: 'course', courseId: { $in: access.studentCourseIds }, recipientType: 'students' });
  }
  if (access.instructorCourseIds.length > 0) {
    scopeFilters.push({ scopeType: 'course', courseId: { $in: access.instructorCourseIds }, recipientType: 'instructors' });
  }

  return {
    $and: [
      { $or: scopeFilters },
      { startAt: { $lte: now } },
      {
        $or: [
          { persistUntilDismissed: true },
          { endAt: { $gte: now } },
        ],
      },
    ],
  };
}

function isNotificationVisibleToUser(notification, access, now = new Date()) {
  const recipientType = normalizeRecipientType(notification.recipientType);
  const isVisibleByDate = notification.startAt <= now
    && (notification.persistUntilDismissed === true || notification.endAt >= now);
  if (!isVisibleByDate) return false;

  if (notification.scopeType === 'system') {
    if (recipientType === 'students') return access.hasStudentRole;
    if (recipientType === 'instructors') return access.hasProfessorRole;
    return true;
  }

  const courseId = String(notification.courseId || '');
  if (!courseId) return false;
  if (recipientType === 'students') return access.studentCourseIds.includes(courseId);
  if (recipientType === 'instructors') return access.instructorCourseIds.includes(courseId);
  return access.courseIds.includes(courseId);
}

async function loadDismissedNotificationIds(userId, notificationIds = []) {
  if (notificationIds.length === 0) return new Set();
  const dismissed = await NotificationDismissal.find({
    userId,
    notificationId: { $in: notificationIds },
  })
    .select('notificationId')
    .lean();
  return new Set(dismissed.map((entry) => String(entry.notificationId)));
}

async function buildCourseLookup(courseIds = []) {
  if (courseIds.length === 0) return new Map();
  const courses = await Course.find({ _id: { $in: courseIds } })
    .select('_id name deptCode courseNumber section semester')
    .lean();
  return new Map(courses.map((course) => [String(course._id), course]));
}

function serializeNotification(notification, courseLookup) {
  const course = notification.scopeType === 'course'
    ? courseLookup.get(String(notification.courseId || '')) || null
    : null;

  return {
    _id: notification._id,
    scopeType: notification.scopeType,
    courseId: notification.courseId || '',
    recipientType: normalizeRecipientType(notification.recipientType),
    title: notification.title,
    message: notification.message,
    startAt: notification.startAt,
    endAt: notification.endAt,
    persistUntilDismissed: notification.persistUntilDismissed === true,
    createdAt: notification.createdAt,
    updatedAt: notification.updatedAt,
    source: notification.scopeType === 'course' && course
      ? {
        type: 'course',
        course,
      }
      : {
        type: 'system',
      },
  };
}

async function ensureManagementScopeAccess(request, reply, scopeType, courseId = '') {
  const roles = request.user?.roles || [];
  const userId = String(request.user?.userId || '');

  if (scopeType === 'system') {
    if (!hasAdminRole(roles)) {
      reply.code(403).send({ error: 'Forbidden', message: 'Only admins can manage system notifications' });
      return null;
    }
    return { scopeType: 'system', course: null };
  }

  if (scopeType !== 'course' || !String(courseId || '').trim()) {
    reply.code(400).send({ error: 'Bad Request', message: 'A valid notification scope is required' });
    return null;
  }

  const course = await Course.findById(courseId)
    .select('_id name deptCode courseNumber section semester instructors')
    .lean();
  if (!course) {
    reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
    return null;
  }

  const instructorIds = Array.isArray(course.instructors) ? course.instructors.map(String) : [];
  if (!hasAdminRole(roles) && !instructorIds.includes(userId)) {
    reply.code(403).send({ error: 'Forbidden', message: 'Only course instructors or admins can manage course notifications' });
    return null;
  }

  return { scopeType: 'course', course };
}

async function loadNotificationWithManagementAccess(request, reply, notificationId) {
  const notification = await Notification.findById(notificationId)
    .select('_id scopeType courseId recipientType title message startAt endAt persistUntilDismissed createdAt updatedAt')
    .lean();
  if (!notification) {
    reply.code(404).send({ error: 'Not Found', message: 'Notification not found' });
    return null;
  }

  const access = await ensureManagementScopeAccess(request, reply, notification.scopeType, notification.courseId);
  if (!access) return null;
  return { notification, access };
}

async function loadVisibleNotificationForDismissal(request, reply, notificationId) {
  const notification = await Notification.findById(notificationId)
    .select('_id scopeType courseId recipientType startAt endAt persistUntilDismissed')
    .lean();
  if (!notification) {
    reply.code(404).send({ error: 'Not Found', message: 'Notification not found' });
    return null;
  }

  const now = new Date();
  const isVisibleByDate = notification.startAt <= now
    && (notification.persistUntilDismissed === true || notification.endAt >= now);
  if (!isVisibleByDate) {
    reply.code(404).send({ error: 'Not Found', message: 'Notification not found' });
    return null;
  }

  const access = await loadViewerNotificationAccess(request.user);
  if (!isNotificationVisibleToUser(notification, access, now)) {
    reply.code(403).send({ error: 'Forbidden', message: 'Notification is not visible to this user' });
    return null;
  }

  return notification;
}

const notificationManageQuerySchema = {
  querystring: {
    type: 'object',
    required: ['scopeType'],
    properties: {
      scopeType: { type: 'string', enum: ['system', 'course'] },
      courseId: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  },
};

const notificationMutationSchema = {
  body: {
    type: 'object',
    required: ['scopeType', 'title', 'message', 'startAt', 'endAt'],
    properties: {
      scopeType: { type: 'string', enum: ['system', 'course'] },
      courseId: { type: 'string', minLength: 1 },
      recipientType: { type: 'string', enum: ['all', 'students', 'instructors'] },
      title: { type: 'string', minLength: 1 },
      message: { type: 'string', minLength: 1 },
      startAt: { type: 'string', format: 'date-time' },
      endAt: { type: 'string', format: 'date-time' },
      persistUntilDismissed: { type: 'boolean' },
    },
    additionalProperties: false,
  },
};

const notificationUpdateSchema = {
  body: {
    type: 'object',
    required: ['title', 'message', 'startAt', 'endAt'],
    properties: {
      recipientType: { type: 'string', enum: ['all', 'students', 'instructors'] },
      title: { type: 'string', minLength: 1 },
      message: { type: 'string', minLength: 1 },
      startAt: { type: 'string', format: 'date-time' },
      endAt: { type: 'string', format: 'date-time' },
      persistUntilDismissed: { type: 'boolean' },
    },
    additionalProperties: false,
  },
};

const notificationIdParamsSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  },
};

export default async function notificationRoutes(app) {
  const { authenticate } = app;
  const notificationWriteRateLimitPreHandler = app.rateLimit({
    max: 30,
    timeWindow: '1 minute',
  });

  app.get('/summary', {
    preHandler: [
      authenticate,
      app.rateLimit({
        max: 120,
        timeWindow: '1 minute',
      }),
    ],
  }, async (request) => {
    const access = await loadViewerNotificationAccess(request.user);
    const notifications = await Notification.find(buildVisibleNotificationsFilter(access))
      .select('_id')
      .lean();
    const dismissedIds = await loadDismissedNotificationIds(
      request.user.userId,
      notifications.map((notification) => String(notification._id))
    );

    return {
      count: notifications.reduce((count, notification) => (
        dismissedIds.has(String(notification._id)) ? count : count + 1
      ), 0),
    };
  });

  app.get('/', {
    preHandler: [
      authenticate,
      app.rateLimit({
        max: 120,
        timeWindow: '1 minute',
      }),
    ],
  }, async (request) => {
    const access = await loadViewerNotificationAccess(request.user);
    const notifications = await Notification.find(buildVisibleNotificationsFilter(access))
      .select('_id scopeType courseId recipientType title message startAt endAt persistUntilDismissed createdAt updatedAt')
      .sort({ startAt: -1, createdAt: -1 })
      .lean();

    const dismissedIds = await loadDismissedNotificationIds(
      request.user.userId,
      notifications.map((notification) => String(notification._id))
    );
    const visibleNotifications = notifications.filter(
      (notification) => !dismissedIds.has(String(notification._id))
    );
    const courseLookup = await buildCourseLookup(
      [...new Set(visibleNotifications
        .filter((notification) => notification.scopeType === 'course')
        .map((notification) => String(notification.courseId || ''))
        .filter(Boolean))]
    );

    return {
      notifications: visibleNotifications.map((notification) => serializeNotification(notification, courseLookup)),
    };
  });

  app.post('/manage', {
    preHandler: [authenticate, notificationWriteRateLimitPreHandler],
    schema: notificationMutationSchema,
  }, async (request, reply) => {
    const { scopeType, courseId = '' } = request.body;
    const access = await ensureManagementScopeAccess(request, reply, scopeType, courseId);
    if (!access) return;

    let normalizedBody;
    try {
      normalizedBody = normalizeNotificationBody(request.body);
    } catch (err) {
      return reply.code(err.statusCode || 400).send({ error: 'Bad Request', message: err.message });
    }

    const notification = await Notification.create({
      scopeType,
      courseId: scopeType === 'course' ? String(access.course._id) : '',
      createdBy: request.user.userId,
      ...normalizedBody,
    });

    return reply.code(201).send({
      notification: serializeNotification(notification.toObject(), new Map(
        access.course ? [[String(access.course._id), access.course]] : []
      )),
    });
  });

  app.get('/manage', {
    preHandler: [
      authenticate,
      app.rateLimit({
        max: 120,
        timeWindow: '1 minute',
      }),
    ],
    schema: notificationManageQuerySchema,
  }, async (request, reply) => {
    const { scopeType, courseId = '' } = request.query;
    const access = await ensureManagementScopeAccess(request, reply, scopeType, courseId);
    if (!access) return;

    const filter = scopeType === 'system'
      ? { scopeType: 'system' }
      : { scopeType: 'course', courseId: String(access.course._id) };
    const notifications = await Notification.find(filter)
      .select('_id scopeType courseId recipientType title message startAt endAt persistUntilDismissed createdAt updatedAt')
      .sort({ startAt: -1, createdAt: -1 })
      .lean();
    const courseLookup = await buildCourseLookup(
      access.course ? [String(access.course._id)] : []
    );

    return {
      notifications: notifications.map((notification) => serializeNotification(notification, courseLookup)),
    };
  });

  app.patch('/:id', {
    preHandler: [authenticate, notificationWriteRateLimitPreHandler],
    schema: { ...notificationIdParamsSchema, ...notificationUpdateSchema },
  }, async (request, reply) => {
    const loaded = await loadNotificationWithManagementAccess(request, reply, request.params.id);
    if (!loaded) return;

    let normalizedBody;
    try {
      normalizedBody = normalizeNotificationBody({
        ...request.body,
        recipientType: request.body.recipientType ?? loaded.notification.recipientType ?? 'all',
        scopeType: loaded.notification.scopeType,
      });
    } catch (err) {
      return reply.code(err.statusCode || 400).send({ error: 'Bad Request', message: err.message });
    }

    const updated = await Notification.findByIdAndUpdate(
      request.params.id,
      {
        $set: {
          title: normalizedBody.title,
          message: normalizedBody.message,
          recipientType: normalizedBody.recipientType,
          startAt: normalizedBody.startAt,
          endAt: normalizedBody.endAt,
          persistUntilDismissed: normalizedBody.persistUntilDismissed,
          updatedAt: new Date(),
        },
      },
      { returnDocument: 'after' }
    );

    if (!updated) {
      return reply.code(404).send({ error: 'Not Found', message: 'Notification not found' });
    }

    const courseLookup = await buildCourseLookup(
      updated.scopeType === 'course' && updated.courseId ? [String(updated.courseId)] : []
    );

    return {
      notification: serializeNotification(updated.toObject(), courseLookup),
    };
  });

  app.delete('/:id', {
    preHandler: [authenticate, notificationWriteRateLimitPreHandler],
    schema: notificationIdParamsSchema,
  }, async (request, reply) => {
    const loaded = await loadNotificationWithManagementAccess(request, reply, request.params.id);
    if (!loaded) return;

    await Promise.all([
      Notification.deleteOne({ _id: request.params.id }),
      NotificationDismissal.deleteMany({ notificationId: request.params.id }),
    ]);

    return reply.code(204).send();
  });

  app.post('/:id/dismiss', {
    preHandler: [authenticate, notificationWriteRateLimitPreHandler],
    schema: notificationIdParamsSchema,
  }, async (request, reply) => {
    const notification = await loadVisibleNotificationForDismissal(request, reply, request.params.id);
    if (!notification) return;

    await NotificationDismissal.updateOne(
      {
        notificationId: request.params.id,
        userId: request.user.userId,
      },
      {
        $setOnInsert: {
          dismissedAt: new Date(),
        },
      },
      { upsert: true }
    );

    return reply.code(204).send();
  });
}
