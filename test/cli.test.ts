import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { counterExample, countsExample, statesExample } from './helpers.js';

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

describe('cli: --shifts', () => {
  it('text and markdown show the shift table', () => {
    expect(main([...full, '--shifts', 'A=06:00,B=14:00,C=22:00'])).toBe(0);
    expect(out).toContain('By shift (each shift summed over every day in the window: A 1x, B 1x;');
    expect(out).toMatch(/A 06:00-14:00 M1\s+5 h 45 min/);
    expect(out).toMatch(/B 14:00-22:00 All\s+12 h 0 min .* 73\.51% +900 \(885 good\)/);
    out = '';
    expect(main([...full, '--shifts', 'A=06:00,B=14:00', '--md'])).toBe(0);
    expect(out).toContain('## By shift');
    expect(out).toContain('| B 14:00-06:00 All |');
    out = '';
    expect(main([...full, '--shifts', 'A=06:00', '--json'])).toBe(0);
    expect(JSON.parse(out).shifts[0]).toMatchObject({ shift: 'A', periods: 1, seconds: 43200 });
    expect(main([...full, '--shifts', 'A'])).toBe(2);
    expect(err).toContain('is not name=HH:MM');
  });

  it('--counter: the running-counter example gives the same OEE as the increments example', () => {
    expect(main([statesExample, '--counts', counterExample, '--counter', '--ideal-cycle', 'M1=30,M2=45', '--json'])).toBe(0);
    const r = JSON.parse(out);
    expect(r.machines[0].oeePct).toBe(76.45);
    expect(r.total.oeePct).toBe(79.08);
    expect(r.total.totalParts).toBe(1800);
    expect(r.counts.counter).toMatchObject({ baselines: 2, repeats: 0, resets: [] });
    out = '';
    expect(main([statesExample, '--counts', counterExample, '--counter', '--ideal-cycle', 'M1=30,M2=45'])).toBe(0);
    expect(out).toMatch(/Note: Running counters: \d+ reading\(s\) -> \d+ increment\(s\); the first reading per machine \(2\) is the starting point\./);
  });
  it('--counter lists resets in the notes (text and md)', () => {
    const states = tmp('s.csv', 'timestamp,state\n2026-01-01 08:00,run\n2026-01-01 10:00,run\n');
    const counts = tmp('c.csv', 'timestamp,total,good\n2026-01-01 08:00,500,490\n2026-01-01 09:00,560,549\n2026-01-01 10:00,40,40\n');
    expect(main([states, '--counts', counts, '--counter', '--ideal-cycle', '60', '--md'])).toBe(0);
    expect(out).toContain('> 1 counter reset(s) (a reading went down; taken as parts since the reset, parts between the reading before and the reset are not seen): machine at 2026-01-01 10:00 (row 4).');
    expect(out).toMatch(/\| machine \| .*\| 100 \(99 good\) \|/);
  });
  it('--counter needs --counts', () => {
    expect(main([statesExample, '--counter'])).toBe(2);
    expect(err).toContain('need --counts');
  });

  it('--changeover-states adds a column and a by-reason table (text and md); JSON carries the fields', () => {
    expect(main([...full, '--changeover-states', 'setup'])).toBe(0);
    expect(out).toContain('States seen: run = RUN; planned stop = BREAK; changeover = SETUP; downtime = DOWN');
    expect(out).toContain('changeover states: setup; anything else is downtime');
    expect(out).toMatch(/Machine +Planned prod\. +Run +Down +Stops +Changeover +C\/O +Planned stop/);
    expect(out).toMatch(/M1 +11 h 45 min +10 h 27 min +48 min +2 +30 min +1 +15 min +0 s +88\.94% +87\.72% +98% +76\.45%/);
    expect(out).toContain('Changeover by reason (availability loss, not in downtime or stops): 1 changeover(s), 30 min');
    expect(out).toMatch(/changeover +1 +30 min +100% +100% +M1/);
    out = '';
    expect(main([...full, '--changeover-states', 'setup', '--md'])).toBe(0);
    expect(out).toContain('## Changeover by reason');
    expect(out).toContain('| Machine | Planned prod. | Run | Down | Stops | Changeover | C/O | Planned stop |');
    out = '';
    expect(main([...full, '--changeover-states', 'nothing-like-this', '--json'])).toBe(0);
    const j = JSON.parse(out);
    expect(j.changeoverReasons).toEqual([]);
    expect(j.machines[0]).toMatchObject({ changeoverS: 0, changeovers: 0 });
    out = '';
    expect(main([...full, '--changeover-states', 'nothing-like-this'])).toBe(0);
    expect(out).toContain('Changeover by reason: no changeover in the window.');
    expect(main([...full, '--changeover-states', 'RUN'])).toBe(2);
    expect(err).toContain('"run" is both a changeover state and a run state');
  });
});

