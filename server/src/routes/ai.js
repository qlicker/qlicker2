import { Readable } from 'node:stream';
import AiConversation, {
  MAX_AI_CONVERSATION_MESSAGES,
  MAX_AI_MESSAGE_CHARS,
  MAX_AI_MESSAGE_WYSIWYG_CHARS,
} from '../models/AiConversation.js';
import AiActionDraft from '../models/AiActionDraft.js';
import AiCourseChatDraft from '../models/AiCourseChatDraft.js';
import AiGradingInstruction from '../models/AiGradingInstruction.js';
import AiGradingJob from '../models/AiGradingJob.js';
import AiSessionRubric from '../models/AiSessionRubric.js';
import AiResponseSummary from '../models/AiResponseSummary.js';
import Course from '../models/Course.js';
import Grade from '../models/Grade.js';
import { getSessionGradingLockReason } from '../services/grading.js';
import Session from '../models/Session.js';
import { getOrCreateSettingsDocument } from '../utils/settingsSingleton.js';
import { isCourseInstructorOrAdmin, resolveCourseAiAudience } from '../utils/courseAccess.js';
import { discoverOllamaModels, discoverOpenAiModels, fetchAiArtifact, normalizeAiBackends, normalizeAiRequestTimeoutSeconds, serializeAiBackends } from '../services/ai.js';
import { authenticateAccessTokenOrRefreshCookie } from '../middleware/auth.js';
import { isAiCourseChatActive, queueAiCourseChat, stopAiCourseChat } from '../services/aiChatJobRunner.js';
import {
  courseChatMaxToolRounds,
  defaultStudentChatGuidance,
  MAX_CHAT_TOOL_ROUNDS,
} from '../services/aiChatRunner.js';
import { haltAiGradingJob, runAiGradingJob } from '../services/aiGradingRunner.js';
import {
  haltAiResponseSummary,
  isAiResponseSummaryActive,
  queueAiResponseSummary,
} from '../services/aiResponseSummaryRunner.js';
import { notifyCourseChatUpdated } from './courseChat.js';
import {
  appendAiGradingLogEntry,
  clearAiGradingLogs,
  finishAiGradingLogRun,
  getAiGradingLog,
  startAiGradingLogRun,
} from '../services/aiLogs.js';

const READ_LIMIT = { max: 60, timeWindow: '1 minute' };
const WRITE_LIMIT = { max: 20, timeWindow: '1 minute' };
const MAX_CONVERSATIONS_PER_COURSE = 100;
const AI_JOB_STALE_MS = 3 * 60 * 1000;
const MAX_AI_RUBRIC_QUESTIONS = 100;
const MAX_AI_INSTRUCTION_CHARS = 10_000;

async function instructorCourse(request, reply) {
  const course = await Course.findById(request.params.courseId).lean();
  if (!course) { reply.code(404).send({ error: 'Not Found', message: 'Course not found' }); return null; }
  if (!isCourseInstructorOrAdmin(course, request.user)) { reply.code(403).send({ error: 'Forbidden', message: 'Only course instructors can use AI helper' }); return null; }
  return course;
}

async function instructorSession(course, sessionId, reply) {
  const session = await Session.findOne({
    _id: String(sessionId),
    courseId: String(course._id),
    studentCreated: { $ne: true },
  }).lean();
  if (!session) reply.code(404).send({ error: 'Not Found', message: 'Session not found in this course' });
  return session;
}

function sessionHasQuestion(session, questionId) {
  return (session?.questions || []).some((id) => String(id) === String(questionId));
}

function normalizeRubricInstructions(value, session) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const sessionQuestionIds = new Set((session?.questions || []).map(String));
  const entries = Object.entries(value);
  if (entries.length > MAX_AI_RUBRIC_QUESTIONS) throw new Error('The grading rubric contains too many questions');
  return Object.fromEntries(entries.map(([questionId, raw]) => {
    if (!sessionQuestionIds.has(String(questionId))) throw new Error('Every rubric instruction must belong to this session');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Each rubric instruction must be an object');
    const grading = String(raw.grading || '');
    const feedback = String(raw.feedback || '');
    if (grading.length > MAX_AI_INSTRUCTION_CHARS || feedback.length > MAX_AI_INSTRUCTION_CHARS) {
      throw new Error(`Grading and feedback instructions cannot exceed ${MAX_AI_INSTRUCTION_CHARS.toLocaleString()} characters`);
    }
    return [String(questionId), {
      grading,
      feedback,
      gradingInstructionId: String(raw.gradingInstructionId || '').slice(0, 200),
      feedbackInstructionId: String(raw.feedbackInstructionId || '').slice(0, 200),
      regrade: !!raw.regrade,
    }];
  }));
}

async function studentCourse(request, reply) {
  const course = await Course.findById(request.params.courseId).lean();
  if (!course) { reply.code(404).send({ error: 'Not Found', message: 'Course not found' }); return null; }
  if (resolveCourseAiAudience(course, request.user) !== 'student') {
    reply.code(403).send({ error: 'Forbidden', message: 'Only students enrolled in this course can use student AI chat' });
    return null;
  }
  if (course.inactive) {
    reply.code(403).send({ error: 'Forbidden', message: 'This course is inactive for students' });
    return null;
  }
  return course;
}

function coursePolicy(settings, courseId) {
  const id = String(courseId);
  const enabled = !!settings?.AI_Enabled && (settings?.AI_EnabledCourses || []).map(String).includes(id);
  return { enabled, allowCourseBackend: enabled && (settings?.AI_AllowCourseBackendCourses || []).map(String).includes(id) };
}

async function studentChatContext(request, reply) {
  const course = await studentCourse(request, reply); if (!course) return null;
  const settings = await getOrCreateSettingsDocument({ lean: true });
  const policy = coursePolicy(settings, course._id);
  if (!policy.enabled || !course.aiEnabled || !course.aiStudentChatEnabled) {
    reply.code(403).send({ error: 'Forbidden', message: 'Student AI chat is disabled for this course' });
    return null;
  }
  return { course, settings, policy };
}

function findModel(backends, backendId, modelId) {
  const backend = (backends || []).find((entry) => String(entry.id) === String(backendId));
  const model = (backend?.models || []).find((entry) => String(entry.id) === String(modelId) && entry.available !== false);
  return backend && model ? { backend, model } : null;
}

function modelKey(backendId, modelId) {
  return `${String(backendId)}::${String(modelId)}`;
}

function availableBackends(course, settings, policy) {
  const requestTimeoutMs = normalizeAiRequestTimeoutSeconds(settings.AI_RequestTimeoutSeconds) * 1_000;
  return [
    ...normalizeAiBackends(settings.AI_Backends || []),
    ...(policy.allowCourseBackend ? normalizeAiBackends(course.aiBackends || []) : []),
  ].map((backend) => ({ ...backend, requestTimeoutMs }));
}

