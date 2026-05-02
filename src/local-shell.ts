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

    // --- Windows cooked-mode line editing ---
    let echo = '';
    for (const ch of raw) {
      if (ch === '\r') {
        // Enter: flush ONLY if there's a non-empty line
        if (this.lineBuffer.length > 0) {
          this.child.stdin?.write(`${this.lineBuffer}\n`);
        }
        this.lineBuffer = '';
        echo += '\r\n';
      } else if (ch === '\x7f' || ch === '\b') {
        if (this.lineBuffer.length > 0) {
          this.lineBuffer = this.lineBuffer.slice(0, -1);
          echo += '\b \b';
        }
      } else if (ch === '\x03') {
        // Ctrl‑C through a Windows pipe is a no‑op.
        // Just clear current input — don't send \x03 (it becomes garbage).
        this.lineBuffer = '';
        echo += '^C';
      } else if (ch === '\x04') {
        // Ctrl‑D through a Windows pipe is a no‑op.
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

  setWindow(_rows: number, _cols: number, _height: number, _width: number): void {
    // Local shells don't support PTY window resizing.  Ignored.
  }

  end(): void {
    this.close();
  }

  close(): void {
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
