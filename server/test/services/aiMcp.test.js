import { describe, expect, it } from 'vitest';
import { createCourseMcpClient } from '../../src/services/aiMcp.js';

describe('course AI MCP audience and history', () => {
  it('gives the student audience only visible-overview, reviewable-session, and own-grade tools', async () => {
    const mcp = await createCourseMcpClient({ courseId: 'course-1', userId: 'student-1', audience: 'student' });
    try {
      const tools = await mcp.client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        'get_course_session_overview',
        'list_reviewable_sessions',
        'get_reviewable_session_questions',
        'get_my_reviewable_session_grade',
      ]);
      expect(tools.tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);
    } finally {
      await mcp.close();
    }
  });

  it('lets instructors request earlier conversation history', async () => {
    const historyMessages = Array.from({ length: 7 }, (_, index) => ([
      { role: 'user', content: `Question ${index + 1}` },
      { role: 'assistant', content: `Answer ${index + 1}` },
    ])).flat();
    const mcp = await createCourseMcpClient({ courseId: 'course-1', audience: 'instructor', historyMessages });
    try {
      const result = await mcp.client.callTool({ name: 'get_conversation_history', arguments: { offset: 0, limit: 2 } });
      const payload = JSON.parse(result.content[0].text);
      expect(payload).toMatchObject({ total_turns: 7, supplied_recent_turns: 5, returned_count: 2, next_offset: 2 });
      expect(payload.turns[0].messages[0].content).toBe('Question 1');
    } finally {
      await mcp.close();
    }
  });

  it('registers authoring tools only for instructors', async () => {
    const mcp = await createCourseMcpClient({ courseId: 'course-1', userId: 'prof-1', audience: 'instructor' });
    try {
      const tools = await mcp.client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        'get_conversation_history',
        'get_course_session_overview',
        'get_session_details',
        'create_course_session',
        'edit_course_session',
        'list_course_questions',
        'create_course_question',
        'edit_course_question',
        'apply_course_action_draft',
        'list_course_chat_topics',
        'get_course_chat_topic',
        'draft_course_chat_message',
        'publish_course_chat_draft',
      ]));
      expect(tools.tools.find((tool) => tool.name === 'create_course_session')?.outputSchema).toBeTruthy();
      expect(tools.tools.find((tool) => tool.name === 'create_course_question')?.outputSchema).toBeTruthy();
    } finally {
      await mcp.close();
    }
  });

  it('rejects malformed authoring arguments before running the tool', async () => {
    const mcp = await createCourseMcpClient({ courseId: 'course-1', userId: 'prof-1', audience: 'instructor' });
    try {
      const result = await mcp.client.callTool({
        name: 'create_course_question',
        arguments: { type: 'multiple_choice', prompt: 'Question', options: 'not-an-array' },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Input validation error');
    } finally {
      await mcp.close();
    }
  });
});
