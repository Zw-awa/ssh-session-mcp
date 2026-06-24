/*
 * SPDX-FileCopyrightText: 2026 Zw-awa
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { LocalShellStream, LocalConnection } from '../src/local-shell';

describe('LocalShellStream', () => {
  it('emits data events from the spawned shell', async () => {
    const stream = new LocalShellStream();

    const chunks: string[] = [];
    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk.toString());
    });

    // Send a simple command and wait for output
    const isWin = process.platform === 'win32';
    stream.write(isWin ? 'echo HELLO_LOCAL_TEST\r\n' : 'echo HELLO_LOCAL_TEST\n');

    // Wait up to 3 seconds for output
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        stream.close();
        reject(new Error('Timeout waiting for shell output. Received: ' + chunks.join('')));
      }, 3000);

      const check = () => {
        const joined = chunks.join('');
        if (joined.includes('HELLO_LOCAL_TEST')) {
          clearTimeout(timer);
          stream.close();
          resolve();
        }
      };

      stream.on('data', check);
      check(); // also check immediately in case data already arrived
    });

    expect(chunks.join('')).toContain('HELLO_LOCAL_TEST');
    stream.close();
  }, 8000);

  it('emits close event when the shell exits', async () => {
    const stream = new LocalShellStream();
    const isWin = process.platform === 'win32';
    stream.write(isWin ? 'exit\r\n' : 'exit\n');

    await new Promise<void>((resolve) => {
      stream.on('close', () => resolve());
    });

    // Should reach here without timeout
    expect(true).toBe(true);
    stream.close();
  }, 8000);

  it('stderr emitter works', async () => {
    const stream = new LocalShellStream();
    const isWin = process.platform === 'win32';
    // Write to stderr via a command that outputs to stderr
    stream.write(isWin ? 'echo ERR_TEST 1>&2\r\n' : 'echo ERR_TEST >&2\n');

    let stderr = '';
    stream.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        stream.close();
        reject(new Error('Timeout waiting for stderr'));
      }, 3000);

      const check = () => {
        if (stderr.includes('ERR_TEST')) {
          clearTimeout(timer);
          stream.close();
          resolve();
        }
      };

      stream.stderr.on('data', check);
      check();
    });

    expect(stderr).toContain('ERR_TEST');
    stream.close();
  }, 8000);

  it('does not echo arrow-key escape sequences back as visible text on Windows', async () => {
    if (process.platform !== 'win32') {
      return;
    }

    const stream = new LocalShellStream();
    let output = '';
    stream.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });

    await new Promise(resolve => setTimeout(resolve, 250));
    output = '';
    stream.write('\x1b[A');
    await new Promise(resolve => setTimeout(resolve, 250));

    expect(output).not.toContain('[A');
    stream.close();
  });
});

describe('LocalConnection', () => {
  it('isConnected returns true', () => {
    const conn = new LocalConnection();
    expect(conn.isConnected()).toBe(true);
  });

  it('connect resolves immediately', async () => {
    const conn = new LocalConnection();
    await conn.connect();
    expect(conn.isConnected()).toBe(true);
  });

  it('getClient throws as expected', () => {
    const conn = new LocalConnection();
    expect(() => conn.getClient()).toThrow('Local mode has no SSH client');
  });

  it('close does not throw', () => {
    const conn = new LocalConnection();
    conn.close();
    expect(conn.isConnected()).toBe(true); // still true, it's a no-op
  });
});
