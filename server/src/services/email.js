import nodemailer from 'nodemailer';
import config from '../config/index.js';

let transporter = null;

export function parseMailUrl(mailUrl, { quiet = false } = {}) {
  if (!mailUrl) return null;
  try {
    const url = new URL(mailUrl);
    return {
      host: url.hostname,
      port: parseInt(url.port, 10) || 587,
      secure: url.port === '465',
      auth: url.username
        ? { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password || '') }
        : undefined,
    };
  } catch (err) {
    if (!quiet) {
      console.error('Failed to parse MAIL_URL:', err.message);
      console.error('  Expected format: smtp://user:password@smtp.example.com:587');
    }
    return null;
  }
}

export function getMailConfigurationStatus() {
  const mailUrl = String(config.mailUrl || '').trim();
  if (!mailUrl) {
    return {
      configured: false,
      code: 'missing',
      message: 'MAIL_URL is not configured. Verified-email signups and password reset emails will not be delivered.',
    };
  }

  const smtpConfig = parseMailUrl(mailUrl, { quiet: true });
  if (!smtpConfig) {
    return {
      configured: false,
      code: 'invalid',
      message: 'MAIL_URL is invalid. Expected format: smtp://user:password@smtp.example.com:587',
    };
  }

  return {
    configured: true,
    code: 'configured',
    message: 'MAIL_URL is configured. You should still test email delivery after enabling verified-email signups.',
  };
}

function getTransporter() {
  if (transporter) return transporter;
  const mailStatus = getMailConfigurationStatus();
  if (!mailStatus.configured) {
    console.warn(`${mailStatus.message}`);
    return null;
  }

  const smtpConfig = parseMailUrl(config.mailUrl);
  transporter = nodemailer.createTransport(smtpConfig);
  return transporter;
}

export async function sendVerificationEmail(user, token) {
  const t = getTransporter();
  if (!t) {
    console.warn('Email transport not available — skipping verification email for', user.emails?.[0]?.address);
    return;
  }
  const verifyUrl = `${config.rootUrl}/verify-email/${token}`;
  const emailAddress = user.emails?.[0]?.address;
  await t.sendMail({
    from: `"Qlicker" <noreply@qlicker.app>`,
    to: emailAddress,
    subject: 'Verify your Qlicker email',
    html: `<p>Hello ${user.profile?.firstname || ''},</p>
<p>Please verify your email by clicking the link below:</p>
<p><a href="${verifyUrl}">${verifyUrl}</a></p>`,
  });
}

export async function sendPasswordResetEmail(user, token) {
  const t = getTransporter();
  if (!t) {
    console.warn('Email transport not available — skipping password reset email for', user.emails?.[0]?.address);
    return;
  }
  const resetUrl = `${config.rootUrl}/reset/${token}`;
  const emailAddress = user.emails?.[0]?.address;
  await t.sendMail({
    from: `"Qlicker" <noreply@qlicker.app>`,
    to: emailAddress,
    subject: 'Reset your Qlicker password',
    html: `<p>Hello ${user.profile?.firstname || ''},</p>
<p>You requested a password reset. Click the link below to set a new password:</p>
<p><a href="${resetUrl}">${resetUrl}</a></p>
<p>If you did not request this, please ignore this email.</p>`,
  });
}
