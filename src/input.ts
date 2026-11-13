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

export interface CountLog {
  rows: CountRow[];
  hasMachine: boolean;
  zoned: boolean | undefined;
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
  return { rows: out, hasMachine: mi !== undefined, zoned: zoned.value };
}
