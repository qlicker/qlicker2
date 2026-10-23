import { describe, expect, it } from 'vitest';
import { getCourseChatEventUnseenDelta } from './courseChat';

describe('getCourseChatEventUnseenDelta', () => {
  it('counts new posts and comments as unseen messages', () => {
    expect(getCourseChatEventUnseenDelta({ changeType: 'post-created' })).toBe(1);
    expect(getCourseChatEventUnseenDelta({ changeType: 'comment-added' })).toBe(1);
  });

  it('ignores non-message chat updates', () => {
    expect(getCourseChatEventUnseenDelta({ changeType: 'post-voted' })).toBe(0);
    expect(getCourseChatEventUnseenDelta({ changeType: 'post-archived' })).toBe(0);
    expect(getCourseChatEventUnseenDelta({ changeType: 'post-unarchived' })).toBe(0);
  });
});
