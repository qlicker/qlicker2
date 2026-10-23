import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import config from '../../src/config/index.js';
import { sendPasswordResetEmail, sendVerificationEmail } from '../../src/services/email.js';

vi.mock('../../src/config/index.js', () => ({
  default: { mailUrl: '', rootUrl: 'https://qlicker.example' },
}));

describe('email delivery through SMTP', () => {
  let server;
  const sockets = new Set();
  const messages = [];
  const authentications = [];

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
      socket.on('data', (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\r\n')) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (inData) {
            if (line === '.') {
              messages.push(message.join('\r\n'));
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
          } else if (line.startsWith('MAIL FROM:') || line.startsWith('RCPT TO:')) {
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
    const message = messages.at(-1).replace(/=\r\n/g, '');
    expect(message).toContain('To: student@example.com');
    expect(message).toContain(`Subject: ${subject}`);
    expect(message).toContain(`https://qlicker.example/${path}/test-token`);
  });
});
