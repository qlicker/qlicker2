import mongoose from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import AiConversation from '../../src/models/AiConversation.js';
import Course from '../../src/models/Course.js';
import Post from '../../src/models/Post.js';
import User from '../../src/models/User.js';
import {
  courseChatApprovalPhrase,
  draftCourseChatMessage,
  getCourseChatTopic,
  listCourseChatTopics,
  publishCourseChatDraft,
} from '../../src/services/aiCourseChatTools.js';

describe('AI course chat tools', () => {
  it('reads instructor-visible, paginated course chat conversations', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const professor = await User.create({
      _id: 'course-chat-prof',
      profile: { firstname: 'Grace', lastname: 'Hopper', roles: ['professor'] },
      emails: [{ address: 'grace@example.com' }],
    });
    const student = await User.create({
      _id: 'course-chat-student',
      profile: { firstname: 'Ada', lastname: 'Lovelace', roles: ['student'] },
      emails: [{ address: 'ada@example.com' }],
    });
    const course = await Course.create({
      name: 'Course Chat AI',
      deptCode: 'CS',
      courseNumber: '101',
      section: '001',
      semester: 'Fall 2026',
      owner: professor._id,
      instructors: [professor._id],
      students: [student._id],
      enrollmentCode: 'CHAT01',
      courseChatEnabled: true,
    });
    const post = await Post.create({
      scopeType: 'course',
      courseId: course._id,
      authorId: student._id,
      authorRole: 'student',
      title: 'Question about loops',
      body: 'Why does this loop stop?',
      comments: [{
        _id: 'existing-comment',
        authorId: professor._id,
        authorRole: 'instructor',
        body: 'Check the loop condition.',
      }],
    });

    const topics = await listCourseChatTopics(course._id, { query: 'loops', limit: 1 });
    expect(topics).toMatchObject({ topic_count: 1, returned_count: 1, next_offset: null });
    expect(topics.topics[0]).toMatchObject({
      topic_id: post._id,
      author_name: 'Ada Lovelace',
      comment_count: 1,
    });

    const topic = await getCourseChatTopic(course._id, post._id, { commentLimit: 1 });
    expect(topic.comments[0]).toMatchObject({
      comment_id: 'existing-comment',
      author_name: 'Grace Hopper',
      body: 'Check the loop condition.',
    });
  });

  it('requires an exact later-turn approval before publishing the unchanged draft', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const course = await Course.create({
      name: 'Strict Approval',
      deptCode: 'CS',
      courseNumber: '102',
      section: '001',
      semester: 'Fall 2026',
      owner: 'approval-prof',
      instructors: ['approval-prof'],
      enrollmentCode: 'CHAT02',
      courseChatEnabled: true,
      tags: [{ value: 'deadlines', label: 'Deadlines' }],
    });
    const target = await Post.create({
      scopeType: 'course',
      courseId: course._id,
      authorId: 'student-1',
      authorRole: 'student',
      title: 'Specific student question',
      body: 'Can you clarify the deadline?',
    });
    const conversation = await AiConversation.create({
      _id: 'approval-conversation',
      courseId: course._id,
      ownerId: 'approval-prof',
      messages: [{ _id: 'request-message', role: 'user', content: 'Please respond to the deadline question.' }],
    });
    const drafted = await draftCourseChatMessage({
      courseId: course._id,
      conversationId: conversation._id,
      userId: 'approval-prof',
      sourceMessageId: 'request-message',
      type: 'response',
      targetPostId: target._id,
      body: 'The deadline is Friday at 5 PM.',
    });
    const draftId = drafted.course_chat_draft.draft_id;
    const onPublished = vi.fn();

    await expect(publishCourseChatDraft({
      draftId,
      courseId: course._id,
      conversationId: conversation._id,
      userId: 'approval-prof',
      currentUserMessageId: 'request-message',
      onPublished,
    })).rejects.toThrow('cannot be approved in the same turn');

    await AiConversation.findByIdAndUpdate(conversation._id, {
      $push: { messages: { _id: 'vague-message', role: 'user', content: 'Yes, that looks good.' } },
    });
    await expect(publishCourseChatDraft({
      draftId,
      courseId: course._id,
      conversationId: conversation._id,
      userId: 'approval-prof',
      currentUserMessageId: 'vague-message',
      onPublished,
    })).rejects.toThrow('exact approval phrase');
    expect((await Post.findById(target._id).lean()).comments).toHaveLength(0);

    await AiConversation.findByIdAndUpdate(conversation._id, {
      $push: { messages: { _id: 'approval-message', role: 'user', content: courseChatApprovalPhrase(draftId) } },
    });
    const published = await publishCourseChatDraft({
      draftId,
      courseId: course._id,
      conversationId: conversation._id,
      userId: 'approval-prof',
      currentUserMessageId: 'approval-message',
      onPublished,
    });
    expect(published).toMatchObject({ posted: true, course_chat_publication: { type: 'response', topic_id: target._id } });
    expect((await Post.findById(target._id).lean()).comments).toEqual([
      expect.objectContaining({ _id: draftId, body: 'The deadline is Friday at 5 PM.', authorRole: 'instructor' }),
    ]);
    expect(onPublished).toHaveBeenCalledWith(expect.objectContaining({ changeType: 'comment-added', postId: target._id }));

    await publishCourseChatDraft({
      draftId,
      courseId: course._id,
      conversationId: conversation._id,
      userId: 'approval-prof',
      currentUserMessageId: 'approval-message',
      onPublished,
    });
    expect((await Post.findById(target._id).lean()).comments).toHaveLength(1);
    expect(onPublished).toHaveBeenCalledTimes(1);

    await AiConversation.findByIdAndUpdate(conversation._id, {
      $push: { messages: { _id: 'topic-request', role: 'user', content: 'Create a deadline announcement.' } },
    });
    const topicDraft = await draftCourseChatMessage({
      courseId: course._id,
      conversationId: conversation._id,
      userId: 'approval-prof',
      sourceMessageId: 'topic-request',
      type: 'topic',
      title: 'Assignment deadline',
      body: 'Remember that the assignment is due Friday at 5 PM.',
      tags: ['Deadlines'],
    });
    const topicDraftId = topicDraft.course_chat_draft.draft_id;
    await AiConversation.findByIdAndUpdate(conversation._id, {
      $push: { messages: { _id: 'topic-approval', role: 'user', content: courseChatApprovalPhrase(topicDraftId) } },
    });
    await publishCourseChatDraft({
      draftId: topicDraftId,
      courseId: course._id,
      conversationId: conversation._id,
      userId: 'approval-prof',
      currentUserMessageId: 'topic-approval',
      onPublished,
    });
    expect(await Post.findById(topicDraftId).lean()).toMatchObject({
      scopeType: 'course',
      courseId: String(course._id),
      title: 'Assignment deadline',
      body: 'Remember that the assignment is due Friday at 5 PM.',
      tags: ['deadlines'],
      authorRole: 'instructor',
    });
  });
});
