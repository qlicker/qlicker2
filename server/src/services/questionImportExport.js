export function normalizeTags(tags = []) {
  if (!Array.isArray(tags)) return [];

  return tags.reduce((normalized, tag) => {
    if (!tag) return normalized;
    if (typeof tag === 'string') {
      const value = tag.trim();
      if (!value) return normalized;
      normalized.push({ value, label: value });
      return normalized;
    }

    const value = String(tag?.value || tag?.label || '').trim();
    const label = String(tag?.label || tag?.value || '').trim();
    if (!value || !label) return normalized;

    normalized.push({
      value,
      label,
      ...(tag?.className ? { className: String(tag.className) } : {}),
    });
    return normalized;
  }, []);
}

export function getNormalizedTagValue(tag) {
  return String(tag?.value || tag?.label || tag || '').trim().toLowerCase();
}

export function filterTagsToAllowedValues(tags = [], allowedValues = new Set()) {
  if (!(allowedValues instanceof Set) || allowedValues.size === 0) return [];
  return normalizeTags(tags).filter((tag) => allowedValues.has(getNormalizedTagValue(tag)));
}

export function mergeNormalizedTags(...tagLists) {
  const merged = [];
  const seen = new Set();

  tagLists.forEach((tags) => {
    normalizeTags(tags).forEach((tag) => {
      const key = getNormalizedTagValue(tag);
      if (!key || seen.has(key)) return;
      seen.add(key);
      merged.push(tag);
    });
  });

  return merged;
}

function buildNormalizedImportedTagList(tags = []) {
  const existingTags = normalizeTags(tags);
  const hasImportedTag = existingTags.some((tag) => String(tag.value || '').toLowerCase() === 'imported');
  if (hasImportedTag) return existingTags;
  return [...existingTags, { value: 'imported', label: 'imported' }];
}

function sanitizeSessionOptionsForExport(sessionOptions = {}) {
  if (!sessionOptions || typeof sessionOptions !== 'object') return undefined;

  const sanitized = {};
  if (sessionOptions.hidden === true) {
    sanitized.hidden = sessionOptions.hidden;
  }
  if (sessionOptions.points !== undefined) {
    sanitized.points = Number(sessionOptions.points) || 0;
  }
  if (sessionOptions.maxAttempts !== undefined) {
    const maxAttempts = Number(sessionOptions.maxAttempts) || 0;
    if (maxAttempts > 0 && maxAttempts !== 1) {
      sanitized.maxAttempts = maxAttempts;
    }
  }
  if (Array.isArray(sessionOptions.attemptWeights)) {
    const attemptWeights = sessionOptions.attemptWeights
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    if (attemptWeights.length > 0) {
      sanitized.attemptWeights = attemptWeights;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizeSessionOptionsForImport(sessionOptions = {}) {
  const sanitized = sanitizeSessionOptionsForExport(sessionOptions);
  if (!sanitized) return undefined;
  return {
    ...sanitized,
    ...(sanitized.maxAttempts === undefined ? { maxAttempts: 1 } : {}),
  };
}

export function sanitizeExportedQuestion(question, { includeSessionOptions = false } = {}) {
  const source = typeof question?.toObject === 'function' ? question.toObject() : question;
  return {
    type: source?.type,
    content: source?.content || '',
    plainText: source?.plainText || '',
    options: Array.isArray(source?.options) ? source.options : [],
    toleranceNumerical: source?.toleranceNumerical,
    correctNumerical: source?.correctNumerical,
    solution: source?.solution || '',
    solution_plainText: source?.solution_plainText || '',
    public: !!source?.public,
    publicOnQlicker: !!source?.publicOnQlicker,
    publicOnQlickerForStudents: !!source?.publicOnQlickerForStudents,
    tags: normalizeTags(source?.tags || []),
    creator: String(source?.creator || '').trim(),
    originalQuestion: String(source?.originalQuestion || source?._id || '').trim(),
    originalCourse: String(source?.originalCourse || source?.courseId || '').trim(),
    imagePath: source?.imagePath || '',
    ...(includeSessionOptions
      ? { sessionOptions: sanitizeSessionOptionsForExport(source?.sessionOptions) }
      : {}),
  };
}

export function sanitizeImportedQuestion(question, {
  courseId,
  sessionId,
  userId,
  includeSessionOptions = false,
  importTags = [],
}) {
  const tags = mergeNormalizedTags(buildNormalizedImportedTagList(question?.tags || []), importTags);
  const payload = {
    type: Number(question?.type),
    content: question?.content || '',
    plainText: question?.plainText || question?.content || '',
    options: Array.isArray(question?.options) ? question.options : [],
    courseId,
    sessionId,
    solution: question?.solution || '',
    solution_plainText: question?.solution_plainText || '',
    public: !!question?.public,
    publicOnQlicker: !!question?.publicOnQlicker,
    publicOnQlickerForStudents: !!question?.publicOnQlickerForStudents,
    tags,
    imagePath: question?.imagePath || '',
    approved: true,
    creator: String(question?.creator || userId),
    owner: userId,
    originalQuestion: String(question?.originalQuestion || '').trim(),
    originalCourse: String(question?.originalCourse || courseId).trim(),
    createdAt: new Date(),
    lastEditedAt: new Date(),
    studentCreated: false,
  };

  if (question?.toleranceNumerical !== undefined) {
    payload.toleranceNumerical = question.toleranceNumerical;
  }
  if (question?.correctNumerical !== undefined) {
    payload.correctNumerical = question.correctNumerical;
  }
  if (includeSessionOptions) {
    payload.sessionOptions = sanitizeSessionOptionsForImport(question?.sessionOptions);
  }

  return payload;
}
