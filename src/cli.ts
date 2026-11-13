#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { analyze } from './analyze.js';
import { InputError } from './errors.js';
import { parseCounts, parseStates } from './input.js';
import { jsonReport, markdownReport, textReport } from './report.js';

const USAGE = `Usage: oee-log-check <states.csv> [--counts <counts.csv> --ideal-cycle <s>] [options]

OEE (availability x performance x quality) per machine and in total, and the downtime Pareto by reason, from a
machine state-change log and an optional part-count log. Offline; reads local files only.

states.csv: header "timestamp,machine,state,reason" (machine and reason optional). Each row starts a state that
lasts until the same machine's next row; the last row lasts until --to, or else the latest timestamp in the input.
Rows need not be sorted. Timestamps ISO 8601 (2026-11-12 14:05:00 or 2026-11-12T14:05:00+08:00).
counts.csv: header "timestamp,machine,total,good" (or reject instead of good; total may be left out when both good
and reject are there). Each row is the parts made since the previous count (an increment), or with --counter a
running-counter reading (parts so far; the first reading per machine is the starting point, a reading that goes
down is a counter reset and counts as the parts made since the reset).

  availability = run time / planned production time (run + downtime + changeover; planned stops and no-data time left out)
  performance  = ideal cycle time x total parts / run time
  quality      = good parts / total parts
  OEE          = availability x performance x quality = ideal cycle time x good parts / planned production time

Options:
  --counts <file>            part-count CSV
  --counter                  counts rows are running-counter readings, not increments (resets handled, listed)
  --ideal-cycle <s|M=s,...>  ideal cycle time in seconds per part, one value or per machine (M1=12,M2=15)
  --run-states <a,b>         states that count as running (default run,running,production)
  --planned-states <a,b>     planned stops, not in planned production time (default planned,break,off,no_order,holiday)
  --changeover-states <a,b>  changeover / setup states (default none): availability loss like downtime, but shown
                             apart (own column, own by-reason table) and not counted as stops or short stops
                             any other state is unplanned downtime; state names are matched without case
  --from <time>              window start (default the first state row)
  --to <time>                window end (default the latest timestamp in the input)
  --short-stop <s>           stops shorter than this are counted as short stops (default 300)
  --target <pct>             OEE target: machines (and the total) below it are findings
  --by-day                   also a table per day (and per machine): times, availability, performance, quality, OEE
  --day-start <HH:MM>        time of day a day starts for --by-day (default 00:00; e.g. 07:00 for a 7am first shift)
  --day-offset <+HH:MM>      zone offset for day and shift boundaries when the files carry offsets (default the first row's)
  --shifts <name=HH:MM,...>  shift calendar, e.g. Day=07:00,Night=19:00: each shift lasts until the next starts;
                             adds a table per shift (and per machine), each shift summed over every day
  --time-column <name>       states timestamp column (default timestamp)
  --machine-column <name>    states machine column (default machine, optional)
  --state-column <name>      states state column (default state)
  --reason-column <name>     states reason column (default reason, optional)
  --counts-time-column <name>     counts timestamp column (default timestamp)
  --counts-machine-column <name>  counts machine column (default machine, optional)
  --total-column <name>      counts total column (default total)
  --good-column <name>       counts good column (default good)
  --reject-column <name>     counts reject column (default reject)
  --json                     JSON report
  --md                       Markdown report
  -h, --help                 show this help

Exit codes: 0 no findings, 1 findings (OEE below --target, performance over 100%, parts counted with no run time,
before the first state or for a machine with no states), 2 input error.
`;

function number(text: string | undefined, flag: string): number | undefined {
  if (text === undefined) {
    return undefined;
  }
  const value = Number(text);
  if (text.trim() === '' || !Number.isFinite(value)) {
    throw new InputError(`${flag} must be a number.`);
  }
  return value;
}

