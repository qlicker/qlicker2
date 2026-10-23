import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import Course from '../../src/models/Course.js';
import Question from '../../src/models/Question.js';
import Response from '../../src/models/Response.js';
import Session from '../../src/models/Session.js';
import User from '../../src/models/User.js';
import {
  getCourseSessionOverview,
  getQuestionResponses,
  getSessionDetails,
  getStudentSessionOverview,
} from '../../src/services/aiCourseTools.js';
import { getAnonymousParticipantId } from '../../src/utils/anonymousSession.js';

describe('AI course session overview tools', () => {
  it('returns all instructor sessions but never exposes drafts to students', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const course = await Course.create({
      name: 'Overview course', deptCode: 'TEST', courseNumber: '200', section: '001', semester: 'Fall 2026',
      owner: 'prof-overview', instructors: ['prof-overview'], students: ['student-overview'], enrollmentCode: 'OVERV1',
    });
    const now = new Date('2026-09-01T15:00:00.000Z');
    const sessions = await Session.create([
      {
        name: 'Draft planning session', courseId: course._id, creator: 'prof-overview', status: 'hidden',
        date: new Date('2026-08-30T15:00:00.000Z'), questions: ['q-draft'], tags: [{ value: 'private', label: 'Private' }],
      },
      {
        name: 'Upcoming quiz', courseId: course._id, creator: 'prof-overview', status: 'visible', quiz: true,
        quizStart: new Date('2026-09-03T15:00:00.000Z'), quizEnd: new Date('2026-09-03T16:00:00.000Z'),
        questions: ['q-1', 'q-2'], reviewable: false, tags: [{ value: 'unit-1', label: 'Unit 1' }],
      },
      {
        name: 'Quiz in progress', courseId: course._id, creator: 'prof-overview', status: 'visible', quiz: true,
        quizStart: new Date('2026-09-01T14:00:00.000Z'), quizEnd: new Date('2026-09-01T16:00:00.000Z'),
        questions: ['q-3'], joined: ['student-overview'],
        joinRecords: [{ userId: 'student-overview' }, { userId: 'student-2' }],
        tags: [{ value: 'exam', label: 'Exam' }],
      },
      {
        name: 'Ended interactive', courseId: course._id, creator: 'prof-overview', status: 'done',
        date: new Date('2026-08-20T14:00:00.000Z'), reviewable: true, questions: ['q-4', 'q-5', 'q-6'],
      },
      {
        name: 'Private student practice', courseId: course._id, creator: 'another-student', studentCreated: true,
        status: 'running', practiceQuiz: true,
      },
    ]);

    const instructorResult = await getCourseSessionOverview(course._id, { now });
    expect(instructorResult.session_count).toBe(4);
    expect(instructorResult.sessions.map((session) => session.name)).toContain('Draft planning session');
    expect(instructorResult.sessions.find((session) => session.name === 'Quiz in progress')).toMatchObject({
      session_id: sessions[2]._id,
      quiz: true,
      status: 'live',
      reviewable: false,
      quiz_start: '2026-09-01T14:00:00.000Z',
      quiz_end: '2026-09-01T16:00:00.000Z',
      date: null,
      question_count: 1,
      joined_student_count: 2,
      tags: ['Exam'],
    });
    expect(instructorResult.sessions.find((session) => session.name === 'Draft planning session')?.status).toBe('draft');

    const studentResult = await getStudentSessionOverview(course._id, 'student-overview', { now });
    expect(studentResult.session_count).toBe(3);
    expect(studentResult.sessions.map((session) => session.name)).toEqual(expect.arrayContaining([
      'Upcoming quiz', 'Quiz in progress', 'Ended interactive',
    ]));
    expect(studentResult.sessions.map((session) => session.name)).not.toContain('Draft planning session');
    expect(studentResult.sessions.map((session) => session.name)).not.toContain('Private student practice');
    expect(studentResult.sessions.find((session) => session.name === 'Ended interactive')).toMatchObject({
      status: 'ended',
      reviewable: true,
      date: '2026-08-20T14:00:00.000Z',
      quiz_start: null,
      quiz_end: null,
      question_count: 3,
      tags: [],
    });
    expect(studentResult.sessions[0]).not.toHaveProperty('joined_student_count');
  });
});

