import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createApp, createTestUser, getAuthToken, authenticatedRequest } from '../helpers.js';
import Course from '../../src/models/Course.js';

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

// Helper to create a course via the API
async function createCourseAsProf(profToken, overrides = {}) {
  const payload = {
    name: 'Test Course',
    deptCode: 'CS',
    courseNumber: '101',
    section: '001',
    semester: 'Fall 2025',
    ...overrides,
  };
  const res = await authenticatedRequest(app, 'POST', '/api/v1/courses', {
    token: profToken,
    payload,
  });
  return res;
}

// ---------- POST /api/v1/courses/:id/groups ----------
describe('POST /api/v1/courses/:id/groups (create category)', () => {
  it('creates a category with groups', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseRes = await createCourseAsProf(token);
    const courseId = courseRes.json().course._id;

    const res = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/groups`, {
      token,
      payload: { categoryName: 'Lab Groups', numberOfGroups: 3 },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.groupCategories).toBeDefined();
    expect(body.groupCategories.length).toBe(1);
    expect(body.groupCategories[0].categoryName).toBe('Lab Groups');
    expect(body.groupCategories[0].groups.length).toBe(3);
    expect(body.groupCategories[0].groups[0].name).toBe('Group 1');
    expect(body.groupCategories[0].groups[2].name).toBe('Group 3');
  });

  it('rejects duplicate category name', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseRes = await createCourseAsProf(token);
    const courseId = courseRes.json().course._id;

    await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/groups`, {
      token,
      payload: { categoryName: 'Lab Groups', numberOfGroups: 2 },
    });

    const res = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/groups`, {
      token,
      payload: { categoryName: 'Lab Groups', numberOfGroups: 2 },
    });

    expect(res.statusCode).toBe(409);
  });

  it('student cannot create a category', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const courseRes = await createCourseAsProf(profToken);
    const courseId = courseRes.json().course._id;

    const student = await createTestUser({ email: 'student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);

    const res = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/groups`, {
      token: studentToken,
      payload: { categoryName: 'Lab Groups', numberOfGroups: 2 },
    });

    expect(res.statusCode).toBe(403);
  });

  it('does not grant group management to a professor enrolled only as a student', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const instructor = await createTestUser({ email: 'instructor@example.com', roles: ['professor'] });
    const instructorToken = await getAuthToken(app, instructor);
    const courseRes = await createCourseAsProf(instructorToken);
    const courseId = courseRes.json().course._id;

    const professorStudent = await createTestUser({ email: 'professor-student@example.com', roles: ['professor', 'student'] });
    const professorStudentToken = await getAuthToken(app, professorStudent);
    await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: professorStudentToken,
      payload: { enrollmentCode: courseRes.json().course.enrollmentCode },
    });

    const res = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/groups`, {
      token: professorStudentToken,
      payload: { categoryName: 'Unauthorized Group', numberOfGroups: 2 },
    });

    expect(res.statusCode).toBe(403);
  });
});

// ---------- GET /api/v1/courses/:id/groups ----------
describe('GET /api/v1/courses/:id/groups (list categories)', () => {
  it('lists group categories', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseRes = await createCourseAsProf(token);
    const courseId = courseRes.json().course._id;

    await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/groups`, {
      token,
      payload: { categoryName: 'Lab Groups', numberOfGroups: 2 },
    });
    await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/groups`, {
      token,
      payload: { categoryName: 'Tutorial Groups', numberOfGroups: 4 },
    });

    const res = await authenticatedRequest(app, 'GET', `/api/v1/courses/${courseId}/groups`, { token });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groupCategories.length).toBe(2);
    expect(body.groupCategories[0].categoryName).toBe('Lab Groups');
    expect(body.groupCategories[1].categoryName).toBe('Tutorial Groups');
    expect(body.groupCategories[1].groups.length).toBe(4);
  });

  it('normalizes legacy group shape', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseRes = await createCourseAsProf(token);
    const courseId = courseRes.json().course._id;

    // Simulate legacy data by writing directly to the native MongoDB collection
    // (bypasses Mongoose schema validation to preserve legacy field names)
    const collection = mongoose.connection.collection('courses');
    await collection.updateOne(
      { _id: courseId },
      {
        $set: {
          groupCategories: [{
            categoryNumber: 1,
            categoryName: 'Legacy Groups',
            groups: [
              { groupNumber: 1, groupName: 'Team A', students: ['user1', 'user2'] },
              { groupNumber: 2, groupName: 'Team B', students: ['user3'] },
            ],
          }],
        },
      }
    );

    const res = await authenticatedRequest(app, 'GET', `/api/v1/courses/${courseId}/groups`, { token });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groupCategories.length).toBe(1);
    const cat = body.groupCategories[0];
    expect(cat.groups[0].name).toBe('Team A');
    expect(cat.groups[0].members).toEqual(['user1', 'user2']);
    expect(cat.groups[1].name).toBe('Team B');
    expect(cat.groups[1].members).toEqual(['user3']);
  });
});

// ---------- DELETE /api/v1/courses/:id/groups/:catId ----------
describe('DELETE /api/v1/courses/:id/groups/:categoryNumber', () => {
  it('deletes a category', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseRes = await createCourseAsProf(token);
    const courseId = courseRes.json().course._id;

    const createRes = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/groups`, {
      token,
      payload: { categoryName: 'Lab Groups', numberOfGroups: 2 },
    });
    const catNum = createRes.json().groupCategories[0].categoryNumber;

    const res = await authenticatedRequest(app, 'DELETE', `/api/v1/courses/${courseId}/groups/${catNum}`, { token });

    expect(res.statusCode).toBe(200);
    expect(res.json().groupCategories.length).toBe(0);
  });

  it('returns 404 for non-existent category', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseRes = await createCourseAsProf(token);
    const courseId = courseRes.json().course._id;

    const res = await authenticatedRequest(app, 'DELETE', `/api/v1/courses/${courseId}/groups/999`, { token });

    expect(res.statusCode).toBe(404);
  });
});

