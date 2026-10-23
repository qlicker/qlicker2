import Course from '../models/Course.js';
import User from '../models/User.js';
import { isCourseInstructorOrAdmin } from '../utils/courseAccess.js';

// ---------------------------------------------------------------------------
// Legacy compatibility: normalize a groupCategories array from the legacy
// Meteor shape (groupNumber/groupName/students) to the current schema
// (name/members).  Safe to call on already-normalized data.
// ---------------------------------------------------------------------------
function normalizeGroupCategories(categories) {
  if (!Array.isArray(categories)) return [];
  return categories.map((cat) => ({
    categoryNumber: cat.categoryNumber,
    categoryName: cat.categoryName,
    catVideoChatOptions: cat.catVideoChatOptions || undefined,
    groups: (cat.groups || []).map((g) => ({
      name: g.name ?? g.groupName ?? `Group ${g.groupNumber ?? 0}`,
      members: g.members ?? g.students ?? [],
      joinedVideoChat: g.joinedVideoChat ?? [],
      helpVideoChat: g.helpVideoChat ?? false,
    })),
  }));
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function escapeCsvCell(value) {
  if (value == null) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function parseCsvRows(text) {
  const rows = [];
  let current = '';
  let inQuotes = false;
  const chars = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < chars.length && chars[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      rows.push(current);
      current = '';
    } else if (ch === '\n') {
      rows.push(current);
      current = '';
      // We'll flatten into a single array, then reshape by column count later
      rows.push('\n');
    } else {
      current += ch;
    }
  }
  if (current) rows.push(current);

  // Reshape flat tokens into rows (split by \n markers)
  const result = [];
  let row = [];
  for (const token of rows) {
    if (token === '\n') {
      if (row.length > 0) result.push(row);
      row = [];
    } else {
      row.push(token.trim());
    }
  }
  if (row.length > 0) result.push(row);
  return result;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export default async function groupRoutes(app) {
  const { authenticate, requireRole } = app;

  // ---- Helpers ----

  async function loadCourseAsInstructor(request, reply) {
    // Use .lean() so legacy fields (groupName, students) are preserved for normalization
    const course = await Course.findById(request.params.id).lean();
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

  // GET /:id/groups — List group categories (with legacy normalization)
  app.get(
    '/:id/groups',
    { preHandler: authenticate },
    async (request, reply) => {
      const course = await loadCourseAsInstructor(request, reply);
      if (!course) return;

      const categories = normalizeGroupCategories(course.groupCategories || []);
      return { groupCategories: categories };
    }
  );

  // POST /:id/groups — Create a new category (with N initial groups)
  app.post(
    '/:id/groups',
    {
      preHandler: authenticate,
      schema: {
        body: {
          type: 'object',
          required: ['categoryName', 'numberOfGroups'],
          properties: {
            categoryName: { type: 'string', minLength: 1 },
            numberOfGroups: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const course = await loadCourseAsInstructor(request, reply);
      if (!course) return;

      const { categoryName, numberOfGroups } = request.body;
      const categories = normalizeGroupCategories(course.groupCategories || []);

      // Check for duplicate category name
      if (categories.some((c) => c.categoryName === categoryName)) {
        return reply.code(409).send({ error: 'Conflict', message: 'Category name already exists' });
      }

      const maxCatNumber = categories.reduce((max, c) => Math.max(max, c.categoryNumber || 0), 0);
      const groups = [];
      for (let i = 1; i <= numberOfGroups; i++) {
        groups.push({ name: `Group ${i}`, members: [] });
      }

      categories.push({
        categoryNumber: maxCatNumber + 1,
        categoryName,
        groups,
      });

      await Course.findByIdAndUpdate(course._id, { $set: { groupCategories: categories } });

      return reply.code(201).send({ groupCategories: categories });
    }
  );

  // DELETE /:id/groups/:categoryNumber — Delete a category
  app.delete(
    '/:id/groups/:categoryNumber',
    { preHandler: authenticate },
    async (request, reply) => {
      const course = await loadCourseAsInstructor(request, reply);
      if (!course) return;

      const catNum = Number(request.params.categoryNumber);
      const categories = normalizeGroupCategories(course.groupCategories || []);
      const idx = categories.findIndex((c) => c.categoryNumber === catNum);
      if (idx === -1) {
        return reply.code(404).send({ error: 'Not Found', message: 'Category not found' });
      }

      categories.splice(idx, 1);
      await Course.findByIdAndUpdate(course._id, { $set: { groupCategories: categories } });

      return { groupCategories: categories };
    }
  );

  // POST /:id/groups/:categoryNumber/groups — Add a group to a category
  app.post(
    '/:id/groups/:categoryNumber/groups',
    {
      preHandler: authenticate,
      schema: {
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const course = await loadCourseAsInstructor(request, reply);
      if (!course) return;

      const catNum = Number(request.params.categoryNumber);
      const categories = normalizeGroupCategories(course.groupCategories || []);
      const cat = categories.find((c) => c.categoryNumber === catNum);
      if (!cat) {
        return reply.code(404).send({ error: 'Not Found', message: 'Category not found' });
      }

      const groupName = request.body?.name || `Group ${cat.groups.length + 1}`;
      cat.groups.push({ name: groupName, members: [] });

      await Course.findByIdAndUpdate(course._id, { $set: { groupCategories: categories } });

      return reply.code(201).send({ groupCategories: categories });
    }
  );

  // DELETE /:id/groups/:categoryNumber/groups/:groupIndex — Delete a group
  app.delete(
    '/:id/groups/:categoryNumber/groups/:groupIndex',
    { preHandler: authenticate },
    async (request, reply) => {
      const course = await loadCourseAsInstructor(request, reply);
      if (!course) return;

      const catNum = Number(request.params.categoryNumber);
      const gIdx = Number(request.params.groupIndex);
      const categories = normalizeGroupCategories(course.groupCategories || []);
      const cat = categories.find((c) => c.categoryNumber === catNum);
      if (!cat) {
        return reply.code(404).send({ error: 'Not Found', message: 'Category not found' });
      }
      if (gIdx < 0 || gIdx >= cat.groups.length) {
        return reply.code(404).send({ error: 'Not Found', message: 'Group not found' });
      }
      if (cat.groups.length <= 1) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Cannot delete the last group in a category' });
      }

      cat.groups.splice(gIdx, 1);
      await Course.findByIdAndUpdate(course._id, { $set: { groupCategories: categories } });

      return { groupCategories: categories };
    }
  );

  // PATCH /:id/groups/:categoryNumber/groups/:groupIndex — Update group (rename, toggle student)
  app.patch(
    '/:id/groups/:categoryNumber/groups/:groupIndex',
    {
      preHandler: authenticate,
      schema: {
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1 },
            toggleStudentId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const course = await loadCourseAsInstructor(request, reply);
      if (!course) return;

      const catNum = Number(request.params.categoryNumber);
      const gIdx = Number(request.params.groupIndex);
      const categories = normalizeGroupCategories(course.groupCategories || []);
      const cat = categories.find((c) => c.categoryNumber === catNum);
      if (!cat) {
        return reply.code(404).send({ error: 'Not Found', message: 'Category not found' });
      }
      if (gIdx < 0 || gIdx >= cat.groups.length) {
        return reply.code(404).send({ error: 'Not Found', message: 'Group not found' });
      }

      const group = cat.groups[gIdx];

      // Rename
      if (request.body.name) {
        group.name = request.body.name;
      }

      // Toggle student membership
      if (request.body.toggleStudentId) {
        const studentId = request.body.toggleStudentId;
        // Check if student is currently in this specific group before any changes
        const wasInThisGroup = group.members.includes(studentId);
        // Remove from all groups in this category
        for (const g of cat.groups) {
          const memberIdx = g.members.indexOf(studentId);
          if (memberIdx !== -1) {
            g.members.splice(memberIdx, 1);
          }
        }
        // Toggle: add to this group only if they weren't already in it
        if (!wasInThisGroup) {
          group.members.push(studentId);
        }
      }

      await Course.findByIdAndUpdate(course._id, { $set: { groupCategories: categories } });

      return { groupCategories: categories };
    }
  );

  // POST /:id/groups/:categoryNumber/groups/:groupIndex/students — Add student to group
  app.post(
    '/:id/groups/:categoryNumber/groups/:groupIndex/students',
    {
      preHandler: authenticate,
      schema: {
        body: {
          type: 'object',
          required: ['studentId'],
          properties: {
            studentId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const course = await loadCourseAsInstructor(request, reply);
      if (!course) return;

      const catNum = Number(request.params.categoryNumber);
      const gIdx = Number(request.params.groupIndex);
      const categories = normalizeGroupCategories(course.groupCategories || []);
      const cat = categories.find((c) => c.categoryNumber === catNum);
      if (!cat) {
        return reply.code(404).send({ error: 'Not Found', message: 'Category not found' });
      }
      if (gIdx < 0 || gIdx >= cat.groups.length) {
        return reply.code(404).send({ error: 'Not Found', message: 'Group not found' });
      }

      const { studentId } = request.body;

      // Remove student from any other group in this category
      for (const g of cat.groups) {
        const memberIdx = g.members.indexOf(studentId);
        if (memberIdx !== -1) {
          g.members.splice(memberIdx, 1);
        }
      }

      // Add to target group
      cat.groups[gIdx].members.push(studentId);

      await Course.findByIdAndUpdate(course._id, { $set: { groupCategories: categories } });

      return { groupCategories: categories };
    }
  );

  // DELETE /:id/groups/:categoryNumber/groups/:groupIndex/students/:studentId — Remove student from group
  app.delete(
    '/:id/groups/:categoryNumber/groups/:groupIndex/students/:studentId',
    { preHandler: authenticate },
    async (request, reply) => {
      const course = await loadCourseAsInstructor(request, reply);
      if (!course) return;

      const catNum = Number(request.params.categoryNumber);
      const gIdx = Number(request.params.groupIndex);
      const categories = normalizeGroupCategories(course.groupCategories || []);
      const cat = categories.find((c) => c.categoryNumber === catNum);
      if (!cat) {
        return reply.code(404).send({ error: 'Not Found', message: 'Category not found' });
      }
      if (gIdx < 0 || gIdx >= cat.groups.length) {
        return reply.code(404).send({ error: 'Not Found', message: 'Group not found' });
      }

      const { studentId } = request.params;
      const group = cat.groups[gIdx];
      const memberIdx = group.members.indexOf(studentId);
      if (memberIdx !== -1) {
        group.members.splice(memberIdx, 1);
      }

      await Course.findByIdAndUpdate(course._id, { $set: { groupCategories: categories } });

      return { groupCategories: categories };
    }
  );

  // GET /:id/groups/csv — Download all group data as CSV
  app.get(
    '/:id/groups/csv',
    { preHandler: authenticate },
    async (request, reply) => {
      const course = await loadCourseAsInstructor(request, reply);
      if (!course) return;

      const categories = normalizeGroupCategories(course.groupCategories || []);

      // Collect all student IDs
      const allStudentIds = new Set();
      for (const cat of categories) {
        for (const g of cat.groups) {
          for (const sid of g.members) allStudentIds.add(sid);
        }
      }

      const studentMap = {};
      if (allStudentIds.size > 0) {
        const students = await User.find({ _id: { $in: [...allStudentIds] } })
          .select('_id profile emails').lean();
        for (const s of students) {
          studentMap[s._id] = s;
        }
      }

      const headers = ['CategoryName', 'CategoryNumber', 'GroupName', 'GroupNumber', 'Email', 'LastName', 'FirstName'];
      const rows = [headers.map(escapeCsvCell).join(',')];

      for (const cat of categories) {
        for (let gi = 0; gi < cat.groups.length; gi++) {
          const g = cat.groups[gi];
          const validMembers = g.members.filter((sid) => studentMap[sid]);
          for (const sid of validMembers) {
            const student = studentMap[sid];
            const email = student.emails?.[0]?.address || '';
            const lastName = student.profile?.lastname || '';
            const firstName = student.profile?.firstname || '';
            rows.push([
              escapeCsvCell(cat.categoryName),
              escapeCsvCell(cat.categoryNumber),
              escapeCsvCell(g.name),
              escapeCsvCell(gi + 1),
              escapeCsvCell(email),
              escapeCsvCell(lastName),
              escapeCsvCell(firstName),
            ].join(','));
          }
        }
      }

      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', 'attachment; filename="groups.csv"');
      return rows.join('\n');
    }
  );

  // POST /:id/groups/csv — Upload CSV to create/update a category
  app.post(
    '/:id/groups/csv',
    {
      preHandler: authenticate,
      schema: {
        body: {
          type: 'object',
          required: ['categoryName', 'csv'],
          properties: {
            categoryName: { type: 'string', minLength: 1 },
            csv: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const course = await loadCourseAsInstructor(request, reply);
      if (!course) return;

      const { categoryName, csv } = request.body;
      const categories = normalizeGroupCategories(course.groupCategories || []);

      // Parse CSV
      const csvRows = parseCsvRows(csv);
      if (csvRows.length < 2) {
        return reply.code(400).send({ error: 'Bad Request', message: 'CSV must have a header row and at least one data row' });
      }

      // Detect columns from header
      const header = csvRows[0].map((h) => h.toLowerCase().trim());
      const emailIdx = header.findIndex((h) => h === 'email');
      const groupNameIdx = header.findIndex((h) => h === 'groupname');

      if (emailIdx === -1) {
        return reply.code(400).send({ error: 'Bad Request', message: 'CSV must contain an "Email" column' });
      }

      // Build group map from CSV
      const groupMap = new Map(); // groupName -> [email]
      for (let i = 1; i < csvRows.length; i++) {
        const row = csvRows[i];
        const email = (row[emailIdx] || '').trim().toLowerCase();
        if (!email) continue;
        const groupName = groupNameIdx !== -1 ? (row[groupNameIdx] || '').trim() : 'Group 1';
        if (!groupMap.has(groupName)) groupMap.set(groupName, []);
        groupMap.get(groupName).push(email);
      }

      // Look up users by email
      const allEmails = [];
      for (const emails of groupMap.values()) {
        allEmails.push(...emails);
      }
      const uniqueEmails = [...new Set(allEmails)];
      const users = await User.find({ 'emails.address': { $in: uniqueEmails } })
        .select('_id emails').lean();
      const emailToUserId = {};
      for (const u of users) {
        for (const e of (u.emails || [])) {
          emailToUserId[e.address.toLowerCase()] = u._id;
        }
      }

      // Build groups
      const groups = [];
      let groupNum = 1;
      for (const [groupName, emails] of groupMap) {
        const members = emails
          .map((e) => emailToUserId[e])
          .filter(Boolean);
        groups.push({ name: groupName || `Group ${groupNum}`, members });
        groupNum++;
      }

      // Remove existing category with same name if present
      const existingIdx = categories.findIndex((c) => c.categoryName === categoryName);
      const maxCatNumber = categories.reduce((max, c) => Math.max(max, c.categoryNumber || 0), 0);
      const newCategory = {
        categoryNumber: existingIdx !== -1 ? categories[existingIdx].categoryNumber : maxCatNumber + 1,
        categoryName,
        groups,
      };

      if (existingIdx !== -1) {
        categories[existingIdx] = newCategory;
      } else {
        categories.push(newCategory);
      }

      await Course.findByIdAndUpdate(course._id, { $set: { groupCategories: categories } });

      const notFound = uniqueEmails.filter((e) => !emailToUserId[e]);

      return reply.code(201).send({
        groupCategories: categories,
        imported: {
          groups: groups.length,
          students: allEmails.length - notFound.length,
          notFound,
        },
      });
    }
  );
}
