#!/usr/bin/env node
// =============================================================================
// Qlicker Production — S3 Private-Bucket Sanitization
// =============================================================================
// Rewrites legacy public S3 URLs in MongoDB to stable /uploads/... paths and,
// when credentials are available, can also switch the underlying S3 objects
// from public-read ACLs to private.
//
// What it does:
//   1. Resolves S3 settings from the database Settings document (env overrides)
//   2. Scans users/images/questions for legacy S3-backed image references
//   3. Rewrites those references to /uploads/<key> so the Fastify app can proxy
//      reads from a private bucket
//   4. Optionally updates object ACLs from public-read to private
//
// Usage:
//   node sanitize-s3.js                     # Dry run
//   node sanitize-s3.js --apply             # Rewrite DB refs + update ACLs
//   node sanitize-s3.js --apply --verbose
// =============================================================================

import mongoose from 'mongoose';

const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--apply');
const VERBOSE = args.includes('--verbose');
const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017/qlicker';
const IMG_SRC_REGEX = /(<img\b[^>]*?\bsrc=["'])([^"']+)(["'][^>]*>)/gi;

if (DRY_RUN) {
  console.log('=== DRY RUN MODE === (pass --apply to make changes)\n');
}

function asBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return fallback;
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function escapeRegExp(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function encodeStorageKey(key = '') {
  return encodeURIComponent(String(key || '')).replace(/%2F/g, '/');
}

function toUploadsUrl(key = '') {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return '';
  return `/uploads/${encodeStorageKey(normalizedKey)}`;
}

function normalizePathSegments(pathname = '') {
  return String(pathname || '')
    .split('/')
    .filter(Boolean)
    .map((segment) => safeDecodeURIComponent(segment));
}

function extractUploadsKey(value = '') {
  const rawValue = String(value || '').trim();
  if (!rawValue) return '';

  const fromPath = (pathname = '') => {
    if (!pathname.startsWith('/uploads/')) return '';
    const key = pathname.slice('/uploads/'.length);
    if (!key) return '';
    return normalizePathSegments(key).join('/');
  };

  try {
    const parsed = rawValue.startsWith('/')
      ? new URL(rawValue, 'http://localhost')
      : new URL(rawValue);
    return fromPath(parsed.pathname);
  } catch {
    const stripped = rawValue.split('?')[0].split('#')[0];
    return fromPath(stripped);
  }
}

function extractConfiguredS3Key(value, config) {
  if (!value || typeof value !== 'string') return '';
  const rawValue = value.trim();
  if (!rawValue) return '';

  let parsed;
  try {
    parsed = rawValue.startsWith('/')
      ? new URL(rawValue, 'http://localhost')
      : new URL(rawValue);
  } catch {
    return '';
  }

  const bucket = String(config.bucket || '').trim();
  if (!bucket) return '';

  const pathSegments = normalizePathSegments(parsed.pathname);
  if (pathSegments.length === 0) return '';

  const bucketLower = bucket.toLowerCase();
  const hostLower = parsed.hostname.toLowerCase();
  const escapedBucket = escapeRegExp(bucketLower);
  const virtualHostedAwsPattern = new RegExp(`^${escapedBucket}\\.s3(?:[.-][a-z0-9-]+)*\\.amazonaws\\.com$`);
  const websiteHostedAwsPattern = new RegExp(`^${escapedBucket}\\.s3-website(?:[.-][a-z0-9-]+)*\\.amazonaws\\.com$`);
  const pathStyleAwsPattern = /^s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/;

  if (virtualHostedAwsPattern.test(hostLower) || websiteHostedAwsPattern.test(hostLower)) {
    return pathSegments.join('/');
  }

  if (pathStyleAwsPattern.test(hostLower) && pathSegments[0]?.toLowerCase() === bucketLower) {
    return pathSegments.slice(1).join('/');
  }

  if (config.endpoint) {
    try {
      const endpoint = new URL(config.endpoint);
      const endpointHostLower = endpoint.hostname.toLowerCase();
      if (hostLower === endpointHostLower) {
        if (pathSegments[0]?.toLowerCase() === bucketLower) {
          return pathSegments.slice(1).join('/');
        }
      }
      if (hostLower === `${bucketLower}.${endpointHostLower}`) {
        return pathSegments.join('/');
      }
    } catch {
      // Ignore malformed endpoint settings; env/settings validation happens elsewhere.
    }
  }

  return '';
}

function analyzeImageReference(value, config) {
  const uploadsKey = extractUploadsKey(value);
  if (uploadsKey) {
    return {
      key: uploadsKey,
      currentUrl: value,
      nextUrl: toUploadsUrl(uploadsKey),
      alreadyNormalized: true,
      managed: true,
    };
  }

  const s3Key = extractConfiguredS3Key(value, config);
  if (!s3Key) {
    return { key: '', currentUrl: value, nextUrl: value, alreadyNormalized: false, managed: false };
  }

  return {
    key: s3Key,
    currentUrl: value,
    nextUrl: toUploadsUrl(s3Key),
    alreadyNormalized: false,
    managed: true,
  };
}

function rewriteHtmlImageSources(html, config, stats) {
  if (!html || typeof html !== 'string' || !html.includes('<img')) {
    return { nextHtml: html, changed: false };
  }

  let changed = false;
  const nextHtml = html.replace(IMG_SRC_REGEX, (match, prefix, src, suffix) => {
    const analyzed = analyzeImageReference(src, config);
    if (!analyzed.managed || !analyzed.key) {
      return match;
    }

    stats.referencesFound += 1;
    stats.s3Keys.add(analyzed.key);
    if (!analyzed.alreadyNormalized && analyzed.nextUrl !== analyzed.currentUrl) {
      stats.referencesRewritten += 1;
      changed = true;
      if (VERBOSE) {
        console.log(`  rewrite html image: ${analyzed.currentUrl} -> ${analyzed.nextUrl}`);
      }
      return `${prefix}${analyzed.nextUrl}${suffix}`;
    }

    if (VERBOSE) {
      console.log(`  keep html image: ${analyzed.currentUrl}`);
    }
    return match;
  });

  return { nextHtml, changed };
}

async function resolveStorageConfig(db) {
  let settings = await db.collection('settings').findOne({ _id: 'settings' });
  if (!settings) {
    settings = await db.collection('settings').findOne({});
    if (settings) {
      console.log(`[WARN] Canonical settings document (_id="settings") was not found. Using legacy settings _id="${String(settings._id || '')}".`);
    }
  }
  settings = settings || {};
  const endpoint = process.env.AWS_ENDPOINT || settings.AWS_endpoint || settings.S3_endpoint || '';
  const defaultPathStyleForEndpoint = Boolean(endpoint);

  return {
    bucket: process.env.AWS_BUCKET || settings.AWS_bucket || '',
    region: process.env.AWS_REGION || settings.AWS_region || 'us-east-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || settings.AWS_accessKeyId || settings.AWS_accessKey || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || settings.AWS_secretAccessKey || settings.AWS_secret || '',
    endpoint,
    forcePathStyle: process.env.AWS_FORCE_PATH_STYLE !== undefined
      ? asBool(process.env.AWS_FORCE_PATH_STYLE, defaultPathStyleForEndpoint)
      : asBool(settings.AWS_forcePathStyle ?? settings.S3_forcePathStyle, defaultPathStyleForEndpoint),
    storageType: String(settings.storageType || '').trim().toLowerCase(),
  };
}

let s3Client = null;
let PutObjectAclCommand = null;

async function initS3(config) {
  if (!config.bucket || !config.accessKeyId || !config.secretAccessKey) {
    console.log('S3 credentials not fully configured. ACL changes will be skipped; DB rewrite can still proceed.');
    return false;
  }

  try {
    const { S3Client, PutObjectAclCommand: AclCommand } = await import('@aws-sdk/client-s3');
    PutObjectAclCommand = AclCommand;
    s3Client = new S3Client({
      region: config.region || 'us-east-1',
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      endpoint: config.endpoint || undefined,
      forcePathStyle: config.forcePathStyle,
    });
    return true;
  } catch (err) {
    console.log('AWS SDK not available. ACL changes will be skipped.');
    console.log(`Reason: ${err.message}`);
    return false;
  }
}

async function setObjectPrivate(bucket, key, stats) {
  if (!s3Client || !PutObjectAclCommand || DRY_RUN) return;

  try {
    await s3Client.send(new PutObjectAclCommand({
      Bucket: bucket,
      Key: key,
      ACL: 'private',
    }));
    stats.aclsUpdated += 1;
    if (VERBOSE) {
      console.log(`  acl private: ${key}`);
    }
  } catch (err) {
    const errorCode = String(err?.name || err?.Code || err?.code || '');
    if (errorCode === 'AccessControlListNotSupported') {
      stats.aclSkipped += 1;
      console.log(`  acl skipped (bucket ACLs disabled): ${key}`);
      return;
    }
    stats.errors += 1;
    console.error(`  acl failed for ${key}: ${err.message}`);
  }
}

async function rewriteUserImages(db, config, stats) {
  console.log('\n--- Scanning user profile images ---');
  const users = db.collection('users');
  const cursor = users.find({
    $or: [
      { 'profile.profileImage': { $exists: true, $ne: '' } },
      { 'profile.profileThumbnail': { $exists: true, $ne: '' } },
    ],
  });

  for await (const user of cursor) {
    stats.documentsScanned += 1;
    const updates = {};

    for (const field of ['profile.profileImage', 'profile.profileThumbnail']) {
      const currentValue = field === 'profile.profileImage'
        ? user.profile?.profileImage
        : user.profile?.profileThumbnail;
      const analyzed = analyzeImageReference(currentValue, config);
      if (!analyzed.managed || !analyzed.key) {
        continue;
      }

      stats.referencesFound += 1;
      stats.s3Keys.add(analyzed.key);
      if (!analyzed.alreadyNormalized && analyzed.nextUrl !== analyzed.currentUrl) {
        updates[field] = analyzed.nextUrl;
        stats.referencesRewritten += 1;
        if (VERBOSE) {
          console.log(`  user ${user._id} ${field}: ${analyzed.currentUrl} -> ${analyzed.nextUrl}`);
        }
      }
    }

    if (!DRY_RUN && Object.keys(updates).length > 0) {
      await users.updateOne({ _id: user._id }, { $set: updates });
      stats.documentsUpdated += 1;
    }
  }
}

async function rewriteImageRecords(db, config, stats) {
  console.log('\n--- Scanning image metadata ---');
  const images = db.collection('images');
  const cursor = images.find({
    $or: [
      { url: { $exists: true, $ne: '' } },
      { key: { $exists: true, $ne: '' } },
    ],
  });

  for await (const image of cursor) {
    stats.documentsScanned += 1;

    const analyzed = analyzeImageReference(image.url, config);
    const key = String(image.key || analyzed.key || '').trim();
    if (!key) {
      continue;
    }

    stats.referencesFound += 1;
    stats.s3Keys.add(key);

    const nextUrl = toUploadsUrl(key);
    const updates = {};
    if (image.url !== nextUrl) {
      updates.url = nextUrl;
      stats.referencesRewritten += 1;
      if (VERBOSE) {
        console.log(`  image ${image._id} url: ${image.url} -> ${nextUrl}`);
      }
    }
    if (!image.key) {
      updates.key = key;
      if (VERBOSE) {
        console.log(`  image ${image._id} key backfill: ${key}`);
      }
    }

    if (!DRY_RUN && Object.keys(updates).length > 0) {
      await images.updateOne({ _id: image._id }, { $set: updates });
      stats.documentsUpdated += 1;
    }
  }
}

async function rewriteQuestionImages(db, config, stats) {
  console.log('\n--- Scanning question image references ---');
  const questions = db.collection('questions');
  const cursor = questions.find({
    $or: [
      { image: { $exists: true, $ne: '' } },
      { imagePath: { $exists: true, $ne: '' } },
      { content: { $regex: '<img' } },
      { solution: { $regex: '<img' } },
      { 'options.content': { $regex: '<img' } },
    ],
  });

  for await (const question of cursor) {
    stats.documentsScanned += 1;
    const updates = {};

    for (const field of ['image', 'imagePath']) {
      const currentValue = question[field];
      const analyzed = analyzeImageReference(currentValue, config);
      if (!analyzed.managed || !analyzed.key) {
        continue;
      }

      stats.referencesFound += 1;
      stats.s3Keys.add(analyzed.key);
      if (!analyzed.alreadyNormalized && analyzed.nextUrl !== analyzed.currentUrl) {
        updates[field] = analyzed.nextUrl;
        stats.referencesRewritten += 1;
        if (VERBOSE) {
          console.log(`  question ${question._id} ${field}: ${analyzed.currentUrl} -> ${analyzed.nextUrl}`);
        }
      }
    }

    for (const field of ['content', 'solution']) {
      const { nextHtml, changed } = rewriteHtmlImageSources(question[field], config, stats);
      if (changed) {
        updates[field] = nextHtml;
      }
    }

    if (Array.isArray(question.options) && question.options.length > 0) {
      let optionsChanged = false;
      const nextOptions = question.options.map((option = {}) => {
        const { nextHtml, changed } = rewriteHtmlImageSources(option.content, config, stats);
        if (!changed) {
          return option;
        }
        optionsChanged = true;
        return { ...option, content: nextHtml };
      });

      if (optionsChanged) {
        updates.options = nextOptions;
      }
    }

    if (!DRY_RUN && Object.keys(updates).length > 0) {
      await questions.updateOne({ _id: question._id }, { $set: updates });
      stats.documentsUpdated += 1;
    }
  }
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  console.log(`Connected to: ${MONGO_URI}`);
  const storageConfig = await resolveStorageConfig(db);
  console.log('Resolved storage config:');
  console.log(`  storageType: ${storageConfig.storageType || '(unset)'}`);
  console.log(`  bucket:      ${storageConfig.bucket || '(missing)'}`);
  console.log(`  region:      ${storageConfig.region || '(default us-east-1)'}`);
  console.log(`  endpoint:    ${storageConfig.endpoint || '(aws default)'}`);
  console.log(`  path style:  ${storageConfig.forcePathStyle}`);

  const s3Available = await initS3(storageConfig);
  const stats = {
    documentsScanned: 0,
    documentsUpdated: 0,
    referencesFound: 0,
    referencesRewritten: 0,
    aclsUpdated: 0,
    aclSkipped: 0,
    errors: 0,
    s3Keys: new Set(),
  };

  await rewriteUserImages(db, storageConfig, stats);
  await rewriteImageRecords(db, storageConfig, stats);
  await rewriteQuestionImages(db, storageConfig, stats);

  console.log('\n--- S3 ACL pass ---');
  console.log(`  unique keys discovered: ${stats.s3Keys.size}`);
  if (DRY_RUN) {
    console.log('  acl mode: dry run');
  } else if (!s3Available) {
    console.log('  acl mode: skipped (credentials/sdk unavailable)');
  } else {
    for (const key of stats.s3Keys) {
      await setObjectPrivate(storageConfig.bucket, key, stats);
    }
  }

  console.log('\n--- Summary ---');
  console.log(`  documents scanned:      ${stats.documentsScanned}`);
  console.log(`  image refs found:       ${stats.referencesFound}`);
  console.log(`  image refs rewritten:   ${stats.referencesRewritten}`);
  console.log(`  unique S3 keys:         ${stats.s3Keys.size}`);
  if (DRY_RUN) {
    console.log('  documents updated:      0 (dry run)');
    console.log('  ACLs updated:           0 (dry run)');
  } else {
    console.log(`  documents updated:      ${stats.documentsUpdated}`);
    console.log(`  ACLs updated:           ${stats.aclsUpdated}`);
    console.log(`  ACLs skipped:           ${stats.aclSkipped}`);
  }
  console.log(`  errors:                 ${stats.errors}`);

  if (DRY_RUN) {
    console.log('\nRun again with --apply to rewrite DB references and update ACLs.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Sanitize S3 failed:', err);
  process.exit(1);
});
