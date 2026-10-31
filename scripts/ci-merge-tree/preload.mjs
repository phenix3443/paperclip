import { registerHooks, syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const root = process.env.PAPERCLIP_FIXED_CI_PRIVATE;
if (root) {
  const observer = new URL('./observer.mjs', import.meta.url).href;
  registerHooks({
    load(url, context, next) {
      if (/\/postgres\/src\/index\.js$/.test(url)) {
        return { format: 'module', shortCircuit: true, source: `
          import original from ${JSON.stringify(`${url}?fixed-ci-original`)};
          import { wrapPostgres, fixtureCapture } from ${JSON.stringify(observer)};
          const capture = fixtureCapture(original, process.env.PAPERCLIP_FIXED_CI_PRIVATE, process.env.PAPERCLIP_FIXED_CI_CONTEXT);
          export default wrapPostgres(original, capture);
        ` };
      }
      return next(url, context);
    },
  });
  const original = childProcess.spawn;
  childProcess.spawn = function (command, argv, options) {
    if (Array.isArray(argv) && argv.includes('vitest') && argv.includes('run')) {
      const context = path.join(root, `context-${randomUUID()}.json`);
      argv = [...argv, '--reporter=default', `--reporter=${new URL('./vitest-reporter.mjs', import.meta.url).pathname}`];
      options = { ...options, env: { ...(options?.env ?? process.env), PAPERCLIP_FIXED_CI_CONTEXT: context } };
    }
    return original.call(this, command, argv, options);
  };
  syncBuiltinESMExports();
  mkdirSync(root, { recursive: true, mode: 0o700 });
}
