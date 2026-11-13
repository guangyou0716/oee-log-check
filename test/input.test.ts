import { describe, expect, it } from 'vitest';
import { InputError } from '../src/errors.js';
import { parseCounts, parseStates, SINGLE_MACHINE } from '../src/input.js';
import { formatDuration, parseTimestamp } from '../src/time.js';

describe('parseTimestamp / formatDuration', () => {
  it('reads naive and zoned ISO times and rejects bad ones', () => {
    expect(parseTimestamp('2026-11-02 08:00')).toEqual({ ms: Date.UTC(2026, 10, 2, 8), zoned: false });
    expect(parseTimestamp('2026-11-02T08:00:00+08:00')).toEqual({ ms: Date.UTC(2026, 10, 2, 0), zoned: true });
    expect(parseTimestamp('2026-02-30 08:00')).toBeUndefined();
    expect(parseTimestamp('02/11/2026 08:00')).toBeUndefined();
  });
  it('formats durations', () => {
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(720)).toBe('12 min');
    expect(formatDuration(3 * 3600 + 300)).toBe('3 h 5 min');
    expect(formatDuration(7230)).toBe('2 h 0 min 30 s');
  });
});

describe('parseStates', () => {
  it('reads machine, state and reason; columns are matched without case', () => {
    const log = parseStates('Timestamp,MACHINE,State,Reason\n2026-01-01 08:00,M1,RUN,\n2026-01-01 09:00,M1,DOWN,jam\n');
    expect(log.hasMachine).toBe(true);
    expect(log.zoned).toBe(false);
    expect(log.rows.map((r) => [r.machine, r.state, r.reason, r.line])).toEqual([
      ['M1', 'RUN', '', 2],
      ['M1', 'DOWN', 'jam', 3],
    ]);
  });
  it('single machine when there is no machine column; renamed columns', () => {
    const log = parseStates('t,status\n2026-01-01 08:00,run\n', { timeColumn: 't', stateColumn: 'status' });
    expect(log.hasMachine).toBe(false);
    expect(log.rows[0].machine).toBe(SINGLE_MACHINE);
  });
  it('input errors name the row', () => {
    const bad: [string, RegExp][] = [
      ['', /empty/],
      ['timestamp,state\n', /no data rows/],
      ['timestamp,machine\n2026-01-01 08:00,M1\n', /no "state" column/],
      ['timestamp,state\n2026-13-01 08:00,run\n', /row 2: timestamp "2026-13-01 08:00"/],
      ['timestamp,state\n2026-01-01 08:00,\n', /row 2: empty state/],
      ['timestamp,machine,state\n2026-01-01 08:00,,run\n', /row 2: empty machine/],
      ['timestamp,state\n2026-01-01 08:00,run\n2026-01-01T09:00Z,down\n', /row 3: mix of timestamps/],
      ['timestamp,state,State\n2026-01-01 08:00,run,run\n', /appears twice/],
    ];
    for (const [text, re] of bad) {
      expect(() => parseStates(text)).toThrow(InputError);
      expect(() => parseStates(text)).toThrow(re);
    }
    expect(() => parseStates('timestamp,state\n2026-01-01 08:00,run\n', { reasonColumn: 'why' })).toThrow(/--reason-column/);
  });
});

describe('parseCounts', () => {
  it('good, reject or both; total worked out from good + reject', () => {
    expect(parseCounts('timestamp,total,good\n2026-01-01 09:00,10,9\n').rows[0]).toMatchObject({ total: 10, good: 9, machine: SINGLE_MACHINE });
    expect(parseCounts('timestamp,total,reject\n2026-01-01 09:00,10,3\n').rows[0]).toMatchObject({ total: 10, good: 7 });
    expect(parseCounts('timestamp,good,reject\n2026-01-01 09:00,8,2\n').rows[0]).toMatchObject({ total: 10, good: 8 });
    expect(parseCounts('timestamp,total,good\n').rows).toEqual([]);
  });
  it('input errors', () => {
    const bad: [string, RegExp][] = [
      ['timestamp,total\n2026-01-01 09:00,10\n', /"good" or a "reject"/],
      ['timestamp,good\n2026-01-01 09:00,10\n', /needs a "total" column/],
      ['timestamp,total,good\n2026-01-01 09:00,10,11\n', /good 11 is more than total 10/],
      ['timestamp,total,reject\n2026-01-01 09:00,10,11\n', /reject 11 is more than total 10/],
      ['timestamp,total,good,reject\n2026-01-01 09:00,10,8,1\n', /good 8 \+ reject 1 is not total 10/],
      ['timestamp,total,good\n2026-01-01 09:00,-1,0\n', /row 2: total "-1" is not a whole number/],
      ['timestamp,total,good\n2026-01-01 09:00,1.5,1\n', /not a whole number/],
      ['timestamp,total,good\n2026-01-01 09:00,,1\n', /not a whole number/],
    ];
    for (const [text, re] of bad) {
      expect(() => parseCounts(text)).toThrow(re);
    }
  });
});
