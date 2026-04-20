import { describe, expect, it } from 'vitest';

import { tryParseCommandOutput } from '../src/parsers';

describe('tryParseCommandOutput', () => {
  describe('git status', () => {
    it('parses short format git status', () => {
      const output = `On branch main
?? newfile.txt
 M modified.txt
A  staged.txt
`;
      const result = tryParseCommandOutput('git status', output);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('git_status');
      const data = result!.data as any;
      expect(data.branch).toBe('main');
      expect(data.untracked).toContain('newfile.txt');
      expect(data.modified).toContain('modified.txt');
    });

    it('returns null for empty output', () => {
      const result = tryParseCommandOutput('git status', '');
      expect(result).toBeNull();
    });

    it('does not match non-git commands', () => {
      const result = tryParseCommandOutput('ls -la', 'On branch main');
      expect(result).toBeNull();
    });
  });

  describe('git log', () => {
    it('parses standard git log output', () => {
      const output = `commit abc123def456
Author: User <user@example.com>
Date:   Mon Apr 20 10:00:00 2026 +0800

    feat: add new feature

commit def789abc012
Author: User <user@example.com>
Date:   Sun Apr 19 09:00:00 2026 +0800

    fix: resolve bug
`;
      const result = tryParseCommandOutput('git log', output);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('git_log');
      const data = result!.data as any[];
      expect(data).toHaveLength(2);
      expect(data[0].hash).toBe('abc123def456');
      expect(data[0].message).toContain('add new feature');
      expect(data[1].hash).toBe('def789abc012');
    });
  });

  describe('ls -la', () => {
    it('parses ls -la output', () => {
      const output = `total 48
drwxr-xr-x  5 user group  4096 Apr 20 10:00 .
drwxr-xr-x  3 user group  4096 Apr 19 09:00 ..
-rw-r--r--  1 user group  1234 Apr 20 10:00 file.txt
lrwxrwxrwx  1 user group    11 Apr 18 08:00 link -> target
`;
      const result = tryParseCommandOutput('ls -la', output);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('ls_la');
      const data = result!.data as any[];
      expect(data.length).toBeGreaterThanOrEqual(3);
      const file = data.find((e: any) => e.name === 'file.txt');
      expect(file).toBeDefined();
      expect(file.type).toBe('file');
      expect(file.size).toBe(1234);
      const link = data.find((e: any) => e.name.startsWith('link'));
      expect(link).toBeDefined();
      expect(link.type).toBe('link');
    });

    it('returns null for non-ls output', () => {
      const result = tryParseCommandOutput('ls -la', 'No such file or directory');
      expect(result).toBeNull();
    });
  });
});
