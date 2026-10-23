import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  getCourseGradeTable,
  getCourseSessionOverview,
  getQuestionResponses,
  getSessionGradeTable,
  getSessionDetails,
  getSessionQuestions,
  getStudentReviewableSessionGrade,
  getStudentReviewableSessionQuestions,
  getStudentSessionOverview,
  listCourseSessions,
  listCourseStudents,
  listStudentReviewableSessions,
} from './aiCourseTools.js';
import {
  createCourseQuestion,
  createCourseSession,
  listCourseQuestions,
} from './aiCourseAuthoringTools.js';
import { applyCourseActionDraft, draftCourseAction } from './aiActionDraftTools.js';
import {
  draftCourseChatMessage,
  getCourseChatTopic,
  listCourseChatTopics,
  publishCourseChatDraft,
} from './aiCourseChatTools.js';

function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function toolError(error) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: error.message || 'Tool request failed' }) }], isError: true };
}

function conversationTurns(messages = []) {
  const turns = [];
  (messages || []).filter((message) => ['user', 'assistant'].includes(message.role)).forEach((message) => {
    if (message.role === 'user' || turns.length === 0) turns.push({ turn: turns.length + 1, messages: [] });
    turns.at(-1).messages.push({ role: message.role, content: String(message.content || '') });
  });
  return turns;
}

