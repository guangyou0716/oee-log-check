import { parseCsv } from './csv.js';
import { InputError } from './errors.js';
import { parseTimestamp } from './time.js';

/** Machine name used when a file has no machine column. */
export const SINGLE_MACHINE = 'machine';

/** One state change: from `time` on, `machine` is in `state` until its next row. */
export interface StateRow {
  machine: string;
  /** Epoch ms (naive timestamps read as if UTC; only differences and order matter). */
  time: number;
  /** Timestamp exactly as written. */
  text: string;
  state: string;
  reason: string;
  /** 1-based line number in the file (header = line 1). */
  line: number;
}

/** Parts counted at `time` (an increment, not a running counter). */
export interface CountRow {
  machine: string;
  time: number;
  text: string;
  total: number;
  good: number;
  line: number;
}

export interface StateLog {
  rows: StateRow[];
  /** Whether the file had a machine column. */
  hasMachine: boolean;
  /** Whether the timestamps carry a zone (all do, or none do). */
  zoned: boolean;
}

/** A running-counter reading that went down (reject counter included): the counter was reset. */
export interface CounterReset {
  machine: string;
  /** Timestamp of the reading after the reset, as written. */
  text: string;
  line: number;
}

/** How running-counter readings were turned into increments (only with the counter option). */
export interface CounterInfo {
  /** Readings in the file. */
  readings: number;
  /** First reading per machine: the starting point, gives no parts itself. */
  baselines: number;
  /** Repeated readings (same machine, same time, same values) left out. */
  repeats: number;
  resets: CounterReset[];
}

export interface CountLog {
  /** Increments (with the counter option: worked out from the readings, stamped at the later reading). */
  rows: CountRow[];
  hasMachine: boolean;
  zoned: boolean | undefined;
  counter?: CounterInfo;
}

export interface StateOptions {
  timeColumn?: string;
  machineColumn?: string;
  stateColumn?: string;
  reasonColumn?: string;
}

export interface CountOptions {
  timeColumn?: string;
  machineColumn?: string;
  totalColumn?: string;
  goodColumn?: string;
  rejectColumn?: string;
  /** Rows are running-counter readings (totals so far), not increments; resets are found and handled. */
  counter?: boolean;
}

function header(rows: string[][], what: string): Map<string, number> {
  if (rows.length === 0) {
    throw new InputError(`${what}: the file is empty.`);
  }
  const map = new Map<string, number>();
  rows[0].forEach((name, i) => {
    const key = name.trim().toLowerCase();
    if (key !== '') {
      if (map.has(key)) {
        throw new InputError(`${what}: column "${name.trim()}" appears twice in the header.`);
      }
      map.set(key, i);
    }
  });
  return map;
}

function column(map: Map<string, number>, name: string, what: string, flag: string): number {
  const i = map.get(name.trim().toLowerCase());
  if (i === undefined) {
    throw new InputError(`${what}: no "${name}" column in the header (set it with ${flag}).`);
  }
  return i;
}

function timestamp(text: string, what: string, line: number, zoned: { value?: boolean }): number {
  const t = parseTimestamp(text);
  if (!t) {
    throw new InputError(`${what} row ${line}: timestamp "${text}" is not ISO 8601 (for example 2026-11-12 14:05:00).`);
  }
  if (zoned.value === undefined) {
    zoned.value = t.zoned;
  } else if (zoned.value !== t.zoned) {
    throw new InputError(`${what} row ${line}: mix of timestamps with and without a zone offset; use one style in all files.`);
  }
  return t.ms;
}

function cell(row: string[], i: number): string {
  return (row[i] ?? '').trim();
}

/** Reads the state-change CSV. Throws InputError with the row number on any problem. */
export function parseStates(text: string, options: StateOptions = {}): StateLog {
  const what = 'States';
  const rows = parseCsv(text);
  const map = header(rows, what);
  const ti = column(map, options.timeColumn ?? 'timestamp', what, '--time-column');
  const si = column(map, options.stateColumn ?? 'state', what, '--state-column');
  const mi = options.machineColumn !== undefined ? column(map, options.machineColumn, what, '--machine-column') : map.get('machine');
  const ri = options.reasonColumn !== undefined ? column(map, options.reasonColumn, what, '--reason-column') : map.get('reason');
  const zoned: { value?: boolean } = {};
  const out: StateRow[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const line = r + 1;
    const machine = mi === undefined ? SINGLE_MACHINE : cell(row, mi);
    if (machine === '') {
      throw new InputError(`${what} row ${line}: empty machine.`);
    }
    const state = cell(row, si);
    if (state === '') {
      throw new InputError(`${what} row ${line}: empty state.`);
    }
    const text = cell(row, ti);
    out.push({ machine, time: timestamp(text, what, line, zoned), text, state, reason: ri === undefined ? '' : cell(row, ri), line });
  }
  if (out.length === 0) {
    throw new InputError(`${what}: no data rows.`);
  }
  return { rows: out, hasMachine: mi !== undefined, zoned: zoned.value ?? false };
}