function normalizeModelPolicies(value) {
  if (!Array.isArray(value)) return [];
  const unique = new Map();
  value.forEach((entry) => {
    const backendId = String(entry?.backendId || '');
    const modelId = String(entry?.modelId || '');
    if (backendId && modelId) unique.set(modelKey(backendId, modelId), {
      backendId,
      modelId,
      displayName: String(entry?.displayName || '').trim().slice(0, 200),
      studentAvailable: !!entry?.studentAvailable,
    });
  });
  return [...unique.values()];
}

function effectiveModelPolicies(course, settings, policy) {
  const configured = normalizeModelPolicies(course.aiModelPolicies);
  if (configured.length) return configured;
  return availableBackends(course, settings, policy).flatMap((backend) => backend.models.map((model) => ({
    backendId: backend.id,
    modelId: model.id,
    studentAvailable: false,
  })));
}

function preferredModel(course, settings, policy) {
  const backends = availableBackends(course, settings, policy);
  const approved = new Set(effectiveModelPolicies(course, settings, policy)
    .map((entry) => modelKey(entry.backendId, entry.modelId)));
  const candidates = [
    [course.aiDefaultBackendId, course.aiDefaultModelId],
    [course.aiSelectedBackendId, course.aiSelectedModelId],
    [settings.AI_DefaultBackendId, settings.AI_DefaultModelId],
  ];
  for (const [backendId, modelId] of candidates) {
    if (backendId && modelId && approved.has(modelKey(backendId, modelId))) {
      const selected = findModel(backends, backendId, modelId);
      if (selected) return selected;
    }
  }
  for (const backend of backends) {
    const model = backend.models.find((entry) => approved.has(modelKey(backend.id, entry.id)));
    if (model) return { backend, model };
  }
  return null;
}

function resolveModel(course, settings, policy, requested = {}) {
  const fallback = preferredModel(course, settings, policy);
  const backendId = requested.backendId || fallback?.backend.id || '';
  const modelId = requested.modelId || fallback?.model.id || '';
  const approved = new Set(effectiveModelPolicies(course, settings, policy).map((entry) => modelKey(entry.backendId, entry.modelId)));
  if (!approved.has(modelKey(backendId, modelId))) return null;
  return findModel(availableBackends(course, settings, policy), backendId, modelId);
}

function resolveStudentModel(course, settings, policy, requested = {}) {
  const eligibleModels = approvedModels(course, settings, policy).filter((model) => model.studentAvailable);
  const configured = eligibleModels.find((model) => (
    model.backendId === course.aiStudentDefaultBackendId && model.modelId === course.aiStudentDefaultModelId
  ));
  const fallback = configured || eligibleModels[0] || null;
  const backendId = requested.backendId || fallback?.backendId || '';
  const modelId = requested.modelId || fallback?.modelId || '';
  if (!eligibleModels.some((model) => model.backendId === backendId && model.modelId === modelId)) return null;
  return findModel(availableBackends(course, settings, policy), backendId, modelId);
}

function approvedModels(course, settings, policy) {
  const policies = effectiveModelPolicies(course, settings, policy);
  const policyByKey = new Map(policies.map((entry) => [modelKey(entry.backendId, entry.modelId), entry]));
  return availableBackends(course, settings, policy).flatMap((backend) => backend.models.flatMap((model) => {
    const modelPolicy = policyByKey.get(modelKey(backend.id, model.id));
    return modelPolicy ? [{
      backendId: backend.id,
      backendName: backend.name || backend.url,
      modelId: model.id,
      modelName: model.name,
      displayName: modelPolicy.displayName || model.displayName || `${backend.name || backend.url} — ${model.name}`,
      studentAvailable: modelPolicy.studentAvailable,
    }] : [];
  }));
}

function conversationAudienceFilter(audience) {
  return audience === 'student' ? { audience: 'student' } : { audience: { $ne: 'student' } };
}

function serializeConversation(doc, includeMessages = false) {
  return {
    _id: String(doc._id), title: doc.title || '', backendId: doc.backendId || '', modelId: doc.modelId || '',
    pending: !!doc.pending, pendingThinking: doc.pendingThinking || '', pendingError: doc.pendingError || '',
    createdAt: doc.createdAt || null, updatedAt: doc.updatedAt || null,
    ...(includeMessages ? { messages: (doc.messages || []).map((message) => ({
      _id: String(message._id),
      role: message.role,
      content: message.content || '',
      contentWysiwyg: message.contentWysiwyg || '',
      thinking: message.thinking || '',
      isError: !!message.isError,
      createdAt: message.createdAt || null,
      artifacts: (message.artifacts || []).map((artifact) => ({
        _id: String(artifact._id),
        kind: artifact.kind,
        filename: artifact.filename || '',
        mimeType: artifact.mimeType || '',
        label: artifact.label || '',
      })),
    })) } : {}),
  };
}