describe('AI course session detail tool', () => {
  it('returns every session property and paginated participant identities', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const course = await Course.create({
      name: 'Mechanics', deptCode: 'PHYS', courseNumber: '123', section: '001', semester: 'Fall 2026',
      owner: 'prof-1', instructors: ['prof-1'], enrollmentCode: 'ABC123',
    });
    const students = await User.create([
      { _id: 'student-1', profile: { firstname: 'Ada', lastname: 'Lovelace' }, emails: [{ address: 'ada@example.com' }] },
      { _id: 'student-2', profile: { firstname: 'Emmy', lastname: 'Noether' }, emails: [{ address: 'emmy@example.com' }] },
      { _id: 'student-3', profile: { firstname: 'Srinivasa', lastname: 'Ramanujan' }, emails: [{ address: 'ramanujan@example.com' }] },
    ]);
    const session = await Session.create({
      name: 'Chapter 8 quiz',
      description: 'Complete session metadata',
      courseId: course._id,
      creator: 'prof-1',
      status: 'visible',
      quiz: true,
      quizStart: new Date('2026-08-28T13:00:00.000Z'),
      quizEnd: new Date('2026-08-28T14:00:00.000Z'),
      quizExtensions: [{ userId: students[2]._id, quizStart: new Date('2026-08-28T13:30:00.000Z'), quizEnd: new Date('2026-08-28T14:30:00.000Z') }],
      questions: ['question-1', 'question-2'],
      joined: [students[0]._id, students[1]._id],
      joinRecords: [{ userId: students[0]._id, joinedAt: new Date('2026-08-28T12:58:00.000Z'), joinedWithCode: true }],
      submittedQuiz: [students[1]._id],
      questionResponseCounts: { 'question-1': 2 },
      joinCodeEnabled: true,
      currentJoinCode: '2468',
      chatEnabled: true,
    });

    const firstPage = await getSessionDetails(course._id, session._id, { participantLimit: 2 });

    expect(firstPage.session).toMatchObject({
      _id: session._id,
      name: 'Chapter 8 quiz',
      quiz: true,
      quizStart: '2026-08-28T13:00:00.000Z',
      quizEnd: '2026-08-28T14:00:00.000Z',
      questions: ['question-1', 'question-2'],
      joinCodeEnabled: true,
      currentJoinCode: '2468',
      chatEnabled: true,
      questionResponseCounts: { 'question-1': 2 },
    });
    expect(firstPage).toMatchObject({
      joined_student_count: 2,
      submitted_quiz_student_count: 1,
      participant_count: 3,
      returned_participant_count: 2,
      next_participant_offset: 2,
    });
    expect(firstPage.participants).toEqual([
      expect.objectContaining({
        student: expect.objectContaining({ student_id: 'student-1', name: 'Ada Lovelace', email: 'ada@example.com' }),
        joined: true,
        joined_at: '2026-08-28T12:58:00.000Z',
        joined_with_code: true,
        submitted_quiz: false,
      }),
      expect.objectContaining({
        student: expect.objectContaining({ student_id: 'student-2', name: 'Emmy Noether' }),
        joined: true,
        submitted_quiz: true,
      }),
    ]);

    const secondPage = await getSessionDetails(course._id, session._id, { participantOffset: 2, participantLimit: 2 });
    expect(secondPage.next_participant_offset).toBeNull();
    expect(secondPage.participants).toEqual([
      expect.objectContaining({
        student: expect.objectContaining({ student_id: 'student-3', name: 'Srinivasa Ramanujan' }),
        joined: false,
        submitted_quiz: false,
        has_quiz_extension: true,
      }),
    ]);
  });
});

describe('AI course tools for anonymous sessions', () => {
  it('lists no participants and labels responses without identities', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const student = await User.create({
      emails: [{ address: 'anon-ai-student@example.com', verified: true }],
      profile: { firstname: 'Hidden', lastname: 'Person', roles: ['student'] },
    });
    const studentId = String(student._id);
    const course = await Course.create({
      name: 'Anonymous AI course', deptCode: 'TEST', courseNumber: '210', section: '001', semester: 'Fall 2026',
      owner: 'prof-anon-ai', instructors: ['prof-anon-ai'], students: [studentId], enrollmentCode: 'ANONAI',
    });
    const session = await Session.create({
      name: 'Anonymous survey', courseId: course._id, creator: 'prof-anon-ai', status: 'done', anonymous: true,
    });
    const participantId = getAnonymousParticipantId(session._id, studentId);
    const question = await Question.create({
      type: 2, content: '<p>Feedback?</p>', plainText: 'Feedback?', courseId: course._id, sessionId: session._id,
      creator: 'prof-anon-ai',
    });
    await Session.updateOne(
      { _id: session._id },
      { $set: { questions: [question._id], joined: [participantId], submittedQuiz: [participantId] } }
    );
    await Response.create({
      questionId: question._id, studentUserId: participantId, attempt: 1, answer: 'More examples please',
    });

    const details = await getSessionDetails(course._id, session._id);
    expect(details).toMatchObject({ anonymous: true, joined_student_count: 1, participants: [] });
    expect(JSON.stringify(details)).not.toContain(participantId);

    await expect(getQuestionResponses(course._id, session._id, question._id))
      .rejects.toThrow('At least four respondents');
    await Response.insertMany([2, 3, 4].map((number) => ({
      questionId: question._id,
      studentUserId: getAnonymousParticipantId(session._id, `anon-ai-student-${number}`),
      attempt: 1,
      answer: `Feedback ${number}`,
    })));
    const responses = await getQuestionResponses(course._id, session._id, question._id);
    expect(responses.responses).toHaveLength(4);
    const expectedAnswerOrder = [
      [participantId, 'More examples please'],
      ...[2, 3, 4].map((number) => [
        getAnonymousParticipantId(session._id, `anon-ai-student-${number}`),
        `Feedback ${number}`,
      ]),
    ].sort(([left], [right]) => left.localeCompare(right)).map(([, answer]) => answer);
    expect(responses.responses.map((response) => response.answer)).toEqual(expectedAnswerOrder);
    expect(responses.responses).toEqual(expect.arrayContaining([
      expect.objectContaining({ answer: 'More examples please' }),
    ]));
    responses.responses.forEach((response) => {
      expect(response.student.student_id).toMatch(/^respondent-[1-4]$/);
      expect(response.student.name).toMatch(/^Anonymous respondent [1-4]$/);
      expect(response.student.email).toBe('');
    });
    const serialized = JSON.stringify(responses);
    expect(serialized).not.toContain(studentId);
    expect(serialized).not.toContain(participantId);
    expect(serialized).not.toContain('Hidden');
  });
});
