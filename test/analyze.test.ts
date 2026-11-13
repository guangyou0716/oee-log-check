import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyze, parseShifts, resolveSettings } from '../src/analyze.js';
import { parseCounts, parseStates } from '../src/input.js';
import { countsExample, statesExample } from './helpers.js';

const states = (text: string) => parseStates(`timestamp,machine,state,reason\n${text}`);
const counts = (text: string) => parseCounts(`timestamp,machine,total,good\n${text}`);

describe('analyze: example (numbers worked out by hand in the README)', () => {
  const r = analyze(parseStates(readFileSync(statesExample, 'utf8')), parseCounts(readFileSync(countsExample, 'utf8')), {
    idealCycleS: { M1: 30, M2: 45 },
  });
  it('per machine times and OEE parts', () => {
    const [m1, m2] = r.machines;
    expect(m1).toMatchObject({ machine: 'M1', runS: 627 * 60, downS: 78 * 60, plannedStopS: 15 * 60, noDataS: 0, plannedProductionS: 705 * 60, stops: 3 });
    expect(m1).toMatchObject({ availabilityPct: 88.94, performancePct: 87.72, qualityPct: 98, oeePct: 76.45, totalParts: 1100, goodParts: 1078 });
    expect(m2).toMatchObject({ runS: 564 * 60, downS: 66 * 60, plannedStopS: 3600, noDataS: 1800, stops: 3, shortStops: 2, shortStopS: 360 });
    expect(m2).toMatchObject({ availabilityPct: 89.52, performancePct: 93.09, qualityPct: 98.43, oeePct: 82.02 });
    expect(r.total).toMatchObject({ plannedProductionS: 1335 * 60, availabilityPct: 89.21, performancePct: 90.26, qualityPct: 98.17, oeePct: 79.08 });
    expect(r.window).toEqual({ from: '2026-11-02 08:00:00', to: '2026-11-02 20:00:00', seconds: 43200, endFromInput: true });
    expect(r.states).toEqual({ run: ['RUN'], planned: ['BREAK'], down: ['DOWN', 'SETUP'] });
    expect(r.findings).toEqual([]);
  });
  it('Pareto merges reasons without case, sorted by time with cumulative share', () => {
    expect(r.pareto.map((e) => [e.reason, e.stops, e.seconds, e.sharePct, e.cumulativePct, e.machines.join('+')])).toEqual([
      ['spindle alarm', 1, 3600, 41.67, 41.67, 'M2'],
      ['material shortage', 1, 2700, 31.25, 72.92, 'M1'],
      ['changeover', 1, 1800, 20.83, 93.75, 'M1'],
      ['jam', 3, 540, 6.25, 100, 'M1+M2'],
    ]);
    expect(r.total).toMatchObject({ shortStops: 3, shortStopS: 540 });
  });
  it('OEE equals A x P x Q', () => {
    for (const m of r.machines) {
      const product = ((m.availabilityPct as number) * (m.performancePct as number) * (m.qualityPct as number)) / 10000;
      expect(Math.abs(product - (m.oeePct as number))).toBeLessThan(0.02);
    }
  });
});