function safeArtifactFilename(value) {
  return String(value || 'artifact').replace(/[\u0000-\u001f\u007f"\\/]/g, '_').trim().slice(0, 200) || 'artifact';
}

function encodeArtifactFilename(value) {
  return encodeURIComponent(value).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function artifactContentType(artifact, upstream) {
  const candidate = String(artifact.mimeType || upstream.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (artifact.kind === 'image' && /^image\/(?:png|jpeg|gif|webp|avif)$/.test(candidate)) return candidate;
  if (artifact.kind === 'audio' && /^audio\/(?:mpeg|mp4|ogg|wav|webm|aac|flac|x-wav)$/.test(candidate)) return candidate;
  return 'application/octet-stream';
}

function copyArtifactHeader(reply, upstream, name) {
  const value = upstream.headers.get(name);
  if (value) reply.header(name, value);
}

async function accessibleArtifactConversation(request) {
  const conversation = await AiConversation.findOne({
    _id: String(request.params.conversationId),
    ownerId: String(request.user?.userId || ''),
  }).lean();
  if (!conversation) return null;
  const course = await Course.findById(conversation.courseId).lean();
  if (!course) return null;
  if (conversation.audience === 'student') {
    if (resolveCourseAiAudience(course, request.user) !== 'student' || course.inactive || !course.aiEnabled || !course.aiStudentChatEnabled) return null;
    const settings = await getOrCreateSettingsDocument({ lean: true });
    if (!coursePolicy(settings, course._id).enabled) return null;
    return { conversation, course, settings };
  }
  if (!isCourseInstructorOrAdmin(course, request.user)) return null;
  return { conversation, course, settings: await getOrCreateSettingsDocument({ lean: true }) };
}

export async function aiMediaRoutes(app) {
  app.get('/media/:conversationId/:artifactId', {
    preHandler: authenticateAccessTokenOrRefreshCookie,
    config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const context = await accessibleArtifactConversation(request);
    if (!context) return reply.code(404).send({ error: 'Not Found', message: 'Artifact not found' });
    const artifact = (context.conversation.messages || [])
      .flatMap((message) => message.artifacts || [])
      .find((entry) => String(entry._id) === String(request.params.artifactId));
    if (!artifact) return reply.code(404).send({ error: 'Not Found', message: 'Artifact not found' });

    const backends = [
      ...normalizeAiBackends(context.settings.AI_Backends || []),
      ...normalizeAiBackends(context.course.aiBackends || []),
    ];
    const timeoutMs = Math.min(normalizeAiRequestTimeoutSeconds(context.settings.AI_RequestTimeoutSeconds) * 1_000, 60_000);
    const backend = backends.find((entry) => entry.id === context.conversation.backendId);
    if (!backend) return reply.code(502).send({ error: 'Bad Gateway', message: 'The artifact backend is no longer available' });

    const range = /^bytes=(?:\d+-\d*|-\d+)$/.test(String(request.headers.range || '')) ? String(request.headers.range) : undefined;
    let upstream;
    try {
      upstream = await fetchAiArtifact({ ...backend, requestTimeoutMs: timeoutMs }, artifact.sourcePath, { range });
    } catch (error) {
      request.log.warn({ err: error, conversationId: context.conversation._id, artifactId: artifact._id }, 'Failed to fetch AI artifact');
      return reply.code(502).send({ error: 'Bad Gateway', message: 'The artifact backend could not be reached' });
    }
    if (upstream.status === 404 || upstream.status === 410) {
      upstream.body?.cancel().catch(() => {});
      return reply.code(410).send({ error: 'Gone', reason: 'expired', message: 'This artifact is no longer available' });
    }
    if (!upstream.ok) {
      upstream.body?.cancel().catch(() => {});
      return reply.code(502).send({ error: 'Bad Gateway', message: 'The artifact backend returned an error' });
    }
    if (!upstream.body) return reply.code(502).send({ error: 'Bad Gateway', message: 'The artifact backend returned an empty response' });

    const contentType = artifactContentType(artifact, upstream);
    const disposition = contentType === 'application/octet-stream' ? 'attachment' : 'inline';
    const filename = safeArtifactFilename(artifact.filename);
    reply.code(upstream.status === 206 ? 206 : 200);
    reply.type(contentType);
    reply.header('Cache-Control', 'private, max-age=3600');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeArtifactFilename(filename)}`);
    ['content-length', 'content-range', 'accept-ranges'].forEach((name) => copyArtifactHeader(reply, upstream, name));
    return reply.send(Readable.fromWeb(upstream.body));
  });
}

async function recoverOrphanedConversation(conversation) {
  if (!conversation?.pending || isAiCourseChatActive(conversation._id)) return conversation;
  if (new Date(conversation.updatedAt || 0).getTime() > Date.now() - AI_JOB_STALE_MS) return conversation;
  return AiConversation.findOneAndUpdate(
    { _id: conversation._id, pending: true },
    { $set: {
      pending: false,
      pendingMessageId: '',
      pendingThinking: '',
      pendingError: 'The previous AI request did not complete. You can send another message.',
      updatedAt: new Date(),
    } },
    { returnDocument: 'after' }
  ).lean();
}

async function recoverOrphanedResponseSummary(summary) {
  if (!summary || !['queued', 'running'].includes(summary.status) || isAiResponseSummaryActive(summary._id)) return summary;
  if (new Date(summary.updatedAt || 0).getTime() > Date.now() - AI_JOB_STALE_MS) return summary;
  return AiResponseSummary.findOneAndUpdate(
    { _id: summary._id, status: { $in: ['queued', 'running'] } },
    { $set: {
      status: 'failed',
      phase: 'failed',
      error: 'The previous AI summary process did not complete. You can generate it again.',
      updatedAt: new Date(),
    } },
    { returnDocument: 'after' }
  ).lean();
}

async function recoverStaleAiGradingJob(job) {
  if (!job || !job.active || !['queued', 'running'].includes(job.status)) return job;
  if (new Date(job.updatedAt || job.createdAt || 0).getTime() > Date.now() - AI_JOB_STALE_MS) return job;
  const error = 'The previous AI grading process stopped unexpectedly. Completed grades were preserved.';
  const recovered = await AiGradingJob.findOneAndUpdate(
    { _id: job._id, active: true, status: { $in: ['queued', 'running'] } },
    { $set: { active: false, status: 'failed', error } },
    { returnDocument: 'after' }
  ).lean();
  if (!recovered) return AiGradingJob.findById(job._id).lean();
  try {
    await startAiGradingLogRun(recovered, recovered.createdAt || new Date());
    await appendAiGradingLogEntry(recovered, { status: 'failed', note: error });
    await finishAiGradingLogRun(recovered._id, 'failed');
  } catch { /* The job state remains recoverable even if log storage is unavailable. */ }
  return recovered;
}

export default async function aiRoutes(app) {
  const { authenticate } = app;

  app.post('/discover-models', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const { backendId = '', url, type = 'ollama', courseId = '', apiToken = '' } = request.body || {};
    if (!url) return reply.code(400).send({ error: 'Bad Request', message: 'Backend URL is required' });
    const settings = await getOrCreateSettingsDocument({ lean: true });
    let storedBackend = normalizeAiBackends(settings.AI_Backends || []).find((backend) => backend.id === backendId);
    if (!(request.user.roles || []).includes('admin')) {
      const course = await Course.findById(courseId).lean();
      const policy = course ? coursePolicy(settings, course._id) : { enabled: false, allowCourseBackend: false };
      if (!course || !isCourseInstructorOrAdmin(course, request.user) || !policy.enabled) {
        return reply.code(403).send({ error: 'Forbidden', message: 'This course cannot access AI backends' });
      }
      const courseBackend = normalizeAiBackends(course.aiBackends || []).find((backend) => backend.id === backendId);
      if (courseBackend && policy.allowCourseBackend) storedBackend = courseBackend;
      else if (!storedBackend && !policy.allowCourseBackend) return reply.code(403).send({ error: 'Forbidden', message: 'This course cannot configure its own AI backend' });
    }
    const storedUrl = String(storedBackend?.url || '').replace(/\/+$/, '');
    const requestedUrl = String(url || '').replace(/\/+$/, '');
    const storedToken = storedUrl === requestedUrl ? storedBackend?.apiToken || '' : '';
    const resolvedToken = apiToken || storedToken;
    try {
      const models = type === 'openai'
        ? await discoverOpenAiModels(url, resolvedToken)
        : await discoverOllamaModels(url, resolvedToken);
      return { models };
    } catch (err) {
      return reply.code(400).send({ error: 'Bad Request', message: err.message || 'Could not discover AI models' });
    }
  });

  app.get('/courses/:courseId/config', { preHandler: authenticate, rateLimit: READ_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const settings = await getOrCreateSettingsDocument({ lean: true });
    const policy = coursePolicy(settings, course._id);
    const modelPolicies = effectiveModelPolicies(course, settings, policy);
    const defaultModel = preferredModel(course, settings, policy);
    const defaultBackendId = defaultModel?.backend.id || '';
    const defaultModelId = defaultModel?.model.id || '';
    const availableModels = approvedModels(course, settings, policy);
    const studentModels = availableModels.filter((model) => model.studentAvailable);
    const configuredStudentModel = studentModels.find((model) => (
      model.backendId === course.aiStudentDefaultBackendId && model.modelId === course.aiStudentDefaultModelId
    ));
    const studentDefaultModel = configuredStudentModel || studentModels[0] || null;
    return {
      ...policy, courseEnabled: !!course.aiEnabled,
      selectedBackendId: course.aiSelectedBackendId || '', selectedModelId: course.aiSelectedModelId || '',
      adminDefaultBackendId: settings.AI_DefaultBackendId || '', adminDefaultModelId: settings.AI_DefaultModelId || '',
      adminBackends: serializeAiBackends(settings.AI_Backends || []).map((backend) => ({ ...backend, models: backend.models.filter((model) => model.available) })),
      courseBackends: policy.allowCourseBackend ? serializeAiBackends(course.aiBackends || []) : [],
      courseDefaultBackendId: course.aiDefaultBackendId || '', courseDefaultModelId: course.aiDefaultModelId || '',
      defaultBackendId,
      defaultModelId,
      modelPolicies,
      approvedModels: availableModels,
      instructorChatMaxToolRounds: courseChatMaxToolRounds(course, 'instructor'),
      studentChatEnabled: !!course.aiStudentChatEnabled,
      studentChatGuidance: course.aiStudentChatGuidance || defaultStudentChatGuidance(course.name),
      studentDefaultBackendId: studentDefaultModel?.backendId || '',
      studentDefaultModelId: studentDefaultModel?.modelId || '',
      studentChatMaxToolRounds: courseChatMaxToolRounds(course, 'student'),
    };
  });

  app.get('/student/courses/:courseId/config', { preHandler: authenticate, rateLimit: READ_LIMIT }, async (request, reply) => {
    const context = await studentChatContext(request, reply); if (!context) return undefined;
    const { course, settings, policy } = context;
    const models = approvedModels(course, settings, policy).filter((model) => model.studentAvailable);
    const configured = models.find((model) => (
      model.backendId === course.aiStudentDefaultBackendId && model.modelId === course.aiStudentDefaultModelId
    ));
    const defaultModel = configured || models[0] || null;
    return {
      enabled: true,
      approvedModels: models.map(({ studentAvailable, ...model }) => model),
      defaultBackendId: defaultModel?.backendId || '',
      defaultModelId: defaultModel?.modelId || '',
    };
  });

  app.patch('/courses/:courseId/config', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const settings = await getOrCreateSettingsDocument({ lean: true });
    const policy = coursePolicy(settings, course._id);
    if (!policy.enabled) return reply.code(403).send({ error: 'Forbidden', message: 'AI helper is not enabled for this course by the administrator' });
    const body = request.body || {}; const updates = {};
    if (body.enabled !== undefined) updates.aiEnabled = !!body.enabled;
    const hasCustom = body.backends !== undefined;
    if (hasCustom && !policy.allowCourseBackend) return reply.code(403).send({ error: 'Forbidden', message: 'This course must use an administrator-configured AI backend' });
    if (body.backends !== undefined) {
      const existingById = new Map(normalizeAiBackends(course.aiBackends || []).map((backend) => [backend.id, backend]));
      updates.aiBackends = normalizeAiBackends(body.backends).map((backend) => ({
        ...backend,
        apiToken: backend.apiToken || existingById.get(backend.id)?.apiToken || '',
      }));
    }
    if (body.defaultBackendId !== undefined) updates.aiDefaultBackendId = body.defaultBackendId;
    if (body.defaultModelId !== undefined) updates.aiDefaultModelId = body.defaultModelId;
    if (body.modelPolicies !== undefined) {
      const available = availableBackends({ ...course, ...updates }, settings, policy);
      updates.aiModelPolicies = normalizeModelPolicies(body.modelPolicies).filter((entry) => (
        !!findModel(available, entry.backendId, entry.modelId)
      ));
    }
    if (body.selectedBackendId !== undefined) updates.aiSelectedBackendId = body.selectedBackendId;
    if (body.selectedModelId !== undefined) updates.aiSelectedModelId = body.selectedModelId;
    if (body.instructorChatMaxToolRounds !== undefined) {
      const value = Number(body.instructorChatMaxToolRounds);
      if (!Number.isInteger(value) || value < 1 || value > MAX_CHAT_TOOL_ROUNDS) {
        return reply.code(400).send({ error: 'Bad Request', message: `Professor AI chat internal turns must be a whole number from 1 to ${MAX_CHAT_TOOL_ROUNDS}` });
      }
      updates.aiInstructorChatMaxToolRounds = value;
    }
    if (body.studentChatEnabled !== undefined) updates.aiStudentChatEnabled = !!body.studentChatEnabled;
    if (body.studentChatGuidance !== undefined) updates.aiStudentChatGuidance = String(body.studentChatGuidance || '').trim();
    if (body.studentDefaultBackendId !== undefined) updates.aiStudentDefaultBackendId = String(body.studentDefaultBackendId || '');
    if (body.studentDefaultModelId !== undefined) updates.aiStudentDefaultModelId = String(body.studentDefaultModelId || '');
    if (body.studentChatMaxToolRounds !== undefined) {
      const value = Number(body.studentChatMaxToolRounds);
      if (!Number.isInteger(value) || value < 1 || value > MAX_CHAT_TOOL_ROUNDS) {
        return reply.code(400).send({ error: 'Bad Request', message: `Student AI chat internal turns must be a whole number from 1 to ${MAX_CHAT_TOOL_ROUNDS}` });
      }
      updates.aiStudentChatMaxToolRounds = value;
    }
    const candidate = { ...course, ...updates };
    if (candidate.aiDefaultBackendId || candidate.aiDefaultModelId || candidate.aiSelectedBackendId || candidate.aiSelectedModelId) {
      if (!resolveModel(candidate, settings, policy)) return reply.code(400).send({ error: 'Bad Request', message: 'Choose an approved AI backend and model' });
    }
    if (candidate.aiStudentDefaultBackendId || candidate.aiStudentDefaultModelId) {
      const studentModels = approvedModels(candidate, settings, policy).filter((model) => model.studentAvailable);
      const studentModel = studentModels.find((model) => (
        model.backendId === candidate.aiStudentDefaultBackendId
        && model.modelId === candidate.aiStudentDefaultModelId
      ));
      if (!studentModel) {
        const explicitlySelectedStudentModel = body.studentDefaultBackendId !== undefined || body.studentDefaultModelId !== undefined;
        if (explicitlySelectedStudentModel) return reply.code(400).send({ error: 'Bad Request', message: 'Choose a model that is available to students' });
        updates.aiStudentDefaultBackendId = studentModels[0]?.backendId || '';
        updates.aiStudentDefaultModelId = studentModels[0]?.modelId || '';
      }
    }
    const updatedCourse = await Course.findByIdAndUpdate(
      course._id,
      { $set: updates },
      { returnDocument: 'after' }
    ).lean();
    return {
      success: true,
      courseBackends: policy.allowCourseBackend ? serializeAiBackends(updatedCourse.aiBackends || []) : [],
    };
  });

  app.get('/courses/:courseId/conversations', { preHandler: authenticate, rateLimit: READ_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const conversations = await AiConversation.find({ courseId: course._id, ownerId: request.user.userId, ...conversationAudienceFilter('instructor') }).select('-messages').sort({ updatedAt: -1 }).limit(MAX_CONVERSATIONS_PER_COURSE).lean();
    return { conversations: conversations.map((entry) => serializeConversation(entry)) };
  });

  app.post('/courses/:courseId/conversations', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const count = await AiConversation.countDocuments({ courseId: course._id, ownerId: request.user.userId, ...conversationAudienceFilter('instructor') });
    if (count >= MAX_CONVERSATIONS_PER_COURSE) return reply.code(409).send({ error: 'Conflict', message: `A course can have at most ${MAX_CONVERSATIONS_PER_COURSE} AI conversations per user` });
    const conversation = await AiConversation.create({ courseId: course._id, ownerId: request.user.userId, audience: 'instructor' });
    return reply.code(201).send({ conversation: serializeConversation(conversation.toObject(), true) });
  });

  app.get('/courses/:courseId/conversations/:conversationId', { preHandler: authenticate, rateLimit: READ_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    let conversation = await AiConversation.findOne({ _id: request.params.conversationId, courseId: course._id, ownerId: request.user.userId, ...conversationAudienceFilter('instructor') }).lean();
    if (!conversation) return reply.code(404).send({ error: 'Not Found', message: 'AI conversation not found' });
    conversation = await recoverOrphanedConversation(conversation);
    return { conversation: serializeConversation(conversation, true) };
  });

  app.get('/courses/:courseId/conversations/:conversationId/status', { preHandler: authenticate, rateLimit: READ_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    let conversation = await AiConversation.findOne({ _id: request.params.conversationId, courseId: course._id, ownerId: request.user.userId, ...conversationAudienceFilter('instructor') }).select('-messages').lean();
    if (!conversation) return reply.code(404).send({ error: 'Not Found', message: 'AI conversation not found' });
    conversation = await recoverOrphanedConversation(conversation);
    return { conversation: serializeConversation(conversation) };
  });

  app.delete('/courses/:courseId/conversations/:conversationId/pending-error', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    let conversation = await AiConversation.findOne({ _id: request.params.conversationId, courseId: course._id, ownerId: request.user.userId, ...conversationAudienceFilter('instructor') }).lean();
    if (!conversation) return reply.code(404).send({ error: 'Not Found', message: 'AI conversation not found' });
    conversation = await recoverOrphanedConversation(conversation);
    if (!conversation.pending && conversation.pendingError) {
      const cleared = await AiConversation.findOneAndUpdate(
        { _id: conversation._id, pending: false },
        { $set: { pendingError: '' } },
        { returnDocument: 'after' }
      ).lean();
      conversation = cleared || await AiConversation.findById(conversation._id).lean();
    }
    return { conversation: serializeConversation(conversation, true) };
  });

  app.delete('/courses/:courseId/conversations/:conversationId', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const conversation = await AiConversation.findOneAndDelete({
      _id: request.params.conversationId,
      courseId: course._id,
      ownerId: request.user.userId,
      ...conversationAudienceFilter('instructor'),
    });
    if (conversation) {
      stopAiCourseChat(conversation._id);
      await Promise.all([
        AiActionDraft.deleteMany({ conversationId: conversation._id, ownerId: request.user.userId }),
        AiCourseChatDraft.deleteMany({ conversationId: conversation._id, ownerId: request.user.userId }),
      ]);
    }
    return reply.code(204).send();
  });

  app.post('/courses/:courseId/conversations/:conversationId/messages', { preHandler: authenticate, rateLimit: { max: 10, timeWindow: '1 minute' } }, async (request, reply) => {
    const content = String(request.body?.content || '').trim();
    if (!content) return reply.code(400).send({ error: 'Bad Request', message: 'A message is required' });
    if (content.length > MAX_AI_MESSAGE_CHARS) return reply.code(400).send({ error: 'Bad Request', message: `Messages cannot exceed ${MAX_AI_MESSAGE_CHARS} characters` });
    const contentWysiwyg = String(request.body?.contentWysiwyg || '');
    if (contentWysiwyg.length > MAX_AI_MESSAGE_WYSIWYG_CHARS) return reply.code(400).send({ error: 'Bad Request', message: 'Formatted message content is too large' });
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const settings = await getOrCreateSettingsDocument({ lean: true }); const policy = coursePolicy(settings, course._id);
    if (!policy.enabled || !course.aiEnabled) return reply.code(403).send({ error: 'Forbidden', message: 'AI helper is disabled for this course' });
    const selected = resolveModel(course, settings, policy, request.body || {});
    if (!selected) return reply.code(400).send({ error: 'Bad Request', message: 'Select an approved AI backend and model before chatting' });
    const conversation = await AiConversation.findOne({ _id: request.params.conversationId, courseId: course._id, ownerId: request.user.userId, ...conversationAudienceFilter('instructor') });
    if (!conversation) return reply.code(404).send({ error: 'Not Found', message: 'AI conversation not found' });
    if (conversation.pending) return reply.code(409).send({ error: 'Conflict', message: 'An AI response is already in progress for this conversation' });
    if (conversation.messages.length >= MAX_AI_CONVERSATION_MESSAGES) {
      conversation.messages.splice(0, conversation.messages.length - MAX_AI_CONVERSATION_MESSAGES + 1);
    }
    conversation.messages.push({ role: 'user', content, contentWysiwyg });
    const userMessage = conversation.messages.at(-1);
    conversation.pending = true;
    conversation.pendingMessageId = String(userMessage._id);
    conversation.pendingThinking = '';
    conversation.pendingError = '';
    conversation.backendId = selected.backend.id;
    conversation.modelId = selected.model.id;
    conversation.title = conversation.title || content.slice(0, 80);
    conversation.updatedAt = new Date();
    await conversation.save();
    queueAiCourseChat({
      conversationId: conversation._id,
      pendingMessageId: userMessage._id,
      backend: selected.backend,
      modelId: selected.model.id,
      course,
      user: request.user,
      timeZone: request.body?.timeZone,
      onCourseChatUpdated: (payload) => notifyCourseChatUpdated(app, course, payload),
    });
    return reply.code(202).send({ conversation: serializeConversation(conversation.toObject(), true) });
  });

  app.post('/courses/:courseId/conversations/:conversationId/stop', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const conversation = await AiConversation.findOneAndUpdate(
      { _id: request.params.conversationId, courseId: course._id, ownerId: request.user.userId, pending: true, ...conversationAudienceFilter('instructor') },
      { $set: { pending: false, pendingMessageId: '', pendingThinking: '', pendingError: 'AI response stopped', updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!conversation) return reply.code(409).send({ error: 'Conflict', message: 'No AI response is in progress for this conversation' });
    stopAiCourseChat(conversation._id);
    return { conversation: serializeConversation(conversation.toObject(), true) };
  });

  app.get('/student/courses/:courseId/conversations', { preHandler: authenticate, rateLimit: READ_LIMIT }, async (request, reply) => {
    const context = await studentChatContext(request, reply); if (!context) return undefined;
    const conversations = await AiConversation.find({
      courseId: context.course._id,
      ownerId: request.user.userId,
      ...conversationAudienceFilter('student'),
    }).select('-messages').sort({ updatedAt: -1 }).limit(MAX_CONVERSATIONS_PER_COURSE).lean();
    return { conversations: conversations.map((entry) => serializeConversation(entry)) };
  });

  app.post('/student/courses/:courseId/conversations', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const context = await studentChatContext(request, reply); if (!context) return undefined;
    const count = await AiConversation.countDocuments({ courseId: context.course._id, ownerId: request.user.userId, ...conversationAudienceFilter('student') });
    if (count >= MAX_CONVERSATIONS_PER_COURSE) return reply.code(409).send({ error: 'Conflict', message: `A course can have at most ${MAX_CONVERSATIONS_PER_COURSE} AI conversations per user` });
    const conversation = await AiConversation.create({
      courseId: context.course._id,
      ownerId: request.user.userId,
      audience: 'student',
    });
    return reply.code(201).send({ conversation: serializeConversation(conversation.toObject(), true) });
  });

  app.get('/student/courses/:courseId/conversations/:conversationId', { preHandler: authenticate, rateLimit: READ_LIMIT }, async (request, reply) => {
    const context = await studentChatContext(request, reply); if (!context) return undefined;
    let conversation = await AiConversation.findOne({
      _id: request.params.conversationId,
      courseId: context.course._id,
      ownerId: request.user.userId,
      ...conversationAudienceFilter('student'),
    }).lean();
    if (!conversation) return reply.code(404).send({ error: 'Not Found', message: 'AI conversation not found' });
    conversation = await recoverOrphanedConversation(conversation);
    return { conversation: serializeConversation(conversation, true) };
  });

  app.get('/student/courses/:courseId/conversations/:conversationId/status', { preHandler: authenticate, rateLimit: READ_LIMIT }, async (request, reply) => {
    const context = await studentChatContext(request, reply); if (!context) return undefined;
    let conversation = await AiConversation.findOne({
      _id: request.params.conversationId,
      courseId: context.course._id,
      ownerId: request.user.userId,
      ...conversationAudienceFilter('student'),
    }).select('-messages').lean();
    if (!conversation) return reply.code(404).send({ error: 'Not Found', message: 'AI conversation not found' });
    conversation = await recoverOrphanedConversation(conversation);
    return { conversation: serializeConversation(conversation) };
  });

  app.delete('/student/courses/:courseId/conversations/:conversationId/pending-error', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const context = await studentChatContext(request, reply); if (!context) return undefined;
    let conversation = await AiConversation.findOne({
      _id: request.params.conversationId,
      courseId: context.course._id,
      ownerId: request.user.userId,
      ...conversationAudienceFilter('student'),
    }).lean();
    if (!conversation) return reply.code(404).send({ error: 'Not Found', message: 'AI conversation not found' });
    conversation = await recoverOrphanedConversation(conversation);
    if (!conversation.pending && conversation.pendingError) {
      const cleared = await AiConversation.findOneAndUpdate(
        { _id: conversation._id, pending: false, ...conversationAudienceFilter('student') },
        { $set: { pendingError: '' } },
        { returnDocument: 'after' }
      ).lean();
      conversation = cleared || await AiConversation.findById(conversation._id).lean();
    }
    return { conversation: serializeConversation(conversation, true) };
  });

  app.delete('/student/courses/:courseId/conversations/:conversationId', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const context = await studentChatContext(request, reply); if (!context) return undefined;
    const conversation = await AiConversation.findOneAndDelete({
      _id: request.params.conversationId,
      courseId: context.course._id,
      ownerId: request.user.userId,
      ...conversationAudienceFilter('student'),
    });
    if (conversation) stopAiCourseChat(conversation._id);
    return reply.code(204).send();
  });

  app.post('/student/courses/:courseId/conversations/:conversationId/messages', { preHandler: authenticate, rateLimit: { max: 10, timeWindow: '1 minute' } }, async (request, reply) => {
    const content = String(request.body?.content || '').trim();
    if (!content) return reply.code(400).send({ error: 'Bad Request', message: 'A message is required' });
    if (content.length > MAX_AI_MESSAGE_CHARS) return reply.code(400).send({ error: 'Bad Request', message: `Messages cannot exceed ${MAX_AI_MESSAGE_CHARS} characters` });
    const contentWysiwyg = String(request.body?.contentWysiwyg || '');
    if (contentWysiwyg.length > MAX_AI_MESSAGE_WYSIWYG_CHARS) return reply.code(400).send({ error: 'Bad Request', message: 'Formatted message content is too large' });
    const context = await studentChatContext(request, reply); if (!context) return undefined;
    const { course, settings, policy } = context;
    const selected = resolveStudentModel(course, settings, policy, request.body || {});
    if (!selected) return reply.code(400).send({ error: 'Bad Request', message: 'Select an AI model made available to students before chatting' });
    const conversation = await AiConversation.findOne({
      _id: request.params.conversationId,
      courseId: course._id,
      ownerId: request.user.userId,
      ...conversationAudienceFilter('student'),
    });
    if (!conversation) return reply.code(404).send({ error: 'Not Found', message: 'AI conversation not found' });
    if (conversation.pending) return reply.code(409).send({ error: 'Conflict', message: 'An AI response is already in progress for this conversation' });
    if (conversation.messages.length >= MAX_AI_CONVERSATION_MESSAGES) {
      conversation.messages.splice(0, conversation.messages.length - MAX_AI_CONVERSATION_MESSAGES + 1);
    }
    conversation.messages.push({ role: 'user', content, contentWysiwyg });
    const userMessage = conversation.messages.at(-1);
    conversation.pending = true;
    conversation.pendingMessageId = String(userMessage._id);
    conversation.pendingThinking = '';
    conversation.pendingError = '';
    conversation.backendId = selected.backend.id;
    conversation.modelId = selected.model.id;
    conversation.title = conversation.title || content.slice(0, 80);
    conversation.updatedAt = new Date();
    await conversation.save();
    queueAiCourseChat({
      conversationId: conversation._id,
      pendingMessageId: userMessage._id,
      backend: selected.backend,
      modelId: selected.model.id,
      course,
      user: request.user,
      timeZone: request.body?.timeZone,
    });
    return reply.code(202).send({ conversation: serializeConversation(conversation.toObject(), true) });
  });

  app.post('/student/courses/:courseId/conversations/:conversationId/stop', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const context = await studentChatContext(request, reply); if (!context) return undefined;
    const conversation = await AiConversation.findOneAndUpdate(
      {
        _id: request.params.conversationId,
        courseId: context.course._id,
        ownerId: request.user.userId,
        pending: true,
        ...conversationAudienceFilter('student'),
      },
      { $set: { pending: false, pendingMessageId: '', pendingThinking: '', pendingError: 'AI response stopped', updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!conversation) return reply.code(409).send({ error: 'Conflict', message: 'No AI response is in progress for this conversation' });
    stopAiCourseChat(conversation._id);
    return { conversation: serializeConversation(conversation.toObject(), true) };
  });

  app.get('/courses/:courseId/grading-instructions', { preHandler: authenticate }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const instructions = await AiGradingInstruction.find({ courseId: course._id }).sort({ kind: 1, name: 1 }).lean();
    return { instructions: [
      { _id: 'no-feedback', kind: 'feedback', name: 'Do not give feedback', content: 'Leave the feedback blank.' },
      { _id: 'basic-summary', kind: 'summary', name: 'Basic summary', content: 'Summarize the student responses to identify up to five themes in the student responses. Give a few example quoted responses for the students for each theme.' },
      ...instructions,
    ] };
  });

  app.post('/courses/:courseId/grading-instructions', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const { _id, kind, name, content } = request.body || {};
    if (!['grading', 'feedback', 'summary'].includes(kind) || !String(name || '').trim() || !String(content || '').trim()) return reply.code(400).send({ error: 'Bad Request', message: 'Instruction type, name, and content are required' });
    if (String(name).trim().length > 200 || String(content).trim().length > MAX_AI_INSTRUCTION_CHARS) return reply.code(400).send({ error: 'Bad Request', message: `Instruction names cannot exceed 200 characters and content cannot exceed ${MAX_AI_INSTRUCTION_CHARS.toLocaleString()} characters` });
    const filter = _id && !['no-feedback', 'basic-summary'].includes(_id) ? { _id, courseId: course._id } : { courseId: course._id, kind, name: String(name).trim() };
    const instruction = await AiGradingInstruction.findOneAndUpdate(filter, { $set: { courseId: course._id, kind, name: String(name).trim(), content: String(content).trim() } }, { upsert: true, returnDocument: 'after', runValidators: true });
    return { instruction };
  });

  app.delete('/courses/:courseId/grading-instructions/:instructionId', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    await AiGradingInstruction.deleteOne({ _id: request.params.instructionId, courseId: course._id });
    return reply.code(204).send();
  });

  app.get('/courses/:courseId/grading-instructions/copy-sources', { preHandler: authenticate }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const courses = await Course.find({
      _id: { $ne: course._id },
      $or: [{ owner: request.user.userId }, { instructors: request.user.userId }],
    }).select('name deptCode courseNumber section semester').sort({ name: 1 }).lean();
    return { courses };
  });

  app.post('/courses/:courseId/grading-instructions/copy', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const sourceCourse = await Course.findById(request.body?.sourceCourseId).lean();
    if (!sourceCourse || !isCourseInstructorOrAdmin(sourceCourse, request.user)) return reply.code(403).send({ error: 'Forbidden', message: 'You cannot copy rubrics from this course' });
    const instructions = await AiGradingInstruction.find({ courseId: sourceCourse._id }).lean();
    if (instructions.length) {
      await AiGradingInstruction.bulkWrite(instructions.map((instruction) => ({
        updateOne: {
          filter: { courseId: course._id, kind: instruction.kind, name: instruction.name },
          update: { $set: { content: instruction.content } },
          upsert: true,
        },
      })));
    }
    return { copied: instructions.length };
  });

  app.get('/courses/:courseId/sessions/:sessionId/ai-grading-rubric', { preHandler: authenticate }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const session = await instructorSession(course, request.params.sessionId, reply); if (!session) return undefined;
    const rubric = await AiSessionRubric.findOne({ courseId: course._id, sessionId: request.params.sessionId }).lean();
    return { rubric };
  });

  app.put('/courses/:courseId/sessions/:sessionId/ai-grading-rubric', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const session = await instructorSession(course, request.params.sessionId, reply); if (!session) return undefined;
    const questionIds = Array.isArray(request.body?.questionIds) ? [...new Set(request.body.questionIds.map(String))] : [];
    if (questionIds.length > MAX_AI_RUBRIC_QUESTIONS) return reply.code(400).send({ error: 'Bad Request', message: `A grading rubric cannot contain more than ${MAX_AI_RUBRIC_QUESTIONS} questions` });
    if (questionIds.some((questionId) => !sessionHasQuestion(session, questionId))) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Every rubric question must belong to this session' });
    }
    let instructions;
    try { instructions = normalizeRubricInstructions(request.body?.instructions, session); }
    catch (error) { return reply.code(400).send({ error: 'Bad Request', message: error.message }); }
    const rubric = await AiSessionRubric.findOneAndUpdate(
      { courseId: course._id, sessionId: request.params.sessionId },
      { $set: { questionIds, instructions } },
      { upsert: true, returnDocument: 'after', runValidators: true }
    ).lean();
    return { rubric };
  });

  app.get('/courses/:courseId/sessions/:sessionId/ai-grading', { preHandler: authenticate }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const session = await instructorSession(course, request.params.sessionId, reply); if (!session) return undefined;
    let job = await AiGradingJob.findOne({ courseId: course._id, sessionId: request.params.sessionId }).sort({ createdAt: -1 }).lean();
    job = await recoverStaleAiGradingJob(job);
    const includeLog = ['1', 'true'].includes(String(request.query?.includeLog || '').toLowerCase());
    return { job, ...(includeLog ? { log: await getAiGradingLog(course._id, session._id) } : {}) };
  });

  app.delete('/courses/:courseId/sessions/:sessionId/ai-grading-log', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const session = await instructorSession(course, request.params.sessionId, reply); if (!session) return undefined;
    await clearAiGradingLogs(course._id, session._id);
    return reply.code(204).send();
  });

  app.post('/courses/:courseId/sessions/:sessionId/ai-grading', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const session = await instructorSession(course, request.params.sessionId, reply); if (!session) return undefined;
    if (session.anonymous) return reply.code(409).send({ error: 'Conflict', message: 'Anonymous sessions do not have grades' });
    const gradingLockReason = getSessionGradingLockReason(session);
    if (gradingLockReason) return reply.code(409).send({ error: 'Conflict', message: gradingLockReason === 'extensions'
      ? 'Grading is locked until all quiz extensions have expired or been removed'
      : 'Session must be in Ended state before grading' });
    const eligibleStudents = session.activityEverShared
      ? (course.students || [])
      : [];
    if (!await Grade.exists({ sessionId: session._id, courseId: course._id,
      ...(session.activityEverShared ? { userId: { $in: eligibleStudents } } : {}) })) {
      return reply.code(409).send({ error: 'Conflict', message: 'Create grade items before grading' });
    }
    const settings = await getOrCreateSettingsDocument({ lean: true }); const policy = coursePolicy(settings, course._id);
    const selectedModel = resolveModel(course, settings, policy, request.body || {});
    if (!policy.enabled || !course.aiEnabled || !selectedModel) return reply.code(400).send({ error: 'Bad Request', message: 'Choose an approved AI model before grading' });
    const { questionIds, instructions = {}, regrade = false } = request.body || {};
    if (!Array.isArray(questionIds) || questionIds.length === 0) return reply.code(400).send({ error: 'Bad Request', message: 'Select at least one question' });
    const normalizedQuestionIds = [...new Set(questionIds.map(String))];
    if (normalizedQuestionIds.length > MAX_AI_RUBRIC_QUESTIONS) return reply.code(400).send({ error: 'Bad Request', message: `Select no more than ${MAX_AI_RUBRIC_QUESTIONS} questions` });
    if (normalizedQuestionIds.some((questionId) => !sessionHasQuestion(session, questionId))) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Every selected question must belong to this session' });
    }
    let normalizedInstructions;
    try { normalizedInstructions = normalizeRubricInstructions(instructions, session); }
    catch (error) { return reply.code(400).send({ error: 'Bad Request', message: error.message }); }
    await AiSessionRubric.findOneAndUpdate(
      { courseId: course._id, sessionId: request.params.sessionId },
      { $set: { questionIds: normalizedQuestionIds, instructions: normalizedInstructions } },
      { upsert: true, returnDocument: 'after', runValidators: true }
    );
    const previousJob = await AiGradingJob.findOne({ courseId: course._id, sessionId: request.params.sessionId, active: true }).sort({ createdAt: -1 }).lean();
    await recoverStaleAiGradingJob(previousJob);
    let job;
    try {
      job = await AiGradingJob.create({ courseId: course._id, sessionId: request.params.sessionId, ownerId: request.user.userId, backendId: selectedModel.backend.id, modelId: selectedModel.model.id, questionIds: normalizedQuestionIds, instructions: normalizedInstructions, regrade: !!regrade, active: true });
    } catch (error) {
      if (error?.code === 11000) return reply.code(409).send({ error: 'Conflict', message: 'AI grading is already in progress for this session' });
      throw error;
    }
    setImmediate(() => runAiGradingJob(job._id));
    return reply.code(202).send({ job });
  });

  app.post('/courses/:courseId/sessions/:sessionId/ai-grading/halt', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const session = await instructorSession(course, request.params.sessionId, reply); if (!session) return undefined;
    const activeJob = await AiGradingJob.findOne({
      courseId: course._id,
      sessionId: request.params.sessionId,
      status: { $in: ['queued', 'running'] },
    }).sort({ createdAt: -1 });
    if (!activeJob) return reply.code(409).send({ error: 'Conflict', message: 'No AI grading job is in progress' });
    const job = await haltAiGradingJob(activeJob._id);
    if (!job) return reply.code(409).send({ error: 'Conflict', message: 'The AI grading job has already finished' });
    return { job, log: await getAiGradingLog(course._id, session._id) };
  });

  app.get('/courses/:courseId/sessions/:sessionId/ai-summaries', { preHandler: authenticate, rateLimit: READ_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const session = await instructorSession(course, request.params.sessionId, reply); if (!session) return undefined;
    const requestedIds = String(request.query?.questionIds || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    const questionIds = requestedIds.length > 0
      ? [...new Set(requestedIds)]
      : (session.questions || []).map(String);
    if (questionIds.length > MAX_AI_RUBRIC_QUESTIONS || questionIds.some((id) => !sessionHasQuestion(session, id))) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Summary questions must belong to this session' });
    }
    const summaries = await AiResponseSummary.find({
      courseId: course._id,
      sessionId: session._id,
      questionId: { $in: questionIds },
    }).lean();
    return { summaries: await Promise.all(summaries.map(recoverOrphanedResponseSummary)) };
  });

  app.get('/courses/:courseId/sessions/:sessionId/questions/:questionId/ai-summary', { preHandler: authenticate }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const session = await instructorSession(course, request.params.sessionId, reply); if (!session) return undefined;
    if (!sessionHasQuestion(session, request.params.questionId)) return reply.code(404).send({ error: 'Not Found', message: 'Question not found in this session' });
    let summary = await AiResponseSummary.findOne({ courseId: course._id, sessionId: request.params.sessionId, questionId: request.params.questionId }).lean();
    summary = await recoverOrphanedResponseSummary(summary);
    return { summary };
  });

  app.post('/courses/:courseId/sessions/:sessionId/questions/:questionId/ai-summary', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const session = await instructorSession(course, request.params.sessionId, reply); if (!session) return undefined;
    if (!sessionHasQuestion(session, request.params.questionId)) return reply.code(404).send({ error: 'Not Found', message: 'Question not found in this session' });
    const settings = await getOrCreateSettingsDocument({ lean: true });
    const policy = coursePolicy(settings, course._id);
    const selectedModel = resolveModel(course, settings, policy, request.body || {});
    if (!policy.enabled || !course.aiEnabled || !selectedModel) return reply.code(400).send({ error: 'Bad Request', message: 'Choose an approved AI model before summarizing' });
    const instruction = String(request.body?.instruction || '').trim();
    if (!instruction) return reply.code(400).send({ error: 'Bad Request', message: 'Summary instructions are required' });
    if (instruction.length > 10_000) return reply.code(400).send({ error: 'Bad Request', message: 'Summary instructions cannot exceed 10,000 characters' });
    const summaryFilter = { courseId: course._id, sessionId: request.params.sessionId, questionId: request.params.questionId };
    let summary;
    try {
      summary = await AiResponseSummary.findOneAndUpdate(
        { ...summaryFilter, status: { $nin: ['queued', 'running'] } },
        { $set: {
          status: 'queued',
          phase: 'queued',
          instruction,
          backendId: selectedModel.backend.id,
          modelId: selectedModel.model.id,
          completed: 0,
          total: 0,
          summary: '',
          error: '',
        } },
        { upsert: true, returnDocument: 'after' }
      );
    } catch (error) {
      if (error?.code === 11000) return reply.code(409).send({ error: 'Conflict', message: 'An AI response summary is already in progress for this question' });
      throw error;
    }
    queueAiResponseSummary(summary._id);
    return reply.code(202).send({ summary });
  });

  app.post('/courses/:courseId/sessions/:sessionId/questions/:questionId/ai-summary/halt', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const session = await instructorSession(course, request.params.sessionId, reply); if (!session) return undefined;
    if (!sessionHasQuestion(session, request.params.questionId)) return reply.code(404).send({ error: 'Not Found', message: 'Question not found in this session' });
    const summary = await AiResponseSummary.findOne({
      courseId: course._id,
      sessionId: request.params.sessionId,
      questionId: request.params.questionId,
      status: { $in: ['queued', 'running'] },
    }).select('_id').lean();
    if (!summary) return reply.code(409).send({ error: 'Conflict', message: 'No AI response summary is in progress' });
    const halted = await haltAiResponseSummary(summary._id);
    if (!halted) return reply.code(409).send({ error: 'Conflict', message: 'The AI response summary has already finished' });
    return { summary: halted };
  });
}
