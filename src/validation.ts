import { stripAnsi } from './shared.js';

// --- Operation Mode ---

export type OperationMode = 'safe' | 'full';

// --- Terminal Mode Detection ---

export type TerminalMode = 'shell' | 'editor' | 'pager' | 'password_prompt' | 'unknown';

export function detectTerminalMode(bufferTail: string): TerminalMode {
  const cleaned = stripAnsi(bufferTail);
  const lines = cleaned.split('\n').filter(l => l.trim().length > 0).slice(-5);
  if (lines.length === 0) return 'unknown';

  const lastLine = lines[lines.length - 1];
  const screenText = lines.join('\n');

  // Password prompt (highest priority)
  if (/password\s*:?\s*$/i.test(lastLine)) return 'password_prompt';
  if (/passphrase\s*:?\s*$/i.test(lastLine)) return 'password_prompt';

  // Editor detection
  if (/-- (INSERT|VISUAL|REPLACE|NORMAL) --/.test(screenText)) return 'editor';
  if (/GNU nano|^\^G Get Help|\^X Exit/.test(screenText)) return 'editor';
  if (lines.filter(l => l.trimStart().startsWith('~')).length >= 3) return 'editor';

  // Pager detection
  if (/\(END\)|--More--|lines \d+-\d+/.test(lastLine)) return 'pager';
  if (lastLine.trim() === ':') return 'pager';
  if (/Manual page \w+/.test(screenText)) return 'pager';

  return 'shell';
}

// --- Command Validation ---

export interface ValidationResult {
  allowed: boolean;
  category: 'safe' | 'dangerous' | 'blocked' | 'interactive' | 'streaming' | 'long_running';
  message?: string;
  suggestion?: string;
}

interface PatternEntry {
  pattern: RegExp;
  category: ValidationResult['category'];
  message: string;
  suggestion?: string;
}

const ALWAYS_BLOCKED: PatternEntry[] = [
  { pattern: /:\(\)\{.*:\|:.*\};:/, category: 'blocked', message: 'Fork bomb detected' },
  { pattern: /\bdd\b.*\bof=\/dev\/[sh]d/, category: 'blocked', message: 'Direct disk write via dd' },
  { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/\s*$/, category: 'blocked', message: 'rm -rf / (root filesystem)' },
  { pattern: /\bmkfs\b.*\/dev\/[sh]d/, category: 'blocked', message: 'Filesystem format on disk device' },
];

const SAFE_MODE_BLOCKED: PatternEntry[] = [
  { pattern: /\brm\s+.*-[a-zA-Z]*r[a-zA-Z]*f/, category: 'dangerous', message: 'Recursive force delete', suggestion: 'Ask the user to run this command manually in the browser terminal.' },
  { pattern: /\bmkfs\b/, category: 'dangerous', message: 'Filesystem format command', suggestion: 'Ask the user to run this command manually.' },
  { pattern: /\btail\s+.*-[a-zA-Z]*f/, category: 'streaming', message: 'Streaming tail command will not terminate', suggestion: 'Use tail without -f, or use tail -n to get last N lines.' },
  { pattern: /\bnohup\b/, category: 'long_running', message: 'Background process via nohup', suggestion: 'Ask the user to run background processes manually in the browser terminal.' },
  { pattern: /&\s*$/, category: 'long_running', message: 'Background process (trailing &)', suggestion: 'Remove the trailing & or ask the user to run it manually.' },
  { pattern: /\bwatch\s+/, category: 'streaming', message: 'watch command runs indefinitely', suggestion: 'Run the underlying command once instead of using watch.' },
];

const INTERACTIVE_PATTERNS: PatternEntry[] = [
  { pattern: /\b(vim?|nvim|emacs|nano|pico|joe|micro)\b/, category: 'interactive', message: 'Interactive editor', suggestion: 'Use non-interactive alternatives (sed, echo >>, etc.) or ask the user to edit manually.' },
  { pattern: /\bhtop\b/, category: 'interactive', message: 'Interactive process viewer', suggestion: 'Use ps aux or top -bn1 for non-interactive process info.' },
  { pattern: /\btop\s*$/, category: 'interactive', message: 'Interactive process viewer', suggestion: 'Use top -bn1 for a single snapshot.' },
  { pattern: /\bnmtui\b/, category: 'interactive', message: 'Interactive network config', suggestion: 'Use nmcli for non-interactive network configuration.' },
  { pattern: /\braspi-config\b/, category: 'interactive', message: 'Interactive system config', suggestion: 'Ask the user to run raspi-config manually.' },
  { pattern: /\bfish_config\b/, category: 'interactive', message: 'Interactive shell config', suggestion: 'Use fish -c "set -U ..." for direct configuration.' },
  { pattern: /\bless\s/, category: 'interactive', message: 'Interactive pager', suggestion: 'Use cat or head/tail instead.' },
  { pattern: /\bmore\s/, category: 'interactive', message: 'Interactive pager', suggestion: 'Use cat or head/tail instead.' },
];

export function validateCommand(command: string, mode: OperationMode): ValidationResult {
  // Always blocked (both modes)
  for (const entry of ALWAYS_BLOCKED) {
    if (entry.pattern.test(command)) {
      return { allowed: false, category: entry.category, message: entry.message };
    }
  }

  // Safe mode: block dangerous + interactive
  if (mode === 'safe') {
    for (const entry of SAFE_MODE_BLOCKED) {
      if (entry.pattern.test(command)) {
        return { allowed: false, category: entry.category, message: entry.message, suggestion: entry.suggestion };
      }
    }
    for (const entry of INTERACTIVE_PATTERNS) {
      if (entry.pattern.test(command)) {
        return { allowed: false, category: entry.category, message: entry.message, suggestion: entry.suggestion };
      }
    }
  }

  // Full mode: warn but allow
  if (mode === 'full') {
    for (const entry of SAFE_MODE_BLOCKED) {
      if (entry.pattern.test(command)) {
        return { allowed: true, category: entry.category, message: entry.message, suggestion: entry.suggestion };
      }
    }
    for (const entry of INTERACTIVE_PATTERNS) {
      if (entry.pattern.test(command)) {
        return { allowed: true, category: entry.category, message: entry.message, suggestion: entry.suggestion };
      }
    }
  }

  return { allowed: true, category: 'safe' };
}

// --- Slow Command Detection ---

const IMMEDIATE_ASYNC_PATTERNS: RegExp[] = [
  /\b(apt|apt-get|dnf|yum|pacman|apk)\s+(install|upgrade|update|dist-upgrade|full-upgrade)/,
  /\b(pip|pip3)\s+install/,
  /\bnpm\s+(install|ci)\b/,
  /\byarn\s+(install|add)\b/,
  /\bconda\s+(install|create|update)\b/,
  /\bdocker\s+(build|pull|push)\b/,
  /\bcargo\s+build\b/,
  /\bmake\s*$/,
];

export function isKnownSlowCommand(command: string): boolean {
  return IMMEDIATE_ASYNC_PATTERNS.some(p => p.test(command));
}