describe('analyze: rules', () => {
  it('unsorted rows are sorted per machine; same machine + time is an input error', () => {
    const r = analyze(states('2026-01-01 09:00,A,DOWN,x\n2026-01-01 08:00,A,RUN,\n2026-01-01 10:00,A,RUN,\n'), undefined);
    expect(r.machines[0]).toMatchObject({ runS: 3600, downS: 3600 });
    expect(() => analyze(states('2026-01-01 08:00,A,RUN,\n2026-01-01 08:00,A,DOWN,\n'), undefined)).toThrow(/rows 2 and 3: machine "A" has two states/);
  });

  it('--from / --to clip states and counts; the last state runs until --to', () => {
    const s = states('2026-01-01 06:00,A,DOWN,x\n2026-01-01 08:30,A,RUN,\n');
    const c = counts('2026-01-01 07:00,A,10,10\n2026-01-01 09:00,A,100,100\n2026-01-01 10:00,A,100,99\n2026-01-01 10:01,A,5,5\n');
    const r = analyze(s, c, { from: '2026-01-01 08:00', to: '2026-01-01 10:00', idealCycleS: 45 });
    expect(r.machines[0]).toMatchObject({ downS: 1800, runS: 5400, totalParts: 200, goodParts: 199, performancePct: 166.67 });
    expect(r.counts).toMatchObject({ outsideWindow: 2 });
    expect(r.window).toMatchObject({ seconds: 7200, endFromInput: false, to: '2026-01-01 10:00' });
    expect(r.findings.map((f) => f.kind)).toEqual(['performance-over-100']);
  });

  it('no-data time before the first row; planned states are left out of planned production time', () => {
    const s = states('2026-01-01 08:00,A,RUN,\n2026-01-01 08:00,B,off,\n2026-01-01 09:00,B,Running,\n2026-01-01 10:00,A,RUN,\n');
    const r = analyze(s, undefined, { to: '2026-01-01 11:00' });
    expect(r.machines.find((m) => m.machine === 'B')).toMatchObject({ plannedStopS: 3600, runS: 7200, noDataS: 0, availabilityPct: 100 });
    const later = analyze(states('2026-01-01 08:00,A,RUN,\n2026-01-01 09:30,B,RUN,\n'), undefined, { to: '2026-01-01 10:00' });
    expect(later.machines[1]).toMatchObject({ noDataS: 5400, runS: 1800 });
  });

  it('custom run and planned states', () => {
    const s = states('2026-01-01 08:00,A,AUTO,\n2026-01-01 09:00,A,PM,\n2026-01-01 10:00,A,IDLE,\n2026-01-01 11:00,A,AUTO,\n');
    const r = analyze(s, undefined, { runStates: ['auto'], plannedStates: ['pm'] });
    expect(r.machines[0]).toMatchObject({ runS: 3600, plannedStopS: 3600, downS: 3600, availabilityPct: 50 });
    expect(r.pareto[0]).toMatchObject({ reason: 'IDLE', stops: 1 });
  });

  it('without counts: availability only; without ideal cycle: no performance / OEE', () => {
    const s = states('2026-01-01 08:00,A,RUN,\n2026-01-01 09:00,A,DOWN,\n2026-01-01 10:00,A,RUN,\n');
    const r = analyze(s, undefined, { idealCycleS: 30 });
    expect(r.machines[0]).toMatchObject({ availabilityPct: 50, performancePct: null, qualityPct: null, oeePct: null });
    const c = analyze(s, counts('2026-01-01 09:00,A,60,60\n'), {});
    expect(c.machines[0]).toMatchObject({ performancePct: null, qualityPct: 100, oeePct: null });
    expect(c.total.performancePct).toBeNull();
  });

  it('counts without a machine column go to the only machine; several machines -> input error', () => {
    const one = analyze(states('2026-01-01 08:00,A,RUN,\n2026-01-01 09:00,A,OFF,\n'), parseCounts('timestamp,total,good\n2026-01-01 09:00,120,120\n'), {
      idealCycleS: 30,
    });
    expect(one.machines[0]).toMatchObject({ performancePct: 100, oeePct: 100 });
    const two = states('2026-01-01 08:00,A,RUN,\n2026-01-01 08:00,B,RUN,\n2026-01-01 09:00,A,OFF,\n');
    expect(() => analyze(two, parseCounts('timestamp,total,good\n2026-01-01 09:00,1,1\n'))).toThrow(/several machines/);
    expect(() => analyze(parseStates('timestamp,state\n2026-01-01 08:00,run\n2026-01-01 09:00,off\n'), counts('2026-01-01 09:00,A,1,1\n'))).toThrow(
      /states file has none/,
    );
  });

  it('findings: unknown machine, counts before first state, parts without run time, below target', () => {
    const s = states('2026-01-01 08:00,A,RUN,\n2026-01-01 08:30,B,DOWN,\n2026-01-01 10:00,A,RUN,\n');
    const c = counts('2026-01-01 08:10,B,5,5\n2026-01-01 09:00,B,5,5\n2026-01-01 09:00,Z,7,7\n2026-01-01 10:00,A,100,90\n');
    const r = analyze(s, c, { idealCycleS: 30, targetPct: 85 });
    expect(r.findings.map((f) => [f.kind, f.machine])).toEqual([
      ['counts-without-states', 'Z'],
      ['below-target', 'A'],
      ['counts-before-first-state', 'B'],
      ['parts-without-run-time', 'B'],
      ['below-target', null],
    ]);
    expect(r.counts.unknownMachine).toBe(1);
    expect(r.machines[0]).toMatchObject({ oeePct: 37.5 });
  });

  it('mixed zone styles and bad windows are input errors', () => {
    const s = states('2026-01-01 08:00,A,RUN,\n2026-01-01 09:00,A,OFF,\n');
    expect(() => analyze(s, counts('2026-01-01T09:00Z,A,1,1\n'))).toThrow(/mix timestamps/);
    expect(() => analyze(s, undefined, { from: '2026-01-01T08:00+08:00' })).toThrow(/--from must not carry/);
    expect(() => analyze(s, undefined, { from: '2026-01-01 09:00', to: '2026-01-01 08:00' })).toThrow(/window is empty/);
    expect(() => analyze(states('2026-01-01 08:00,A,RUN,\n'), undefined)).toThrow(/window is empty/);
    expect(() => analyze(s, undefined, { to: 'tomorrow' })).toThrow(/--to "tomorrow" is not ISO 8601/);
    expect(() => analyze(s, undefined, { idealCycleS: { Q: 3 } })).toThrow(/names machine "Q"/);
    expect(() => analyze(s, undefined, { idealCycleS: 0 })).toThrow(/above 0/);
  });

  it('settings validation', () => {
    expect(resolveSettings({})).toMatchObject({ shortStopS: 300, targetPct: null });
    expect(() => resolveSettings({ runStates: ['run'], plannedStates: ['RUN'] })).toThrow(/both a run state/);
    expect(() => resolveSettings({ runStates: [' '] })).toThrow(/at least one run state/);
    expect(() => resolveSettings({ targetPct: 120 })).toThrow(/--target/);
    expect(() => resolveSettings({ shortStopS: -1 })).toThrow(/--short-stop/);
  });
});

