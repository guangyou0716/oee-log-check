# oee-log-check

Offline CLI that turns a machine **state-change log** (and optionally a **part-count log**) into an OEE report:

- **per machine and in total**: planned production time, run time, downtime, stops, planned stops, time with no
  data, and **availability x performance x quality = OEE**;
- **downtime Pareto** by reason (the state name when a row has no reason), with share, cumulative share and the
  machines affected, plus the number and total time of **short stops**;
- **findings** with exit code 1: OEE below a target, performance over 100% (wrong ideal cycle time or counts), parts
  counted with no run time, before a machine's first state row, or for a machine with no state rows.

It is meant for the exports you get from a PLC, SCADA historian, MES or IIoT gateway when you would otherwise build
the OEE sheet and downtime Pareto by hand. No runtime dependencies, no network, reads local files only.

## Usage

```sh
npm ci && npm run build
node dist/cli.js examples/states-example.csv                                    # availability + Pareto
node dist/cli.js examples/states-example.csv --counts examples/counts-example.csv --ideal-cycle M1=30,M2=45
node dist/cli.js examples/states-example.csv --counts examples/counts-example.csv --ideal-cycle 30 --target 80 --md
node dist/cli.js line.csv --counts parts.csv --ideal-cycle 12 --from "2026-11-02 08:00" --to "2026-11-02 20:00" --json
node dist/cli.js line.csv --counts parts.csv --ideal-cycle 12 --by-day --day-start 07:00   # one row per day and machine
node dist/cli.js line.csv --counts parts.csv --ideal-cycle 12 --shifts A=07:00,B=15:00,C=23:00   # one row per shift and machine
```

`examples/` holds **example data** (made up for this README): two machines over one 12-hour shift, with a break, a
lunch, a changeover, jams, a material shortage and a spindle alarm, and hourly part counts.

```
Window: 2026-11-02 08:00:00 .. 2026-11-02 20:00:00 (12 h 0 min), end = latest timestamp in the input
States seen: run = RUN; planned stop = BREAK; downtime = DOWN, SETUP
  (run states: run, running, production; planned-stop states: planned, break, off, no_order, holiday; anything else is downtime)

  Machine  Planned prod.          Run        Down  Stops  Planned stop  No data  Avail.   Perf.  Quality     OEE  Parts
  M1         11 h 45 min  10 h 27 min  1 h 18 min      3        15 min      0 s  88.94%  87.72%      98%  76.45%  1100 (1078 good)
  M2         10 h 30 min   9 h 24 min   1 h 6 min      3     1 h 0 min   30 min  89.52%  93.09%   98.43%  82.02%  700 (689 good)
  All        22 h 15 min  19 h 51 min  2 h 24 min      6    1 h 15 min   30 min  89.21%  90.26%   98.17%  79.08%  1800 (1767 good)

Downtime by reason (state when there is no reason):
  Reason             Stops       Time   Share    Cum.  Machines
  spindle alarm          1  1 h 0 min  41.67%  41.67%  M2
  material shortage      1     45 min  31.25%  72.92%  M1
  changeover             1     30 min  20.83%  93.75%  M1
  jam                    3      9 min   6.25%    100%  M1, M2
Short stops (< 5 min): 3 stop(s), 9 min (counted as downtime)

Findings: none
```

Checked by hand: M1 runs 627 of 705 planned-production minutes (A = 88.94%), makes 1,100 parts at an ideal 30 s
(P = 33,000 s / 37,620 s = 87.72%) with 1,078 good (Q = 98%), so OEE = 30 s x 1,078 / 42,300 s = 76.45%.

### Per day (`--by-day`)

`--by-day` adds a table per day (per machine and `All`) with the same columns, and `days` in `--json`. A day starts
at `--day-start` (default 00:00; use 07:00 when the first shift starts at 7) and is labelled with the date it starts
on. The first and last day are cut to the window. Days add up to the window: a stop that runs across a day start is
split and counts as a stop in both days, and a count stamped exactly on a day start closes the day before. For files
whose timestamps carry an offset, day boundaries use the first state row's offset unless `--day-offset +08:00` is
given. Day tables raise no findings of their own; at most 400 days per run.

On the example with `--by-day --day-start 14:00`, M1 has 5 h 45 min + 6 h 0 min of planned production and 552 + 548
parts, which add up to the 11 h 45 min and 1,100 parts above.

### Per shift (`--shifts`)

