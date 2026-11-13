import { InputError } from './errors.js';
import type { CountLog, StateLog, StateRow } from './input.js';
import { parseTimestamp } from './time.js';

export type StateClass = 'run' | 'planned' | 'down';

export interface Settings {
  /** States that count as running (matched without case). */
  runStates?: string[];
  /** States that count as planned stops (not in planned production time). */
  plannedStates?: string[];
  /** Ideal cycle time in seconds per part: one value for every machine, or per machine. */
  idealCycleS?: number | Record<string, number>;
  /** Window start / end, ISO 8601 (same zone style as the files). */
  from?: string;
  to?: string;
  /** Stops shorter than this many seconds are counted as short stops (default 300). */
  shortStopS?: number;
  /** OEE target in percent: machines (and the total) below it are findings. */
  targetPct?: number;
  /** Also split the window into days (report.days). */
  byDay?: boolean;
  /** Time of day a day starts, HH:MM (default 00:00), e.g. 07:00 when the first shift starts at 7. */
  dayStart?: string;
  /** Zone offset for day boundaries when the files carry offsets (default: the first state row's offset). */
  dayOffset?: string;
}

export interface ResolvedSettings {
  runStates: string[];
  plannedStates: string[];
  shortStopS: number;
  targetPct: number | null;
}

export interface MachineStats {
  machine: string;
  /** Planned production time = run + downtime (window minus planned stops and time with no data). */
  plannedProductionS: number;
  runS: number;
  downS: number;
  plannedStopS: number;
  /** Time in the window before the machine's first state row (or with no rows at all). */
  noDataS: number;
  stops: number;
  shortStops: number;
  shortStopS: number;
  idealCycleS: number | null;
  totalParts: number;
  goodParts: number;
  /** Percentages rounded to 2 decimals; null when they cannot be worked out. */
  availabilityPct: number | null;
  performancePct: number | null;
  qualityPct: number | null;
  oeePct: number | null;
}

export type TotalStats = Omit<MachineStats, 'machine' | 'idealCycleS'>;

export interface DayStats {
  /** Date the day starts on (YYYY-MM-DD, wall clock). */
  day: string;
  from: string;
  to: string;
  seconds: number;
  machines: MachineStats[];
  total: TotalStats;
}

export interface ParetoRow {
  reason: string;
  stops: number;
  seconds: number;
  sharePct: number;
  cumulativePct: number;
  machines: string[];
}

export interface Finding {
  kind: 'below-target' | 'performance-over-100' | 'parts-without-run-time' | 'counts-without-states' | 'counts-before-first-state';
  machine: string | null;
  message: string;
}

export interface Report {
  settings: ResolvedSettings;
  window: { from: string; to: string; seconds: number; endFromInput: boolean };
  /** Distinct state names seen, by class (as written, first spelling kept). */
  states: Record<StateClass, string[]>;
  machines: MachineStats[];
  total: TotalStats;
  /** Per day, only with byDay. Day tables raise no findings of their own. */
  days?: DayStats[];
  /** With byDay: day start time and the offset used for day boundaries (null for files without offsets). */
  dayStart?: { time: string; offset: string | null };
  pareto: ParetoRow[];
  counts: { given: boolean; rows: number; outsideWindow: number; unknownMachine: number };
  findings: Finding[];
}

const DEFAULT_RUN = ['run', 'running', 'production'];
const DEFAULT_PLANNED = ['planned', 'break', 'off', 'no_order', 'holiday'];

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 10000) / 100 : null);
const sec = (ms: number) => Math.round(ms) / 1000;

function boundary(text: string, flag: string, zoned: boolean): number {
  const t = parseTimestamp(text);
  if (!t) {
    throw new InputError(`${flag} "${text}" is not ISO 8601 (for example 2026-11-12 08:00).`);
  }
  if (t.zoned !== zoned) {
    throw new InputError(`${flag} must ${zoned ? 'carry' : 'not carry'} a zone offset, like the timestamps in the files.`);
  }
  return t.ms;
}