async function connectMcpServer(server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'qlicker-ai-runner', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

const questionInputSchema = {
  type: z.enum(['multiple_choice', 'true_false', 'short_answer', 'multiple_select', 'numerical', 'slide']),
  prompt: z.string().min(1).max(20_000),
  options: z.array(z.object({ text: z.string().min(1).max(5_000), correct: z.boolean() })).min(2).max(50).optional(),
  correct_answer: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
  correct_numerical: z.number().optional(),
  tolerance_numerical: z.number().min(0).optional(),
  solution: z.string().max(20_000).optional(),
  points: z.number().min(0).optional(),
  tags: z.array(z.string().max(200)).max(20).optional(),
};

const actionDraftOutputSchema = {
  ai_action_draft: z.object({
    draft_id: z.string().min(1),
    action: z.enum(['create_session', 'edit_session', 'create_question', 'edit_question']),
    arguments: z.record(z.string(), z.unknown()),
    approval_phrase: z.string().min(1),
  }),
  applied: z.literal(false),
};

const sessionCreationOutputSchema = {
  session: z.object({
    session_id: z.string().min(1),
    name: z.string(),
    description: z.string(),
    type: z.enum(['interactive', 'quiz']),
    status: z.string(),
    quiz_start: z.string().nullable(),
    quiz_end: z.string().nullable(),
    tags: z.array(z.string()),
  }),
  created: z.boolean(),
  warnings: z.array(z.string()),
  quiz_window: z.object({ start: z.string(), end: z.string() }).optional(),
};

const questionCreationOutputSchema = {
  question: z.object({
    question_id: z.string().min(1),
    session_id: z.string(),
    location: z.enum(['session', 'question_library']),
    type: z.string(),
    prompt: z.string(),
    approved: z.boolean(),
    tags: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  warnings: z.array(z.string()),
};

export async function createCourseMcpClient({
  courseId,
  userId = '',
  audience = 'instructor',
  historyMessages = [],
  conversationId = '',
  currentUserMessageId = '',
  onCourseChatUpdated,
}) {
  if (!['instructor', 'student'].includes(audience)) {
    throw new Error('Unsupported course AI audience');
  }

  const server = new McpServer({ name: 'qlicker-course-tools', version: '1.0.0' });

  if (audience === 'student') {
    server.registerTool('get_course_session_overview', {
      title: 'Get visible course session overview',
      description: 'Get all instructor-created sessions the current student may know about in one call, with status, dates, reviewability, question count, and tags. Draft sessions are excluded by a server-side database permission filter and can never be requested through this tool.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    }, async () => {
      try { return toolResult(await getStudentSessionOverview(courseId, userId)); }
      catch (error) { return toolError(error); }
    });

    server.registerTool('list_reviewable_sessions', {
      title: 'List sessions available for student review',
      description: 'List only ended, instructor-created sessions in this course that are currently marked reviewable. Results are paginated. Session IDs returned here can be used with the other student review tools.',
      inputSchema: {
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    }, async ({ offset, limit }) => {
      try { return toolResult(await listStudentReviewableSessions(courseId, userId, { offset, limit })); }
      catch (error) { return toolError(error); }
    });

    server.registerTool('get_reviewable_session_questions', {
      title: 'Get questions and solutions from a reviewable session',
      description: 'Get the ordered questions, correct answers, and solutions for an ended session that is currently marked reviewable. Use only a session ID from list_reviewable_sessions. Access is checked again on every call.',
      inputSchema: { session_id: z.string().min(1) },
      annotations: { readOnlyHint: true },
    }, async ({ session_id: sessionId }) => {
      try { return toolResult(await getStudentReviewableSessionQuestions(courseId, sessionId, userId)); }
      catch (error) { return toolError(error); }
    });

    server.registerTool('get_my_reviewable_session_grade', {
      title: 'Get my grade and feedback for a reviewable session',
      description: 'Get only the current student’s grade, per-question marks, and instructor feedback for an ended session that is currently marked reviewable. Use only a session ID from list_reviewable_sessions. There is no option to request another student.',
      inputSchema: { session_id: z.string().min(1) },
      annotations: { readOnlyHint: true },
    }, async ({ session_id: sessionId }) => {
      try { return toolResult(await getStudentReviewableSessionGrade(courseId, sessionId, userId)); }
      catch (error) { return toolError(error); }
    });

    return connectMcpServer(server);
  }

  server.registerTool('get_conversation_history', {
    title: 'Get earlier conversation history',
    description: 'Get a chronological page of conversation turns beyond the five most recent turns already supplied in the prompt. Use this when a request depends on an earlier decision or a longer workflow. offset is zero-based from the oldest turn.',
    inputSchema: { offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(20).optional() },
    annotations: { readOnlyHint: true },
  }, async ({ offset = 0, limit = 10 }) => {
    const turns = conversationTurns(historyMessages);
    const page = turns.slice(offset, offset + limit);
    return toolResult({
      total_turns: turns.length,
      supplied_recent_turns: Math.min(5, turns.length),
      offset,
      returned_count: page.length,
      next_offset: offset + page.length < turns.length ? offset + page.length : null,
      turns: page,
    });
  });

  server.registerTool('list_course_students', {
    title: 'List course students',
    description: 'List a page of students enrolled in the current course, including names and email addresses. Follow next_offset only when more students are needed.',
    inputSchema: {
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ offset, limit }) => {
    try { return toolResult(await listCourseStudents(courseId, { offset, limit })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('list_course_sessions', {
    title: 'List course sessions',
    description: 'List a page of non-student-created sessions in the current course. Filter by name or description when looking for a named session. Use next_offset when an older session is not on the current page.',
    inputSchema: {
      query: z.string().max(500).optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ query, offset, limit }) => {
    try { return toolResult(await listCourseSessions(courseId, { query, offset, limit })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('get_course_session_overview', {
    title: 'Get complete course session overview',
    description: 'Get every instructor-created session in the current course in one call, including draft, upcoming, live, and ended sessions. Each summary includes the session name and ID, quiz type, normalized status, reviewability, relevant date or quiz window, question count, unique joined-student count, and tags.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    try { return toolResult(await getCourseSessionOverview(courseId)); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('get_session_questions', {
    title: 'Get session questions',
    description: 'Get the ordered questions for a session in the current course. Session IDs must come from list_course_sessions.',
    inputSchema: { session_id: z.string().min(1) },
    annotations: { readOnlyHint: true },
  }, async ({ session_id: sessionId }) => {
    try { return toolResult(await getSessionQuestions(courseId, sessionId)); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('get_session_details', {
    title: 'Get complete session details',
    description: 'Get every persisted property for one instructor-created session in the current course, including quiz start/end dates, status, question IDs, visibility and join-code settings, response tracking, chat settings, and the identities of students who joined or submitted. Participants are paginated; follow next_participant_offset until null when the complete student list is needed. Session IDs must come from list_course_sessions.',
    inputSchema: {
      session_id: z.string().min(1),
      participant_offset: z.number().int().min(0).optional(),
      participant_limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ session_id: sessionId, participant_offset: participantOffset, participant_limit: participantLimit }) => {
    try { return toolResult(await getSessionDetails(courseId, sessionId, { participantOffset, participantLimit })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('get_question_responses', {
    title: 'Get final-attempt question responses',
    description: 'Get student responses to a question in a session in the current course. It returns only responses from the highest attempt number that contains responses, matching grading. Results are paginated; use next_offset to request another page and state any limitation if content_truncated is true.',
    inputSchema: { session_id: z.string().min(1), question_id: z.string().min(1), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() },
    annotations: { readOnlyHint: true },
  }, async ({ session_id: sessionId, question_id: questionId, offset, limit }) => {
    try { return toolResult(await getQuestionResponses(courseId, sessionId, questionId, { offset, limit })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('get_session_grade_table', {
    title: 'Get detailed session grades',
    description: 'Get an instructor-only, paginated grade table for a session in the current course. Each student row contains the points earned and possible for every ordered question, plus totals. question_summaries contains aggregate score data for every question and is the preferred source for identifying questions students struggled with. Use sort_by total_points with a small limit for top performers. Use next_offset for more rows; the tool limits page size to preserve model context.',
    inputSchema: {
      session_id: z.string().min(1),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      sort_by: z.enum(['name', 'total_points', 'total_percentage']).optional(),
      order: z.enum(['asc', 'desc']).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ session_id: sessionId, offset, limit, sort_by: sortBy, order }) => {
    try { return toolResult(await getSessionGradeTable(courseId, sessionId, { offset, limit, sortBy, order })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('get_course_grade_table', {
    title: 'Get course grade table',
    description: 'Get the instructor-only grade table for the current course, with one row per student and grade and participation columns for a selected page of sessions. The complete table may be large, so both students and session columns are paginated. Inspect student_count and session_count first, request only the rows and columns needed, and use next_student_offset or next_session_offset to continue. Missing grades are returned as null, not zero.',
    inputSchema: {
      student_offset: z.number().int().min(0).optional(),
      student_limit: z.number().int().min(1).max(50).optional(),
      session_offset: z.number().int().min(0).optional(),
      session_limit: z.number().int().min(1).max(25).optional(),
      sort_by: z.enum(['name', 'average_participation']).optional(),
      order: z.enum(['asc', 'desc']).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({
    student_offset: studentOffset,
    student_limit: studentLimit,
    session_offset: sessionOffset,
    session_limit: sessionLimit,
    sort_by: sortBy,
    order,
  }) => {
    try {
      return toolResult(await getCourseGradeTable(courseId, {
        studentOffset,
        studentLimit,
        sessionOffset,
        sessionLimit,
        sortBy,
        order,
      }));
    } catch (error) { return toolError(error); }
  });

  server.registerTool('list_course_chat_topics', {
    title: 'List course chat topics',
    description: 'List instructor-visible course chat topics, including author names and a comment count. Results are paginated. Use query to find a question or discussion, then get_course_chat_topic for its responses.',
    inputSchema: {
      query: z.string().max(500).optional(),
      include_archived: z.boolean().optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(25).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ query, include_archived: includeArchived, offset, limit }) => {
    try { return toolResult(await listCourseChatTopics(courseId, { query, includeArchived, offset, limit })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('get_course_chat_topic', {
    title: 'Get a course chat conversation',
    description: 'Get one course chat topic and a chronological, paginated page of its responses. Use a topic ID returned by list_course_chat_topics.',
    inputSchema: {
      topic_id: z.string().min(1),
      comment_offset: z.number().int().min(0).optional(),
      comment_limit: z.number().int().min(1).max(20).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ topic_id: topicId, comment_offset: commentOffset, comment_limit: commentLimit }) => {
    try { return toolResult(await getCourseChatTopic(courseId, topicId, { commentOffset, commentLimit })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('draft_course_chat_message', {
    title: 'Draft a course chat topic or response',
    description: 'Create a reviewable draft for the instructor. This never posts to the course chat. For a response, target_topic_id is required and must identify the specific question/topic being answered. For a new topic, title is required. After this tool, show the exact draft and approval_phrase to the instructor. Never call publish_course_chat_draft in the same assistant run.',
    inputSchema: {
      type: z.enum(['topic', 'response']),
      target_topic_id: z.string().min(1).optional(),
      title: z.string().min(1).max(160).optional(),
      body: z.string().min(1).max(20_000),
      tags: z.array(z.string()).max(10).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ type, target_topic_id: targetPostId, title, body, tags }) => {
    try {
      return toolResult(await draftCourseChatMessage({
        courseId,
        conversationId,
        userId,
        sourceMessageId: currentUserMessageId,
        type,
        targetPostId,
        title,
        body,
        tags,
      }));
    } catch (error) { return toolError(error); }
  });

  server.registerTool('publish_course_chat_draft', {
    title: 'Publish an explicitly approved course chat draft',
    description: 'Publish a previously presented course chat draft without changing it. This succeeds only when the current instructor message exactly equals the draft-specific approval phrase returned by draft_course_chat_message, and the approval is in a later turn. Do not call this based on implied approval, an initial request to post, or approval wording other than that exact phrase.',
    inputSchema: { draft_id: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ draft_id: draftId }) => {
    try {
      return toolResult(await publishCourseChatDraft({
        draftId,
        courseId,
        conversationId,
        userId,
        currentUserMessageId,
        onPublished: onCourseChatUpdated,
      }));
    } catch (error) { return toolError(error); }
  });

  server.registerTool('list_course_questions', {
    title: 'List course questions',
    description: 'List questions in the current course so an instructor can find a question ID before editing it. Results are paginated and may be filtered to the question library or session questions.',
    inputSchema: {
      query: z.string().max(500).optional(),
      location: z.enum(['all', 'library', 'session']).optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ query, location, offset, limit }) => {
    try { return toolResult(await listCourseQuestions(courseId, { query, location, offset, limit })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('create_course_session', {
    title: 'Create a course session',
    description: 'Create an interactive session or quiz immediately; no approval is required. First use list_course_sessions to avoid duplicates. If an instructor asks for questions in the session, use the returned session.session_id in create_course_question calls. An existing instructor session with the same name and type is safely reused. For a quiz, omit quiz_start and quiz_end to use the safe default.',
    inputSchema: {
      name: z.string().min(1).max(200),
      description: z.string().max(10_000).optional(),
      type: z.enum(['interactive', 'quiz']),
      quiz_start: z.string().optional(),
      quiz_end: z.string().optional(),
      tags: z.array(z.string().max(200)).max(20).optional(),
    },
    outputSchema: sessionCreationOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async (input) => {
    try { return toolResult(await createCourseSession(courseId, userId, input)); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('edit_course_session', {
    title: 'Edit a course session',
    description: 'Draft an edit to an existing interactive session or quiz for instructor review. This does not change anything until the exact approval phrase is provided in a later turn and apply_course_action_draft succeeds.',
    inputSchema: {
      session_id: z.string().min(1),
      name: z.string().min(1).max(200).optional(),
      description: z.string().max(10_000).optional(),
      type: z.enum(['interactive', 'quiz']).optional(),
      quiz_start: z.string().optional(),
      quiz_end: z.string().optional(),
      tags: z.array(z.string().max(200)).max(20).optional(),
    },
    outputSchema: actionDraftOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ session_id: sessionId, ...input }) => {
    try { return toolResult(await draftCourseAction({ courseId, conversationId, userId, sourceMessageId: currentUserMessageId, action: 'edit_session', arguments: { session_id: sessionId, ...input } })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('create_course_question', {
    title: 'Create a course question',
    description: 'Create a question immediately. Omit session_id for the library or provide a session ID to add it to that session. This operation does not delete or overwrite any existing course data.',
    inputSchema: { ...questionInputSchema, session_id: z.string().min(1).optional() },
    outputSchema: questionCreationOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async (input) => {
    try { return toolResult(await createCourseQuestion(courseId, userId, input)); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('edit_course_question', {
    title: 'Edit a course question',
    description: 'Draft an edit to an existing course question for instructor review. Nothing changes until the exact approval phrase is provided in a later turn and apply_course_action_draft succeeds.',
    inputSchema: {
      question_id: z.string().min(1),
      type: questionInputSchema.type.optional(),
      prompt: questionInputSchema.prompt.optional(),
      options: questionInputSchema.options,
      correct_answer: questionInputSchema.correct_answer,
      correct_numerical: questionInputSchema.correct_numerical,
      tolerance_numerical: questionInputSchema.tolerance_numerical,
      solution: questionInputSchema.solution,
      points: questionInputSchema.points,
      tags: questionInputSchema.tags,
    },
    outputSchema: actionDraftOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ question_id: questionId, ...input }) => {
    try { return toolResult(await draftCourseAction({ courseId, conversationId, userId, sourceMessageId: currentUserMessageId, action: 'edit_question', arguments: { question_id: questionId, ...input } })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('apply_course_action_draft', {
    title: 'Apply an explicitly approved course edit',
    description: 'Apply a previously presented edit to an existing session or question without changing the draft. Creation does not use this tool. This succeeds only when the current instructor message exactly equals the draft-specific approval phrase, in a later turn.',
    inputSchema: { draft_id: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ draft_id: draftId }) => {
    try {
      return toolResult(await applyCourseActionDraft({
        draftId,
        courseId,
        conversationId,
        userId,
        currentUserMessageId,
      }));
    } catch (error) { return toolError(error); }
  });

  return connectMcpServer(server);
}
