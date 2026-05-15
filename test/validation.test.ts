import { describe, expect, it } from 'vitest';

import {
  type CustomPolicyRule,
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

  it('detects dirty terminal states even with ANSI noise', () => {
    expect(detectTerminalMode('\x1b[31mPassword:\x1b[0m ')).toBe('password_prompt');
    expect(detectTerminalMode('\x1b[2J\x1b[HGNU nano 5.4\n^G Get Help')).toBe('editor');
    expect(detectTerminalMode('\x1b[7mcontent\x1b[0m\n\x1b[33m(END)\x1b[0m')).toBe('pager');
  });
});

describe('validateCommand', () => {
  const customRules: CustomPolicyRule[] = [
    {
      id: 'block-kubectl-delete',
      enabled: true,
      pattern: '\\bkubectl\\s+delete\\b',
      mode: 'safe',
      category: 'dangerous',
      action: 'block',
      message: 'kubectl delete blocked by session policy',
      source: 'session',
    },
    {
      id: 'warn-terraform-apply',
      enabled: true,
      pattern: '\\bterraform\\s+apply\\b',
      mode: 'both',
      category: 'dangerous',
      action: 'warn',
      message: 'terraform apply is risky',
      source: 'default',
    },
  ];

  describe('ALWAYS_BLOCKED', () => {
    it('blocks fork bombs', () => {
      const result = validateCommand(':(){ :|:& };:', 'full');
      expect(result.allowed).toBe(false);
      expect(result.category).toBe('blocked');
      expect(result.ruleId).toBe('block-fork-bomb');
      expect(result.source).toBe('built-in');
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

    it('blocks rm -fr variant', () => {
      expect(validateCommand('rm -fr /tmp/cache', 'safe').allowed).toBe(false);
      expect(validateCommand('rm -Rf /tmp/cache', 'safe').allowed).toBe(false);
    });

    it('does not block rm with long option containing r and f', () => {
      // Regression: --reference contains -ref which has 'r' then 'f' but is not -rf
      expect(validateCommand('rm file --reference=foo', 'safe').allowed).toBe(true);
    });

    it('blocks tail -f', () => {
      const result = validateCommand('tail -f /var/log/syslog', 'safe');
      expect(result.allowed).toBe(false);
      expect(result.category).toBe('streaming');
      expect(result.ruleId).toBe('safe-block-tail-follow');
    });

    it('blocks nohup at command start', () => {
      const result = validateCommand('nohup ./server &', 'safe');
      expect(result.allowed).toBe(false);
    });

    it('does not block nohup inside quoted strings', () => {
      // Regression: "echo nohup" should not be treated as a background command
      expect(validateCommand('echo "nohup"', 'safe').allowed).toBe(true);
      expect(validateCommand("echo something about nohup", 'safe').allowed).toBe(true);
    });

    it('blocks trailing & for background processes', () => {
      expect(validateCommand('./server &', 'safe').allowed).toBe(false);
      expect(validateCommand('sleep 100 &', 'safe').allowed).toBe(false);
    });

    it('does not block trailing & inside quotes', () => {
      // Regression: & inside quoted strings should not be treated as background indicator
      expect(validateCommand('echo "foo & bar"', 'safe').allowed).toBe(true);
    });

    it('blocks interactive editors', () => {
      const result = validateCommand('vim /etc/config', 'safe');
      expect(result.allowed).toBe(false);
      expect(result.category).toBe('interactive');
      expect(result.ruleId).toBe('safe-block-editors');
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

    it('applies custom blocking rules before built-in safe warnings', () => {
      const result = validateCommand('kubectl delete pod demo', 'safe', customRules);
      expect(result.allowed).toBe(false);
      expect(result.ruleId).toBe('block-kubectl-delete');
      expect(result.source).toBe('session');
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
      expect(result.ruleId).toBe('safe-block-rm-rf');
    });

    it('allows interactive commands with warning', () => {
      const result = validateCommand('vim file.txt', 'full');
      expect(result.allowed).toBe(true);
      expect(result.category).toBe('interactive');
    });

    it('allows custom warn rules in full mode with metadata', () => {
      const result = validateCommand('terraform apply', 'full', customRules);
      expect(result.allowed).toBe(true);
      expect(result.ruleId).toBe('warn-terraform-apply');
      expect(result.source).toBe('default');
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
