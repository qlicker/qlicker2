export function getCourseChatEventUnseenDelta(eventPayload) {
  const changeType = String(eventPayload?.changeType || '');
  return changeType === 'post-created' || changeType === 'comment-added' ? 1 : 0;
}