function idealCycle(text: string | undefined): number | Record<string, number> | undefined {
  if (text === undefined) {
    return undefined;
  }
  if (!text.includes('=')) {
    return number(text, '--ideal-cycle');
  }
  const map: Record<string, number> = {};
  for (const part of text.split(',')) {
    const at = part.lastIndexOf('=');
    const name = part.slice(0, at).trim();
    if (at < 0 || name === '') {
      throw new InputError(`--ideal-cycle: "${part}" is not machine=seconds.`);
    }
    if (name in map) {
      throw new InputError(`--ideal-cycle names machine "${name}" twice.`);
    }
    map[name] = number(part.slice(at + 1), `--ideal-cycle for "${name}"`) as number;
  }
  return map;
}

const list = (text: string | undefined) => text?.split(',').map((x) => x.trim());

function read(path: string, what: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    throw new InputError(`Cannot read ${what} ${path}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`);
  }
}

export function main(argv: string[]): number {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        counts: { type: 'string' },
        counter: { type: 'boolean', default: false },
        'ideal-cycle': { type: 'string' },
        'run-states': { type: 'string' },
        'planned-states': { type: 'string' },
        'changeover-states': { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        'short-stop': { type: 'string' },
        target: { type: 'string' },
        'by-day': { type: 'boolean', default: false },
        'day-start': { type: 'string' },
        'day-offset': { type: 'string' },
        shifts: { type: 'string' },
        'time-column': { type: 'string' },
        'machine-column': { type: 'string' },
        'state-column': { type: 'string' },
        'reason-column': { type: 'string' },
        'counts-time-column': { type: 'string' },
        'counts-machine-column': { type: 'string' },
        'total-column': { type: 'string' },
        'good-column': { type: 'string' },
        'reject-column': { type: 'string' },
        json: { type: 'boolean', default: false },
        md: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    if (values.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    if (positionals.length !== 1) {
      throw new InputError(positionals.length ? 'Give exactly one states CSV (counts go with --counts).' : 'Give a states CSV.');
    }
    if (values.json && values.md) {
      throw new InputError('Use either --json or --md, not both.');
    }
    const countFlags = ['counts-time-column', 'counts-machine-column', 'total-column', 'good-column', 'reject-column'] as const;
    if (values.counts === undefined && (countFlags.some((f) => values[f] !== undefined) || values.counter)) {
      throw new InputError('Counts options (columns, --counter) need --counts.');
    }
    const states = parseStates(read(positionals[0], 'states'), {
      timeColumn: values['time-column'],
      machineColumn: values['machine-column'],
      stateColumn: values['state-column'],
      reasonColumn: values['reason-column'],
    });
    const counts =
      values.counts === undefined
        ? undefined
        : parseCounts(read(values.counts, 'counts'), {
            timeColumn: values['counts-time-column'],
            machineColumn: values['counts-machine-column'],
            totalColumn: values['total-column'],
            goodColumn: values['good-column'],
            rejectColumn: values['reject-column'],
            counter: values.counter,
          });
    const report = analyze(states, counts, {
      runStates: list(values['run-states']),
      plannedStates: list(values['planned-states']),
      changeoverStates: list(values['changeover-states']),
      idealCycleS: idealCycle(values['ideal-cycle']),
      from: values.from,
      to: values.to,
      shortStopS: number(values['short-stop'], '--short-stop'),
      targetPct: number(values.target, '--target'),
      byDay: values['by-day'],
      dayStart: values['day-start'],
      dayOffset: values['day-offset'],
      shifts: values.shifts,
    });
    process.stdout.write(values.json ? jsonReport(report) : values.md ? markdownReport(report) : textReport(report));
    return report.findings.length ? 1 : 0;
  } catch (e) {
    if (e instanceof InputError || (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      process.stderr.write(`oee-log-check: ${(e as Error).message}\n`);
      return 2;
    }
    throw e;
  }
}

function isEntryPoint(): boolean {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = main(process.argv.slice(2));
}
