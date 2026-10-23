import { fileTypeFromBuffer } from 'file-type';
import Image from '../models/Image.js';
import { generateMeteorId } from '../utils/meteorId.js';

const ALLOWED_MIMETYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

export default async function imageRoutes(app) {
  const { authenticate } = app;

  // POST / — Upload an image
  app.post('/', {
    preHandler: authenticate,
    config: {
      rateLimit: { max: 10, timeWindow: '1 hour' },
    },
    schema: {
      consumes: ['multipart/form-data'],
    },
  }, async (request, reply) => {
    try {
      const data = await request.file();
      if (!data) {
        return reply.code(400).send({ error: 'Bad Request', message: 'No file uploaded' });
      }

      if (!ALLOWED_MIMETYPES.includes(data.mimetype)) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: `Invalid file type. Allowed: ${ALLOWED_MIMETYPES.join(', ')}`,
        });
      }

      const buffer = await data.toBuffer();

      if (buffer.length > 5 * 1024 * 1024) {
        return reply.code(400).send({ error: 'Bad Request', message: 'File size exceeds 5MB limit' });
      }

      // Validate file content matches claimed MIME type (magic bytes check)
      const detected = await fileTypeFromBuffer(buffer);
      if (!detected || !ALLOWED_MIMETYPES.includes(detected.mime)) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: `File content does not match an allowed image type. Detected: ${detected?.mime || 'unknown'}`,
        });
      }

      const { url, key } = await app.uploadFile(buffer, data.filename, detected.mime);

      const image = await Image.create({
        _id: generateMeteorId(),
        url,
        key,
        UID: request.user.userId,
        type: detected.mime,
        size: buffer.length,
        createdAt: new Date(),
      });

      return reply.code(201).send({
        image: {
          _id: image._id,
          url: image.url,
          type: image.type,
          size: image.size,
          createdAt: image.createdAt,
        },
      });
    } catch (err) {
      request.log.error({ err }, 'Image upload failed');
      if (typeof err?.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
        return reply.code(err.statusCode).send({
          error: 'Bad Request',
          message: err.message || 'Invalid upload request',
        });
      }
      if (err?.code === 'UPLOAD_CONFIG_ERROR') {
        return reply.code(400).send({
          error: 'Bad Request',
          message: err.message,
        });
      }
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Image upload failed',
      });
    }
  });

  // DELETE /:id — Delete an image (admin or uploader only)
  app.delete('/:id', { preHandler: authenticate }, async (request, reply) => {
    const image = await Image.findById(request.params.id);
    if (!image) {
      return reply.code(404).send({ error: 'Not Found', message: 'Image not found' });
    }

    const isAdmin = (request.user.roles || []).includes('admin');
    const isOwner = image.UID === request.user.userId;
    if (!isAdmin && !isOwner) {
      return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
    }

    await app.deleteFile(image.key);
    await image.deleteOne();

    return { success: true };
  });
}
