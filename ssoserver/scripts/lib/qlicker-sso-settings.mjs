import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ssoserverDir = path.resolve(__dirname, '../..');
const repoRootDir = path.resolve(ssoserverDir, '..');
const envExamplePath = path.join(ssoserverDir, '.env.example');
const envPath = path.join(ssoserverDir, '.env');
const rootEnvPath = path.join(repoRootDir, '.env');

function parseEnv(raw) {
  return raw.split(/\r?\n/).reduce((acc, line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return acc;
    const separator = trimmed.indexOf('=');
    if (separator === -1) return acc;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    acc[key] = value;
    return acc;
  }, {});
}

export function loadSsoEnv() {
  const defaults = fs.existsSync(envExamplePath) ? parseEnv(fs.readFileSync(envExamplePath, 'utf8')) : {};
  const rootEnv = fs.existsSync(rootEnvPath) ? parseEnv(fs.readFileSync(rootEnvPath, 'utf8')) : {};
  const fromFile = fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, 'utf8')) : {};

  const derivedFromRoot = deriveQlickerEnv(rootEnv);
  const merged = { ...defaults, ...fromFile, ...process.env };

  for (const key of ['QCLICKER_APP_URL', 'QCLICKER_API_URL', 'QCLICKER_SP_ENTITY_ID']) {
    const explicitProcessValue = process.env[key];
    const fileValue = fromFile[key];
    const defaultValue = defaults[key];
    const rootValue = derivedFromRoot[key];

    if (explicitProcessValue) {
      merged[key] = explicitProcessValue;
    } else if (fileValue && fileValue !== defaultValue) {
      merged[key] = fileValue;
    } else if (rootValue) {
      merged[key] = rootValue;
    } else if (fileValue) {
      merged[key] = fileValue;
    } else if (defaultValue) {
      merged[key] = defaultValue;
    }
  }

  return merged;
}

function normalizeUrlCandidate(value) {
  return String(value || '').trim().replace(/\/$/, '');
}

function ensureApiV1Path(value) {
  const trimmed = normalizeUrlCandidate(value);
  if (!trimmed) return '';
  if (trimmed.endsWith('/api/v1')) return trimmed;
  if (trimmed.endsWith('/api')) return `${trimmed}/v1`;
  return `${trimmed}/api/v1`;
}

function deriveQlickerEnv(rootEnv) {
  const appUrl = normalizeUrlCandidate(
    rootEnv.QCLICKER_APP_URL
      || rootEnv.ROOT_URL
      || (rootEnv.APP_PORT ? `http://127.0.0.1:${rootEnv.APP_PORT}` : '')
  );
  const apiUrl = ensureApiV1Path(
    rootEnv.QCLICKER_API_URL
      || rootEnv.VITE_API_URL
      || (rootEnv.API_PORT ? `http://127.0.0.1:${rootEnv.API_PORT}` : '')
  );

  return {
    QCLICKER_APP_URL: appUrl,
    QCLICKER_API_URL: apiUrl,
    QCLICKER_SP_ENTITY_ID: appUrl ? `${appUrl}/SSO/SAML2/metadata` : '',
  };
}

function normalizeBasePath(input) {
  const trimmed = String(input || 'simplesaml').trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `${trimmed}/` : '';
}

function requireValue(name, value) {
  if (!value) {
    throw new Error(`Missing required ssoserver setting: ${name}`);
  }
  return value;
}

function ensureHttpUrl(name, value) {
  const parsed = new URL(value);
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error(`${name} must use http or https: ${value}`);
  }
  return parsed.toString().replace(/\/$/, '');
}

function readRequiredFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Required file is missing: ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf8').trim();
}

export function stripCertificatePem(pem) {
  return pem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '')
    .trim();
}

