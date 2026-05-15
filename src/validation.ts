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
  if (/password[^:=\n"']*:?\s*$/i.test(lastLine)) return 'password_prompt';
  if (/passphrase[^:=\n"']*:?\s*$/i.test(lastLine)) return 'password_prompt';

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
  ruleId?: string;
  source?: 'built-in';
  message?: string;
  suggestion?: string;
}

interface BuiltInPolicyEntry {
  id: string;
  pattern: RegExp;
  category: ValidationResult['category'];
  action: 'block' | 'warn';
  message: string;
  suggestion?: string;
  source: 'built-in';
}

const ALWAYS_BLOCKED: BuiltInPolicyEntry[] = [
  { id: 'block-fork-bomb', pattern: /:\(\)\{.*:\|:.*\};:/, category: 'blocked', action: 'block', message: 'Fork bomb detected', source: 'built-in' },
  { id: 'block-dd-disk-write', pattern: /\bdd\b.*\bof=\/dev\/[sh]d/, category: 'blocked', action: 'block', message: 'Direct disk write via dd', source: 'built-in' },
  { id: 'block-rm-rf-root', pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/\s*$/, category: 'blocked', action: 'block', message: 'rm -rf / (root filesystem)', source: 'built-in' },
  { id: 'block-rm-rf-system-root', pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/[a-z]*\s*$/, category: 'blocked', action: 'block', message: 'rm -rf on system root directory', source: 'built-in' },
  { id: 'block-mkfs-disk-device', pattern: /\bmkfs\b.*\/dev\/[sh]d/, category: 'blocked', action: 'block', message: 'Filesystem format on disk device', source: 'built-in' },
];

const SAFE_MODE_BLOCKED: BuiltInPolicyEntry[] = [
  // Match rm with a single short flag containing both r and f (e.g. -rf, -fr, -Rf).
  // Uses a negative lookahead to skip long options like --reference.
  { id: 'safe-block-rm-rf', pattern: /\brm\s+.*-(?![a-zA-Z]{4,})(?=[a-zA-Z]*[rR])[a-zA-Z]*[fF]/, category: 'dangerous', action: 'warn', message: 'Recursive force delete', suggestion: 'Ask the user to run this command manually in the browser terminal.', source: 'built-in' },
  { id: 'safe-block-mkfs', pattern: /\bmkfs\b/, category: 'dangerous', action: 'warn', message: 'Filesystem format command', suggestion: 'Ask the user to run this command manually.', source: 'built-in' },
  { id: 'safe-block-tail-follow', pattern: /\btail\s+.*-[a-zA-Z]*f/, category: 'streaming', action: 'warn', message: 'Streaming tail command will not terminate', suggestion: 'Use tail without -f, or use tail -n to get last N lines.', source: 'built-in' },
  // Only match nohup at the start of a command, not inside quoted strings or comments.
  { id: 'safe-block-nohup', pattern: /^\s*nohup\b/, category: 'long_running', action: 'warn', message: 'Background process via nohup', suggestion: 'Ask the user to run background processes manually in the browser terminal.', source: 'built-in' },
  // Trailing & as background indicator: must not be inside quotes. Use negative lookbehind
  // to avoid matching & when preceded by a quote char on the same line.
  { id: 'safe-block-background-ampersand', pattern: /(?<![`"'])\s*&\s*$/, category: 'long_running', action: 'warn', message: 'Background process (trailing &)', suggestion: 'Remove the trailing & or ask the user to run it manually.', source: 'built-in' },
  { id: 'safe-block-watch', pattern: /\bwatch\s+/, category: 'streaming', action: 'warn', message: 'watch command runs indefinitely', suggestion: 'Run the underlying command once instead of using watch.', source: 'built-in' },
];

const INTERACTIVE_PATTERNS: BuiltInPolicyEntry[] = [
  { id: 'safe-block-editors', pattern: /\b(vim?|nvim|emacs|nano|pico|joe|micro)\b/, category: 'interactive', action: 'warn', message: 'Interactive editor', suggestion: 'Use non-interactive alternatives (sed, echo >>, etc.) or ask the user to edit manually.', source: 'built-in' },
  { id: 'safe-block-htop', pattern: /\bhtop\b/, category: 'interactive', action: 'warn', message: 'Interactive process viewer', suggestion: 'Use ps aux or top -bn1 for non-interactive process info.', source: 'built-in' },
  { id: 'safe-block-top', pattern: /\btop\s*$/, category: 'interactive', action: 'warn', message: 'Interactive process viewer', suggestion: 'Use top -bn1 for a single snapshot.', source: 'built-in' },
  { id: 'safe-block-nmtui', pattern: /\bnmtui\b/, category: 'interactive', action: 'warn', message: 'Interactive network config', suggestion: 'Use nmcli for non-interactive network configuration.', source: 'built-in' },
  { id: 'safe-block-raspi-config', pattern: /\braspi-config\b/, category: 'interactive', action: 'warn', message: 'Interactive system config', suggestion: 'Ask the user to run raspi-config manually.', source: 'built-in' },
  { id: 'safe-block-fish-config', pattern: /\bfish_config\b/, category: 'interactive', action: 'warn', message: 'Interactive shell config', suggestion: 'Use fish -c "set -U ..." for direct configuration.', source: 'built-in' },
  { id: 'safe-block-less', pattern: /\bless\s/, category: 'interactive', action: 'warn', message: 'Interactive pager', suggestion: 'Use cat or head/tail instead.', source: 'built-in' },
  { id: 'safe-block-more', pattern: /\bmore\s/, category: 'interactive', action: 'warn', message: 'Interactive pager', suggestion: 'Use cat or head/tail instead.', source: 'built-in' },
];

function toValidationResult(entry: BuiltInPolicyEntry, allowed: boolean): ValidationResult {
  return {
    allowed,
    category: entry.category,
    ruleId: entry.id,
    source: entry.source,
    message: entry.message,
    suggestion: entry.suggestion,
  };
}

function matchRule(command: string, entries: BuiltInPolicyEntry[]) {
  return entries.find(entry => entry.pattern.test(command));
}

export function validateCommand(command: string, mode: OperationMode): ValidationResult {
  // Always blocked (both modes)
  const alwaysBlocked = matchRule(command, ALWAYS_BLOCKED);
  if (alwaysBlocked) {
    return toValidationResult(alwaysBlocked, false);
  }

  // Safe mode: block dangerous + interactive
  if (mode === 'safe') {
    const safeBlocked = matchRule(command, SAFE_MODE_BLOCKED);
    if (safeBlocked) {
      return toValidationResult(safeBlocked, false);
    }
    const interactiveBlocked = matchRule(command, INTERACTIVE_PATTERNS);
    if (interactiveBlocked) {
      return toValidationResult(interactiveBlocked, false);
    }
  }

  // Full mode: warn but allow
  if (mode === 'full') {
    const safeWarn = matchRule(command, SAFE_MODE_BLOCKED);
    if (safeWarn) {
      return toValidationResult(safeWarn, true);
    }
    const interactiveWarn = matchRule(command, INTERACTIVE_PATTERNS);
    if (interactiveWarn) {
      return toValidationResult(interactiveWarn, true);
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
