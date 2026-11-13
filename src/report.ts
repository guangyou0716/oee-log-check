import type { MachineStats, Report } from './analyze.js';
import { formatDuration as dur } from './time.js';

type Row = Omit<MachineStats, 'machine' | 'idealCycleS'>;
const p = (v: number | null) => (v === null ? '-' : `${v}%`);
const partsCell = (r: Report, m: Row) => (r.counts.given ? `${m.totalParts} (${m.goodParts} good)` : '-');

const co = (r: Report) => r.settings.changeoverStates.length > 0;

function heads(r: Report): string[] {
  return [
    'Machine',
    'Planned prod.',
    'Run',
    'Down',
    'Stops',
    ...(co(r) ? ['Changeover', 'C/O'] : []),
    'Planned stop',
    'No data',
    'Avail.',
    'Perf.',
    'Quality',
    'OEE',
    ...(r.counts.given ? ['Parts'] : []),
  ];
}

/** Numeric columns (right-aligned): everything between the name and the parts column. */
const numeric = (r: Report) => (i: number) => i > 0 && i < (co(r) ? 13 : 11);

function cells(r: Report, name: string, m: Row): string[] {
  return [
    name,
    dur(m.plannedProductionS),
    dur(m.runS),
    dur(m.downS),
    String(m.stops),
    ...(co(r) ? [dur(m.changeoverS), String(m.changeovers)] : []),
    dur(m.plannedStopS),
    dur(m.noDataS),
    p(m.availabilityPct),
    p(m.performancePct),
    p(m.qualityPct),
    p(m.oeePct),
    ...(r.counts.given ? [partsCell(r, m)] : []),
  ];
}

function rows(r: Report): string[][] {
  const out = r.machines.map((m) => cells(r, m.machine, m));
  if (r.machines.length > 1) out.push(cells(r, 'All', r.total));
  return out;
}

function dayRows(r: Report): string[][] {
  const out: string[][] = [];
  for (const d of r.days ?? []) {
    if (r.machines.length > 1) {
      for (const m of d.machines) out.push(cells(r, `${d.day} ${m.machine}`, m));
      out.push(cells(r, `${d.day} All`, d.total));
    } else {
      out.push(cells(r, d.day, d.total));
    }
  }
  return out;
}

function dayHeads(r: Report): string[] {
  return [r.machines.length > 1 ? 'Day / machine' : 'Day', ...heads(r).slice(1)];
}

function dayTitle(r: Report): string {
  const ds = r.dayStart;
  return `By day (a day starts at ${ds?.time ?? '00:00'}${ds?.offset ? ` ${ds.offset}` : ''}; a stop across a day start counts in both days)`;
}

function shiftRows(r: Report): string[][] {
  const out: string[][] = [];
  for (const sh of r.shifts ?? []) {
    const label = `${sh.shift} ${sh.start}-${sh.end}`;
    if (r.machines.length > 1) {
      for (const m of sh.machines) out.push(cells(r, `${label} ${m.machine}`, m));
      out.push(cells(r, `${label} All`, sh.total));
    } else {
      out.push(cells(r, label, sh.total));
    }
  }
  return out;
}

function shiftHeads(r: Report): string[] {
  return [r.machines.length > 1 ? 'Shift / machine' : 'Shift', ...heads(r).slice(1)];
}

function shiftTitle(r: Report): string {
  const times = (r.shifts ?? []).map((sh) => `${sh.shift} ${sh.periods}x`).join(', ');
  const off = r.shiftOffset ? ` at ${r.shiftOffset}` : '';
  return `By shift${off} (each shift summed over every day in the window: ${times}; a stop across a shift change counts in both shifts)`;
}

function table(head: string[], body: string[][], right: (i: number) => boolean): string[] {
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const fmt = (cols: string[]) =>
    '  ' +
    cols
      .map((c, i) => (right(i) ? c.padStart(widths[i]) : c.padEnd(widths[i])))
      .join('  ')
      .trimEnd();
  return [fmt(head), ...body.map(fmt)];
}

function header(r: Report): string[] {
  const s = r.settings;
  const st = r.states;
  const list = (xs: string[]) => (xs.length ? xs.join(', ') : 'none seen');
  const withCo = co(r);
  return [
    `Window: ${r.window.from} .. ${r.window.to} (${dur(r.window.seconds)})${r.window.endFromInput ? ', end = latest timestamp in the input' : ''}`,
    `States seen: run = ${list(st.run)}; planned stop = ${list(st.planned)}; ${withCo ? `changeover = ${list(st.changeover)}; ` : ''}downtime = ${list(st.down)}`,
    `  (run states: ${s.runStates.join(', ')}; planned-stop states: ${s.plannedStates.join(', ')}${withCo ? `; changeover states: ${s.changeoverStates.join(', ')}` : ''}; anything else is downtime)`,
  ];
}

