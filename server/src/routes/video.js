import crypto from 'crypto';
import Course from '../models/Course.js';
import Settings from '../models/Settings.js';
import User from '../models/User.js';
import { isCourseInstructorOrAdmin, isCourseStudent } from '../utils/courseAccess.js';

// Default api options for a new video chat
const DEFAULT_VIDEO_API_OPTIONS = {
  startAudioMuted: true,
  startVideoMuted: true,
  startTileView: true,
};

// Default Jitsi configOverwrite (sent to JitsiMeetExternalAPI)
const DEFAULT_JITSI_CONFIG_OVERWRITE = {
  disableSimulcast: false,
  enableClosePage: false,
  disableThirdPartyRequests: true,
};

// Default Jitsi interfaceConfigOverwrite
const DEFAULT_JITSI_INTERFACE_CONFIG_OVERWRITE = {
  filmStripOnly: false,
  HIDE_INVITE_MORE_HEADER: true,
  SHOW_JITSI_WATERMARK: false,
  SHOW_WATERMARK_FOR_GUESTS: false,
  DEFAULT_REMOTE_DISPLAY_NAME: 'Classmate',
  TOOLBAR_BUTTONS: [
    'microphone', 'camera', 'desktop', 'fullscreen',
    'fodeviceselection', 'hangup', 'chat',
    'etherpad', 'raisehand', 'participants-pane',
    'videoquality', 'filmstrip', 'settings', 'select-background',
    'tileview', 'mute-everyone', 'shareaudio', 'sharedvideo',
  ],
};

const videoApiOptionsSchema = {
  body: {
    type: 'object',
    properties: {
      startAudioMuted: { type: 'boolean' },
      startVideoMuted: { type: 'boolean' },
      startTileView: { type: 'boolean' },
    },
    additionalProperties: false,
  },
};

function generateVideoId() {
  return crypto.randomBytes(6).toString('hex');
}

function findCategory(categories, categoryNumber) {
  return (categories || []).find((c) => c.categoryNumber === categoryNumber);
}

function findGroupByIndex(groups, groupIndex) {
  return (groups || []).find((g, i) => i === groupIndex);
}

