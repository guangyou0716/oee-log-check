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

### Input

**States** (`states.csv`): header `timestamp,machine,state,reason`; `machine` and `reason` are optional (no
machine column = one machine). Each row starts a state that lasts until the same machine's next row; the last row
lasts until `--to`, or else until the latest timestamp in the input (the report says so). Rows need not be sorted,
but one machine cannot have two rows at the same time.

**Counts** (`counts.csv`, optional): header `timestamp,machine,total,good` (or `reject` instead of `good`; `total`
may be left out when both `good` and `reject` are there). Each row is the number of parts made since the previous
count: an increment, not a running counter. Counts stamped from the window start up to and including its end are
used, so an hourly total stamped at the end of the hour is kept.

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

Shift calendar and per-shift / per-day tables, running-counter input with resets, changeover as its own class.
Presets for specific MES / SCADA export layouts need real sample files.

## License

MIT
