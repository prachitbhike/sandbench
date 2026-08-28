/**
 * Protocol-level check for the Modal sidecar: handshake, id correlation under
 * concurrency, error propagation, and clean shutdown. Requires the sidecar
 * venv but NOT Modal credentials — auth failures are themselves a test case.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { StdioSidecar } from '../packages/core/src/providers/sidecar.js';

const py = resolve('providers/modal_sidecar/.venv/bin/python');
const script = resolve('providers/modal_sidecar/sidecar.py');
if (!existsSync(py)) {
  console.error(`missing venv at ${py} — see providers/modal_sidecar/README.md`);
  process.exit(2);
}

let failures = 0;
function check(label: string, cond: boolean, detail: string): void {
  console.log(`${cond ? '  \x1b[32mPASS\x1b[0m' : '  \x1b[31mFAIL\x1b[0m'}  ${label} — ${detail}`);
  if (!cond) failures++;
}

console.log('\nmodal sidecar protocol check\n');
const sc = new StdioSidecar(py, [script], { readyTimeoutMs: 60_000 });

const t0 = Date.now();
await sc.start();
check('handshake', true, `__ready__ received in ${Date.now() - t0}ms`);

const ping = await sc.call<{ pong: boolean; modal_version: string }>('ping');
check('ping', ping.pong === true, `modal ${ping.modal_version}`);

// 8 concurrent calls must all come back correctly correlated.
const many = await Promise.all(Array.from({ length: 8 }, () => sc.call<{ pong: boolean }>('ping')));
check('concurrent id correlation', many.length === 8 && many.every((m) => m.pong === true),
  `${many.filter((m) => m.pong).length}/8 correct responses`);

// Unknown op -> structured error, not a hang.
let unknownErr = '';
try {
  await sc.call('does_not_exist');
} catch (e) {
  unknownErr = e instanceof Error ? e.message : String(e);
}
check('unknown op rejected', unknownErr.includes('UnknownOp'), unknownErr.slice(0, 80) || '(no error!)');

// Operating on a bogus handle -> KeyError surfaced with its raw message.
let badHandle = '';
try {
  await sc.call('exec', { sandbox_id: 'sb-nope', cmd: 'echo hi' }, 30_000);
} catch (e) {
  badHandle = e instanceof Error ? e.message : String(e);
}
check('unknown sandbox rejected', badHandle.includes('KeyError') && badHandle.includes('sb-nope'),
  badHandle.slice(0, 90) || '(no error!)');

// create without credentials must produce a real error, not a silent hang.
let createErr = '';
try {
  await sc.call('create', { timeout: 60 }, 90_000);
  createErr = '(unexpectedly succeeded — credentials present?)';
} catch (e) {
  createErr = e instanceof Error ? e.message : String(e);
}
check('create surfaces auth failure', createErr.length > 0, createErr.split('\n')[0]!.slice(0, 100));

await sc.stop();
check('clean shutdown', true, 'stdin closed, process exited');

console.log(failures === 0 ? '\n\x1b[32msidecar protocol ok\x1b[0m\n' : `\n\x1b[31m${failures} failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