export default async function videoRoutes(app) {
  const { authenticate } = app;

  // ── helpers ──────────────────────────────────────────────────────────────
  async function requireCourseInstructorOrAdmin(request, reply) {
    const course = await Course.findById(request.params.id);
    if (!course) {
      reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      return null;
    }
    if (!isCourseInstructorOrAdmin(course, request.user)) {
      reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      return null;
    }
    return course;
  }

  async function requireCourseMember(request, reply) {
    const course = await Course.findById(request.params.id);
    if (!course) {
      reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      return null;
    }
    if (!isCourseInstructorOrAdmin(course, request.user) && !isCourseStudent(course, request.user)) {
      reply.code(403).send({ error: 'Forbidden', message: 'Not enrolled in this course' });
      return null;
    }
    return course;
  }

  function broadcastVideoUpdated(course) {
    if (!app.wsBroadcast || !course) return;
    const courseMembers = [...(course.instructors || []), ...(course.students || [])];
    app.wsSendToUsers(courseMembers, 'video:updated', { courseId: course._id });
  }

  // ── POST /:id/video/toggle — Toggle course-wide video chat ──────────────
  app.post(
    '/:id/video/toggle',
    { preHandler: authenticate },
    async (request, reply) => {
      const course = await requireCourseInstructorOrAdmin(request, reply);
      if (!course) return;

      if (course.videoChatOptions && course.videoChatOptions.urlId) {
        // Disable — remove videoChatOptions
        course.videoChatOptions = undefined;
        await course.save();
        broadcastVideoUpdated(course);
        return { enabled: false };
      }

      // Enable — create new video chat options with random urlId
      course.videoChatOptions = {
        urlId: generateVideoId(),
        joined: [],
        apiOptions: { ...DEFAULT_VIDEO_API_OPTIONS },
      };
      await course.save();
      broadcastVideoUpdated(course);
      return { enabled: true, videoChatOptions: course.videoChatOptions };
    }
  );

  // ── PATCH /:id/video/api-options — Update course-wide api options ───────
  app.patch(
    '/:id/video/api-options',
    { preHandler: authenticate, schema: videoApiOptionsSchema },
    async (request, reply) => {
      const course = await requireCourseInstructorOrAdmin(request, reply);
      if (!course) return;

      if (!course.videoChatOptions || !course.videoChatOptions.urlId) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Video chat is not enabled for this course' });
      }

      const { startAudioMuted, startVideoMuted, startTileView } = request.body || {};
      const apiOptions = course.videoChatOptions.apiOptions || {};
      if (typeof startAudioMuted === 'boolean') apiOptions.startAudioMuted = startAudioMuted;
      if (typeof startVideoMuted === 'boolean') apiOptions.startVideoMuted = startVideoMuted;
      if (typeof startTileView === 'boolean') apiOptions.startTileView = startTileView;

      course.videoChatOptions.apiOptions = apiOptions;
      course.markModified('videoChatOptions');
      await course.save();
      broadcastVideoUpdated(course);
      return { videoChatOptions: course.videoChatOptions };
    }
  );

  // ── POST /:id/video/join — Join course-wide video chat ──────────────────
  app.post(
    '/:id/video/join',
    { preHandler: authenticate },
    async (request, reply) => {
      const course = await requireCourseMember(request, reply);
      if (!course) return;

      if (!course.videoChatOptions || !course.videoChatOptions.urlId) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Video chat is not enabled' });
      }

      const userId = request.user.userId;
      const joined = course.videoChatOptions.joined || [];
      if (!joined.includes(userId)) {
        joined.push(userId);
        course.videoChatOptions.joined = joined;
        course.markModified('videoChatOptions');
        await course.save();
      }

      broadcastVideoUpdated(course);

      return { success: true };
    }
  );

  // ── POST /:id/video/leave — Leave course-wide video chat ────────────────
  app.post(
    '/:id/video/leave',
    { preHandler: authenticate },
    async (request, reply) => {
      const course = await requireCourseMember(request, reply);
      if (!course) return;

      if (!course.videoChatOptions) {
        return { success: true };
      }

      const userId = request.user.userId;
      course.videoChatOptions.joined = (course.videoChatOptions.joined || []).filter((id) => id !== userId);
      course.markModified('videoChatOptions');
      await course.save();

      broadcastVideoUpdated(course);

      return { success: true };
    }
  );

  // ── POST /:id/video/clear — Clear course-wide joined list (instructor) ──
  app.post(
    '/:id/video/clear',
    { preHandler: authenticate },
    async (request, reply) => {
      const course = await requireCourseInstructorOrAdmin(request, reply);
      if (!course) return;

      if (course.videoChatOptions) {
        course.videoChatOptions.joined = [];
        course.markModified('videoChatOptions');
        await course.save();
      }

      broadcastVideoUpdated(course);

      return { success: true };
    }
  );

  // ── POST /:id/video/category/:catNum/toggle — Toggle category video ─────
  app.post(
    '/:id/video/category/:catNum/toggle',
    { preHandler: authenticate },
    async (request, reply) => {
      const course = await requireCourseInstructorOrAdmin(request, reply);
      if (!course) return;

      const catNum = parseInt(request.params.catNum, 10);
      const categories = course.groupCategories || [];
      const category = findCategory(categories, catNum);
      if (!category) {
        return reply.code(404).send({ error: 'Not Found', message: 'Category not found' });
      }

      if (category.catVideoChatOptions && category.catVideoChatOptions.urlId) {
        // Disable
        category.catVideoChatOptions = undefined;
      } else {
        // Enable
        category.catVideoChatOptions = {
          urlId: generateVideoId(),
          joined: [],
          apiOptions: { ...DEFAULT_VIDEO_API_OPTIONS },
        };
        // Reset joinedVideoChat for all groups
        for (const group of (category.groups || [])) {
          group.joinedVideoChat = [];
          group.helpVideoChat = false;
        }
      }

      course.markModified('groupCategories');
      await course.save();
      broadcastVideoUpdated(course);
      return { success: true, groupCategories: course.groupCategories };
    }
  );

  // ── PATCH /:id/video/category/:catNum/api-options — Update category api options
  app.patch(
    '/:id/video/category/:catNum/api-options',
    { preHandler: authenticate, schema: videoApiOptionsSchema },
    async (request, reply) => {
      const course = await requireCourseInstructorOrAdmin(request, reply);
      if (!course) return;

      const catNum = parseInt(request.params.catNum, 10);
      const category = findCategory(course.groupCategories, catNum);
      if (!category || !category.catVideoChatOptions) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Video chat is not enabled for this category' });
      }

      const { startAudioMuted, startVideoMuted, startTileView } = request.body || {};
      const apiOptions = category.catVideoChatOptions.apiOptions || {};
      if (typeof startAudioMuted === 'boolean') apiOptions.startAudioMuted = startAudioMuted;
      if (typeof startVideoMuted === 'boolean') apiOptions.startVideoMuted = startVideoMuted;
      if (typeof startTileView === 'boolean') apiOptions.startTileView = startTileView;

      category.catVideoChatOptions.apiOptions = apiOptions;
      course.markModified('groupCategories');
      await course.save();
      broadcastVideoUpdated(course);
      return { success: true };
    }
  );

  // ── POST /:id/video/category/:catNum/clear — Clear all rooms in category
  app.post(
    '/:id/video/category/:catNum/clear',
    { preHandler: authenticate },
    async (request, reply) => {
      const course = await requireCourseInstructorOrAdmin(request, reply);
      if (!course) return;

      const catNum = parseInt(request.params.catNum, 10);
      const category = findCategory(course.groupCategories, catNum);
      if (!category) {
        return reply.code(404).send({ error: 'Not Found', message: 'Category not found' });
      }

      for (const group of (category.groups || [])) {
        group.joinedVideoChat = [];
        group.helpVideoChat = false;
      }

      course.markModified('groupCategories');
      await course.save();

      broadcastVideoUpdated(course);

      return { success: true };
    }
  );

  // ── POST /:id/video/category/:catNum/group/:groupIdx/join — Join group video
  app.post(
    '/:id/video/category/:catNum/group/:groupIdx/join',
    { preHandler: authenticate },
    async (request, reply) => {
      const course = await requireCourseMember(request, reply);
      if (!course) return;

      const catNum = parseInt(request.params.catNum, 10);
      const groupIdx = parseInt(request.params.groupIdx, 10);
      const userId = request.user.userId;
      const roles = request.user.roles || [];
      const isAdmin = roles.includes('admin');
      const isInstructor = !isAdmin && isCourseInstructorOrAdmin(course, request.user);

      const category = findCategory(course.groupCategories, catNum);
      if (!category || !category.catVideoChatOptions) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Video chat is not enabled for this category' });
      }

      const group = category.groups?.[groupIdx];
      if (!group) {
        return reply.code(404).send({ error: 'Not Found', message: 'Group not found' });
      }

      // Students can only join groups they are members of
      if (!isAdmin && !isInstructor) {
        if (!(group.members || []).includes(userId)) {
          return reply.code(403).send({ error: 'Forbidden', message: 'Not a member of this group' });
        }
      }

      const joined = group.joinedVideoChat || [];
      if (!joined.includes(userId)) {
        joined.push(userId);
        group.joinedVideoChat = joined;
      }

      // Instructors joining disables the help button
      if (isInstructor) {
        group.helpVideoChat = false;
      }

      course.markModified('groupCategories');
      await course.save();

      if (app.wsBroadcast) {
        const courseMembers = [...(course.instructors || []), ...(course.students || [])];
        app.wsSendToUsers(courseMembers, 'video:updated', { courseId: course._id });
      }

      return { success: true };
    }
  );

  // ── POST /:id/video/category/:catNum/group/:groupIdx/leave — Leave group video
  app.post(
    '/:id/video/category/:catNum/group/:groupIdx/leave',
    { preHandler: authenticate },
    async (request, reply) => {
      const course = await requireCourseMember(request, reply);
      if (!course) return;

      const catNum = parseInt(request.params.catNum, 10);
      const groupIdx = parseInt(request.params.groupIdx, 10);
      const userId = request.user.userId;

      const category = findCategory(course.groupCategories, catNum);
      if (!category) return { success: true };

      const group = category.groups?.[groupIdx];
      if (!group) return { success: true };

      group.joinedVideoChat = (group.joinedVideoChat || []).filter((id) => id !== userId);
      if (group.joinedVideoChat.length < 1) {
        group.helpVideoChat = false;
      }

      course.markModified('groupCategories');
      await course.save();

      if (app.wsBroadcast) {
        const courseMembers = [...(course.instructors || []), ...(course.students || [])];
        app.wsSendToUsers(courseMembers, 'video:updated', { courseId: course._id });
      }

      return { success: true };
    }
  );

  // ── POST /:id/video/category/:catNum/group/:groupIdx/toggle-help — Toggle help
  app.post(
    '/:id/video/category/:catNum/group/:groupIdx/toggle-help',
    { preHandler: authenticate },
    async (request, reply) => {
      const course = await requireCourseMember(request, reply);
      if (!course) return;

      const catNum = parseInt(request.params.catNum, 10);
      const groupIdx = parseInt(request.params.groupIdx, 10);
      const userId = request.user.userId;
      const isInstructor = !request.user.roles?.includes('admin')
        && isCourseInstructorOrAdmin(course, request.user);

      // Only students in the group can toggle the help button
      if (isInstructor) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Only students can toggle the help button' });
      }

      const category = findCategory(course.groupCategories, catNum);
      if (!category) {
        return reply.code(404).send({ error: 'Not Found', message: 'Category not found' });
      }

      const group = category.groups?.[groupIdx];
      if (!group) {
        return reply.code(404).send({ error: 'Not Found', message: 'Group not found' });
      }

      if (!(group.members || []).includes(userId)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Not a member of this group' });
      }

      group.helpVideoChat = !group.helpVideoChat;
      course.markModified('groupCategories');
      await course.save();

      if (app.wsBroadcast) {
        const courseMembers = [...(course.instructors || []), ...(course.students || [])];
        app.wsSendToUsers(courseMembers, 'video:updated', { courseId: course._id });
      }

      return { success: true, helpVideoChat: group.helpVideoChat };
    }
  );

  // ── POST /:id/video/category/:catNum/group/:groupIdx/clear — Clear group room
  app.post(
    '/:id/video/category/:catNum/group/:groupIdx/clear',
    { preHandler: authenticate },
    async (request, reply) => {
      const course = await requireCourseInstructorOrAdmin(request, reply);
      if (!course) return;

      const catNum = parseInt(request.params.catNum, 10);
      const groupIdx = parseInt(request.params.groupIdx, 10);

      const category = findCategory(course.groupCategories, catNum);
      if (!category) {
        return reply.code(404).send({ error: 'Not Found', message: 'Category not found' });
      }

      const group = category.groups?.[groupIdx];
      if (!group) {
        return reply.code(404).send({ error: 'Not Found', message: 'Group not found' });
      }

      group.joinedVideoChat = [];
      group.helpVideoChat = false;
      course.markModified('groupCategories');
      await course.save();

      if (app.wsBroadcast) {
        const courseMembers = [...(course.instructors || []), ...(course.students || [])];
        app.wsSendToUsers(courseMembers, 'video:updated', { courseId: course._id });
      }

      return { success: true };
    }
  );

  // ── GET /:id/video/connection-info — Get connection info for course-wide video
  app.get(
    '/:id/video/connection-info',
    { preHandler: authenticate },
    async (request, reply) => {
      const course = await requireCourseMember(request, reply);
      if (!course) return;

      if (!course.videoChatOptions || !course.videoChatOptions.urlId) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Video chat is not enabled' });
      }

      const userId = request.user.userId;
      const user = await User.findById(userId).lean();
      const displayName = `${user?.profile?.firstname || ''} ${user?.profile?.lastname || ''}`.trim() || 'User';
      const isInstructor = !request.user.roles?.includes('admin')
        && isCourseInstructorOrAdmin(course, request.user);

      const roomName = `${course._id}Qlicker${course.videoChatOptions.urlId}all`;
      const apiOptions = {
        ...(course.videoChatOptions.apiOptions?.toObject?.() || course.videoChatOptions.apiOptions || DEFAULT_VIDEO_API_OPTIONS),
        subjectTitle: 'Course chat',
      };

      const configOverwrite = { ...DEFAULT_JITSI_CONFIG_OVERWRITE };
      if (apiOptions.startVideoMuted) configOverwrite.startWithVideoMuted = true;

      return {
        options: {
          roomName,
          userInfo: { displayName },
          interfaceConfigOverwrite: { ...DEFAULT_JITSI_INTERFACE_CONFIG_OVERWRITE },
          configOverwrite,
        },
        apiOptions,
        courseId: course._id,
        isInstructor,
      };
    }
  );

  // ── GET /:id/video/category/:catNum/group/:groupIdx/connection-info
  app.get(
    '/:id/video/category/:catNum/group/:groupIdx/connection-info',
    { preHandler: authenticate },
    async (request, reply) => {
      const course = await requireCourseMember(request, reply);
      if (!course) return;

      const catNum = parseInt(request.params.catNum, 10);
      const groupIdx = parseInt(request.params.groupIdx, 10);
      const userId = request.user.userId;
      const isInstructor = !request.user.roles?.includes('admin')
        && isCourseInstructorOrAdmin(course, request.user);

      const category = findCategory(course.groupCategories, catNum);
      if (!category || !category.catVideoChatOptions) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Video chat is not enabled for this category' });
      }

      let group;
      if (isInstructor) {
        group = category.groups?.[groupIdx];
      } else {
        // Students must be in the group
        group = (category.groups || []).find((g) => (g.members || []).includes(userId));
        if (!group) {
          return reply.code(403).send({ error: 'Forbidden', message: 'Not a member of any group in this category' });
        }
      }

      if (!group) {
        return reply.code(404).send({ error: 'Not Found', message: 'Group not found' });
      }

      const user = await User.findById(userId).lean();
      const displayName = `${user?.profile?.firstname || ''} ${user?.profile?.lastname || ''}`.trim() || 'User';
      const catName = category.categoryName || `Cat${catNum}`;
      const groupName = group.name || `Group${groupIdx}`;

      const roomName = `Ql_C_${course._id}cat_${catName}${category.catVideoChatOptions.urlId}grp_${groupName}`;
      const apiOptions = {
        ...(category.catVideoChatOptions.apiOptions?.toObject?.() || category.catVideoChatOptions.apiOptions || DEFAULT_VIDEO_API_OPTIONS),
        subjectTitle: `${catName}: ${groupName}`,
      };

      const configOverwrite = { ...DEFAULT_JITSI_CONFIG_OVERWRITE };
      if (apiOptions.startVideoMuted) configOverwrite.startWithVideoMuted = true;

      // Find the actual group index for the student's group
      const actualGroupIdx = category.groups.indexOf(group);

      return {
        options: {
          roomName,
          userInfo: { displayName },
          interfaceConfigOverwrite: { ...DEFAULT_JITSI_INTERFACE_CONFIG_OVERWRITE },
          configOverwrite,
        },
        apiOptions,
        courseId: course._id,
        categoryNumber: catNum,
        groupIndex: actualGroupIdx,
        helpVideoChat: group.helpVideoChat || false,
        isInstructor,
      };
    }
  );
}
