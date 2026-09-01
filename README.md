# 🏁 Sandbox Grand Prix

A benchmark harness that runs **identical AI-agent tasks across multiple sandbox
providers** (E2B, Modal, Daytona) and compares them on time to a usable
sandbox, per-command latency, file throughput, isolation behaviour, concurrency
ceilings, SDK ergonomics and cost.

It is built to be *hard to misread*: every median carries a confidence
interval, every cost carries its provenance, and every run ships the list of
things the harness could not hold constant.

TypeScript orchestrator + dashboard; the agent tasks themselves run Python
inside the sandboxes.

> **Status: all four races and the dashboard are built.** The results schema is
> at **v2**, which added time-to-ready and per-command round-trip measurement,
> interleaved provider scheduling, measured (rather than assumed) machine sizes
> behind the cost model, confidence intervals on every median, and a fairness
> report the harness generates against its own output. See
> [What this benchmark controls, and what it doesn't](#what-this-benchmark-controls-and-what-it-doesnt).
>
> [Measured results](#measured-results) are from a full v2 run against real
> infrastructure on all three providers, 2026-09-01. The headline: on
> `createSandbox()` latency the three are within 100 ms of each other, and on
> time-to-a-usable-sandbox they are **5.6× apart**. The v1 harness ranked on the
> former.

---

## Quick start

```bash
pnpm install
cp .env.example .env   # then fill in the keys you have
pnpm build

# Modal only: its adapter runs through a Python sidecar
python3 -m venv providers/modal_sidecar/.venv
providers/modal_sidecar/.venv/bin/pip install -r providers/modal_sidecar/requirements.txt

node packages/cli/dist/index.js race --all --providers e2b,modal,daytona
```

No credentials handy? Run the harness against the built-in local fixture:

```bash
node packages/cli/dist/index.js race --task sprint --providers local --iterations 5
```

---

## Layout

| Path | What it is |
| --- | --- |
| `packages/core` | Provider abstraction, instrumentation, tasks, race runner |
| `packages/cli` | `sgp` CLI — run races, print result tables |
| `packages/dashboard` | Next.js live telemetry dashboard |
| `providers/modal_sidecar` | Python sidecar for Modal's Python-first SDK *(Phase 2)* |
| `results/` | One append-only JSON file per race run, schema-versioned |
| `pricing.json` | Editable rate card + billing model per provider, read at race time |

---

## The dashboard

```bash
pnpm dashboard      # http://localhost:4100
```

A pit-wall telemetry board that reads `results/` and repaints as races land —
start a race in one terminal and watch it appear without a reload.

| Panel | What it shows |
| --- | --- |
| **Masthead** | Races logged, cumulative sandbox seconds, **open caveats**, errors captured, and a running cost counter that eases to each new total |
| **Protocol bar** | The conditions the run was held under — provider order, formation lap, machine size requested, whether micro-probes ran — stated *above* the results, because an ordering claim is unreadable without them |
| **Timing tower** | Motorsport leaderboard ranked on **time to ready**, each median carrying its 95% CI. A provider whose interval overlaps the leader's reads `≈ TIED` rather than being given a gap it has not earned; one that did not complete every lap is *unclassified* (`–`) rather than placed last, so the position column never disagrees with the times beside it. Cost carries a badge saying whether the machine size behind it was requested, measured or assumed |
| **Where the wait comes from** | Create vs first-command vs per-command round trip on one axis. A short dark bar with a long pale one is a provider that returns from `create` before the sandbox can run anything — the wait moved, it did not disappear |
| **Cold start distribution** | A strip plot drawing *every* sample, not a histogram — with ~10 laps per provider, binning would hide exactly the tail outliers you care about — with the CI on the median drawn over it, so overlapping providers look overlapping |
| **Lap times** | Per-provider sparklines on a shared vertical scale; failed laps are hollow and ringed |
| **Where the time went** | For single-iteration races, a step breakdown instead of a one-point "distribution" — this is where Marathon's `pip install` dominance and its deliberately-red test segment show up |
| **Escape room matrix** | provider × probe → outcome, with the platform knob that changes each row named underneath, so a default does not read as a moat. Not ranked |
| **What was under test** | Image, OS, machine as delivered, isolation, whether our size request applied, adapter size split from scaffolding, and SDK path — per provider, on every board |
| **Read this before quoting the numbers** | The caveats the harness raised against its own run, on the board they qualify. Warnings expanded by default, because nobody clicks "show caveats" |
| **Race log** | Newest-first ticker of every run on disk |

Implementation notes:

- **Polling, not websockets.** The page polls `/api/results` every 2.5s, pauses
  while the tab is hidden, and catches up immediately on refocus. The route is
  `force-dynamic` so it always re-reads the directory.
- **Dark-only, by design.** It is a telemetry screen; a light variant would be a
  different product. Colours are CSS variables in one block if you want to fork it.
- **The categorical palette is validated, not eyeballed.** Provider liveries
  (e2b `#12A594`, modal `#BE7F00`, daytona `#A855F7`) pass a six-check colour
  audit against the dark surface — lightness band, chroma floor, colour-blind
  separation (ΔE 14.1 worst adjacent pair under protanopia/deuteranopia),
  normal-vision separation (ΔE 20.2) and 3:1 contrast.
- **Nothing depends on colour alone.** Every escape-room cell carries a glyph and
  a word; charts carry direct labels and a legend; the distribution chart ships a
  screen-reader table of the same numbers.
- **Escape-room outcomes are states, not scores.** `allowed` is rendered as a
  neutral caution, not a failure — it usually means "this is the provider's
  documented default", and Modal's open network is configurable.

> Don't run `pnpm --filter @sgp/dashboard build` while the dev server is running —
> they share `.next` and the dev server will start returning 500s. Stop it first,
> or `rm -rf packages/dashboard/.next` to recover.

---

## Getting API keys

Keys are read from `.env` at the repo root and are **never** hardcoded. Any
provider whose keys are missing is skipped and marked `DNS` (did not start) in
the results — the race continues.

### E2B — `E2B_API_KEY`
1. Sign in at <https://e2b.dev>.
2. Go to **Dashboard → API Keys** (<https://e2b.dev/dashboard?tab=keys>).
3. Copy the key (it starts with `e2b_`) into `E2B_API_KEY`.

SDK: [`@e2b/code-interpreter`](https://www.npmjs.com/package/@e2b/code-interpreter) v2.x.

### Modal — `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET`
1. Sign in at <https://modal.com>.
2. Either run `pip install modal && modal token new` (writes `~/.modal.toml`),
   or create a token manually at **Settings → API Tokens**
   (<https://modal.com/settings/tokens>).
3. Copy the token id (`ak-…`) and secret (`as-…`) into `.env`.

Modal's adapter runs through a Python sidecar under `providers/modal_sidecar/`
that the TypeScript orchestrator drives over newline-delimited JSON on stdio.
Set it up once:

```bash
python3 -m venv providers/modal_sidecar/.venv
providers/modal_sidecar/.venv/bin/pip install -r providers/modal_sidecar/requirements.txt
```

> **⚠️ The sidecar may no longer be necessary.** This design assumes Modal is
> Python-only. As of 2026-08-28 Modal publishes an official TypeScript SDK
> (`modal` on npm, v0.10.0). Keeping the sidecar costs Modal ~380 lines of
> adapter code versus ~45 for the native-SDK providers, which materially skews
> the LOC ergonomics column. See **SDK ergonomics** below.

### Daytona — `DAYTONA_API_KEY`
1. Sign in at <https://app.daytona.io>.
2. Go to **Dashboard → Keys** and create an API key.
3. Copy it into `DAYTONA_API_KEY`.
   Optional: `DAYTONA_API_URL` and `DAYTONA_TARGET` override the defaults.

SDK: [`@daytona/sdk`](https://www.npmjs.com/package/@daytona/sdk).
**Note:** the older `@daytonaio/sdk` package is deprecated — it now prints a
notice pointing at `@daytona/sdk` (same API, no breaking changes). This project
uses the current package.

---

## CLI

```bash
sgp race --task sprint --providers e2b,modal,daytona
sgp race --all                 # every implemented task
sgp report                     # pretty table, latest run per task
sgp report --json              # raw JSON
sgp providers                  # readiness, integration facts, adapter size
```

Useful flags:

| Flag | Effect |
| --- | --- |
| `--iterations <n>` | Override the per-task default (for RELAY, this is the fleet size). Medians need ~10; tails need ~20 |
| `--image <map>` | Per-provider image, e.g. `--image modal=python:3.12-slim,daytona=python:3.12-slim`. **The single most important fairness control** — see [Image parity](#image-parity) |
| `--template <id>` | One image for every provider (rarely what you want; the providers do not accept the same identifiers) |
| `--vcpus <n>` / `--mem <mib>` | Machine size requested from every provider. Default 2 vCPU / 2048 MiB |
| `--order <mode>` | `interleaved` (default) or `sequential` |
| `--formation-lap` | One throwaway sandbox per provider before measuring, to absorb first-call costs like image pulls. Applied uniformly to every provider or not at all |
| `--no-probes` | Skip the readiness and exec-round-trip micro-probes |
| `--quiet` | Hide live lap-by-lap output |

`SGP_RESULTS_DIR` overrides where results are read and written, so you can keep
measurement campaigns apart instead of piling them into one directory.

### Report columns

| Column | Meaning |
| --- | --- |
| Ready p50 | **The headline.** `createSandbox()` + the first command that came back, ± the 95% CI on the median |
| vs leader | Gap to first place — or `≈ tied` when the confidence intervals overlap and the ordering is not in the data |
| Create p50 | `createSandbox()` alone. Lower than Ready by however much boot work the SDK defers into your first command |
| Exec RTT | Per-command round trip on a live sandbox. An agent session pays this dozens of times |
| Laps ok | Laps that completed the task as specified |
| Cost | `alive_s × (vCPU × $/vCPU-hr + GiB × $/GiB-hr) / 3600`, with a `*` when the machine size was assumed rather than measured |
| $/1k sessions | 1,000 sandboxes alive ten minutes each — the figure you can actually budget against |

Below the table: the cold-start spread (min/p50/p90/p95/max, CV, lap 1 vs
steady state), what was under test (image, OS, machine, isolation, adapter
size, SDK), the task detail, errors bucketed by kind, and the caveats.

---

## What this benchmark controls, and what it doesn't

A sandbox benchmark is easy to write and easy to misread. The dangerous output
is not a wrong number — it is a right number quoted as if it settled a question
it never touched. So the harness holds what it can constant, states what it
cannot, and ships the caveats *inside the result file* rather than leaving them
in a README next to the chart.

### Held constant

**Interleaved provider order (default).** Lap *n* runs on every provider before
lap *n+1*, with a rotating start order. Running all of provider A and then all
of provider B measures two different minutes of the internet, and hands the
first-listed provider a permanent slice of time nobody else got.
`--order sequential` restores the old behaviour and the run says so.

**The same machine, asked for.** Every provider is asked for the same size
(default 2 vCPU / 2048 MiB). Whether it was *applied* is self-reported per
create — Modal pins it, Daytona applies it only with an image pinned, E2B
cannot take cpu/memory at create time at all — and any mismatch becomes a
warning on the run.

**One retry on create, none on exec.** Real flakiness should be visible in the
numbers, not smoothed away.

**Untimed adapter setup.** Sidecar boot and SDK client construction happen in a
`warmup()` hook, so this repo's architecture never lands in a provider's cold
start.

**Expected errors are not failures.** ESCAPE ROOM exists to provoke the
sandbox. A provider whose memory cap kills the OOM probe was doing its job;
counting that against it would score the strictest isolation as the most broken
platform.

### Measured rather than assumed

**Time to ready, not create latency.** `createSandbox()` resolving is not the
same event across SDKs — some return once the control plane accepts the request
and finish booting inside your first command. Ranking on it rewards whoever
defers the most work. The headline metric is create **plus a command that came
back**, and the report shows the split, so a provider that moves the wait
rather than removing it is visible.

**Per-command round trip.** An agent loop issues dozens of commands per
session. At twenty commands, a 40 ms difference in round trip outweighs a
200 ms difference in boot — the opposite of what a cold-start leaderboard
implies. Five no-op execs per lap measure that floor.

**The file channel.** SPRINT pushes 1 MiB in and pulls it back out. Getting
code into a sandbox is a per-session cost that fast booting does not offset.

**The machine, from inside it.** One probe per provider per race records
schedulable CPUs, the cgroup quota, the memory cap, free disk, kernel, OS and
Python version. This grounds three claims that used to be assumptions: the cost
model, image parity, and the isolation technology.

**Acquisition time separately from cold start.** If a provider stalls 30 s,
fails, then succeeds in 100 ms, its cold start was 100 ms — and its caller
waited 30.1 s. Both are recorded.

### Stated, not solved

**<a id="image-parity"></a>Image parity.** This is the biggest confound in the
whole benchmark. `pip install flask pytest` on a slim Debian image is a
different amount of work than on an image that ships them, and a 2 GB image
pulls slower than a 200 MB one. Modal and Daytona both accept a registry tag,
so they can be matched:

```bash
sgp race --all --image modal=python:3.12-slim,daytona=python:3.12-slim
```

E2B cannot — its sizes and contents come from templates built ahead of time
with the E2B CLI — so full three-way parity needs a prebuilt E2B template that
matches. Until it exists, the run raises an `image-parity` warning listing what
each provider actually ran.

**Statistical honesty.** Every median carries a bootstrap 95% confidence
interval, and a provider whose interval overlaps the leader's is labelled
`≈ tied` rather than given a gap it has not earned. A p95 computed from n=10 is
interpolated between the top two samples — the maximum wearing a lab coat — so
it is labelled rather than quietly printed as a tail. Below n=5 the run says
outright that the ordering is anecdote.

**Cost provenance.** Cost is modelled from measured sandbox-alive seconds
against `pricing.json`, never read from a billing API, so it is an estimate in
every case. The machine size behind it is resolved in a defined order and the
answer carries which rung it landed on:

| Basis | Meaning |
| --- | --- |
| `requested` | The SDK let us pin cpu/memory *and* the vendor bills on the request |
| `measured` | The cgroup limits observed inside the sandbox |
| `assumed` | `pricing.json`'s default — nobody actually knows |

An `assumed` cost column is a restatement of runtime, not a price, so it is
badged in both the terminal and the dashboard. The E2B and Daytona rate cards
in `pricing.json` are the project's original placeholders and have **not** been
checked against those vendors' pricing pages; both meter memory (and Daytona
disk) separately, so those rows understate real cost. Anything unverified or
older than 90 days is flagged on the run.

**Defaults are not capabilities.** ESCAPE ROOM records what each platform does
by default. All three ship a switch for outbound network — E2B
`allowInternetAccess`, Daytona `networkBlockAll` / `networkAllowList`, Modal
`block_network` — and the memory ceiling follows the size you asked for. The
matrix names the relevant knob on every row that has one, so "Daytona blocks
egress" reads as a default rather than a moat.

**Throughput on an incomplete fleet.** Creates-per-second counts only
successful creates, so a provider throttled after two sandboxes can post a
spectacular rate for the two it managed. RELAY reports fleet completion beside
it and marks the number as not comparable when the fleet did not finish. These
ceilings are account tier, not capability.

**One client, one location, one moment.** Every latency figure includes the
round trip from a single machine to whichever region each provider defaulted
to, which is not held constant and can be tens of milliseconds on its own. Run
it from your own deployment region before treating any of it as a decision
input.

The harness generates these caveats itself (`packages/core/src/fairness.ts`),
writes them into every result file, prints them under the terminal table, and
renders them on the dashboard board they qualify.

---

## The races

| Task | What it measures | Status |
| --- | --- | --- |
| **SPRINT** | Time-to-ready distribution, per-command round trip, and 1 MiB file-channel throughput. Write a Python script, exec it, read stdout (the 10,000th prime), then round-trip a 1 MiB payload. 10 laps. | ✅ |
| **MARATHON** | Multi-step stateful session in one sandbox: pip install, write a Flask app + pytest tests, run them, break a test, fix it, re-run until green. Does state persist across `exec` calls? | ✅ |
| **ESCAPE ROOM** | Observational isolation probes: outbound HTTP, `/etc/passwd` + `/proc`, 2 GB disk write, 200 processes, OOM. Records allowed / blocked / killed — not pass/fail, not ranked, and each row names the knob that changes it. | ✅ |
| **RELAY** | 20 parallel sandboxes per provider mapping over shards of a 100k-row synthetic CSV. Measures concurrency ceiling, provisioning throughput and throttling — with throughput marked not-comparable when the fleet did not complete. | ✅ |

The RELAY dataset is generated deterministically (seeded PRNG) into
`data/relay-100000.csv` on first use and cached. The orchestrator recomputes the
reduction locally and asserts the distributed result matches, so a provider
cannot score well by silently dropping rows.

---

## Design notes

**Adapters stay thin.** All timing, retry and error capture lives in
`packages/core/src/instrument.ts`, wrapped around the provider. Adapters are
pure SDK translation, which keeps the `LOC` ergonomics metric an honest
comparison rather than a measure of who wrote more boilerplate.

### SDK ergonomics

A single line count made Modal look 9× harder to integrate than it is, because
it charged Modal for a sidecar that exists only because *this repo* chose to
talk to a Python SDK from TypeScript. The number is now split, and sits next to
the facts a line count cannot express:

| Provider | Adapter | Scaffolding | SDK | Machine size | Registry images |
| --- | --- | --- | --- | --- | --- |
| E2B | 73 | — | native TypeScript | template-only | no |
| Daytona | 74 | — | native TypeScript | per-sandbox¹ | yes |
| Modal | 115 | 334 | via python3 sidecar² | per-sandbox | yes |

¹ Daytona takes `resources: { cpu, memory, disk }`, but only on the from-image
overload — pin an image and the request applies; leave it unpinned and you get
its default machine.
² Modal has shipped a first-party TypeScript SDK since 2026-08. This adapter
predates it. The 334 lines of scaffolding are a cost of our integration path,
not of Modal, and the report keeps them in their own column so the two claims
stay separable. Rewriting the adapter on the TS SDK is the obvious next change.

`sgp providers` prints this table plus per-provider notes.

**Failures are data, not crashes.** Every SDK error is captured into the
results JSON with its raw message, phase and truncated stack. A provider that
explodes still produces a row.

**Retry policy** (per spec): exactly **one** retry on `createSandbox`, **none**
on `exec` — real flakiness should show up in the numbers.

**Sandboxes are always destroyed** in a `finally` block, including when the
task body throws or creation partially succeeded. A failed `destroy` is
recorded as `ORPHAN RISK` in the step timings so you can go hunt it down. Both
task modes share one `spawn()` implementation, so the guarantee cannot drift
between the sequential and parallel paths. The Modal sidecar additionally
terminates every sandbox it still tracks when stdin closes, so killing the
orchestrator mid-race cannot strand billed containers. Verified after every
race in this build: zero orphans.

**Adapter setup is not cold start.** Booting the Modal sidecar and constructing
SDK clients happen in an untimed `warmup()` hook, so our architecture never
inflates a provider's `cold_start_ms`. `--formation-lap` optionally burns one
throwaway sandbox per provider first — applied uniformly or not at all.

**Non-zero exit ≠ error.** E2B's `commands.run` throws `CommandExitError` on a
non-zero exit code; the adapter unwraps it into a normal result. MARATHON's
deliberately-failing test and ESCAPE ROOM's blocked probes depend on this.

### Verifying the harness itself

`scripts/selfcheck.ts` injects faults into a mock provider and asserts 35
invariants across four groups:

- **lifecycle** — retry-once-then-give-up, always-destroy (including when the
  task body throws), no exec retry, destroy-failure tolerance, and that a slow
  failed attempt lands in `acquireMs` instead of vanishing behind the cold
  start of the attempt that worked;
- **fleet** — every sandbox destroyed, genuine concurrency, one failing shard
  not taking the fleet down, and fleets never interleaved;
- **fairness controls** — providers interleaved lap by lap with a rotating
  lead, the requested machine size claimed as honoured only when an adapter
  says it applied it, and task-declared expected errors not counted against a
  provider;
- **measurement** — probes collected when on and absent when off, the machine
  fingerprinted once per provider rather than once per lap, and every run
  emitting its own caveats and cost basis.

```bash
npx tsx scripts/selfcheck.ts
```

`scripts/sidecar-check.ts` exercises the Modal sidecar protocol itself —
handshake, request-id correlation under concurrency, structured error
propagation, and clean shutdown. It needs the sidecar venv but not credentials.

```bash
npx tsx scripts/sidecar-check.ts
```

---

## Cost model

Rates live in `pricing.json` — edit freely, they are read at race time.

| Provider | $/vCPU-hr | $/GiB-hr | Billed on | Source |
| --- | --- | --- | --- | --- |
| E2B | 0.0504 | 0 | template tier | ⚠️ project placeholder, **not** checked against e2b.dev/pricing; E2B meters memory separately, so this row understates cost |
| Daytona | 0.0504 | 0 | requested resources | ⚠️ project placeholder, **not** checked against daytona.io/pricing; Daytona meters CPU, memory and disk separately, so this row understates cost |
| Modal | 0.070956 | 0.024012 | requested resources | [modal.com/pricing](https://modal.com/pricing) Sandboxes tier, checked 2026-08-28: $0.00003942/core/sec where 1 core = 2 vCPU; memory $0.00000667/GiB/sec |

Cost is derived from **sandbox-alive seconds** measured by the harness
(`createSandbox` completion → `destroy` completion), never from provider billing
APIs, so treat it as a modelled estimate in every case.

`default_vcpus` and `default_mem_gib` are the last resort, not the first.
Every race runs one environment probe per provider and resolves the machine
size behind the cost as `requested` → `measured` → `assumed`, recording which
rung it landed on. The report and dashboard badge the `assumed` rows, and the
run raises a warning naming them, because an assumed size makes the cost column
a restatement of runtime rather than a price.

`verified_on` is the date a human last checked a rate against the vendor's
price page; anything missing or older than 90 days is flagged on the run. Two
of the three rows above are placeholders inherited from the original spec —
fixing them is the highest-value edit anyone can make to this repo.

---

## Measured results

Full three-way grand prix, **2026-09-01**, schema v2, from a single client in
one location. Every number came out of `sgp race`; nothing is hand-written.
Providers were interleaved lap by lap, each asked for 2 vCPU / 2 GiB, on their
**default images** — so read the caveats, which the harness prints under every
table.

Zero orphaned sandboxes: 116 destroys across the four races, none failed.

### SPRINT — 20 laps each

| Provider | Ready p50 | Create p50 | Exec RTT p50 | Upload | Download | Laps ok | $/1k sessions |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **e2b** | **276 ms** ±22 | 162 ms | **56 ms** | **6.4 MB/s** | **18.0 MB/s** | 20/20 | $16.80 |
| daytona | 545 ms ±71 | 261 ms | 116 ms | 2.1 MB/s | 1.8 MB/s | 20/20 | **$8.40** |
| modal | 1.54 s ±167 | **175 ms** | 306 ms | 1.4 MB/s | 1.8 MB/s | 20/20 | $31.66 |

**This is the finding the v1 harness could not see.** On `createSandbox()`
latency the three are nearly tied — 162 / 261 / 175 ms — and Modal is second
fastest. On *time to a sandbox that will actually run a command* they are 5.6×
apart, and Modal is last by more than a second. Modal's `create` returns in
175 ms and the first command then takes ~1.36 s: the wait moved, it did not
disappear. Ranking on create latency rewards exactly that.

The per-command round trip compounds it. An agent session issuing 50 commands
pays 2.8 s on E2B, 5.8 s on Daytona and 15.3 s on Modal — before any of them
does a single second of useful work, and dwarfing the cold-start gap the old
table led with.

Cold-start spread (create only):

| Provider | n | min | p50 | p90 | p95 | max | CV | Lap 1 | Steady p50 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| e2b | 20 | 106 ms | 162 ms | 205 ms | 207 ms | 233 ms | 0.22 | 206 ms | 160 ms |
| daytona | 20 | 128 ms | 261 ms | 299 ms | 306 ms | 315 ms | 0.31 | 270 ms | 260 ms |
| modal | 20 | 162 ms | 175 ms | 195 ms | 212 ms | 376 ms | **0.24** | 376 ms | 174 ms |

At n=20 the p95 is finally worth printing. Modal has the tightest body and the
worst single outlier — its max is its first lap, which is connection warm-up
rather than the platform.

### MARATHON — stateful session

All three completed the full cycle: deps and files persisted across separate
`exec` calls, the deliberately-broken test failed, and the suite went green
after the fix.

| Provider | Ready | pip install | Cost |
| --- | --- | --- | --- |
| e2b | **322 ms** | 1.56 s | $0.00013 |
| daytona | 630 ms | **1.06 s** | $0.00012 |
| modal | 1.60 s | 3.31 s | $0.00064 |

The `pip install` column is **not** a clean comparison: all three ran different
default images with different Python versions (3.13.14 / 3.14.4 / 3.12.14) and
different preinstalled packages. That is image choice as much as platform.

### ESCAPE ROOM — isolation (observational, not ranked)

| Probe | e2b | modal | daytona |
| --- | --- | --- | --- |
| outbound_http | allowed | allowed | **blocked** (HTTP 403) |
| read_etc_passwd | allowed | allowed | allowed |
| list_proc | allowed — **95 PIDs visible** | allowed — 4 PIDs | allowed — 11 PIDs |
| disk_2gb | **blocked** at 992 MB (ENOSPC) | allowed (2048 MB) | allowed (2048 MB) |
| fork_200 | allowed | allowed | allowed |
| memory_oom | **killed** ~1536 MB | allowed (no cap) | **killed** ~768 MB |

Machine as delivered:

| Provider | Image | CPU | Memory | Disk | Kernel |
| --- | --- | --- | --- | --- | --- |
| e2b | `base` | 2 vCPU | no cap reported | 0.97 GiB free | 6.1.158+ |
| modal | `python:3.12-slim` | 17 schedulable | 448 GiB | unreported | `4.19.0-gvisor` → **gVisor** |
| daytona | provider default | **1 vCPU (cgroup quota)** | 1 GiB | 3 GiB free | 6.8.0-generic |

Read as observation of **defaults**, not capabilities. All three ship an egress
switch (E2B `allowInternetAccess`, Daytona `networkBlockAll` /
`networkAllowList`, Modal `block_network`), and the memory ceiling follows the
size you asked for — Modal did not OOM because it was handed 448 GiB, not
because it has no limits. The real spread: Daytona is the only one blocking
egress by default, E2B exposes a much wider PID namespace and a ~1 GiB disk.
The OOM probe touches one byte per 4 KiB page precisely so lazily-mapped zero
pages cannot fake an "allowed".

### RELAY — 20 parallel sandboxes over 100k rows

| Provider | Shards | Rows | Reduce matches | Throttled | Window | Creates/sec | Comparable |
| --- | --- | --- | --- | --- | --- | --- | --- |
| e2b | **20/20** | 100,000 | ✅ | 0 | 457 ms | 43.8 | yes |
| modal | **20/20** | 100,000 | ✅ | 0 | 490 ms | 40.8 | yes |
| daytona | 10/20 | 50,000 | ❌ | 20 | 349 ms | 28.7 | **no** |

Daytona hit `Total CPU limit exceeded. Maximum allowed: 10` on half the fleet.
Only 50,000 of 100,000 rows were processed, and the reduce-vs-local reference
check correctly flagged the result as not matching — a benchmark without that
check would have reported a plausible-looking half-answer as a success.

Its 349 ms window and 28.7 creates/sec are **the fastest-looking window in the
table and the least meaningful number in it**: both count only the ten
sandboxes that came up. The harness marks the row not-comparable rather than
letting it sit next to the two complete fleets as if it were a peer. This is an
account-tier ceiling, not a capability limit.

Modal is also worth noting here: 441 ms create p50 in parallel against 175 ms
sequentially, and a 2.2 s time-to-ready. Its provisioning degrades under
fan-out in a way the sequential races do not show.

### Cost

The whole four-race grand prix cost **$0.0126** across all three providers,
which is the other reason not to read the `Cost` column as a decision input at
this scale — read `$/1k sessions` instead. And note that two of the three rate
cards in `pricing.json` are unverified placeholders that omit memory (and, for
Daytona, disk) billing, so the E2B and Daytona figures understate real cost.

---

## Requirements

Node 20+ (developed on 24), pnpm workspaces, strict TypeScript.
Python 3 is only needed for the Modal sidecar in Phase 2.