describe('analyze: --by-day', () => {
  const s = states(
    '2026-01-01 22:00,A,RUN,\n2026-01-01 23:30,A,DOWN,jam\n2026-01-02 00:30,A,RUN,\n2026-01-02 06:00,A,off,\n2026-01-02 07:00,A,RUN,\n2026-01-02 08:00,A,RUN,\n',
  );
  const c = counts('2026-01-01 23:00,A,100,100\n2026-01-02 00:00,A,50,49\n2026-01-02 01:00,A,60,60\n2026-01-02 08:00,A,10,10\n');

  it('days cut at midnight add up to the window; a count on midnight closes the day before', () => {
    const r = analyze(s, c, { idealCycleS: 30, byDay: true });
    expect(r.days?.map((d) => [d.day, d.from, d.to, d.seconds])).toEqual([
      ['2026-01-01', '2026-01-01 22:00:00', '2026-01-02 00:00:00', 7200],
      ['2026-01-02', '2026-01-02 00:00:00', '2026-01-02 08:00:00', 28800],
    ]);
    const [d1, d2] = r.days ?? [];
    expect(d1.total).toMatchObject({ runS: 5400, downS: 1800, stops: 1, totalParts: 150, goodParts: 149, availabilityPct: 75 });
    // The jam from 23:30 to 00:30 crosses midnight: it counts as a stop in both days.
    expect(d2.total).toMatchObject({ runS: 6.5 * 3600, downS: 1800, plannedStopS: 3600, stops: 1, totalParts: 70 });
    expect(d1.total.runS + d2.total.runS).toBe(r.total.runS);
    expect(d1.total.totalParts + d2.total.totalParts).toBe(r.total.totalParts);
    expect(r.total.stops).toBe(1);
    expect(r.dayStart).toEqual({ time: '00:00', offset: null });
    expect(r.findings).toEqual([]);
  });

  it('--day-start moves the cut; without --by-day there are no days', () => {
    const r = analyze(s, c, { idealCycleS: 30, byDay: true, dayStart: '7:00' });
    expect(r.days?.map((d) => [d.day, d.from, d.to])).toEqual([
      ['2026-01-01', '2026-01-01 22:00:00', '2026-01-02 07:00:00'],
      ['2026-01-02', '2026-01-02 07:00:00', '2026-01-02 08:00:00'],
    ]);
    expect(r.dayStart).toEqual({ time: '07:00', offset: null });
    expect(analyze(s, c, { idealCycleS: 30 }).days).toBeUndefined();
  });

  it('files with offsets: day boundaries use the first row offset unless --day-offset is given', () => {
    const z = parseStates('timestamp,machine,state\n2026-01-01T22:00:00+08:00,A,RUN\n2026-01-02T02:00:00+08:00,A,DOWN\n2026-01-02T04:00:00+08:00,A,RUN\n');
    const own = analyze(z, undefined, { byDay: true });
    expect(own.days?.map((d) => [d.day, d.from, d.to, d.total.runS])).toEqual([
      ['2026-01-01', '2026-01-01 22:00:00+08:00', '2026-01-02 00:00:00+08:00', 7200],
      ['2026-01-02', '2026-01-02 00:00:00+08:00', '2026-01-02 04:00:00+08:00', 7200],
    ]);
    const utc = analyze(z, undefined, { byDay: true, dayOffset: 'Z' });
    expect(utc.days?.map((d) => [d.day, d.from, d.to])).toEqual([['2026-01-01', '2026-01-01 14:00:00+00:00', '2026-01-01 20:00:00+00:00']]);
    expect(utc.dayStart).toEqual({ time: '00:00', offset: 'Z' });
  });

  it('bad day options are input errors', () => {
    expect(() => analyze(s, c, { byDay: true, dayStart: '25:00' })).toThrow(/--day-start "25:00"/);
    expect(() => analyze(s, c, { dayStart: '07:00' })).toThrow(/need --by-day/);
    expect(() => analyze(s, c, { byDay: true, dayOffset: '+08:00' })).toThrow(/only for files whose timestamps carry a zone offset/);
    const z = parseStates('timestamp,state\n2026-01-01T00:00:00Z,RUN\n2026-01-02T00:00:00Z,DOWN\n');
    expect(() => analyze(z, undefined, { byDay: true, dayOffset: '8' })).toThrow(/not a zone offset/);
    expect(() => analyze(z, undefined, { byDay: true, to: '2028-01-01T00:00:00Z' })).toThrow(/at most 400 days/);
  });
});

