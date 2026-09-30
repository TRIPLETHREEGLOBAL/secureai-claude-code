#!/usr/bin/env node
'use strict';
/**
 * Session hook shared by all adapters.
 *
 *   node session-hook.js start --platform claude [--format claude|cursor|codex]
 *   node session-hook.js end   --platform cursor
 *
 * `start` asks Core to auto-protect this tool *if the customer's policy allows*.
 * It never blocks or fails the host tool: any problem is swallowed and the hook
 * always exits 0 with a "continue" response.
 */

const { withCore, CUSTOMER_PLATFORMS } = require('./secureai-core.js');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const phase = process.argv[2];
const platform = arg('--platform');
const format = arg('--format') || platform;

function done() {
  // Claude Code: plain exit 0 with no stdout adds nothing to the model context.
  if (format === 'claude') process.exit(0);
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
}

async function main() {
  if (!CUSTOMER_PLATFORMS.includes(platform)) return;
  if (phase === 'start') {
    await withCore(platform, (c) => c.autoProtect(platform));
  }
  // `end`: nothing to do — protection is per tool, not per session, and the
  // customer's choice persists in Core.
}

const guard = setTimeout(done, 5000);
main()
  .catch(() => {})
  .finally(() => {
    clearTimeout(guard);
    done();
  });