function count(text: string, what: string, name: string, line: number): number {
  if (!/^\d+$/.test(text)) {
    throw new InputError(`${what} row ${line}: ${name} "${text}" is not a whole number of parts (0 or more).`);
  }
  return Number(text);
}

/** Reads the part-count CSV (increments per row). Needs good or reject; total may be left out when both are there. */
export function parseCounts(text: string, options: CountOptions = {}): CountLog {
  const what = 'Counts';
  const rows = parseCsv(text);
  const map = header(rows, what);
  const ti = column(map, options.timeColumn ?? 'timestamp', what, '--counts-time-column');
  const mi = options.machineColumn !== undefined ? column(map, options.machineColumn, what, '--counts-machine-column') : map.get('machine');
  const pick = (given: string | undefined, fallback: string, flag: string) =>
    given !== undefined ? column(map, given, what, flag) : map.get(fallback);
  const toti = pick(options.totalColumn, 'total', '--total-column');
  const gi = pick(options.goodColumn, 'good', '--good-column');
  const rji = pick(options.rejectColumn, 'reject', '--reject-column');
  if (gi === undefined && rji === undefined) {
    throw new InputError(`${what}: needs a "good" or a "reject" column (set with --good-column or --reject-column).`);
  }
  if (toti === undefined && (gi === undefined || rji === undefined)) {
    throw new InputError(`${what}: needs a "total" column, or both "good" and "reject".`);
  }
  const zoned: { value?: boolean } = {};
  const out: CountRow[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const line = r + 1;
    const machine = mi === undefined ? SINGLE_MACHINE : cell(row, mi);
    if (machine === '') {
      throw new InputError(`${what} row ${line}: empty machine.`);
    }
    const good = gi === undefined ? undefined : count(cell(row, gi), what, 'good', line);
    const reject = rji === undefined ? undefined : count(cell(row, rji), what, 'reject', line);
    let total = toti === undefined ? undefined : count(cell(row, toti), what, 'total', line);
    if (total === undefined) {
      total = (good ?? 0) + (reject ?? 0);
    }
    if (good !== undefined && good > total) {
      throw new InputError(`${what} row ${line}: good ${good} is more than total ${total}.`);
    }
    if (reject !== undefined && reject > total) {
      throw new InputError(`${what} row ${line}: reject ${reject} is more than total ${total}.`);
    }
    if (good !== undefined && reject !== undefined && good + reject !== total) {
      throw new InputError(`${what} row ${line}: good ${good} + reject ${reject} is not total ${total}.`);
    }
    const text = cell(row, ti);
    out.push({ machine, time: timestamp(text, what, line, zoned), text, total, good: good ?? total - (reject as number), line });
  }
  const base = { hasMachine: mi !== undefined, zoned: zoned.value };
  if (!options.counter) {
    return { rows: out, ...base };
  }
  const { rows: increments, counter } = counterIncrements(out);
  return { rows: increments, ...base, counter };
}

/**
 * Turns running-counter readings into increments, per machine in time order (file order is not needed).
 * The first reading of a machine is its starting point. A reading where total, good or reject went down is a reset:
 * the counter restarted from zero, so that reading itself is the parts made since the reset (parts between the
 * previous reading and the reset are not seen). Two readings of one machine at the same time must be equal.
 */
export function counterIncrements(readings: CountRow[]): { rows: CountRow[]; counter: CounterInfo } {
  const byMachine = new Map<string, CountRow[]>();
  for (const r of readings) {
    const list = byMachine.get(r.machine);
    if (list) list.push(r);
    else byMachine.set(r.machine, [r]);
  }
  const rows: CountRow[] = [];
  const counter: CounterInfo = { readings: readings.length, baselines: 0, repeats: 0, resets: [] };
  for (const list of byMachine.values()) {
    list.sort((a, b) => a.time - b.time || a.line - b.line);
    counter.baselines++;
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      if (cur.time === prev.time) {
        if (cur.total !== prev.total || cur.good !== prev.good) {
          throw new InputError(
            `Counts row ${cur.line}: machine ${cur.machine} has two different counter readings at ${cur.text} (rows ${prev.line} and ${cur.line}).`,
          );
        }
        counter.repeats++;
        continue;
      }
      const total = cur.total - prev.total;
      const good = cur.good - prev.good;
      if (total < 0 || good < 0 || good > total) {
        counter.resets.push({ machine: cur.machine, text: cur.text, line: cur.line });
        rows.push({ ...cur });
      } else {
        rows.push({ ...cur, total, good });
      }
    }
  }
  rows.sort((a, b) => a.time - b.time || a.line - b.line);
  return { rows, counter };
}