export function escapePhpString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function getSsoConfig(rawEnv = loadSsoEnv()) {
  const basePath = normalizeBasePath(rawEnv.SSOSERVER_BASE_PATH);
  const ssoserverPort = rawEnv.SSOSERVER_PORT || '4100';
  const ssoserverBaseUrl = ensureHttpUrl('SSOSERVER_BASE_URL', rawEnv.SSOSERVER_BASE_URL || `http://127.0.0.1:${ssoserverPort}`);
  const qlickerAppUrl = ensureHttpUrl('QCLICKER_APP_URL', rawEnv.QCLICKER_APP_URL || 'http://127.0.0.1:3300');
  const qlickerApiUrl = ensureHttpUrl('QCLICKER_API_URL', rawEnv.QCLICKER_API_URL || 'http://127.0.0.1:3301/api/v1');
  const idpEntityId = rawEnv.SSOSERVER_ENTITY_ID || `${ssoserverBaseUrl}/${basePath}saml2/idp/metadata.php`;
  const idpEntrypointUrl = rawEnv.SSOSERVER_ENTRYPOINT_URL || `${ssoserverBaseUrl}/${basePath}module.php/saml/idp/singleSignOnService`;
  const idpLogoutUrl = rawEnv.SSOSERVER_LOGOUT_URL || `${ssoserverBaseUrl}/${basePath}module.php/saml/idp/singleLogout`;
  const qlickerSpEntityId = rawEnv.QCLICKER_SP_ENTITY_ID || `${qlickerAppUrl}/SSO/SAML2/metadata`;

  return {
    basePath,
    ssoserverPort,
    ssoserverBaseUrl,
    qlickerAppUrl,
    qlickerApiUrl,
    idpEntityId,
    idpEntrypointUrl,
    idpLogoutUrl,
    qlickerSpEntityId,
    institutionName: rawEnv.SSOSERVER_INSTITUTION_NAME || 'Local SimpleSAMLphp',
    adminPassword: requireValue('SSOSERVER_ADMIN_PASSWORD', rawEnv.SSOSERVER_ADMIN_PASSWORD),
    secretSalt: requireValue('SSOSERVER_SECRET_SALT', rawEnv.SSOSERVER_SECRET_SALT),
    certDir: path.join(ssoserverDir, 'certs'),
    generatedConfigDir: path.join(ssoserverDir, 'generated', 'config'),
    generatedMetadataDir: path.join(ssoserverDir, 'generated', 'metadata'),
    templatesDir: path.join(ssoserverDir, 'templates'),
    certFiles: {
      idpKey: 'idp.key',
      idpCert: 'idp.crt',
      qlickerSpKey: 'qlicker-sp.key',
      qlickerSpCert: 'qlicker-sp.crt',
    },
    users: [
      {
        username: requireValue('SSO_PROFESSOR_USERNAME', rawEnv.SSO_PROFESSOR_USERNAME),
        password: requireValue('SSO_PROFESSOR_PASSWORD', rawEnv.SSO_PROFESSOR_PASSWORD),
        email: requireValue('SSO_PROFESSOR_EMAIL', rawEnv.SSO_PROFESSOR_EMAIL),
        givenName: requireValue('SSO_PROFESSOR_FIRSTNAME', rawEnv.SSO_PROFESSOR_FIRSTNAME),
        sn: requireValue('SSO_PROFESSOR_LASTNAME', rawEnv.SSO_PROFESSOR_LASTNAME),
        role: requireValue('SSO_PROFESSOR_ROLE', rawEnv.SSO_PROFESSOR_ROLE),
        studentNumber: requireValue('SSO_PROFESSOR_STUDENT_NUMBER', rawEnv.SSO_PROFESSOR_STUDENT_NUMBER),
      },
      {
        username: requireValue('SSO_STUDENT_USERNAME', rawEnv.SSO_STUDENT_USERNAME),
        password: requireValue('SSO_STUDENT_PASSWORD', rawEnv.SSO_STUDENT_PASSWORD),
        email: requireValue('SSO_STUDENT_EMAIL', rawEnv.SSO_STUDENT_EMAIL),
        givenName: requireValue('SSO_STUDENT_FIRSTNAME', rawEnv.SSO_STUDENT_FIRSTNAME),
        sn: requireValue('SSO_STUDENT_LASTNAME', rawEnv.SSO_STUDENT_LASTNAME),
        role: requireValue('SSO_STUDENT_ROLE', rawEnv.SSO_STUDENT_ROLE),
        studentNumber: requireValue('SSO_STUDENT_STUDENT_NUMBER', rawEnv.SSO_STUDENT_STUDENT_NUMBER),
      },
    ],
  };
}

export function readCertBundle(config = getSsoConfig()) {
  return {
    idpCert: readRequiredFile(path.join(config.certDir, config.certFiles.idpCert)),
    idpKey: readRequiredFile(path.join(config.certDir, config.certFiles.idpKey)),
    qlickerSpCert: readRequiredFile(path.join(config.certDir, config.certFiles.qlickerSpCert)),
    qlickerSpKey: readRequiredFile(path.join(config.certDir, config.certFiles.qlickerSpKey)),
  };
}

export function buildUserBlock(config = getSsoConfig()) {
  return config.users.map((user) => `            '${escapePhpString(user.username)}:${escapePhpString(user.password)}' => [\n                'uid' => ['${escapePhpString(user.username)}'],\n                'mail' => ['${escapePhpString(user.email)}'],\n                'givenName' => ['${escapePhpString(user.givenName)}'],\n                'sn' => ['${escapePhpString(user.sn)}'],\n                'role' => ['${escapePhpString(user.role)}'],\n                'studentNumber' => ['${escapePhpString(user.studentNumber)}'],\n            ],`).join('\n');
}

export function buildTemplateContext(config = getSsoConfig()) {
  return {
    '__BASEURLPATH__': escapePhpString(config.basePath),
    '__SECRET_SALT__': escapePhpString(config.secretSalt),
    '__ADMIN_PASSWORD__': escapePhpString(config.adminPassword),
    '__IDP_ENTITY_ID__': escapePhpString(config.idpEntityId),
    '__IDP_PRIVATE_KEY_FILE__': escapePhpString(config.certFiles.idpKey),
    '__IDP_CERT_FILE__': escapePhpString(config.certFiles.idpCert),
    '__SP_ENTITY_ID__': escapePhpString(config.qlickerSpEntityId),
    '__SP_ACS_URL__': escapePhpString(`${config.qlickerAppUrl}/api/v1/auth/sso/callback`),
    '__SP_LOGOUT_URL__': escapePhpString(`${config.qlickerAppUrl}/api/v1/auth/sso/logout`),
    '__SP_CERT_FILE__': escapePhpString(config.certFiles.qlickerSpCert),
    '__USERS__': buildUserBlock(config),
  };
}

export function buildQlickerSsoSettingsPayload(config = getSsoConfig(), certBundle = readCertBundle(config)) {
  return {
    SSO_enabled: true,
    SSO_entrypoint: config.idpEntrypointUrl,
    SSO_logoutUrl: config.idpLogoutUrl,
    SSO_EntityId: config.qlickerSpEntityId,
    SSO_identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    SSO_institutionName: config.institutionName,
    SSO_emailIdentifier: 'mail',
    SSO_firstNameIdentifier: 'givenName',
    SSO_lastNameIdentifier: 'sn',
    SSO_roleIdentifier: 'role',
    SSO_roleProfName: 'professor',
    SSO_studentNumberIdentifier: 'studentNumber',
    SSO_cert: stripCertificatePem(certBundle.idpCert),
    SSO_privCert: certBundle.qlickerSpCert,
    SSO_privKey: certBundle.qlickerSpKey,
  };
}
