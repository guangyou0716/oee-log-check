#!/usr/bin/env node
// End-to-end check of the built CLI (dist/cli.js), run directly and through a symlink like an npm bin.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'dist', 'cli.js');
const states = join(root, 'examples', 'states-example.csv');
const counts = join(root, 'examples', 'counts-example.csv');
const fail = (message) => {
  console.error(`smoke: FAIL ${message}`);
  process.exit(1);
};
const run = (bin, args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const dir = mkdtempSync(join(tmpdir(), 'oee-smoke-'));
const link = join(dir, 'oee-log-check');
symlinkSync(cli, link);
for (const bin of [cli, link]) {
  const res = run(bin, [states, '--counts', counts, '--ideal-cycle', 'M1=30,M2=45', '--target', '80', '--json']);
  const data = res.stdout ? JSON.parse(res.stdout) : {};
  if (res.status !== 1 || data.total?.oeePct !== 79.08 || data.machines?.[0]?.oeePct !== 76.45 || data.findings?.length !== 2) {
    fail(`example via ${bin}: status ${res.status} ${JSON.stringify(data.total)} ${res.stderr}`);
  }
}
console.log('smoke: ok example (direct and via symlink) OEE M1 76.45%, total 79.08%, 2 below-target findings, exit 1');

// 20 machines x 90 days, a state row every 10 minutes (259,200 rows): 50 min RUN then 10 min DOWN each hour,
// plus one count row per machine per hour (43,200 rows) of 100 parts with 1 reject. Ideal cycle 30 s.
const s = ['timestamp,machine,state,reason'];
const c = ['timestamp,machine,total,good'];
const base = Date.UTC(2026, 0, 1);
const hours = 90 * 24;
for (let m = 1; m <= 20; m++) {
  for (let i = 0; i < hours * 6; i++) {
    const t = new Date(base + i * 600_000).toISOString().slice(0, 19).replace('T', ' ');
    s.push(i % 6 === 5 ? `${t},M${m},DOWN,${m % 2 ? 'jam' : 'waiting material'}` : `${t},M${m},RUN,`);
  }
  for (let h = 1; h <= hours; h++) {
    c.push(`${new Date(base + h * 3_600_000).toISOString().slice(0, 19).replace('T', ' ')},M${m},100,99`);
  }
}
const bigS = join(dir, 'states.csv');
const bigC = join(dir, 'counts.csv');
writeFileSync(bigS, `${s.join('\n')}\n`);
writeFileSync(bigC, `${c.join('\n')}\n`);
const started = Date.now();
const res = run(cli, [bigS, '--counts', bigC, '--ideal-cycle', '30', '--json']);
const data = res.stdout ? JSON.parse(res.stdout) : {};
// Last DOWN row of each machine (index 12959) ends at the latest timestamp (last count, 90 days after start).
const t = data.total ?? {};
if (res.status !== 0 || data.machines?.length !== 20 || t.runS !== 20 * hours * 3000 || t.downS !== 20 * hours * 600 ||
  t.availabilityPct !== 83.33 || t.performancePct !== 100 || t.qualityPct !== 99 || t.oeePct !== 82.5 ||
  data.pareto?.length !== 2 || data.pareto[0].stops !== 10 * hours) {
  fail(`big log: status ${res.status} ${JSON.stringify(t)} ${res.stderr}`);
}
console.log(`smoke: ok 20 machines x 90 days (${s.length - 1} state rows, ${c.length - 1} count rows) in ${Date.now() - started} ms, OEE 82.5%`);

const bad = run(cli, [states, '--json', '--md']);
if (bad.status !== 2 || !bad.stderr.includes('either --json or --md')) {
  fail(`bad flags: status ${bad.status} ${bad.stderr}`);
}
console.log('smoke: ok bad flags -> exit 2');