describe('analyze: --shifts', () => {
  const s = states(
    '2026-01-01 22:00,A,RUN,\n2026-01-01 23:30,A,DOWN,jam\n2026-01-02 00:30,A,RUN,\n2026-01-02 06:00,A,off,\n2026-01-02 07:00,A,RUN,\n2026-01-02 08:00,A,RUN,\n',
  );
  const c = counts('2026-01-01 23:00,A,100,100\n2026-01-02 00:00,A,50,49\n2026-01-02 01:00,A,60,60\n2026-01-02 07:00,A,5,5\n2026-01-02 08:00,A,10,10\n');

  it('cuts the window at each shift start; a count on a shift change closes the shift before', () => {
    const r = analyze(s, c, { idealCycleS: 30, shifts: 'Night=19:00,Day=07:00' });
    expect(r.shifts?.map((x) => [x.shift, x.start, x.end, x.periods, x.seconds])).toEqual([
      ['Day', '07:00', '19:00', 1, 3600],
      ['Night', '19:00', '07:00', 1, 9 * 3600],
    ]);
    const [day, night] = r.shifts ?? [];
    expect(night.total).toMatchObject({ runS: 7 * 3600, downS: 3600, plannedStopS: 3600, stops: 1, totalParts: 215, goodParts: 214 });
    expect(day.total).toMatchObject({ runS: 3600, downS: 0, stops: 0, totalParts: 10, availabilityPct: 100 });
    expect(day.total.runS + night.total.runS).toBe(r.total.runS);
    expect(day.total.totalParts + night.total.totalParts).toBe(r.total.totalParts);
    expect(r.shiftOffset).toBeNull();
    expect(r.days).toBeUndefined();
    expect(r.findings).toEqual([]);
    expect(analyze(s, c, { idealCycleS: 30 }).shifts).toBeUndefined();
  });

  it('sums each shift over every day; shifts that never fall in the window are left out', () => {
    const z = states('2026-01-01 00:00,M,RUN,\n2026-01-02 13:00,M,DOWN,jam\n2026-01-02 15:00,M,RUN,\n2026-01-03 00:00,M,RUN,\n');
    const r = analyze(z, undefined, { shifts: 'A=06:00,B=14:00,C=22:00' });
    expect(r.shifts?.map((x) => [x.shift, x.periods, x.seconds, x.total.downS, x.total.stops])).toEqual([
      ['A', 2, 16 * 3600, 3600, 1],
      ['B', 2, 16 * 3600, 3600, 1],
      ['C', 3, 16 * 3600, 0, 0],
    ]);
    // The jam from 13:00 to 15:00 crosses the 14:00 change: a stop in both A and B, one stop in the machine total.
    expect(r.total.stops).toBe(1);
    const short = analyze(z, undefined, { shifts: 'A=06:00,B=14:00,C=22:00', from: '2026-01-01 07:00', to: '2026-01-01 12:00' });
    expect(short.shifts?.map((x) => [x.shift, x.periods, x.seconds])).toEqual([['A', 1, 5 * 3600]]);
  });

  it('a count right on the window start goes to the first shift', () => {
    const r = analyze(s, c, { idealCycleS: 30, shifts: 'Day=07:00,Night=19:00', from: '2026-01-02 07:00' });
    expect(r.shifts?.map((x) => [x.shift, x.total.totalParts])).toEqual([['Day', 15]]);
  });

  it('files with offsets: shift boundaries use the first row offset unless --day-offset is given', () => {
    const z = parseStates('timestamp,machine,state\n2026-01-01T05:00:00+08:00,A,RUN\n2026-01-01T09:00:00+08:00,A,DOWN\n2026-01-01T11:00:00+08:00,A,RUN\n');
    const own = analyze(z, undefined, { shifts: 'Day=07:00,Night=19:00' });
    expect(own.shiftOffset).toBe('+08:00');
    expect(own.shifts?.map((x) => [x.shift, x.seconds, x.total.runS])).toEqual([
      ['Day', 4 * 3600, 2 * 3600],
      ['Night', 2 * 3600, 2 * 3600],
    ]);
    // In UTC the window is 21:00 .. 03:00, all inside Night (19:00 .. 07:00).
    const utc = analyze(z, undefined, { shifts: 'Day=07:00,Night=19:00', dayOffset: 'Z' });
    expect(utc.shifts?.map((x) => [x.shift, x.seconds])).toEqual([['Night', 6 * 3600]]);
    expect(utc.shiftOffset).toBe('Z');
  });

  it('with --by-day too, both tables add up to the window', () => {
    const r = analyze(s, c, { idealCycleS: 30, byDay: true, shifts: 'Day=07:00,Night=19:00' });
    const sum = (xs: { total: { runS: number; totalParts: number } }[] | undefined) => (xs ?? []).reduce((t, x) => t + x.total.runS + x.total.totalParts, 0);
    expect(sum(r.days)).toBe(r.total.runS + r.total.totalParts);
    expect(sum(r.shifts)).toBe(r.total.runS + r.total.totalParts);
  });

  it('a single shift covers the whole day', () => {
    const r = analyze(s, c, { shifts: 'All day=00:00' });
    expect(r.shifts?.map((x) => [x.shift, x.start, x.end, x.periods, x.seconds])).toEqual([['All day', '00:00', '00:00', 2, 10 * 3600]]);
  });

  it('bad shift options are input errors', () => {
    expect(parseShifts(' B = 14:00 , A=6:00')).toEqual([
      { name: 'A', startMin: 360 },
      { name: 'B', startMin: 840 },
    ]);
    expect(() => parseShifts('07:00')).toThrow(/is not name=HH:MM/);
    expect(() => parseShifts('=07:00')).toThrow(/is not name=HH:MM/);
    expect(() => parseShifts('Day=7')).toThrow(/--shifts start of "Day" "7" is not a time of day/);
    expect(() => parseShifts('Day=07:00,day=19:00')).toThrow(/names shift "day" twice/);
    expect(() => parseShifts('Day=07:00,Late=7:00')).toThrow(/"Day" and "Late" both start at 07:00/);
    expect(() => analyze(s, c, { shifts: 'Day=07:00', dayStart: '07:00' })).toThrow(/need --by-day/);
    expect(() => analyze(s, c, { shifts: 'Day=07:00', dayOffset: '+08:00' })).toThrow(/only for files whose timestamps carry a zone offset/);
    const z = parseStates('timestamp,state\n2026-01-01T00:00:00Z,RUN\n2026-01-02T00:00:00Z,DOWN\n');
    expect(() => analyze(z, undefined, { dayOffset: '+08:00' })).toThrow(/need --by-day/);
    expect(() => analyze(z, undefined, { shifts: 'Day=07:00', to: '2028-01-01T00:00:00Z' })).toThrow(/at most 400 days/);
  });
});