// ---------- POST /:id/groups/:catNum/groups (add group) ----------
describe('POST /api/v1/courses/:id/groups/:catNum/groups (add group)', () => {
  it('adds a group to a category', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseRes = await createCourseAsProf(token);
    const courseId = courseRes.json().course._id;

    const createRes = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/groups`, {
      token,
      payload: { categoryName: 'Lab Groups', numberOfGroups: 1 },
    });
    const catNum = createRes.json().groupCategories[0].categoryNumber;

    const res = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/groups/${catNum}/groups`, {
      token,
      payload: { name: 'Extra Group' },
    });

    expect(res.statusCode).toBe(201);
    const cat = res.json().groupCategories.find((c) => c.categoryNumber === catNum);
    expect(cat.groups.length).toBe(2);
    expect(cat.groups[1].name).toBe('Extra Group');
  });

  it('auto-names when no name given', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseRes = await createCourseAsProf(token);
    const courseId = courseRes.json().course._id;

    const createRes = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/groups`, {
      token,
      payload: { categoryName: 'Lab Groups', numberOfGroups: 2 },
    });
    const catNum = createRes.json().groupCategories[0].categoryNumber;

    const res = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/groups/${catNum}/groups`, {
      token,
      payload: {},
    });

    expect(res.statusCode).toBe(201);
    const cat = res.json().groupCategories.find((c) => c.categoryNumber === catNum);
    expect(cat.groups[2].name).toBe('Group 3');
  });
});

// ---------- DELETE /:id/groups/:catNum/groups/:gIdx (delete group) ----------
describe('DELETE /api/v1/courses/:id/groups/:catNum/groups/:gIdx', () => {
  it('deletes a group from a category', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseRes = await createCourseAsProf(token);
    const courseId = courseRes.json().course._id;

    const createRes = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/groups`, {
      token,
      payload: { categoryName: 'Lab Groups', numberOfGroups: 3 },
    });
    const catNum = createRes.json().groupCategories[0].categoryNumber;

    const res = await authenticatedRequest(app, 'DELETE', `/api/v1/courses/${courseId}/groups/${catNum}/groups/1`, { token });

    expect(res.statusCode).toBe(200);
    const cat = res.json().groupCategories.find((c) => c.categoryNumber === catNum);
    expect(cat.groups.length).toBe(2);
  });

  it('refuses to delete last group', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseRes = await createCourseAsProf(token);
    const courseId = courseRes.json().course._id;

    const createRes = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/groups`, {
      token,
      payload: { categoryName: 'Lab Groups', numberOfGroups: 1 },
    });
    const catNum = createRes.json().groupCategories[0].categoryNumber;

    const res = await authenticatedRequest(app, 'DELETE', `/api/v1/courses/${courseId}/groups/${catNum}/groups/0`, { token });

    expect(res.statusCode).toBe(400);
  });
});

