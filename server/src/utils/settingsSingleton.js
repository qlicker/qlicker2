import Settings from '../models/Settings.js';
import { isDeepStrictEqual } from 'node:util';

export const SETTINGS_DOCUMENT_ID = 'settings';

function sanitizeSettingsDocument(doc = {}) {
  const sanitized = { ...doc };
  delete sanitized._id;
  delete sanitized.__v;
  delete sanitized.id;
  return sanitized;
}

function normalizeLegacyStorageType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'aws' || normalized === 's3') return 's3';
  if (normalized === 'azure') return 'azure';
  if (normalized === 'none' || normalized === 'local' || normalized === '') return 'local';
  return value;
}

function normalizePromotedFieldValue(key, value) {
  if (value === undefined) return undefined;
  if (key === 'storageType') return normalizeLegacyStorageType(value);
  return value;
}

function normalizeComparableValue(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeComparableValue(entry));
  }
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = normalizeComparableValue(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function valuesEqual(lhs, rhs) {
  return isDeepStrictEqual(normalizeComparableValue(lhs), normalizeComparableValue(rhs));
}

function buildDefaultSettingsSnapshot() {
  const defaults = new Settings({ _id: SETTINGS_DOCUMENT_ID })
    .toObject({ virtuals: false });
  return sanitizeSettingsDocument(defaults);
}

function countNonDefaultFields(doc, defaults) {
  const sanitized = sanitizeSettingsDocument(doc);
  let count = 0;
  for (const [key, rawValue] of Object.entries(sanitized)) {
    const value = normalizePromotedFieldValue(key, rawValue);
    if (value === undefined) continue;
    const defaultValue = defaults[key];
    if (!valuesEqual(value, defaultValue)) {
      count += 1;
    }
  }
  return count;
}

function rankLegacyDuplicates(duplicates, defaults) {
  return [...duplicates].sort((left, right) => {
    const leftScore = countNonDefaultFields(left, defaults);
    const rightScore = countNonDefaultFields(right, defaults);
    if (leftScore !== rightScore) return rightScore - leftScore;
    return String(left?._id || '').localeCompare(String(right?._id || ''));
  });
}

function mergeLegacyValuesIntoCanonical(canonical, duplicates, defaults) {
  const merged = { ...canonical };
  const mergedFromDuplicateIds = new Set();
  const rankedDuplicates = rankLegacyDuplicates(duplicates, defaults);

  for (const duplicate of rankedDuplicates) {
    const sourceId = String(duplicate?._id || '');
    const sanitized = sanitizeSettingsDocument(duplicate);
    let mergedFromThisSource = false;

    for (const [key, rawValue] of Object.entries(sanitized)) {
      const value = normalizePromotedFieldValue(key, rawValue);
      if (value === undefined) continue;

      const currentValue = merged[key];
      const defaultValue = defaults[key];
      const canPromoteField = valuesEqual(currentValue, defaultValue);
      if (!canPromoteField) continue;

      if (!valuesEqual(currentValue, value)) {
        merged[key] = value;
        mergedFromThisSource = true;
      }
    }

    if (mergedFromThisSource) {
      mergedFromDuplicateIds.add(sourceId);
    }
  }

  return {
    merged,
    mergedFromDuplicateIds: Array.from(mergedFromDuplicateIds),
  };
}

async function writeCanonicalSettingsDocument(settingsDoc) {
  const sanitized = sanitizeSettingsDocument(settingsDoc);
  await Settings.updateOne(
    { _id: SETTINGS_DOCUMENT_ID },
    {
      $set: sanitized,
      $setOnInsert: { _id: SETTINGS_DOCUMENT_ID },
    },
    { upsert: true }
  );
}

export async function ensureSettingsSingleton(logger) {
  if (Settings.db?.readyState !== 1) {
    return {
      skipped: true,
      removedDuplicates: 0,
      seededFromDuplicate: false,
      mergedFromDuplicates: false,
      mergedFromDuplicateIds: [],
    };
  }

  const defaults = buildDefaultSettingsSnapshot();
  const canonical = await Settings.findById(SETTINGS_DOCUMENT_ID).lean();
  const duplicates = await Settings.find({ _id: { $ne: SETTINGS_DOCUMENT_ID } }).lean();

  if (!canonical && duplicates.length === 0) {
    return {
      skipped: false,
      removedDuplicates: 0,
      seededFromDuplicate: false,
      mergedFromDuplicates: false,
      mergedFromDuplicateIds: [],
    };
  }

  const seededFromDuplicate = !canonical && duplicates.length > 0;
  const canonicalBase = {
    ...defaults,
    ...sanitizeSettingsDocument(canonical || {}),
  };

  let mergedCanonical = canonicalBase;
  let mergedFromDuplicateIds = [];

  if (duplicates.length > 0) {
    const mergeResult = mergeLegacyValuesIntoCanonical(canonicalBase, duplicates, defaults);
    mergedCanonical = mergeResult.merged;
    mergedFromDuplicateIds = mergeResult.mergedFromDuplicateIds;
  }

  // If canonical is missing, or if duplicates exist, write the merged canonical
  // document so restore flows always end with a full defaults+legacy override document.
  if (!canonical || duplicates.length > 0) {
    await writeCanonicalSettingsDocument(mergedCanonical);
  }

  let removedDuplicates = 0;
  if (duplicates.length > 0) {
    const deleteResult = await Settings.deleteMany({ _id: { $ne: SETTINGS_DOCUMENT_ID } });
    removedDuplicates = Number(deleteResult?.deletedCount || 0);

    if (logger?.warn) {
      logger.warn(
        {
          removedDuplicates,
          duplicateSettingsIds: duplicates.map((entry) => String(entry._id || '')),
          mergedFromDuplicateIds,
          seededFromDuplicate,
        },
        'Reconciled duplicate settings documents into canonical _id="settings".'
      );
    }
  }

  return {
    skipped: false,
    removedDuplicates,
    seededFromDuplicate,
    mergedFromDuplicates: mergedFromDuplicateIds.length > 0,
    mergedFromDuplicateIds,
  };
}

export async function getOrCreateSettingsDocument({ select = '', lean = false } = {}) {
  const buildQuery = () => {
    let query = Settings.findById(SETTINGS_DOCUMENT_ID);
    if (select) query = query.select(select);
    if (lean) query = query.lean();
    return query;
  };

  let settings = await buildQuery();
  if (settings) return settings;

  // During live restore flows, the running app may observe a legacy/non-canonical
  // settings record before restart. Promote it instead of creating a blank doc.
  await ensureSettingsSingleton();

  settings = await buildQuery();
  if (settings) return settings;

  await Settings.updateOne(
    { _id: SETTINGS_DOCUMENT_ID },
    { $setOnInsert: { _id: SETTINGS_DOCUMENT_ID } },
    { upsert: true }
  );

  return buildQuery();
}
