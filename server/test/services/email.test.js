import net from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import addressparser from 'nodemailer/lib/addressparser';
import config from '../../src/config/index.js';
import { sendPasswordResetEmail, sendVerificationEmail } from '../../src/services/email.js';
import { createApp, createTestUser, csrfHeaders } from '../helpers.js';
import User from '../../src/models/User.js';

vi.mock('../../src/config/index.js', async (importOriginal) => {
  const original = await importOriginal();
  return { default: { ...original.default, mailUrl: '', rootUrl: 'https://qlicker.example' } };
});

// RFC 5322 mailboxes from the maintainer advisories. The apparent attacker
// addresses are comment/display text or part of a quoted local part.
const advisoryAddresses = [
  ['GHSA-8c8m-p3m8-cjg8', 'Victim (x(y) <evil@evil.com>) <v@victim.com>', 'v@victim.com'],
  ['GHSA-m943-m63m-w62w (comment)', 'G: (a; <evil@evil.com>) <v@victim.com>;', 'v@victim.com'],
  ['GHSA-m943-m63m-w62w (quoted name)', 'G: "a;" "<evil@evil.com>" <v@victim.com>;', 'v@victim.com'],
  ['GHSA-85x2-q946-cp5h', '<"a@evil.com>"@good.com>', '"a@evil.com>"@good.com'],
];

