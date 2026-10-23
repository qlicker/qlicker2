export const QUESTION_TYPES = {
  MULTIPLE_CHOICE: 0,
  TRUE_FALSE: 1,
  SHORT_ANSWER: 2,
  MULTI_SELECT: 3,
  NUMERICAL: 4,
  SLIDE: 6,
};

export const TYPE_LABELS = {
  [QUESTION_TYPES.SHORT_ANSWER]: 'Short Answer',
  [QUESTION_TYPES.MULTIPLE_CHOICE]: 'Multiple Choice',
  [QUESTION_TYPES.TRUE_FALSE]: 'True/False',
  [QUESTION_TYPES.MULTI_SELECT]: 'Multi-Select',
  [QUESTION_TYPES.NUMERICAL]: 'Numerical',
  [QUESTION_TYPES.SLIDE]: 'Slide',
};

const TYPE_TRANSLATION_KEYS = {
  [QUESTION_TYPES.SHORT_ANSWER]: 'questions.types.shortAnswer',
  [QUESTION_TYPES.MULTIPLE_CHOICE]: 'questions.types.multipleChoice',
  [QUESTION_TYPES.TRUE_FALSE]: 'questions.types.trueFalse',
  [QUESTION_TYPES.MULTI_SELECT]: 'questions.types.multiSelect',
  [QUESTION_TYPES.NUMERICAL]: 'questions.types.numerical',
  [QUESTION_TYPES.SLIDE]: 'questions.types.slide',
};

export const TYPE_COLORS = {
  [QUESTION_TYPES.SHORT_ANSWER]: 'default',
  [QUESTION_TYPES.MULTIPLE_CHOICE]: 'primary',
  [QUESTION_TYPES.TRUE_FALSE]: 'secondary',
  [QUESTION_TYPES.MULTI_SELECT]: 'info',
  [QUESTION_TYPES.NUMERICAL]: 'warning',
  [QUESTION_TYPES.SLIDE]: 'default',
};

export function isSlideType(type) {
  return Number(type) === QUESTION_TYPES.SLIDE;
}

export function isSlideQuestion(question = {}) {
  return isSlideType(question?.type);
}

export function isOptionBasedQuestionType(type) {
  return [
    QUESTION_TYPES.MULTIPLE_CHOICE,
    QUESTION_TYPES.TRUE_FALSE,
    QUESTION_TYPES.MULTI_SELECT,
  ].includes(Number(type));
}

export function isAutoGradeableQuestionType(type) {
  return [
    QUESTION_TYPES.MULTIPLE_CHOICE,
    QUESTION_TYPES.TRUE_FALSE,
    QUESTION_TYPES.MULTI_SELECT,
    QUESTION_TYPES.NUMERICAL,
  ].includes(Number(type));
}

export function isResponseQuestionType(type) {
  return !isSlideType(type);
}

export function getQuestionTypeLabel(t, type, fallback = {}) {
  const normalizedType = normalizeQuestionType({ type });
  const translationKey = TYPE_TRANSLATION_KEYS[normalizedType];
  if (translationKey) {
    return t(translationKey, {
      defaultValue: TYPE_LABELS[normalizedType],
    });
  }

  return t(fallback.key || 'common.unknown', {
    defaultValue: fallback.defaultValue || 'Unknown',
  });
}

export function buildQuestionProgressList(questions = []) {
  const totalPages = Array.isArray(questions) ? questions.length : 0;
  const totalQuestions = (questions || []).reduce(
    (count, question) => count + (isSlideType(normalizeQuestionType(question)) ? 0 : 1),
    0
  );

  let questionsSeen = 0;
  return (questions || []).map((question, index) => {
    if (!isSlideType(normalizeQuestionType(question))) {
      questionsSeen += 1;
    }

    return {
      pageCurrent: index + 1,
      pageTotal: totalPages,
      questionCurrent: questionsSeen,
      questionTotal: totalQuestions,
    };
  });
}

function isTrueFalseOptions(options = []) {
  if (!Array.isArray(options) || options.length !== 2) return false;
  const labels = options.map((o) => (o?.answer || o?.plainText || o?.content || '').replace(/<[^>]*>/g, '').trim().toUpperCase());
  return labels.includes('TRUE') && labels.includes('FALSE');
}

function countCorrect(options = []) {
  return options.filter((o) => !!o?.correct).length;
}

/**
 * Normalize question type values.
 * Canonical mapping follows Meteor app configs:
 * MC=0 (exactly one correct option), TF=1, SA=2, MS=3 (one or more correct options), NU=4.
 */
export function normalizeQuestionType(question = {}) {
  const rawType = Number(question?.type);
  const options = question?.options || [];
  if (rawType === QUESTION_TYPES.MULTIPLE_CHOICE) return QUESTION_TYPES.MULTIPLE_CHOICE;
  if (rawType === QUESTION_TYPES.TRUE_FALSE) return QUESTION_TYPES.TRUE_FALSE;
  if (rawType === QUESTION_TYPES.SHORT_ANSWER) return QUESTION_TYPES.SHORT_ANSWER;
  if (rawType === QUESTION_TYPES.MULTI_SELECT) return QUESTION_TYPES.MULTI_SELECT;
  if (rawType === QUESTION_TYPES.SLIDE) return QUESTION_TYPES.SLIDE;
  if (rawType === QUESTION_TYPES.NUMERICAL) {
    // Guard for malformed restored rows: numerical type with multiple options.
    // These should be option-based questions, not numerical.
    if (Array.isArray(options) && options.length > 1) {
      if (isTrueFalseOptions(options)) return QUESTION_TYPES.TRUE_FALSE;
      return countCorrect(options) > 1 ? QUESTION_TYPES.MULTI_SELECT : QUESTION_TYPES.MULTIPLE_CHOICE;
    }
    return QUESTION_TYPES.NUMERICAL;
  }

  // Compatibility for any docs written with a 1..5 enum where 5 represented numerical.
  if (rawType === 5) return QUESTION_TYPES.NUMERICAL;

  // Last-resort fallback for malformed records with unknown type values.
  return QUESTION_TYPES.SHORT_ANSWER;
}
