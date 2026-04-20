import { describe, expect, it } from 'vitest';

import {
  type OperationMode,
  type TerminalMode,
  validateCommand,
  detectTerminalMode,
  isKnownSlowCommand,
} from '../src/validation';

describe('detectTerminalMode', () => {
  it('detects shell mode for normal prompt', () => {
    expect(detectTerminalMode('user@host:~$ ')).toBe('shell');
  });

  it('detects password prompt', () => {
    expect(detectTerminalMode('Password: ')).toBe('password_prompt');
    expect(detectTerminalMode('[sudo] password for user: ')).toBe('password_prompt');
    expect(detectTerminalMode('Enter passphrase: ')).toBe('password_prompt');
  });

  it('detects vim editor', () => {
    expect(detectTerminalMode('some text\n-- INSERT --')).toBe('editor');
    expect(detectTerminalMode('line1\n-- VISUAL --\nline3')).toBe('editor');
  });

  it('detects nano editor', () => {
    expect(detectTerminalMode('GNU nano 5.4\n^G Get Help')).toBe('editor');
  });

  it('detects vim tilde lines', () => {
    expect(detectTerminalMode('~\n~\n~\n~')).toBe('editor');
  });

  it('detects less pager', () => {
    expect(detectTerminalMode('content here\n(END)')).toBe('pager');
    expect(detectTerminalMode('content\n:')).toBe('pager');
    expect(detectTerminalMode('line1\n--More--')).toBe('pager');
  });

  it('returns shell for empty or unknown content', () => {
    expect(detectTerminalMode('')).toBe('unknown');
    expect(detectTerminalMode('some random output\nmore output')).toBe('shell');
  });

  it('handles ANSI escape codes', () => {
    expect(detectTerminalMode('\x1b[32muser@host\x1b[0m:~$ ')).toBe('shell');
  });
});

describe('validateCommand', () => {
  describe('ALWAYS_BLOCKED', () => {
    it('blocks fork bombs', () => {
      const result = validateCommand(':(){ :|:& };:', 'full');
      expect(result.allowed).toBe(false);
      expect(result.category).toBe('blocked');
    });

    it('blocks dd to disk device', () => {
      const result = validateCommand('dd if=/dev/zero of=/dev/sda bs=1M', 'full');
      expect(result.allowed).toBe(false);
    });

    it('blocks rm -rf /', () => {
      const result = validateCommand('rm -rf /', 'full');
      expect(result.allowed).toBe(false);
    });

    it('blocks mkfs on disk device', () => {
      const result = validateCommand('mkfs.ext4 /dev/sda1', 'full');
      expect(result.allowed).toBe(false);
    });
  });

  describe('safe mode', () => {
    it('blocks rm -rf with paths', () => {
      const result = validateCommand('rm -rf /some/path', 'safe');
      expect(result.allowed).toBe(false);
      expect(result.category).toBe('dangerous');
      expect(result.suggestion).toBeDefined();
    });

    it('blocks tail -f', () => {
      const result = validateCommand('tail -f /var/log/syslog', 'safe');
      expect(result.allowed).toBe(false);
      expect(result.category).toBe('streaming');
    });

    it('blocks nohup', () => {
      const result = validateCommand('nohup ./server &', 'safe');
      expect(result.allowed).toBe(false);
    });

    it('blocks interactive editors', () => {
      const result = validateCommand('vim /etc/config', 'safe');
      expect(result.allowed).toBe(false);
      expect(result.category).toBe('interactive');
    });

    it('blocks htop', () => {
      const result = validateCommand('htop', 'safe');
      expect(result.allowed).toBe(false);
    });

    it('allows safe commands', () => {
      expect(validateCommand('ls -la', 'safe').allowed).toBe(true);
      expect(validateCommand('echo hello', 'safe').allowed).toBe(true);
      expect(validateCommand('cat /etc/hosts', 'safe').allowed).toBe(true);
      expect(validateCommand('python3 script.py', 'safe').allowed).toBe(true);
    });

    it('allows tail without -f', () => {
      expect(validateCommand('tail -n 100 /var/log/syslog', 'safe').allowed).toBe(true);
    });
  });

  describe('full mode', () => {
    it('allows rm -rf with warning', () => {
      const result = validateCommand('rm -rf /tmp/test', 'full');
      expect(result.allowed).toBe(true);
      expect(result.category).toBe('dangerous');
      expect(result.message).toBeDefined();
    });

    it('allows interactive commands with warning', () => {
      const result = validateCommand('vim file.txt', 'full');
      expect(result.allowed).toBe(true);
      expect(result.category).toBe('interactive');
    });

    it('still blocks fork bombs', () => {
      const result = validateCommand(':(){ :|:& };:', 'full');
      expect(result.allowed).toBe(false);
    });
  });
});

describe('isKnownSlowCommand', () => {
  it('detects package manager installs', () => {
    expect(isKnownSlowCommand('apt install nginx')).toBe(true);
    expect(isKnownSlowCommand('apt-get update')).toBe(true);
    expect(isKnownSlowCommand('pip install numpy')).toBe(true);
    expect(isKnownSlowCommand('npm install')).toBe(true);
    expect(isKnownSlowCommand('conda install pytorch')).toBe(true);
  });

  it('detects build commands', () => {
    expect(isKnownSlowCommand('docker build .')).toBe(true);
    expect(isKnownSlowCommand('cargo build')).toBe(true);
    expect(isKnownSlowCommand('make')).toBe(true);
  });

  it('does not flag normal commands', () => {
    expect(isKnownSlowCommand('ls -la')).toBe(false);
    expect(isKnownSlowCommand('echo hello')).toBe(false);
    expect(isKnownSlowCommand('git status')).toBe(false);
    expect(isKnownSlowCommand('python3 script.py')).toBe(false);
  });
});