describe('email delivery through SMTP', () => {
  let server;
  const sockets = new Set();
  const messages = [];
  const authentications = [];
  const envelopes = [];

  beforeAll(async () => {
    // Exercise the real Nodemailer transport against a loopback-only SMTP fixture.
    server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.setEncoding('utf8');
      socket.write('220 localhost ESMTP test\r\n');
      let buffer = '';
      let inData = false;
      let message = [];
      let recipients = [];
      socket.on('data', (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\r\n')) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (inData) {
            if (line === '.') {
              messages.push(message.join('\r\n'));
              envelopes.push(recipients);
              message = [];
              inData = false;
              socket.write('250 Message accepted\r\n');
            } else {
              message.push(line.replace(/^\.\./, '.'));
            }
          } else if (line.startsWith('EHLO')) {
            socket.write('250-localhost\r\n250 AUTH PLAIN\r\n');
          } else if (line.startsWith('AUTH PLAIN ')) {
            authentications.push(Buffer.from(line.slice(11), 'base64').toString());
            socket.write('235 Authenticated\r\n');
          } else if (line.startsWith('MAIL FROM:')) {
            recipients = [];
            socket.write('250 OK\r\n');
          } else if (line.startsWith('RCPT TO:')) {
            recipients.push(line.slice('RCPT TO:<'.length, -1));
            socket.write('250 OK\r\n');
          } else if (line === 'DATA') {
            inData = true;
            socket.write('354 End with dot\r\n');
          } else if (line === 'QUIT') {
            socket.end('221 Bye\r\n');
          } else {
            socket.write('500 Unsupported command\r\n');
          }
        }
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    config.mailUrl = `smtp://test-user:test-password@127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
  });

  it.each([
    [sendVerificationEmail, 'Verify your Qlicker email', 'verify-email'],
    [sendPasswordResetEmail, 'Reset your Qlicker password', 'reset'],
  ])('delivers %s with the expected recipient and link', async (send, subject, path) => {
    await send({ emails: [{ address: 'student@example.com' }], profile: { firstname: 'Ada' } }, 'test-token');
    expect(authentications.at(-1)).toBe('\0test-user\0test-password');
    expect(envelopes.at(-1)).toEqual(['student@example.com']);
    const message = messages.at(-1).replace(/=\r\n/g, '');
    expect(message).toContain('To: student@example.com');
    expect(message).toContain(`Subject: ${subject}`);
    expect(message).toContain(`https://qlicker.example/${path}/test-token`);
  });

  describe.each([
    ['verification', sendVerificationEmail],
    ['password reset', sendPasswordResetEmail],
  ])('%s recipient parsing', (_name, send) => {
    it.each(advisoryAddresses)('rejects stored %s header syntax without sending mail', async (_advisory, address) => {
      const count = messages.length;
      await expect(send({ emails: [{ address }] }, 'advisory-token')).rejects.toThrow('Invalid account email recipient');
      expect(messages).toHaveLength(count);
    });
  });

  it.each(advisoryAddresses)('Nodemailer parses %s as the intended mailbox', (_advisory, address, recipient) => {
    // Guard the dependency fix independently. Message composition still rewrites
    // angle brackets in a quoted local part, so account mail rejects them above.
    expect(addressparser(address, { flatten: true }).map((entry) => entry.address)).toEqual([recipient]);
  });

  it.each([
    'first@example.com, second@example.com',
    'student@example.com (comment)',
    'student@example.com\r\nBcc: evil@evil.com',
    '"a@evil.com>"@good.com',
    '"first\tlast"@example.com',
    '"first\0last"@example.com',
    '"first\x7flast"@example.com',
    '',
    undefined,
  ])('rejects an unsafe stored mailbox %j', async (address) => {
    const count = messages.length;
    await expect(sendPasswordResetEmail({ emails: [{ address }] }, 'test-token')).rejects.toThrow('Invalid account email recipient');
    expect(messages).toHaveLength(count);
  });

  it.each(['student+tag@example.com', "o'connor@example.com", '"first last"@example.com'])('preserves the bare mailbox %s over SMTP', async (address) => {
    await sendPasswordResetEmail({ emails: [{ address }] }, 'test-token');
    expect(envelopes.at(-1)).toEqual([address]);
  });

  describe('authentication request schemas and SMTP recipients', () => {
    let app;

    beforeEach(async () => {
      // These security regressions must execute, not silently skip without MongoDB.
      expect(mongoose.connection.readyState).toBe(1);
      app = await createApp();
    });

    afterEach(async () => {
      if (app) await app.close();
      app = null;
    });

    it.each(advisoryAddresses)('rejects %s at registration without sending mail', async (_advisory, email) => {
      const count = messages.length;
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: csrfHeaders,
        payload: { email, password: 'password123', firstname: 'Test', lastname: 'User' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('email');
      expect(await User.countDocuments()).toBe(0);
      expect(messages).toHaveLength(count);
    });

    it('registers and sends verification to the normalized mailbox', async () => {
      const count = messages.length;
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: csrfHeaders,
        payload: { email: 'Student@Example.com', password: 'password123', firstname: 'Test', lastname: 'User' },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().user.emails[0].address).toBe('student@example.com');
      expect(messages).toHaveLength(count + 1);
      expect(envelopes.at(-1)).toEqual(['student@example.com']);
    });

    it.each(advisoryAddresses)('rejects %s at password reset even for a matching stored account', async (_advisory, email) => {
      const user = await createTestUser({ email });
      const count = messages.length;
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/forgot-password',
        headers: csrfHeaders,
        payload: { email },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('email');
      expect(messages).toHaveLength(count);
      const stored = await User.findById(user._id);
      expect(stored.services?.resetPassword).toBeUndefined();
    });

    it('sends a password reset to the stored mailbox after case-insensitive lookup', async () => {
      const user = await createTestUser({ email: 'student@example.com' });
      const count = messages.length;
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/forgot-password',
        headers: csrfHeaders,
        payload: { email: 'Student@Example.com' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true });
      expect(messages).toHaveLength(count + 1);
      expect(envelopes.at(-1)).toEqual(['student@example.com']);
      const stored = await User.findById(user._id);
      expect(stored.services.resetPassword.token).toBeTruthy();
      expect(messages.at(-1).replace(/=\r\n/g, '')).toContain(`/reset/${stored.services.resetPassword.token}`);
    });
  });
});
