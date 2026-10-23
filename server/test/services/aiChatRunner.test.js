import { describe, expect, it } from 'vitest';
import {
  courseChatMaxToolRounds,
  currentDateTimeContext,
  DEFAULT_INSTRUCTOR_CHAT_MAX_TOOL_ROUNDS,
  DEFAULT_STUDENT_CHAT_MAX_TOOL_ROUNDS,
  instructorCreationGoals,
  normalizeAiArtifacts,
  recentConversationMessages,
  systemMessage,
} from '../../src/services/aiChatRunner.js';

describe('AI chat current date and time context', () => {
  const now = new Date('2026-08-31T18:30:45.000Z');

  it('formats the server clock in the quiz-date timezone for both audiences', () => {
    const expected = 'The current date and time is 2026-08-31 14:30:45 (America/Toronto, UTC-04:00). Quiz dates and times use this timezone.';

    expect(currentDateTimeContext('America/Toronto', now)).toBe(expected);
    expect(systemMessage({ name: 'Physics' }, 'instructor', { timeZone: 'America/Toronto', now }).content)
      .toContain(expected);
    expect(systemMessage({ name: 'Physics' }, 'student', { timeZone: 'America/Toronto', now }).content)
      .toContain(expected);
  });

  it('uses UTC when a client supplies an invalid timezone', () => {
    expect(currentDateTimeContext('not/a-timezone', now))
      .toContain('2026-08-31 18:30:45 (UTC, UTC+00:00)');
  });
});

describe('recentConversationMessages', () => {
  it('keeps the five most recent user prompts and their assistant responses', () => {
    const messages = Array.from({ length: 7 }, (_, index) => {
      const number = index + 1;
      return [
        { role: 'user', content: `Question ${number}` },
        { role: 'assistant', content: `Response ${number}` },
      ];
    }).flat();

    expect(recentConversationMessages(messages)).toEqual([
      { role: 'user', content: 'Question 3' },
      { role: 'assistant', content: 'Response 3' },
      { role: 'user', content: 'Question 4' },
      { role: 'assistant', content: 'Response 4' },
      { role: 'user', content: 'Question 5' },
      { role: 'assistant', content: 'Response 5' },
      { role: 'user', content: 'Question 6' },
      { role: 'assistant', content: 'Response 6' },
      { role: 'user', content: 'Question 7' },
      { role: 'assistant', content: 'Response 7' },
    ]);
  });
});

describe('normalizeAiArtifacts', () => {
  it('keeps only safe root-relative artifact metadata and mints opaque IDs', () => {
    const [artifact] = normalizeAiArtifacts([
      {
        kind: 'image',
        path: '/api/files/generated/chart.png',
        filename: 'chart.png',
        mime_type: 'IMAGE/PNG',
        label: 'Velocity chart',
        apiToken: 'must-not-survive',
      },
      { kind: 'audio', path: 'https://qrag.example/private.mp3' },
      { kind: 'file', path: '/api/files/%2e%2e/secret' },
      { kind: 'file', path: '//other-host/secret' },
    ]);

    expect(artifact).toMatchObject({
      kind: 'image',
      sourcePath: '/api/files/generated/chart.png',
      filename: 'chart.png',
      mimeType: 'image/png',
      label: 'Velocity chart',
    });
    expect(artifact._id).toEqual(expect.any(String));
    expect(artifact).not.toHaveProperty('apiToken');
    expect(normalizeAiArtifacts(Array.from({ length: 20 }, (_, index) => ({ path: `/api/files/${index}`, kind: 'file' })))).toHaveLength(10);
  });
});

describe('instructorCreationGoals', () => {
  it('detects a combined session and counted-question creation request', () => {
    expect(instructorCreationGoals([{
      role: 'user',
      content: 'Create an interactive session called L6 and include three multiple-choice questions.',
    }])).toEqual({ session: true, questions: true, questionCount: 3 });
  });

  it('does not turn how-to questions into course mutations', () => {
    expect(instructorCreationGoals([{
      role: 'user',
      content: 'How do I create a session?',
    }])).toBeNull();
    expect(instructorCreationGoals([{
      role: 'user',
      content: 'Do not create a session; just explain the workflow.',
    }])).toBeNull();
  });
});

describe('course AI chat tool-round limits', () => {
  it('uses separate course settings for instructor and student chat', () => {
    const course = {
      aiInstructorChatMaxToolRounds: 27,
      aiStudentChatMaxToolRounds: 4,
    };

    expect(courseChatMaxToolRounds(course, 'instructor')).toBe(27);
    expect(courseChatMaxToolRounds(course, 'student')).toBe(4);
  });

  it('uses safe audience-specific defaults for missing or invalid values', () => {
    expect(courseChatMaxToolRounds({}, 'instructor')).toBe(DEFAULT_INSTRUCTOR_CHAT_MAX_TOOL_ROUNDS);
    expect(courseChatMaxToolRounds({}, 'student')).toBe(DEFAULT_STUDENT_CHAT_MAX_TOOL_ROUNDS);
    expect(courseChatMaxToolRounds({ aiInstructorChatMaxToolRounds: 100 }, 'instructor'))
      .toBe(DEFAULT_INSTRUCTOR_CHAT_MAX_TOOL_ROUNDS);
    expect(courseChatMaxToolRounds({ aiStudentChatMaxToolRounds: 0 }, 'student'))
      .toBe(DEFAULT_STUDENT_CHAT_MAX_TOOL_ROUNDS);
  });
});