// ---------- PATCH /:id/groups/:catNum/groups/:gIdx (update group) ----------
describe('PATCH /api/v1/courses/:id/groups/:catNum/groups/:gIdx', () => {
  it('renames a group', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseRes = await createCourseAsProf(token);
    const courseId = courseRes.json().course._id;

    const createRes = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/groups`, {
      token,
      payload: { categoryName: 'Lab Groups', numberOfGroups: 2 },
    });
    const catNum = createRes.json().groupCategories[0].categoryNumber;

    const res = await authenticatedRequest(app, 'PATCH', `/api/v1/courses/${courseId}/groups/${catNum}/groups/0`, {
      token,
      payload: { name: 'Team Alpha' },
    });

    expect(res.statusCode).toBe(200);
    const cat = res.json().groupCategories.find((c) => c.categoryNumber === catNum);
    expect(cat.groups[0].name).toBe('Team Alpha');
  });
});

// ---------- Student management in groups ----------
describe('Group student management', () => {
  it('adds a student to a group', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseRes = await createCourseAsProf(token);
    const courseId = courseRes.json().course._id;

    const student = await createTestUser({ email: 'student@example.com', roles: ['student'] });

    const createRes = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/groups`, {
      token,
      payload: { categoryName: 'Lab Groups', numberOfGroups: 2 },
    });
    const catNum = createRes.json().groupCategories[0].categoryNumber;

    const res = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/groups/${catNum}/groups/0/students`, {
      token,
      payload: { studentId: student._id.toString() },
    });

    expect(res.statusCode).toBe(200);
    const cat = res.json().groupCategories.find((c) => c.categoryNumber === catNum);
    expect(cat.groups[0].members).toContain(student._id.toString());
  });

  it('removes a student from a group', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseRes = await createCourseAsProf(token);
    const courseId = courseRes.json().course._id;

    const student = await createTestUser({ email: 'student@example.com', roles: ['student'] });

    const createRes = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/groups`, {
      token,
      payload: { categoryName: 'Lab Groups', numberOfGroups: 2 },
    });
    const catNum = createRes.json().groupCategories[0].categoryNumber;

    // Add student
    await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/groups/${catNum}/groups/0/students`, {
      token,
      payload: { studentId: student._id.toString() },
    });

    // Remove student
    const res = await authenticatedRequest(app, 'DELETE', `/api/v1/courses/${courseId}/groups/${catNum}/groups/0/students/${student._id}`, { token });

    expect(res.statusCode).toBe(200);
    const cat = res.json().groupCategories.find((c) => c.categoryNumber === catNum);
    expect(cat.groups[0].members).not.toContain(student._id.toString());
  });

  it('moves student between groups when adding to a new group', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseRes = await createCourseAsProf(token);
    const courseId = courseRes.json().course._id;

    const student = await createTestUser({ email: 'student@example.com', roles: ['student'] });

    const createRes = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/groups`, {
      token,
      payload: { categoryName: 'Lab Groups', numberOfGroups: 2 },
    });
    const catNum = createRes.json().groupCategories[0].categoryNumber;

    // Add student to group 0
    await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/groups/${catNum}/groups/0/students`, {
      token,
      payload: { studentId: student._id.toString() },
    });

    // Move student to group 1
    const res = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/groups/${catNum}/groups/1/students`, {
      token,
      payload: { studentId: student._id.toString() },
    });

    expect(res.statusCode).toBe(200);
    const cat = res.json().groupCategories.find((c) => c.categoryNumber === catNum);
    expect(cat.groups[0].members).not.toContain(student._id.toString());
    expect(cat.groups[1].members).toContain(student._id.toString());
  });
});

// ---------- CSV endpoints ----------
describe('Group CSV endpoints', () => {
  it('downloads CSV', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseRes = await createCourseAsProf(token);
    const courseId = courseRes.json().course._id;

    const student = await createTestUser({ email: 'student1@example.com', firstname: 'Jane', lastname: 'Doe', roles: ['student'] });

    const createRes = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/groups`, {
      token,
      payload: { categoryName: 'Lab Groups', numberOfGroups: 1 },
    });
    const catNum = createRes.json().groupCategories[0].categoryNumber;

    await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/groups/${catNum}/groups/0/students`, {
      token,
      payload: { studentId: student._id.toString() },
    });

    const res = await authenticatedRequest(app, 'GET', `/api/v1/courses/${courseId}/groups/csv`, { token });

    expect(res.statusCode).toBe(200);
    const csv = res.payload;
    expect(csv).toContain('CategoryName');
    expect(csv).toContain('Lab Groups');
    expect(csv).toContain('student1@example.com');
    expect(csv).toContain('Doe');
    expect(csv).toContain('Jane');
  });

  it('uploads CSV to create a category', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseRes = await createCourseAsProf(token);
    const courseId = courseRes.json().course._id;

    const student1 = await createTestUser({ email: 'student1@example.com', firstname: 'Jane', lastname: 'Doe', roles: ['student'] });
    const student2 = await createTestUser({ email: 'student2@example.com', firstname: 'John', lastname: 'Smith', roles: ['student'] });

    const csvContent = [
      'GroupName,Email,LastName,FirstName',
      'Team A,student1@example.com,Doe,Jane',
      'Team B,student2@example.com,Smith,John',
    ].join('\n');

    const res = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/groups/csv`, {
      token,
      payload: { categoryName: 'Uploaded Groups', csv: csvContent },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    const cat = body.groupCategories.find((c) => c.categoryName === 'Uploaded Groups');
    expect(cat).toBeDefined();
    expect(cat.groups.length).toBe(2);
    expect(cat.groups[0].name).toBe('Team A');
    expect(cat.groups[0].members).toContain(student1._id.toString());
    expect(cat.groups[1].name).toBe('Team B');
    expect(cat.groups[1].members).toContain(student2._id.toString());
    expect(body.imported.notFound).toEqual([]);
  });
});
