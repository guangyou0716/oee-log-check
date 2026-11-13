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
  total: Omit<MachineStats, 'machine' | 'idealCycleS'>;
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
    const ms: Record<StateClass, number> = { run: 0, planned: 0, down: 0 };
    let stops = 0;
    let shortStops = 0;
    let shortMs = 0;
    for (let i = 0; i < list.length; i++) {
      const row = list[i];
      const start = Math.max(row.time, from);
      const end = Math.min(i + 1 < list.length ? list[i + 1].time : to, to);
      if (end <= start) continue;
      const cls = classOf(row.state);
      const key = row.state.toLowerCase();
      if (!seen[cls].has(key)) seen[cls].set(key, row.state);
      ms[cls] += end - start;
      if (cls === 'down') {
        stops++;
        if ((end - start) / 1000 < settings.shortStopS) {
          shortStops++;
          shortMs += end - start;
        }
        const reason = row.reason || row.state;
        const pk = reason.toLowerCase();
        const entry = pareto.get(pk) ?? { reason, stops: 0, ms: 0, machines: new Set<string>() };
        entry.stops++;
        entry.ms += end - start;
        entry.machines.add(machine);
        pareto.set(pk, entry);
      }
    }
    const noDataMs = to - from - ms.run - ms.planned - ms.down;
    const prod = ms.run + ms.down;
    const p = parts.get(machine) ?? { total: 0, good: 0, beforeFirst: 0 };
    const cycle = ideal.get(machine) ?? null;
    const availabilityPct = pct(ms.run, prod);
    const performancePct = counts && cycle !== null && ms.run > 0 ? pct(cycle * p.total * 1000, ms.run) : null;
    const qualityPct = counts ? pct(p.good, p.total) : null;
    // OEE = A x P x Q = ideal cycle x good parts / planned production time (from unrounded values).
    const oeePct =
      availabilityPct !== null && performancePct !== null && qualityPct !== null && cycle !== null ? pct(cycle * p.good * 1000, prod) : null;
    machines.push({
      machine,
      plannedProductionS: sec(prod),
      runS: sec(ms.run),
      downS: sec(ms.down),
      plannedStopS: sec(ms.planned),
      noDataS: sec(noDataMs),
      stops,
      shortStops,
      shortStopS: sec(shortMs),
      idealCycleS: cycle,
      totalParts: p.total,
      goodParts: p.good,
      availabilityPct,
      performancePct,
      qualityPct,
      oeePct,
    });
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

  // Total: sums of times and parts; performance only when every machine with run time has an ideal cycle.
  const sum = (f: (m: MachineStats) => number) => machines.reduce((t, m) => t + f(m), 0);
  const runS = sum((m) => m.runS);
  const prodS = sum((m) => m.plannedProductionS);
  const totalParts = sum((m) => m.totalParts);
  const goodParts = sum((m) => m.goodParts);
  const allIdeal = machines.every((m) => m.idealCycleS !== null || m.runS === 0);
  const availabilityPct = pct(runS, prodS);
  const performancePct = counts && allIdeal && runS > 0 ? pct(sum((m) => (m.idealCycleS ?? 0) * m.totalParts), runS) : null;
  const qualityPct = counts ? pct(goodParts, totalParts) : null;
  const oeePct =
    availabilityPct !== null && performancePct !== null && qualityPct !== null
      ? pct(sum((m) => (m.idealCycleS ?? 0) * m.goodParts), prodS)
      : null;
  const round3 = (x: number) => Math.round(x * 1000) / 1000;
  const total = {
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
  if (machines.length > 1 && settings.targetPct !== null && oeePct !== null && oeePct < settings.targetPct) {
    findings.push({ kind: 'below-target', machine: null, message: `All machines: OEE ${oeePct}% is below the ${settings.targetPct}% target.` });
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
    pareto: paretoRows,
    counts: { given: counts !== undefined, rows: countRows.length, outsideWindow, unknownMachine },
    findings,
  };
}
