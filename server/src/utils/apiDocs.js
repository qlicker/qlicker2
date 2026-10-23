const PUBLIC_ROUTE_PATTERNS = [
  /^\/api\/v1\/health$/,
  /^\/api\/v1\/auth\/register$/,
  /^\/api\/v1\/auth\/login$/,
  /^\/api\/v1\/auth\/refresh$/,
  /^\/api\/v1\/auth\/forgot-password$/,
  /^\/api\/v1\/auth\/reset-password$/,
  /^\/api\/v1\/auth\/verify-email$/,
  /^\/api\/v1\/auth\/sso\/login$/,
  /^\/api\/v1\/auth\/sso\/callback$/,
  /^\/api\/v1\/auth\/sso\/logout$/,
  /^\/api\/v1\/settings\/public$/,
  /^\/uploads\//,
];

const TAG_LABELS = {
  auth: 'Auth',
  users: 'Users',
  settings: 'Settings',
  courses: 'Courses',
  sessions: 'Sessions',
  questions: 'Questions',
  grades: 'Grades',
  images: 'Images',
  groups: 'Groups',
  video: 'Video',
  health: 'Health',
  uploads: 'Uploads',
};

function isPublicRoute(url = '') {
  return PUBLIC_ROUTE_PATTERNS.some((pattern) => pattern.test(url));
}

function inferTag(url = '') {
  if (url.startsWith('/uploads/')) return TAG_LABELS.uploads;
  if (url === '/api/v1/health') return TAG_LABELS.health;
  if (url.includes('/video')) return TAG_LABELS.video;
  if (url.includes('/groups')) return TAG_LABELS.groups;

  const [firstSegment = ''] = url.replace(/^\/api\/v1\/?/, '').split('/');
  return TAG_LABELS[firstSegment] || 'API';
}

function inferParamsSchema(url = '') {
  const paramNames = [...url.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]);
  if (!paramNames.length) return undefined;

  return {
    type: 'object',
    required: paramNames,
    properties: Object.fromEntries(
      paramNames.map((name) => [
        name,
        {
          type: 'string',
          description: `${name} path parameter`,
        },
      ])
    ),
  };
}

function buildResponseContent(schema) {
  return {
    'application/json': {
      schema,
    },
  };
}

function buildDefaultResponses(method = 'GET', url = '') {
  if (url.startsWith('/uploads/')) {
    return {
      200: {
        description: 'Uploaded file contents',
      },
      400: {
        description: 'Invalid filename',
        content: buildResponseContent({
          type: 'object',
          properties: {
            error: { type: 'string' },
            message: { type: 'string' },
          },
        }),
      },
      404: {
        description: 'File not found',
        content: buildResponseContent({
          type: 'object',
          properties: {
            error: { type: 'string' },
            message: { type: 'string' },
          },
        }),
      },
    };
  }

  const successStatus = 200;
  return {
    [successStatus]: {
      description: 'Successful response',
      content: buildResponseContent({
        type: 'object',
        additionalProperties: true,
      }),
    },
    400: {
      description: 'Bad Request',
      content: buildResponseContent({
        type: 'object',
        properties: {
          error: { type: 'string' },
          message: { type: 'string' },
        },
      }),
    },
    401: {
      description: 'Unauthorized',
      content: buildResponseContent({
        type: 'object',
        properties: {
          error: { type: 'string' },
          message: { type: 'string' },
        },
      }),
    },
    403: {
      description: 'Forbidden',
      content: buildResponseContent({
        type: 'object',
        properties: {
          error: { type: 'string' },
          message: { type: 'string' },
        },
      }),
    },
    404: {
      description: 'Not Found',
      content: buildResponseContent({
        type: 'object',
        properties: {
          error: { type: 'string' },
          message: { type: 'string' },
        },
      }),
    },
  };
}

export function transformApiDocs({ schema = {}, url = '', route }) {
  const nextSchema = { ...schema };
  const method = String(route?.method || 'GET').toUpperCase();

  if (!nextSchema.tags || !nextSchema.tags.length) {
    nextSchema.tags = [inferTag(url)];
  }

  if (!nextSchema.params) {
    const paramsSchema = inferParamsSchema(url);
    if (paramsSchema) {
      nextSchema.params = paramsSchema;
    }
  }

  if (
    !nextSchema.body
    && Array.isArray(nextSchema.consumes)
    && nextSchema.consumes.includes('multipart/form-data')
  ) {
    nextSchema.body = {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Multipart file upload field',
        },
      },
    };
  }

  if (!nextSchema.response) {
    nextSchema.response = buildDefaultResponses(method, url);
  }

  if (!nextSchema.security && !isPublicRoute(url)) {
    nextSchema.security = [{ bearerAuth: [] }];
  }

  return nextSchema;
}

export function stringParamsSchema(paramNames) {
  return {
    type: 'object',
    required: paramNames,
    properties: Object.fromEntries(paramNames.map((name) => [name, { type: 'string', minLength: 1 }])),
    additionalProperties: false,
  };
}