function notes(r: Report): string[] {
  const out: string[] = [];
  if (!r.counts.given) out.push('No counts file: availability only (give --counts and --ideal-cycle for performance, quality and OEE).');
  else if (r.machines.some((m) => m.idealCycleS === null)) out.push('No ideal cycle time for some machines: performance and OEE left out for them (--ideal-cycle).');
  if (r.counts.outsideWindow) out.push(`${r.counts.outsideWindow} count row(s) outside the window left out.`);
  const c = r.counts.counter;
  if (c) {
    out.push(
      `Running counters: ${c.readings} reading(s) -> ${r.counts.rows} increment(s); the first reading per machine (${c.baselines}) is the starting point` +
        (c.repeats ? `; ${c.repeats} repeated reading(s) left out` : '') +
        '.',
    );
    if (c.resets.length) {
      const shown = c.resets.slice(0, 5).map((x) => `${x.machine} at ${x.text} (row ${x.line})`);
      const more = c.resets.length > shown.length ? `, and ${c.resets.length - shown.length} more` : '';
      out.push(
        `${c.resets.length} counter reset(s) (a reading went down; taken as parts since the reset, parts between the reading before and the reset are not seen): ${shown.join(', ')}${more}.`,
      );
    }
  }
  return out;
}

const paretoHeads = ['Reason', 'Stops', 'Time', 'Share', 'Cum.', 'Machines'];
const changeoverHeads = ['Reason', 'Changeovers', 'Time', 'Share', 'Cum.', 'Machines'];
const paretoCells = (rows: Report['pareto']) => rows.map((e) => [e.reason, String(e.stops), dur(e.seconds), `${e.sharePct}%`, `${e.cumulativePct}%`, e.machines.join(', ')]);

export function textReport(r: Report): string {
  const lines = [...header(r), ''];
  lines.push(...table(heads(r), rows(r), numeric(r)));
  lines.push('');
  if (r.days) {
    lines.push(`${dayTitle(r)}:`);
    lines.push(...table(dayHeads(r), dayRows(r), numeric(r)));
    lines.push('');
  }
  if (r.shifts) {
    lines.push(`${shiftTitle(r)}:`);
    lines.push(...table(shiftHeads(r), shiftRows(r), numeric(r)));
    lines.push('');
  }
  if (r.pareto.length) {
    lines.push('Downtime by reason (state when there is no reason):');
    lines.push(...table(paretoHeads, paretoCells(r.pareto), (i) => i >= 1 && i <= 4));
    lines.push(`Short stops (< ${dur(r.settings.shortStopS)}): ${r.total.shortStops} stop(s), ${dur(r.total.shortStopS)} (counted as downtime)`);
  } else {
    lines.push('Downtime by reason: no downtime in the window.');
  }
  if (r.changeoverReasons) {
    lines.push('');
    if (r.changeoverReasons.length) {
      lines.push(`Changeover by reason (availability loss, not in downtime or stops): ${r.total.changeovers} changeover(s), ${dur(r.total.changeoverS)}`);
      lines.push(...table(changeoverHeads, paretoCells(r.changeoverReasons), (i) => i >= 1 && i <= 4));
    } else {
      lines.push('Changeover by reason: no changeover in the window.');
    }
  }
  for (const n of notes(r)) lines.push(`Note: ${n}`);
  lines.push('');
  if (r.findings.length) {
    lines.push(`Findings (${r.findings.length}):`);
    for (const f of r.findings) lines.push(`  - ${f.message}`);
  } else {
    lines.push('Findings: none');
  }
  return `${lines.join('\n')}\n`;
}

const md = (cols: string[]) => `| ${cols.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`;
const mdTable = (head: string[], body: string[][]) => [md(head), md(head.map(() => '---')), ...body.map(md)];

export function markdownReport(r: Report): string {
  const lines = ['# OEE report', '', ...header(r).map((h) => `- ${h.trim()}`), '', '## Machines', '', ...mdTable(heads(r), rows(r)), ''];
  if (r.days) lines.push('## By day', '', `${dayTitle(r)}.`, '', ...mdTable(dayHeads(r), dayRows(r)), '');
  if (r.shifts) lines.push('## By shift', '', `${shiftTitle(r)}.`, '', ...mdTable(shiftHeads(r), shiftRows(r)), '');
  lines.push('## Downtime by reason', '');
  if (r.pareto.length) {
    lines.push(...mdTable(paretoHeads, paretoCells(r.pareto)), '');
    lines.push(`Short stops (< ${dur(r.settings.shortStopS)}): ${r.total.shortStops} stop(s), ${dur(r.total.shortStopS)} (counted as downtime)`, '');
  } else {
    lines.push('No downtime in the window.', '');
  }
  if (r.changeoverReasons) {
    lines.push('## Changeover by reason', '');
    if (r.changeoverReasons.length) {
      lines.push(`Availability loss, not in downtime or stops: ${r.total.changeovers} changeover(s), ${dur(r.total.changeoverS)}.`, '');
      lines.push(...mdTable(changeoverHeads, paretoCells(r.changeoverReasons)), '');
    } else {
      lines.push('No changeover in the window.', '');
    }
  }
  for (const n of notes(r)) lines.push(`> ${n}`, '');
  lines.push('## Findings', '');
  lines.push(...(r.findings.length ? r.findings.map((f) => `- ${f.message}`) : ['None.']));
  return `${lines.join('\n')}\n`;
}

export function jsonReport(r: Report): string {
  return `${JSON.stringify(r, null, 2)}\n`;
}
