# 🏁 Sandbox Grand Prix

A benchmark harness that runs **identical AI-agent tasks across multiple sandbox
providers** (E2B, Modal, Daytona) and compares them on cold start, wall-clock
time, SDK ergonomics, and cost.

TypeScript orchestrator + dashboard; the agent tasks themselves run Python
inside the sandboxes.

> **Status: Phase 3 complete — the project is done.** All three adapters (E2B, Modal, Daytona) and all
> four races (SPRINT, MARATHON, ESCAPE ROOM, RELAY) are implemented and have been
> run end to end against **real infrastructure on all three providers** — see
> [Measured results](#measured-results). Zero orphaned sandboxes across ~100
> created. The live dashboard is built and reads `results/` as races land.

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
| `pricing.json` | Editable $/vCPU-hr rates used for the cost column |

---

## The dashboard

```bash
pnpm dashboard      # http://localhost:4100
```

A pit-wall telemetry board that reads `results/` and repaints as races land —
start a race in one terminal and watch it appear without a reload.

| Panel | What it shows |
| --- | --- |
| **Masthead** | Races logged, cumulative sandbox seconds, errors captured, and a running cost counter that eases to each new total |
| **Timing tower** | Classic motorsport leaderboard — position, livery, cold-start p50, gap to leader, p95, a min–p95 range bar with a median tick, total, alive seconds, cost, errors and retries |
| **Cold start distribution** | A strip plot drawing *every* sample, not a histogram — with ~10 laps per provider, binning would hide exactly the tail outliers you care about |
| **Lap times** | Per-provider sparklines on a shared vertical scale; failed laps are hollow and ringed |
| **Where the time went** | For single-iteration races, a step breakdown instead of a one-point "distribution" — this is where Marathon's `pip install` dominance and its deliberately-red test segment show up |
| **Escape room matrix** | provider × probe → outcome, plus a spec plate per provider showing the machine actually delivered |
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
sgp providers                  # readiness + adapter size
```

Useful flags:

| Flag | Effect |
| --- | --- |
| `--iterations <n>` | Override the per-task default (for RELAY, this is the fleet size) |
| `--template <id>` | Provider image/template (e.g. a registry tag for Modal) |
| `--formation-lap` | One throwaway sandbox per provider before measuring, to absorb first-call costs like image pulls. Applied uniformly to every provider or not at all |
| `--quiet` | Hide live lap-by-lap output |

### Report columns

| Column | Meaning |
| --- | --- |
| Cold p50 / p95 / min | `createSandbox()` latency distribution |
| Total | Wall clock for the provider's whole race |
| Alive | Total sandbox-alive seconds (the cost basis) |
| Cost | `alive_s × (vCPU × $/vCPU-hr + GiB × $/GiB-hr) / 3600` |
| Err / Retry | Errors recorded, and sandbox-creation retries consumed |
| LOC | Significant lines of adapter code — the SDK-ergonomics metric |

---

## The races

| Task | What it measures | Status |
| --- | --- | --- |
| **SPRINT** | Cold-start distribution. Write a Python script, exec it, read stdout (computes the 10,000th prime). 10 iterations. | ✅ Phase 1 |
| **MARATHON** | Multi-step stateful session in one sandbox: pip install, write a Flask app + pytest tests, run them, break a test, fix it, re-run until green. Does state persist across `exec` calls? | ✅ Phase 2 |
| **ESCAPE ROOM** | Observational isolation probes: outbound HTTP, `/etc/passwd` + `/proc`, 2 GB disk write, 200 processes, OOM. Records allowed / blocked / killed — not pass/fail. Also records the machine actually delivered. | ✅ Phase 2 |
| **RELAY** | 20 parallel sandboxes per provider mapping over shards of a 100k-row synthetic CSV. Measures parallel provisioning throughput and 429s. | ✅ Phase 2 |

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

### SDK ergonomics (measured)

| Provider | Adapter LOC | Made of |
| --- | --- | --- |
| Daytona | 44 | one TS file |
| E2B | 46 | one TS file |
| Modal | 425 | TS adapter + stdio RPC client + Python sidecar |

Modal's number is charged honestly: the sidecar and its RPC plumbing exist
*only* because the adapter avoids a TypeScript SDK, so they are a real cost of
this integration path. But it is a cost of **our chosen architecture**, not an
inherent property of Modal — Modal now ships a TS SDK. Swapping to it is a
one-file change (`packages/core/src/providers/modal.ts` plus its registry
entry) and would be expected to land Modal near the other two. Treat the 425
as "cost of the sidecar approach", not "Modal is 9× harder to integrate".

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

`scripts/selfcheck.ts` injects faults into a mock provider and asserts all 17
invariants — retry-once-then-give-up, always-destroy (including when the task
body throws), no exec retry, destroy-failure tolerance, and for the parallel
fleet path: every sandbox destroyed, genuine concurrency, and one failing shard
not taking the fleet down.

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

| Provider | $/vCPU-hr | $/GiB-hr | Source |
| --- | --- | --- | --- |
| E2B | 0.0504 | 0 | project default |
| Daytona | 0.0504 | 0 | project default |
| Modal | 0.070956 | 0.024012 | [modal.com/pricing](https://modal.com/pricing) Sandboxes tier, checked 2026-08-28: $0.00003942/core/sec where 1 core = 2 vCPU; memory $0.00000667/GiB/sec |

Cost is derived from **sandbox-alive seconds** measured by the harness
(`createSandbox` completion → `destroy` completion), not from provider billing
APIs, so treat it as a modelled estimate.

`default_vcpus` and `default_mem_gib` are **assumptions**. Run
`sgp race --task escape` to record what each provider actually hands out — the
ESCAPE ROOM task reports schedulable CPUs, the cgroup CPU quota, the memory cap
and the kernel — then calibrate `pricing.json` against that. The Modal adapter
pins its request (`cpu=1.0` core, 2048 MiB) so its row is grounded rather than
inheriting an unknown default.

---

## Measured results

Full three-way grand prix, 2026-08-28, all providers on their default images.
Every number below came out of `sgp race --all`; nothing is hand-written.

### SPRINT — cold start (10 laps each)

| Provider | p50 | p95 | min | Correct | Cost |
| --- | --- | --- | --- | --- | --- |
| **e2b** | **118 ms** | 513 ms | 109 ms | 10/10 | $0.00011 |
| daytona | 123 ms | **147 ms** | 119 ms | 10/10 | $0.00018 |
| modal | 158 ms | 280 ms | 151 ms | 10/10 | $0.00103 |

E2B has the fastest median but the longest tail; Daytona is the most
consistent (p95 only 24 ms above p50).

### MARATHON — stateful session

All three completed the full cycle: deps and files persisted across separate
`exec` calls, the deliberately-broken test failed, and the suite went green
after the fix.

| Provider | Cold start | pip install | Cost |
| --- | --- | --- | --- |
| e2b | 200 ms | 1560 ms | $0.00012 |
| daytona | 299 ms | **1036 ms** | $0.00021 |
| modal | 362 ms | 2233 ms | $0.00039 |

### ESCAPE ROOM — isolation (observational)

| Probe | e2b | modal | daytona |
| --- | --- | --- | --- |
| outbound_http | allowed | allowed | **blocked** (HTTP 403) |
| read_etc_passwd | allowed | allowed | allowed |
| list_proc | allowed — **95 PIDs visible** | allowed — 4 PIDs | allowed — 11 PIDs |
| disk_2gb | **blocked** at 992 MB (ENOSPC) | allowed (2048 MB) | allowed (2048 MB) |
| fork_200 | allowed | allowed | allowed |
| memory_oom | **killed** ~1536 MB | allowed (no cap) | **killed** ~768 MB |

Machine as delivered:

| Provider | CPU | Memory | Disk | Kernel |
| --- | --- | --- | --- | --- |
| e2b | 2 schedulable | no cap reported | 0.97 GiB free | 6.1.158+ |
| modal | 17 schedulable | 376 GiB cap | unreported | `4.19.0-gvisor` → **gVisor** |
| daytona | 64 schedulable, **cgroup quota 1 core** | 1 GiB cap | 3 GiB free | 6.8.0-138-generic |

Read as observation, not scoring. The real spread: Daytona is the only one that
blocks egress by default; E2B exposes a much wider PID namespace and has a
~1 GiB disk; Modal enforces no memory ceiling on this configuration, so nothing
OOM-killed. E2B and Daytona both OOM-killed as their caps imply. The OOM probe
touches one byte per 4 KiB page precisely so lazily-mapped zero pages cannot
fake an "allowed" result.

### RELAY — 20 parallel sandboxes over 100k rows

| Provider | Shards | Rows | Reduce matches | Throttled | Provisioning window | Creates/sec |
| --- | --- | --- | --- | --- | --- | --- |
| modal | **20/20** | 100,000 | ✅ | 0 | 2366 ms | 8.5 |
| e2b | **20/20** | 100,000 | ✅ | 1 (retried, recovered) | **251 ms** | **79.7** |
| daytona | 10/20 | 50,000 | ❌ | 10 | 372 ms | 26.9 |

This is where the providers actually separate, and it is entirely account-tier
capacity rather than raw speed:

- **E2B** hit `maximum number of concurrent E2B sandboxes (20)` once. The single
  permitted create retry absorbed it and all 20 shards completed.
- **Daytona** hit `Total CPU limit exceeded. Maximum allowed: 10` on half the
  fleet. Only 50,000 of 100,000 rows were processed — and the reduce-vs-local
  reference check correctly flagged the result as **not matching**. A benchmark
  without that check would have reported a plausible-looking half-answer as a
  success.
- **Modal** provisioned all 20 cleanly but with the widest create window on this
  run (2366 ms; an earlier run managed 471 ms, so treat Modal's parallel
  provisioning as high-variance).

Both failure modes are quota, not capability — raising either account's tier
would likely change this table.

### Cost

The entire four-race grand prix across all three providers cost well under
**$0.01** in total.

---

## Requirements

Node 20+ (developed on 24), pnpm workspaces, strict TypeScript.
Python 3 is only needed for the Modal sidecar in Phase 2.