export function resolveSettings(s: Settings): ResolvedSettings {
  const norm = (list: string[] | undefined, fallback: string[]) => (list ?? fallback).map((x) => x.trim().toLowerCase()).filter((x) => x !== '');
  const runStates = norm(s.runStates, DEFAULT_RUN);
  const plannedStates = norm(s.plannedStates, DEFAULT_PLANNED);
  if (runStates.length === 0) {
    throw new InputError('Give at least one run state.');
  }
  const both = runStates.find((x) => plannedStates.includes(x));
  if (both) {
    throw new InputError(`State "${both}" is both a run state and a planned-stop state.`);
  }
  const shortStopS = s.shortStopS ?? 300;
  if (!(shortStopS >= 0)) {
    throw new InputError('--short-stop must be 0 or more seconds.');
  }
  if (s.targetPct !== undefined && !(s.targetPct > 0 && s.targetPct <= 100)) {
    throw new InputError('--target must be above 0 and at most 100 (percent).');
  }
  return { runStates, plannedStates, shortStopS, targetPct: s.targetPct ?? null };
}


interface Walk {
  ms: Record<StateClass, number>;
  stops: number;
  shortStops: number;
  shortMs: number;
}

/** Index of the last row starting at or before t (0 when every row starts later); rows are sorted by time. */
function firstIndex(list: StateRow[], t: number): number {
  let lo = 0;
  let hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (list[mid].time <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Adds up one machine's state time inside [from, to); each state lasts until the next row. */
function walk(
  list: StateRow[],
  from: number,
  to: number,
  classOf: (state: string) => StateClass,
  shortStopS: number,
  onSegment?: (row: StateRow, cls: StateClass, ms: number) => void,
): Walk {
  const ms: Record<StateClass, number> = { run: 0, planned: 0, down: 0 };
  let stops = 0;
  let shortStops = 0;
  let shortMs = 0;
  for (let i = firstIndex(list, from); i < list.length && list[i].time < to; i++) {
    const row = list[i];
    const start = Math.max(row.time, from);
    const end = Math.min(i + 1 < list.length ? list[i + 1].time : to, to);
    if (end <= start) continue;
    const cls = classOf(row.state);
    ms[cls] += end - start;
    if (cls === 'down') {
      stops++;
      if ((end - start) / 1000 < shortStopS) {
        shortStops++;
        shortMs += end - start;
      }
    }
    onSegment?.(row, cls, end - start);
  }
  return { ms, stops, shortStops, shortMs };
}

function machineStats(
  machine: string,
  w: Walk,
  windowMs: number,
  p: { total: number; good: number },
  cycle: number | null,
  countsGiven: boolean,
): MachineStats {
  const { ms } = w;
  const noDataMs = windowMs - ms.run - ms.planned - ms.down;
  const prod = ms.run + ms.down;
  const availabilityPct = pct(ms.run, prod);
  const performancePct = countsGiven && cycle !== null && ms.run > 0 ? pct(cycle * p.total * 1000, ms.run) : null;
  const qualityPct = countsGiven ? pct(p.good, p.total) : null;
  // OEE = A x P x Q = ideal cycle x good parts / planned production time (from unrounded values).
  const oeePct =
    availabilityPct !== null && performancePct !== null && qualityPct !== null && cycle !== null ? pct(cycle * p.good * 1000, prod) : null;
  return {
    machine,
    plannedProductionS: sec(prod),
    runS: sec(ms.run),
    downS: sec(ms.down),
    plannedStopS: sec(ms.planned),
    noDataS: sec(noDataMs),
    stops: w.stops,
    shortStops: w.shortStops,
    shortStopS: sec(w.shortMs),
    idealCycleS: cycle,
    totalParts: p.total,
    goodParts: p.good,
    availabilityPct,
    performancePct,
    qualityPct,
    oeePct,
  };
}

/** Total: sums of times and parts; performance only when every machine with run time has an ideal cycle. */
function totalOf(machines: MachineStats[], countsGiven: boolean): TotalStats {
  const sum = (f: (m: MachineStats) => number) => machines.reduce((t, m) => t + f(m), 0);
  const runS = sum((m) => m.runS);
  const prodS = sum((m) => m.plannedProductionS);
  const totalParts = sum((m) => m.totalParts);
  const goodParts = sum((m) => m.goodParts);
  const allIdeal = machines.every((m) => m.idealCycleS !== null || m.runS === 0);
  const availabilityPct = pct(runS, prodS);
  const performancePct = countsGiven && allIdeal && runS > 0 ? pct(sum((m) => (m.idealCycleS ?? 0) * m.totalParts), runS) : null;
  const qualityPct = countsGiven ? pct(goodParts, totalParts) : null;
  const oeePct =
    availabilityPct !== null && performancePct !== null && qualityPct !== null
      ? pct(sum((m) => (m.idealCycleS ?? 0) * m.goodParts), prodS)
      : null;
  const round3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    plannedProductionS: round3(prodS),
    runS: round3(runS),
    downS: round3(sum((m) => m.downS)),
    plannedStopS: round3(sum((m) => m.plannedStopS)),
    noDataS: round3(sum((m) => m.noDataS)),
    stops: sum((m) => m.stops),
    shortStops: sum((m) => m.shortStops),
    shortStopS: round3(sum((m) => m.shortStopS)),
    totalParts,
    goodParts,
    availabilityPct,
    performancePct,
    qualityPct,
    oeePct,
  };
}

const DAY_MS = 86_400_000;
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** "+08:00" -> minutes east of UTC. */
function offsetMinutes(text: string, flag: string): number {
  const m = /^(Z)$|^([+-])(\d{2}):?(\d{2})$/.exec(text.trim());
  if (!m || (m[3] !== undefined && (Number(m[3]) > 23 || Number(m[4]) > 59))) {
    throw new InputError(`${flag} "${text}" is not a zone offset like +08:00.`);
  }
  return m[1] ? 0 : (m[2] === '-' ? -1 : 1) * (Number(m[3]) * 60 + Number(m[4]));
}

/** Wall-clock text for epoch ms shifted by the offset: "2026-11-12 07:00:00" (+ ".250" when there are ms). */
function wallText(ms: number, offsetMin: number, zoned: boolean): string {
  const d = new Date(ms + offsetMin * 60_000);
  const frac = d.getUTCMilliseconds() ? `.${pad(d.getUTCMilliseconds(), 3)}` : '';
  const base = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${frac}`;
  if (!zoned) return base;
  const a = Math.abs(offsetMin);
  return `${base}${offsetMin < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** Works out availability, performance, quality and OEE per machine and in total, plus the downtime Pareto. */
export function analyze(states: StateLog, counts: CountLog | undefined, s: Settings = {}): Report {
  const settings = resolveSettings(s);
  const classOf = (state: string): StateClass => {
    const key = state.toLowerCase();
    return settings.runStates.includes(key) ? 'run' : settings.plannedStates.includes(key) ? 'planned' : 'down';
  };

  if (counts && counts.zoned !== undefined && counts.zoned !== states.zoned) {
    throw new InputError('States and counts mix timestamps with and without a zone offset; use one style in both files.');
  }

  // Group by machine in order of first appearance; same machine + same timestamp is ambiguous.
  const byMachine = new Map<string, StateRow[]>();
  for (const row of states.rows) {
    const list = byMachine.get(row.machine) ?? [];
    list.push(row);
    byMachine.set(row.machine, list);
  }
  for (const [machine, list] of byMachine) {
    list.sort((a, b) => a.time - b.time || a.line - b.line);
    for (let i = 1; i < list.length; i++) {
      if (list[i].time === list[i - 1].time) {
        throw new InputError(`States rows ${list[i - 1].line} and ${list[i].line}: machine "${machine}" has two states at ${list[i].text}.`);
      }
    }
  }
  const machineNames = [...byMachine.keys()];

  let countRows = counts?.rows ?? [];
  if (counts && counts.hasMachine !== states.hasMachine) {
    if (!counts.hasMachine && machineNames.length === 1) {
      countRows = countRows.map((c) => ({ ...c, machine: machineNames[0] }));
    } else if (!counts.hasMachine) {
      throw new InputError('Counts has no machine column but the states file has several machines.');
    } else {
      throw new InputError('Counts has a machine column but the states file has none; add one to the states file.');
    }
  }

  // Ideal cycle per machine.
  const ideal = new Map<string, number>();
  if (typeof s.idealCycleS === 'number') {
    if (!(s.idealCycleS > 0)) throw new InputError('--ideal-cycle must be above 0 seconds.');
    for (const m of machineNames) ideal.set(m, s.idealCycleS);
  } else if (s.idealCycleS) {
    for (const [m, v] of Object.entries(s.idealCycleS)) {
      if (!byMachine.has(m)) throw new InputError(`--ideal-cycle names machine "${m}", which is not in the states file.`);
      if (!(v > 0)) throw new InputError(`--ideal-cycle for "${m}" must be above 0 seconds.`);
      ideal.set(m, v);
    }
  }

  // Window.
  const firstRow = states.rows.reduce((a, b) => (b.time < a.time ? b : a));
  const lastStamp = [...states.rows, ...countRows].reduce((a, b) => (b.time > a.time ? b : a));
  const from = s.from !== undefined ? boundary(s.from, '--from', states.zoned) : firstRow.time;
  const to = s.to !== undefined ? boundary(s.to, '--to', states.zoned) : lastStamp.time;
  if (!(to > from)) {
    throw new InputError('The window is empty: the end must be after the start (check --from / --to, or the file has one timestamp).');
  }
  const window = {
    from: s.from ?? firstRow.text,
    to: s.to ?? lastStamp.text,
    seconds: sec(to - from),
    endFromInput: s.to === undefined,
  };

  const seen: Record<StateClass, Map<string, string>> = { run: new Map(), planned: new Map(), down: new Map() };
  const pareto = new Map<string, { reason: string; stops: number; ms: number; machines: Set<string> }>();
  const findings: Finding[] = [];
  const machines: MachineStats[] = [];

  // Counts per machine inside the window [from, to] (both edges kept: a count stamped at the end of its interval).
  const parts = new Map<string, { total: number; good: number; beforeFirst: number }>();
  let outsideWindow = 0;
  let unknownMachine = 0;
  const unknown = new Map<string, number>();
  for (const c of countRows) {
    if (c.time < from || c.time > to) {
      outsideWindow++;
      continue;
    }
    const list = byMachine.get(c.machine);
    if (!list) {
      unknownMachine++;
      unknown.set(c.machine, (unknown.get(c.machine) ?? 0) + c.total);
      continue;
    }
    const p = parts.get(c.machine) ?? { total: 0, good: 0, beforeFirst: 0 };
    p.total += c.total;
    p.good += c.good;
    if (c.time < list[0].time) p.beforeFirst += c.total;
    parts.set(c.machine, p);
  }
  for (const [m, n] of unknown) {
    findings.push({ kind: 'counts-without-states', machine: m, message: `${m}: ${n} part(s) counted, but the machine has no state rows (left out).` });
  }

  for (const machine of machineNames) {
    const list = byMachine.get(machine) as StateRow[];
    const w = walk(list, from, to, classOf, settings.shortStopS, (row, cls, len) => {
      const key = row.state.toLowerCase();
      if (!seen[cls].has(key)) seen[cls].set(key, row.state);
      if (cls === 'down') {
        const reason = row.reason || row.state;
        const pk = reason.toLowerCase();
        const entry = pareto.get(pk) ?? { reason, stops: 0, ms: 0, machines: new Set<string>() };
        entry.stops++;
        entry.ms += len;
        entry.machines.add(machine);
        pareto.set(pk, entry);
      }
    });
    const ms = w.ms;
    const p = parts.get(machine) ?? { total: 0, good: 0, beforeFirst: 0 };
    const cycle = ideal.get(machine) ?? null;
    const stats = machineStats(machine, w, to - from, p, cycle, counts !== undefined);
    const { performancePct, oeePct } = stats;
    machines.push(stats);
    if (p.beforeFirst > 0) {
      findings.push({
        kind: 'counts-before-first-state',
        machine,
        message: `${machine}: ${p.beforeFirst} part(s) counted before its first state row (${list[0].text}).`,
      });
    }
    if (p.total > 0 && ms.run === 0) {
      findings.push({ kind: 'parts-without-run-time', machine, message: `${machine}: ${p.total} part(s) counted but no run time in the window.` });
    }
    if (performancePct !== null && performancePct > 100) {
      findings.push({
        kind: 'performance-over-100',
        machine,
        message: `${machine}: performance ${performancePct}% is over 100%: check the ideal cycle time (${cycle} s) or the counts.`,
      });
    }
    if (settings.targetPct !== null && oeePct !== null && oeePct < settings.targetPct) {
      findings.push({ kind: 'below-target', machine, message: `${machine}: OEE ${oeePct}% is below the ${settings.targetPct}% target.` });
    }
  }

  const total = totalOf(machines, counts !== undefined);
  const oeePct = total.oeePct;
  if (machines.length > 1 && settings.targetPct !== null && oeePct !== null && oeePct < settings.targetPct) {
    findings.push({ kind: 'below-target', machine: null, message: `All machines: OEE ${oeePct}% is below the ${settings.targetPct}% target.` });
  }

  // Per-day tables: [from, to) cut at each day start; a count stamped exactly on a day start belongs to the day before
  // (it closes that day's last interval), so the days add up to the window.
  let days: DayStats[] | undefined;
  let dayStart: Report['dayStart'];
  if (s.byDay) {
    const dm = /^(\d{1,2}):(\d{2})$/.exec((s.dayStart ?? '00:00').trim());
    if (!dm || Number(dm[1]) > 23 || Number(dm[2]) > 59) {
      throw new InputError(`--day-start "${s.dayStart}" is not a time of day like 07:00.`);
    }
    const startMin = Number(dm[1]) * 60 + Number(dm[2]);
    let offsetMin = 0;
    let offsetText: string | null = null;
    if (states.zoned) {
      const own = /(Z|[+-]\d{2}:?\d{2})$/.exec(firstRow.text.trim());
      offsetText = s.dayOffset ?? (own ? own[1] : 'Z');
      offsetMin = offsetMinutes(offsetText, '--day-offset');
    } else if (s.dayOffset !== undefined) {
      throw new InputError('--day-offset is only for files whose timestamps carry a zone offset.');
    }
    // Wall clock is epoch ms + offset; the first day start at or before `from`.
    const shift = offsetMin * 60_000 - startMin * 60_000;
    const first = Math.floor((from + shift) / DAY_MS) * DAY_MS - shift;
    const count = Math.ceil((to - first) / DAY_MS);
    if (count > 400) {
      throw new InputError(`--by-day would give ${count} days; narrow the window with --from / --to (at most 400 days).`);
    }
    const edges = Array.from({ length: count + 1 }, (_, i) => Math.min(Math.max(first + i * DAY_MS, from), to));
    const dayParts = Array.from({ length: count }, () => new Map<string, { total: number; good: number }>());
    for (const c of countRows) {
      if (c.time < from || c.time > to || !byMachine.has(c.machine)) continue;
      // Day i holds (edges[i], edges[i + 1]]; a count right on `from` goes to the first day.
      let i = Math.ceil((c.time - first) / DAY_MS) - 1;
      if (i < 0) i = 0;
      const m = dayParts[i].get(c.machine) ?? { total: 0, good: 0 };
      m.total += c.total;
      m.good += c.good;
      dayParts[i].set(c.machine, m);
    }
    days = [];
    for (let i = 0; i < count; i++) {
      const a = edges[i];
      const b = edges[i + 1];
      const dayMachines = machineNames.map((machine) =>
        machineStats(
          machine,
          walk(byMachine.get(machine) as StateRow[], a, b, classOf, settings.shortStopS),
          b - a,
          dayParts[i].get(machine) ?? { total: 0, good: 0 },
          ideal.get(machine) ?? null,
          counts !== undefined,
        ),
      );
      days.push({
        day: wallText(first + i * DAY_MS, offsetMin, false).slice(0, 10),
        from: wallText(a, offsetMin, states.zoned),
        to: wallText(b, offsetMin, states.zoned),
        seconds: sec(b - a),
        machines: dayMachines,
        total: totalOf(dayMachines, counts !== undefined),
      });
    }
    dayStart = { time: `${pad(Math.floor(startMin / 60))}:${dm[2]}`, offset: offsetText };
  } else if (s.dayStart !== undefined || s.dayOffset !== undefined) {
    throw new InputError('--day-start and --day-offset need --by-day.');
  }

  const downMs = [...pareto.values()].reduce((t, e) => t + e.ms, 0);
  let cumulative = 0;
  const paretoRows = [...pareto.values()]
    .sort((a, b) => b.ms - a.ms || b.stops - a.stops || a.reason.localeCompare(b.reason))
    .map((e) => {
      cumulative += e.ms;
      return {
        reason: e.reason,
        stops: e.stops,
        seconds: sec(e.ms),
        sharePct: pct(e.ms, downMs) ?? 0,
        cumulativePct: pct(cumulative, downMs) ?? 0,
        machines: [...e.machines],
      };
    });

  return {
    settings,
    window,
    states: { run: [...seen.run.values()], planned: [...seen.planned.values()], down: [...seen.down.values()] },
    machines,
    total,
    ...(days ? { days, dayStart } : {}),
    pareto: paretoRows,
    counts: { given: counts !== undefined, rows: countRows.length, outsideWindow, unknownMachine },
    findings,
  };
}
