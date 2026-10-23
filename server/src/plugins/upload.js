import fp from 'fastify-plugin';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateMeteorId } from '../utils/meteorId.js';
import { guessImageContentTypeFromKey, toUploadsUrl } from '../utils/storageUrls.js';
import { getOrCreateSettingsDocument } from '../utils/settingsSingleton.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.resolve(__dirname, '../../uploads');
const IMAGE_EXTENSIONS_BY_TYPE = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

async function uploadPlugin(fastify) {
  await fastify.register(import('@fastify/multipart'), {
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  });

  // Ensure uploads directory exists for local storage
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }

  let s3ModulePromise = null;
  let azureModulePromise = null;
  let cachedStorageConfig = null;
  let cachedStorageConfigExpiresAt = 0;
  let cachedS3Client = null;
  let cachedS3ClientKey = '';
  let cachedAzureBlobServiceClient = null;
  let cachedAzureBlobServiceClientKey = '';
  const STORAGE_CONFIG_CACHE_TTL_MS = 5000;
  // S3 closes idle connections after ~20s, so probe often enough to stay warm.
  const STORAGE_KEEP_WARM_INTERVAL_MS = 15000;

  function asBool(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true' || normalized === '1') return true;
      if (normalized === 'false' || normalized === '0') return false;
    }
    return fallback;
  }

  function normalizeStorageType(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 's3' || normalized === 'azure' || normalized === 'local') {
      return normalized;
    }
    return 'local';
  }

  function getFileExtension(filename, mimetype) {
    // Pin the stored extension to the validated content type so a client cannot
    // choose the served Content-Type (e.g. naming a raster upload ".svg" or
    // ".html"). Only fall back to the filename for types we don't map.
    const fromMime = IMAGE_EXTENSIONS_BY_TYPE[mimetype];
    if (fromMime) return fromMime;
    const fromName = path.extname(filename || '').toLowerCase();
    if (fromName && fromName.length <= 8) return fromName;
    return '';
  }

  function createStorageConfigError(message) {
    const err = new Error(message);
    err.code = 'UPLOAD_CONFIG_ERROR';
    return err;
  }

  async function streamToBuffer(body) {
    if (!body) return Buffer.alloc(0);
    if (Buffer.isBuffer(body)) return body;
    if (typeof body.transformToByteArray === 'function') {
      return Buffer.from(await body.transformToByteArray());
    }

    const chunks = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  function ensureRequired(value, message) {
    if (!value || String(value).trim().length === 0) {
      throw createStorageConfigError(message);
    }
  }

  function hasStaticS3Credentials(config) {
    return Boolean(config.AWS_accessKeyId || config.AWS_secretAccessKey);
  }

  function validateS3Configuration(config) {
    ensureRequired(config.AWS_bucket, 'S3 storage requires AWS bucket.');

    const hasAccessKeyId = Boolean(String(config.AWS_accessKeyId || '').trim());
    const hasSecretAccessKey = Boolean(String(config.AWS_secretAccessKey || '').trim());
    if (hasAccessKeyId !== hasSecretAccessKey) {
      throw createStorageConfigError('S3 storage requires both AWS access key ID and secret access key when using static credentials.');
    }
  }

  async function getStorageConfig() {
    if (cachedStorageConfig && Date.now() < cachedStorageConfigExpiresAt) {
      return cachedStorageConfig;
    }

    const settings = await getOrCreateSettingsDocument({
      lean: true,
      select: [
        'storageType',
        'AWS_bucket',
        'AWS_region',
        'AWS_accessKeyId',
        'AWS_accessKey',
        'AWS_secretAccessKey',
        'AWS_secret',
        'AWS_endpoint',
        'S3_endpoint',
        'AWS_forcePathStyle',
        'S3_forcePathStyle',
        'Azure_storageAccount',
        'Azure_accountName',
        'Azure_storageAccessKey',
        'Azure_accountKey',
        'Azure_storageContainer',
        'Azure_containerName',
      ].join(' '),
    });
    const storageType = normalizeStorageType(
      settings?.storageType || 'local'
    );
    const awsEndpoint = settings?.AWS_endpoint || settings?.S3_endpoint || '';
    const rawForcePathStyle = settings?.AWS_forcePathStyle
      ?? settings?.S3_forcePathStyle
      ?? undefined;
    const defaultPathStyleForEndpoint = Boolean(awsEndpoint);
    const awsForcePathStyle = rawForcePathStyle === undefined
      || rawForcePathStyle === null
      || (typeof rawForcePathStyle === 'string' && rawForcePathStyle.trim() === '')
      ? defaultPathStyleForEndpoint
      : asBool(rawForcePathStyle, defaultPathStyleForEndpoint);

    cachedStorageConfig = {
      storageType,
      AWS_bucket: settings?.AWS_bucket || '',
      AWS_region: settings?.AWS_region || 'us-east-1',
      AWS_accessKeyId: settings?.AWS_accessKeyId
        || settings?.AWS_accessKey
        || '',
      AWS_secretAccessKey: settings?.AWS_secretAccessKey
        || settings?.AWS_secret
        || '',
      AWS_endpoint: awsEndpoint,
      AWS_forcePathStyle: awsForcePathStyle,
      Azure_storageAccount: settings?.Azure_storageAccount
        || settings?.Azure_accountName
        || '',
      Azure_storageAccessKey: settings?.Azure_storageAccessKey
        || settings?.Azure_accountKey
        || '',
      Azure_storageContainer: settings?.Azure_storageContainer
        || settings?.Azure_containerName
        || '',
    };
    cachedStorageConfigExpiresAt = Date.now() + STORAGE_CONFIG_CACHE_TTL_MS;
    return cachedStorageConfig;
  }

  async function loadS3Module() {
    if (!s3ModulePromise) {
      s3ModulePromise = import('@aws-sdk/client-s3');
    }
    return s3ModulePromise;
  }

  async function loadAzureModule() {
    if (!azureModulePromise) {
      azureModulePromise = import('@azure/storage-blob');
    }
    return azureModulePromise;
  }

  function getS3ClientCacheKey(config) {
    return JSON.stringify({
      region: config.AWS_region || 'us-east-1',
      credentialsMode: hasStaticS3Credentials(config) ? 'static' : 'default',
      accessKeyId: config.AWS_accessKeyId || '',
      secretAccessKey: config.AWS_secretAccessKey || '',
      endpoint: config.AWS_endpoint || '',
      forcePathStyle: !!config.AWS_forcePathStyle,
    });
  }

  async function getS3Client(config) {
    const cacheKey = getS3ClientCacheKey(config);
    if (cachedS3Client && cachedS3ClientKey === cacheKey) {
      return cachedS3Client;
    }

    const { S3Client } = await loadS3Module();
    const clientOptions = {
      region: config.AWS_region || 'us-east-1',
      endpoint: config.AWS_endpoint || undefined,
      forcePathStyle: config.AWS_forcePathStyle,
    };
    if (hasStaticS3Credentials(config)) {
      clientOptions.credentials = {
        accessKeyId: config.AWS_accessKeyId,
        secretAccessKey: config.AWS_secretAccessKey,
      };
    }

    cachedS3Client = new S3Client({
      ...clientOptions,
    });
    cachedS3ClientKey = cacheKey;
    return cachedS3Client;
  }

  function getAzureBlobServiceClientCacheKey(config) {
    return JSON.stringify({
      account: config.Azure_storageAccount || '',
      accessKey: config.Azure_storageAccessKey || '',
    });
  }

  async function getAzureBlobServiceClient(config) {
    const cacheKey = getAzureBlobServiceClientCacheKey(config);
    if (cachedAzureBlobServiceClient && cachedAzureBlobServiceClientKey === cacheKey) {
      return cachedAzureBlobServiceClient;
    }

    const { StorageSharedKeyCredential, BlobServiceClient } = await loadAzureModule();
    const credential = new StorageSharedKeyCredential(
      config.Azure_storageAccount,
      config.Azure_storageAccessKey
    );
    cachedAzureBlobServiceClient = new BlobServiceClient(
      `https://${config.Azure_storageAccount}.blob.core.windows.net`,
      credential
    );
    cachedAzureBlobServiceClientKey = cacheKey;
    return cachedAzureBlobServiceClient;
  }

  async function uploadFile(fileBuffer, filename, mimetype) {
    const config = await getStorageConfig();
    const ext = getFileExtension(filename, mimetype);
    const key = `${generateMeteorId()}${ext}`;

    switch (config.storageType) {
      case 'local': {
        const filePath = path.join(UPLOADS_DIR, key);
        await fs.promises.writeFile(filePath, fileBuffer);
        const url = toUploadsUrl(key);
        return { url, key };
      }
      case 's3': {
        validateS3Configuration(config);

        const { PutObjectCommand } = await loadS3Module();
        const client = await getS3Client(config);
        await client.send(new PutObjectCommand({
          Bucket: config.AWS_bucket,
          Key: key,
          Body: fileBuffer,
          ContentType: mimetype,
        }));

        const url = toUploadsUrl(key);
        return { url, key };
      }
      case 'azure': {
        ensureRequired(config.Azure_storageAccount, 'Azure storage requires account name.');
        ensureRequired(config.Azure_storageAccessKey, 'Azure storage requires account key.');
        ensureRequired(config.Azure_storageContainer, 'Azure storage requires container.');

        const blobServiceClient = await getAzureBlobServiceClient(config);
        const containerClient = blobServiceClient.getContainerClient(config.Azure_storageContainer);
        await containerClient.createIfNotExists();

        const blockBlobClient = containerClient.getBlockBlobClient(key);
        await blockBlobClient.uploadData(fileBuffer, {
          blobHTTPHeaders: {
            blobContentType: mimetype,
          },
        });

        return { url: toUploadsUrl(key), key };
      }
      default:
        throw createStorageConfigError(`Unknown storage type: ${config.storageType}`);
    }
  }

  async function deleteFile(key) {
    if (!key) return;

    const config = await getStorageConfig();
    switch (config.storageType) {
      case 'local': {
        const filePath = path.join(UPLOADS_DIR, key);
        if (fs.existsSync(filePath)) {
          await fs.promises.unlink(filePath);
        }
        return;
      }
      case 's3': {
        validateS3Configuration(config);

        const { DeleteObjectCommand } = await loadS3Module();
        const client = await getS3Client(config);
        await client.send(new DeleteObjectCommand({
          Bucket: config.AWS_bucket,
          Key: key,
        }));
        return;
      }
      case 'azure': {
        ensureRequired(config.Azure_storageAccount, 'Azure storage requires account name.');
        ensureRequired(config.Azure_storageAccessKey, 'Azure storage requires account key.');
        ensureRequired(config.Azure_storageContainer, 'Azure storage requires container.');

        const blobServiceClient = await getAzureBlobServiceClient(config);
        const containerClient = blobServiceClient.getContainerClient(config.Azure_storageContainer);
        const blockBlobClient = containerClient.getBlockBlobClient(key);
        await blockBlobClient.deleteIfExists();
        return;
      }
      default:
        throw createStorageConfigError(`Unknown storage type: ${config.storageType}`);
    }
  }

  async function getFileObject(key) {
    if (!key) {
      throw createStorageConfigError('File key is required.');
    }

    const config = await getStorageConfig();
    switch (config.storageType) {
      case 'local': {
        const filePath = path.join(UPLOADS_DIR, key);
        const buffer = await fs.promises.readFile(filePath);
        return {
          buffer,
          contentType: guessImageContentTypeFromKey(key),
        };
      }
      case 's3': {
        validateS3Configuration(config);

        const { GetObjectCommand } = await loadS3Module();
        const client = await getS3Client(config);
        const response = await client.send(new GetObjectCommand({
          Bucket: config.AWS_bucket,
          Key: key,
        }));
        return {
          buffer: await streamToBuffer(response.Body),
          contentType: response.ContentType || guessImageContentTypeFromKey(key),
        };
      }
      case 'azure': {
        ensureRequired(config.Azure_storageAccount, 'Azure storage requires account name.');
        ensureRequired(config.Azure_storageAccessKey, 'Azure storage requires account key.');
        ensureRequired(config.Azure_storageContainer, 'Azure storage requires container.');

        const blobServiceClient = await getAzureBlobServiceClient(config);
        const containerClient = blobServiceClient.getContainerClient(config.Azure_storageContainer);
        const blockBlobClient = containerClient.getBlockBlobClient(key);
        const response = await blockBlobClient.download();
        return {
          buffer: await streamToBuffer(response.readableStreamBody),
          contentType: response.contentType || guessImageContentTypeFromKey(key),
        };
      }
      default:
        throw createStorageConfigError(`Unknown storage type: ${config.storageType}`);
    }
  }

  async function getFileBuffer(key) {
    const { buffer } = await getFileObject(key);
    return buffer;
  }

  fastify.decorate('uploadFile', uploadFile);
  fastify.decorate('deleteFile', deleteFile);
  fastify.decorate('getFileObject', getFileObject);
  fastify.decorate('getFileBuffer', getFileBuffer);
  fastify.decorate('uploadsDir', UPLOADS_DIR);

  // Fresh TLS handshakes to S3 can be very slow on some networks (a constant
  // ~3s per handshake was measured on the production host), so every cold
  // upload or image fetch paid that cost. Keep one pooled connection warm per
  // process so requests reuse an established socket instead.
  async function warmStorageConnection() {
    const config = await getStorageConfig();
    if (config.storageType !== 's3') return;
    validateS3Configuration(config);
    const { HeadBucketCommand } = await loadS3Module();
    const client = await getS3Client(config);
    // Any response (including an auth error) leaves the TLS session warm.
    await client.send(new HeadBucketCommand({ Bucket: config.AWS_bucket })).catch(() => {});
  }

  if (fastify.config?.nodeEnv !== 'test') {
    let keepWarmTimer = null;
    const warm = () => {
      warmStorageConnection().catch((err) => {
        fastify.log.debug({ err }, 'Storage keep-warm probe failed');
      });
    };
    fastify.addHook('onReady', async () => {
      warm();
      keepWarmTimer = setInterval(warm, STORAGE_KEEP_WARM_INTERVAL_MS);
      keepWarmTimer.unref?.();
    });
    fastify.addHook('onClose', async () => {
      if (keepWarmTimer) clearInterval(keepWarmTimer);
    });
  }
}

export default fp(uploadPlugin, { name: 'upload' });
