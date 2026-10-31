import { execFileSync } from 'node:child_process';
import path from 'node:path';

export function sourceLocations(root) {
  let files = new Set();
  if (root) {
    try {
      files = new Set(execFileSync('git', ['-C', root, 'ls-tree', '-rz', '--name-only', 'HEAD'], {
        env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
        stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024,
      }).toString('utf8').split('\0').filter(Boolean));
    } catch {}
  }
  return {
    files,
    location(file, line, column) {
      const relative = root && typeof file === 'string' ? path.relative(root, path.resolve(root, file)) : null;
      return files.has(relative) ? { file: relative,
        ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}),
        ...(Number.isSafeInteger(column) && column > 0 ? { column } : {}),
      } : { file: '[redacted]' };
    },
  };
}