`--shifts Day=07:00,Night=19:00` (or `A=07:00,B=15:00,C=23:00`) gives a shift calendar: each shift starts at its
time every day and lasts until the next shift starts. The report adds a table per shift (per machine and `All`) with
the same columns, each shift summed over every day in the window (the title says how many times each shift falls in
it), and `shifts` in `--json`. Shifts add up to the window the same way days do: a stop across a shift change counts
in both shifts and a count stamped exactly on a shift change closes the shift before. A shift that never falls in
the window is left out. For files with offsets, shift times use the first state row's offset unless `--day-offset`
is given. `--shifts` works with or without `--by-day`; shift tables raise no findings of their own.

On the example with `--shifts A=06:00,B=14:00,C=22:00`, shift A has the same 5 h 45 min and 552 parts for M1 as
the first day above, and C is left out (the window ends at 20:00).

### Input

**States** (`states.csv`): header `timestamp,machine,state,reason`; `machine` and `reason` are optional (no
machine column = one machine). Each row starts a state that lasts until the same machine's next row; the last row
lasts until `--to`, or else until the latest timestamp in the input (the report says so). Rows need not be sorted,
but one machine cannot have two rows at the same time.

**Counts** (`counts.csv`, optional): header `timestamp,machine,total,good` (or `reject` instead of `good`; `total`
may be left out when both `good` and `reject` are there). Each row is the number of parts made since the previous
count: an increment. Counts stamped from the window start up to and including its end are used, so an hourly total
stamped at the end of the hour is kept.

**Running counters** (`--counter`): when the counts file holds counter readings (parts so far, as a PLC or MES
counter shows them) instead of increments. Per machine, in time order (the file need not be sorted):

- the first reading is the starting point and gives no parts itself (put a reading at the shift or window start);
- each later reading gives the difference to the reading before, stamped at the later reading;
- a reading where total, good or reject went down is a **counter reset**: the counter restarted from zero, so that
  reading itself is the parts made since the reset. Parts made between the reading before and the reset are not
  seen. Every reset is listed in the report notes (first five in text/Markdown, all in JSON `counts.counter.resets`);
- the same reading twice at one time is left out; two different readings at one time are an input error (exit 2).

```sh
oee-log-check examples/states-example.csv --counts examples/counter-example.csv --counter --ideal-cycle M1=30,M2=45
```

gives the same OEE as the increments example.

Column names are matched without case and can be renamed (`--time-column`, `--machine-column`, `--state-column`,
`--reason-column`, `--counts-time-column`, `--counts-machine-column`, `--total-column`, `--good-column`,
`--reject-column`). Timestamps are ISO 8601 (`2026-11-12 14:05:00`, `2026-11-12T14:05:00+08:00`), all with or all
without a zone offset. Any problem is reported with its row number (exit 2).

### How it is worked out

| Term | Meaning |
|---|---|
| run time | time in a run state (`--run-states`, default `run,running,production`) |
| planned stop | time in a planned-stop state (`--planned-states`, default `planned,break,off,no_order,holiday`) |
| downtime | time in **any other state**; every state counted as downtime is listed at the top of the report |
| no data | time in the window before a machine's first state row |
| planned production time | run time + downtime |
| availability | run time / planned production time |
| performance | ideal cycle time x total parts / run time (`--ideal-cycle 30` or `--ideal-cycle M1=30,M2=45`) |
| quality | good parts / total parts |
| OEE | availability x performance x quality = ideal cycle time x good parts / planned production time |

The **All** row sums the times and parts of every machine (performance uses each machine's own ideal cycle time).
Each downtime row counts as one stop. Short stops (`--short-stop`, default 300 s) stay in downtime and so in availability; they are only counted. Where
your plant books changeovers or short stops differently, set `--run-states` / `--planned-states` to match.
Without `--counts` the report gives availability and the Pareto only; without `--ideal-cycle` it leaves out
performance and OEE.

### Exit codes

`0` no findings, `1` findings, `2` input error. Without `--target`, a low OEE alone is not a finding.

## Development

```sh
npm ci
npm run check   # lint + typecheck + tests
npm run build && npm run smoke
```

CI runs the same on Node 20 and 22. The smoke test also runs 20 machines x 90 days (259,200 state rows,
43,200 count rows).

## Not yet

Changeover as its own class, per-shift-per-day tables. Counter rollover at a fixed maximum (e.g. 65535) is
treated as a reset, not as a wrap.
Presets for specific MES / SCADA export layouts need real sample files.

## License

MIT
