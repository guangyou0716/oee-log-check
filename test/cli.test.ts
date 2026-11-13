import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { countsExample, statesExample } from './helpers.js';

let out = '';
let err = '';
beforeEach(() => {
  out = '';
  err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err += String(chunk);
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());

const tmp = (name: string, text: string) => {
  const path = join(mkdtempSync(join(tmpdir(), 'oee-cli-')), name);
  writeFileSync(path, text);
  return path;
};
const full = [statesExample, '--counts', countsExample, '--ideal-cycle', 'M1=30,M2=45'];

describe('cli', () => {
  it('text report of the example (exit 0 without a target)', () => {
    expect(main(full)).toBe(0);
    expect(out).toContain('Window: 2026-11-02 08:00:00 .. 2026-11-02 20:00:00 (12 h 0 min), end = latest timestamp in the input');
    expect(out).toContain('States seen: run = RUN; planned stop = BREAK; downtime = DOWN, SETUP');
    expect(out).toMatch(/M1 +11 h 45 min +10 h 27 min +1 h 18 min +3 +15 min +0 s +88\.94% +87\.72% +98% +76\.45% +1100 \(1078 good\)/);
    expect(out).toMatch(/All +22 h 15 min .* 79\.08% +1800 \(1767 good\)/);
    expect(out).toMatch(/spindle alarm +1 +1 h 0 min +41\.67% +41\.67% +M2/);
    expect(out).toContain('Short stops (< 5 min): 3 stop(s), 9 min (counted as downtime)');
    expect(out).toContain('Findings: none');
  });

  it('--target makes findings (exit 1); Markdown and JSON', () => {
    expect(main([...full, '--target', '80'])).toBe(1);
    expect(out).toContain('  - M1: OEE 76.45% is below the 80% target.');
    expect(out).toContain('  - All machines: OEE 79.08% is below the 80% target.');
    out = '';
    expect(main([...full, '--md'])).toBe(0);
    expect(out).toContain('# OEE report');
    expect(out).toContain('| M2 | 10 h 30 min | 9 h 24 min | 1 h 6 min | 3 | 1 h 0 min | 30 min | 89.52% | 93.09% | 98.43% | 82.02% | 700 (689 good) |');
    expect(out).toContain('| jam | 3 | 9 min | 6.25% | 100% | M1, M2 |');
    out = '';
    expect(main([...full, '--json', '--short-stop', '120'])).toBe(0);
    const data = JSON.parse(out);
    expect(data.total.oeePct).toBe(79.08);
    expect(data.total.shortStops).toBe(0);
    expect(data.settings.shortStopS).toBe(120);
  });

  it('states only: availability and Pareto, with a note; one ideal cycle for all machines', () => {
    expect(main([statesExample])).toBe(0);
    expect(out).toMatch(/M1 .* 88\.94% +- +- +-\n/);
    expect(out).not.toContain('Parts');
    expect(out).toContain('Note: No counts file: availability only');
    out = '';
    expect(main([statesExample, '--counts', countsExample, '--ideal-cycle', '30', '--json'])).toBe(0);
    expect(JSON.parse(out).machines.map((m: { idealCycleS: number }) => m.idealCycleS)).toEqual([30, 30]);
    out = '';
    expect(main([statesExample, '--counts', countsExample])).toBe(0);
    expect(out).toContain('Note: No ideal cycle time for some machines');
  });

  it('renamed columns, custom states and window', () => {
    const s = tmp('s.csv', 'time,line,status\n2026-01-01 08:00,L1,AUTO\n2026-01-01 09:00,L1,PM\n2026-01-01 09:30,L1,ALARM\n2026-01-01 09:40,L1,AUTO\n');
    const c = tmp('c.csv', 'ts,line,ok,ng\n2026-01-01 09:00,L1,118,2\n2026-01-01 10:00,L1,20,0\n');
    const args = [s, '--time-column', 'time', '--machine-column', 'line', '--state-column', 'status', '--run-states', 'AUTO', '--planned-states', 'PM'];
    const countArgs = ['--counts', c, '--counts-time-column', 'ts', '--counts-machine-column', 'line', '--good-column', 'ok', '--reject-column', 'ng'];
    expect(main([...args, ...countArgs, '--ideal-cycle', 'L1=30', '--to', '2026-01-01 10:00', '--json'])).toBe(0);
    const data = JSON.parse(out);
    expect(data.machines[0]).toMatchObject({ runS: 4800, downS: 600, plannedStopS: 1800, totalParts: 140, goodParts: 138, qualityPct: 98.57 });
    expect(data.pareto[0]).toMatchObject({ reason: 'ALARM', stops: 1, seconds: 600 });
  });

  it('input errors exit 2 with a message', () => {
    const cases: [string[], RegExp][] = [
      [[], /Give a states CSV/],
      [[statesExample, countsExample], /exactly one states CSV/],
      [[statesExample, '--json', '--md'], /either --json or --md/],
      [[statesExample, '--good-column', 'ok'], /need --counts/],
      [[statesExample, '--target', 'x'], /--target must be a number/],
      [[statesExample, '--ideal-cycle', 'M1=a'], /--ideal-cycle for "M1" must be a number/],
      [[statesExample, '--ideal-cycle', '=3'], /not machine=seconds/],
      [[statesExample, '--ideal-cycle', 'M1=3,M1=4'], /twice/],
      [[statesExample, '--ideal-cycle', 'M9=3'], /names machine "M9"/],
      [[join(tmpdir(), 'no-such-oee.csv')], /Cannot read states .*ENOENT/],
      [[statesExample, '--counts', join(tmpdir(), 'no-such-oee.csv')], /Cannot read counts/],
      [[statesExample, '--bogus'], /Unknown option/],
    ];
    for (const [args, re] of cases) {
      err = '';
      expect(main(args)).toBe(2);
      expect(err).toMatch(/^oee-log-check: /);
      expect(err).toMatch(re);
    }
  });

  it('--help exits 0', () => {
    expect(main(['--help'])).toBe(0);
    expect(out).toContain('Usage: oee-log-check');
  });
});

describe('cli: --by-day', () => {
  it('text and markdown show the day table; day options need --by-day', () => {
    expect(main([...full, '--by-day', '--day-start', '14:00'])).toBe(0);
    expect(out).toContain('By day (a day starts at 14:00;');
    expect(out).toMatch(/2026-11-01 All\s+10 h 15 min/);
    expect(out).toMatch(/2026-11-02 M1\s+6 h 0 min/);
    out = '';
    expect(main([...full, '--by-day', '--md'])).toBe(0);
    expect(out).toContain('## By day');
    expect(out).toContain('| 2026-11-02 All |');
    expect(main([...full, '--day-start', '07:00'])).toBe(2);
    expect(err).toContain('need --by-day');
  });
});
