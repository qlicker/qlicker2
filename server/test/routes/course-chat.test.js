import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { authenticatedRequest, createApp, createTestUser, getAuthToken } from '../helpers.js';
import Course from '../../src/models/Course.js';
import CourseChatView from '../../src/models/CourseChatView.js';
import Post from '../../src/models/Post.js';

let app;

beforeEach(async (ctx) => {
  if (mongoose.connection.readyState !== 1) {
    ctx.skip();
    return;
  }
  app = await createApp();
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

async function createCourse(profToken, overrides = {}) {
  const res = await authenticatedRequest(app, 'POST', '/api/v1/courses', {
    token: profToken,
    payload: {
      name: 'Course Chat 101',
      deptCode: 'CHAT',
      courseNumber: '101',
      section: '001',
      semester: 'Fall 2026',
      tags: [{ value: 'homework', label: 'Homework' }],
      ...overrides,
    },
  });
  return res.json().course;
}

describe('course chat routes', () => {
  it('lets instructors enable course chat and set retention', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'chat-prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const course = await createCourse(token);

    const res = await authenticatedRequest(app, 'PATCH', `/api/v1/courses/${course._id}`, {
      token,
      payload: { courseChatEnabled: true, courseChatRetentionDays: 30 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().course.courseChatEnabled).toBe(true);
    expect(res.json().course.courseChatRetentionDays).toBe(30);
  });

  it('keeps instructor identities anonymous to students in course chat payloads', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'chat-prof-2@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const course = await createCourse(profToken, { courseChatEnabled: true });

    const student = await createTestUser({ email: 'chat-student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);

    await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });

    await Course.findByIdAndUpdate(course._id, {
      $set: { courseChatEnabled: true },
    });

    await Post.create({
      scopeType: 'course',
      courseId: String(course._id),
      authorId: String(prof._id),
      authorRole: 'instructor',
      title: 'Professor announcement',
      body: 'Remember to review chapter 3.',
      bodyWysiwyg: '<p>Remember to review chapter 3.</p>',
      tags: ['homework'],
      comments: [],
      upvoteUserIds: [],
      upvoteCount: 0,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/chat`, {
      token: studentToken,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().posts).toHaveLength(1);
    expect(res.json().posts[0].authorName).toBeNull();
    expect(res.json().posts[0].author).toBeUndefined();
    expect(res.json().posts[0].authorRole).toBe('instructor');
  });

  it('lets students and professors edit only their own course chat posts', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'chat-edit-prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const course = await createCourse(profToken, { courseChatEnabled: true });
    const student = await createTestUser({ email: 'chat-edit-student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);
    await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });
    await Course.findByIdAndUpdate(course._id, { $set: { courseChatEnabled: true } });

    const studentPostRes = await authenticatedRequest(app, 'POST', `/api/v1/courses/${course._id}/chat/posts`, {
      token: studentToken,
      payload: { title: 'Student topic', body: 'Student original' },
    });
    expect(studentPostRes.statusCode).toBe(201);

    const professorEditingStudentRes = await authenticatedRequest(
      app,
      'PATCH',
      `/api/v1/courses/${course._id}/chat/posts/${studentPostRes.json().postId}`,
      { token: profToken, payload: { title: 'Overwrite', body: 'Professor overwrite' } }
    );
    expect(professorEditingStudentRes.statusCode).toBe(403);

    const studentEditRes = await authenticatedRequest(
      app,
      'PATCH',
      `/api/v1/courses/${course._id}/chat/posts/${studentPostRes.json().postId}`,
      { token: studentToken, payload: { title: 'Student revised topic', body: 'Student revised' } }
    );
    expect(studentEditRes.statusCode).toBe(200);

    const professorPostRes = await authenticatedRequest(app, 'POST', `/api/v1/courses/${course._id}/chat/posts`, {
      token: profToken,
      payload: { title: 'Professor topic', body: 'Professor original' },
    });
    expect(professorPostRes.statusCode).toBe(201);
    const professorEditRes = await authenticatedRequest(
      app,
      'PATCH',
      `/api/v1/courses/${course._id}/chat/posts/${professorPostRes.json().postId}`,
      { token: profToken, payload: { title: 'Professor revised topic', body: 'Professor revised' } }
    );
    expect(professorEditRes.statusCode).toBe(200);

    expect(await Post.findById(studentPostRes.json().postId).lean()).toEqual(expect.objectContaining({
      title: 'Student revised topic',
      body: 'Student revised',
    }));
    expect(await Post.findById(professorPostRes.json().postId).lean()).toEqual(expect.objectContaining({
      title: 'Professor revised topic',
      body: 'Professor revised',
    }));
  });

  it('counts unseen posts and comments until the chat is opened', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'chat-prof-3@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const course = await createCourse(profToken, { courseChatEnabled: true });

    const student = await createTestUser({ email: 'chat-student-2@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);

    await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });

    // Use timestamps relative to now so the seeded post stays inside the chat
    // retention window (and is not auto-archived) regardless of the wall clock.
    const viewedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const postCreatedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const commentCreatedAt = new Date(Date.now() - 1 * 60 * 60 * 1000);

    await CourseChatView.create({
      courseId: String(course._id),
      userId: String(student._id),
      lastViewedAt: viewedAt,
    });

    const post = await Post.create({
      scopeType: 'course',
      courseId: String(course._id),
      authorId: String(prof._id),
      authorRole: 'instructor',
      title: 'Announcement',
      body: 'Main body',
      bodyWysiwyg: '<p>Main body</p>',
      tags: [],
      comments: [{
        _id: 'comment-1',
        authorId: String(prof._id),
        authorRole: 'instructor',
        body: 'Follow-up',
        bodyWysiwyg: '<p>Follow-up</p>',
        upvoteUserIds: [],
        upvoteCount: 0,
        createdAt: commentCreatedAt,
        updatedAt: commentCreatedAt,
      }],
      upvoteUserIds: [],
      upvoteCount: 0,
      archivedAt: null,
      createdAt: postCreatedAt,
      updatedAt: commentCreatedAt,
    });

    const summaryRes = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/chat/summary`, {
      token: studentToken,
    });

    expect(summaryRes.statusCode).toBe(200);
    expect(summaryRes.json().unseenCount).toBe(2);

    const chatRes = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/chat`, {
      token: studentToken,
    });

    expect(chatRes.statusCode).toBe(200);
    expect(chatRes.json().posts[0]._id).toBe(String(post._id));

    const refreshedView = await CourseChatView.findOne({
      courseId: String(course._id),
      userId: String(student._id),
    }).lean();
    expect(refreshedView?.lastViewedAt).toBeTruthy();

    const refreshedSummaryRes = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/chat/summary`, {
      token: studentToken,
    });
    expect(refreshedSummaryRes.statusCode).toBe(200);
    expect(refreshedSummaryRes.json().unseenCount).toBe(0);
  });

  it('lets instructors include archived posts and unarchive them', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'chat-prof-4@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const course = await createCourse(token, { courseChatEnabled: true });

    const post = await Post.create({
      scopeType: 'course',
      courseId: String(course._id),
      authorId: String(prof._id),
      authorRole: 'instructor',
      title: 'Archived note',
      body: 'Body',
      bodyWysiwyg: '<p>Body</p>',
      tags: [],
      comments: [],
      upvoteUserIds: [],
      upvoteCount: 0,
      archivedAt: new Date('2026-04-10T12:00:00.000Z'),
      archivedBy: String(prof._id),
      createdAt: new Date('2026-04-10T10:00:00.000Z'),
      updatedAt: new Date('2026-04-10T12:00:00.000Z'),
    });

    const defaultRes = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/chat`, {
      token,
    });
    expect(defaultRes.statusCode).toBe(200);
    expect(defaultRes.json().posts).toHaveLength(0);

    const archivedRes = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/chat?includeArchived=true`, {
      token,
    });
    expect(archivedRes.statusCode).toBe(200);
    expect(archivedRes.json().posts).toHaveLength(1);
    expect(archivedRes.json().posts[0].isArchived).toBe(true);

    const unarchiveRes = await authenticatedRequest(app, 'PATCH', `/api/v1/courses/${course._id}/chat/posts/${post._id}/unarchive`, {
      token,
    });
    expect(unarchiveRes.statusCode).toBe(200);

    const refreshedPost = await Post.findById(post._id).lean();
    expect(refreshedPost?.archivedAt).toBeNull();
    expect(refreshedPost?.archivedBy).toBe('');
  });

  it('does not let students include archived posts', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'chat-prof-5@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const course = await createCourse(profToken, { courseChatEnabled: true });

    const student = await createTestUser({ email: 'chat-student-3@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);

    await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });

    await Course.findByIdAndUpdate(course._id, {
      $set: { courseChatEnabled: true },
    });

    await Post.create({
      scopeType: 'course',
      courseId: String(course._id),
      authorId: String(prof._id),
      authorRole: 'instructor',
      title: 'Archived instructor note',
      body: 'Body',
      bodyWysiwyg: '<p>Body</p>',
      tags: [],
      comments: [],
      upvoteUserIds: [],
      upvoteCount: 0,
      archivedAt: new Date('2026-04-10T12:00:00.000Z'),
      archivedBy: String(prof._id),
      createdAt: new Date('2026-04-10T10:00:00.000Z'),
      updatedAt: new Date('2026-04-10T12:00:00.000Z'),
    });

    const res = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/chat?includeArchived=true`, {
      token: studentToken,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().posts).toHaveLength(0);
  });
});
