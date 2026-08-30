/**
 * Runs the TrueForge harness with Tombstone's local settings.
 *
 * Pinned to an exact version so a clone reproduces the same harness behaviour
 * the project was built and demonstrated against.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TRUEFORGE_VERSION = '0.1.4';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.TRUEFORGE_PORT ?? '8790';

const child = spawn('npx', ['-y', `@truefoundry/trueforge@${TRUEFORGE_VERSION}`], {
  stdio: 'inherit',
  env: { ...process.env, PORT: port, SQLITE_PATH: path.join(root, '.trueforge', 'trueforge.sqlite') },
});
child.on('exit', (code) => process.exit(code ?? 0));
