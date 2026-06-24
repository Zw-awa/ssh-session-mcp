/*
 * SPDX-FileCopyrightText: 2026 Zw-awa
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

/**
 * Mimics ssh2's ClientChannel interface enough for SSHSession to consume,
 * backed by a locally spawned shell process instead of an SSH connection.
 */
export class LocalShellStream extends EventEmitter {
  private child: ChildProcess;
  public readonly stderr: EventEmitter;
  private lineBuffer = '';
  private pendingEscape = '';

  constructor() {
    super();
    this.stderr = new EventEmitter();

    const isWin = process.platform === 'win32';
    this.child = spawn(
      isWin ? 'cmd.exe' : '/bin/bash',
      isWin ? [] : ['-i'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1' },
      },
    );

    this.child.stdout?.on('data', (chunk: Buffer) => {
      this.emit('data', chunk);
    });

    this.child.stdin?.on('error', () => {
      // Child shutdown can race with buffered writes during tests/cleanup.
    });

    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr.emit('data', chunk);
    });

    this.child.on('close', (code, signal) => {
      this.emit('close', code, signal);
    });

    this.child.on('error', (err: Error) => {
      this.emit('error', err);
    });
  }

  write(data: string | Buffer): boolean {
    const raw = typeof data === 'string' ? data : data.toString();
    if (raw.length === 0) return true;

    if (process.platform !== 'win32') {
      this.child.stdin?.write(raw);
      return true;
    }

    // --- Windows pipe-mode input normalization ---
    // Keep line-buffered editing for plain text so local mode still feels usable,
    // but forward escape/control sequences verbatim instead of degrading them
    // into visible characters like "[A".
    let echo = '';
    const chars = this.pendingEscape.length > 0 ? this.pendingEscape + raw : raw;
    this.pendingEscape = '';
    for (let i = 0; i < chars.length; i += 1) {
      const ch = chars[i];
      if (ch === '\x1b') {
        if (this.lineBuffer.length > 0) {
          this.child.stdin?.write(this.lineBuffer);
          this.lineBuffer = '';
        }
        const remaining = chars.slice(i);
        const seq = this.consumeEscapeSequence(remaining);
        if (seq.complete) {
          this.child.stdin?.write(seq.value);
          i += seq.value.length - 1;
        } else {
          this.pendingEscape = seq.value;
          break;
        }
        continue;
      }

      if (ch === '\r') {
        if (this.lineBuffer.length > 0) this.child.stdin?.write(this.lineBuffer);
        this.child.stdin?.write('\n');
        this.lineBuffer = '';
        echo += '\r\n';
      } else if (ch === '\x7f' || ch === '\b') {
        if (this.lineBuffer.length > 0) {
          this.lineBuffer = this.lineBuffer.slice(0, -1);
          echo += '\b \b';
        }
      } else if (ch === '\x03') {
        if (this.lineBuffer.length > 0) {
          this.lineBuffer = '';
        }
        this.child.stdin?.write('\x03');
        this.lineBuffer = '';
        echo += '^C';
      } else if (ch === '\x04') {
        this.child.stdin?.write('\x04');
        echo += '^D';
      } else if (ch === '\t') {
        this.lineBuffer += '\t';
        echo += '\t';
      } else if (ch >= ' ') {
        this.lineBuffer += ch;
        echo += ch;
      }
    }
    if (echo.length > 0) {
      this.emit('data', Buffer.from(echo));
    }
    return true;
  }

  private consumeEscapeSequence(input: string): { complete: boolean; value: string } {
    if (input.length === 1) {
      return { complete: false, value: input };
    }

    if (input[1] !== '[' && input[1] !== 'O') {
      return { complete: true, value: input[0] };
    }

    let index = 2;
    while (index < input.length) {
      const current = input[index];
      if ((current >= '@' && current <= '~') || (current >= 'A' && current <= 'Z') || (current >= 'a' && current <= 'z')) {
        return { complete: true, value: input.slice(0, index + 1) };
      }
      index += 1;
    }

    return { complete: false, value: input };
  }

  setWindow(_rows: number, _cols: number, _height: number, _width: number): void {
    // Local shells don't support PTY window resizing.  Ignored.
  }

  end(): void {
    this.close();
  }

  close(): void {
    this.pendingEscape = '';
    try {
      this.child.stdin?.end();
    } catch {
      // ignore
    }
    try {
      this.child.kill();
    } catch {
      // ignore
    }
    this.removeAllListeners();
    this.stderr.removeAllListeners();
  }
}

/** No-op connection object — there is no SSH layer in local mode. */
export class LocalConnection {
  isConnected(): boolean {
    return true;
  }

  connect(): Promise<void> {
    return Promise.resolve();
  }

  getClient(): never {
    throw new Error('Local mode has no SSH client');
  }

  close(): void {
    // nothing to tear down
  }
}
