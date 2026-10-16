import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let mongoServer;
let mongoAvailable = false;

beforeAll(async () => {
  try {
    mongoServer = new MongoMemoryServer({
      binary: {
        systemBinary: process.env.MONGOMS_SYSTEM_BINARY || undefined,
      },
    });
    await mongoServer.start();
    const uri = mongoServer.getUri();
    await mongoose.connect(uri);
    mongoAvailable = true;
  } catch (err) {
    console.warn(
      'MongoDB Memory Server not available (MongoDB binary could not be downloaded).',
      'Tests requiring MongoDB will be skipped.',
      'In CI, ensure a MongoDB service is configured.',
    );
    // Connect to a local MongoDB if available as a fallback
    try {
      const fallbackUri = process.env.MONGO_TEST_URI || 'mongodb://localhost:27017/qlicker-test';
      await mongoose.connect(fallbackUri, { serverSelectionTimeoutMS: 2000 });
      mongoAvailable = true;
    } catch {
      console.warn('No local MongoDB available either. All DB tests will be skipped.');
    }
  }
});

afterAll(async () => {
  try {
    await mongoose.disconnect();
  } finally {
    if (mongoServer) {
      await mongoServer.stop();
    }
  }
});

afterEach(async () => {
  if (mongoose.connection.readyState !== 1) return;
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
});

export { mongoAvailable };
