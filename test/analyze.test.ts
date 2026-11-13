import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyze, resolveSettings } from '../src/analyze.js';
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
