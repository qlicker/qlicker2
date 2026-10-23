import fp from 'fastify-plugin';
import mongoose from 'mongoose';
import { connectMongooseWithRetry } from '../utils/mongo.js';

async function dbPlugin(fastify, options) {
  const uri = options.uri || fastify.config.mongoUri;
  try {
    await connectMongooseWithRetry(uri, {
      mongooseInstance: mongoose,
      logger: fastify.log,
      maxPoolSize: fastify.config.mongoMaxPoolSize,
      minPoolSize: fastify.config.mongoMinPoolSize,
      serverSelectionTimeoutMS: fastify.config.mongoServerSelectionTimeoutMs,
      socketTimeoutMS: fastify.config.mongoSocketTimeoutMs,
      connectRetries: fastify.config.mongoConnectRetries,
      connectRetryDelayMs: fastify.config.mongoConnectRetryDelayMs,
    });
    fastify.log.info('MongoDB connected');
  } catch (err) {
    fastify.log.error({ err }, 'MongoDB connection error');
    throw err;
  }
  fastify.decorate('mongoose', mongoose);
  fastify.addHook('onClose', async () => {
    await mongoose.connection.close();
  });
}

export default fp(dbPlugin, { name: 'db' });
