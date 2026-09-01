import type { IterationResult } from '../types.js';
import type { Task, TaskContext } from './types.js';

const TARGET_N = 10_000;
/** Known-good value, used to verify the sandbox actually did the work. */
const EXPECTED = 104_729;

const SCRIPT = `import json, time

def nth_prime(n):
    primes = [2]
    cand = 3
    while len(primes) < n:
        limit = int(cand ** 0.5)
        is_p = True
        for p in primes:
            if p > limit:
                break
            if cand % p == 0:
                is_p = False
                break
        if is_p:
            primes.append(cand)
        cand += 2
    return primes[-1]

t0 = time.perf_counter()
value = nth_prime(${TARGET_N})
elapsed_ms = (time.perf_counter() - t0) * 1000
payload = {"n": ${TARGET_N}, "value": value, "compute_ms": round(elapsed_ms, 3)}
with open("/tmp/sprint_result.json", "w") as f:
    json.dump(payload, f)
print(json.dumps(payload))
`;

/**
 * 1 MiB of deterministic filler.
 *
 * Cold start is a one-time cost; getting code *into* the sandbox is not. An
 * agent that uploads a repo, or streams a build artefact back, pays this on
 * every session, and no amount of fast booting makes up for a slow file
 * channel. Same payload for every provider, so the MB/s figures compare.
 */
const IO_BYTES = 1024 * 1024;
const IO_PAYLOAD = 'sgp-payload-'.repeat(Math.ceil(IO_BYTES / 12)).slice(0, IO_BYTES);
const IO_PATH = '/tmp/sprint_payload.txt';

export interface SprintOutput {
  value: number | null;
  expected: number;
  correct: boolean;
  computeMs: number | null;
  exitCode: number;
  /** Whether readFile round-tripped the same answer stdout reported. */
  fileRoundTrip: boolean;
  /** 1 MiB file-channel timings — what uploading a repo actually costs. */
  io: {
    bytes: number;
    uploadMs: number | null;
    downloadMs: number | null;
    uploadMbPerSec: number | null;
    downloadMbPerSec: number | null;
    intact: boolean;
  };
  stderr?: string;
}

/**
 * SPRINT — the cold-start race.
 * write script -> exec -> parse stdout -> read the result file back.
 */
export const sprintTask: Task = {
  name: 'sprint',
  description: 'Write a Python script, execute it, read stdout (10,000th prime).',
  mode: 'perSandbox',
  defaultIterations: 10,

  async run(ctx: TaskContext): Promise<SprintOutput> {
    const { provider, handle, rec } = ctx;

    const wrote = await provider.writeFile(handle, '/tmp/sprint.py', SCRIPT, 'write:script');
    if (!wrote) {
      return {
        value: null, expected: EXPECTED, correct: false, computeMs: null,
        exitCode: -1, fileRoundTrip: false, io: emptyIo(), stderr: 'writeFile failed',
      };
    }

    const res = await provider.exec(handle, 'python3 /tmp/sprint.py', { timeoutMs: 120_000 }, 'exec:script');

    let value: number | null = null;
    let computeMs: number | null = null;
    const parsed = parseJsonLine(res.stdout);
    if (parsed) {
      value = typeof parsed['value'] === 'number' ? parsed['value'] : null;
      computeMs = typeof parsed['compute_ms'] === 'number' ? parsed['compute_ms'] : null;
    }

    const raw = await provider.readFile(handle, '/tmp/sprint_result.json', 'read:result');
    const fromFile = raw ? parseJsonLine(raw) : null;
    const fileRoundTrip = fromFile?.['value'] === value && value !== null;

    // File channel: push 1 MiB in, pull the same 1 MiB back out.
    await provider.writeFile(handle, IO_PATH, IO_PAYLOAD, 'io:upload');
    const echoed = await provider.readFile(handle, IO_PATH, 'io:download');
    const uploadMs = stepMs(rec, 'io:upload');
    const downloadMs = stepMs(rec, 'io:download');

    return {
      value,
      expected: EXPECTED,
      correct: value === EXPECTED,
      computeMs,
      exitCode: res.exitCode,
      fileRoundTrip,
      io: {
        bytes: IO_BYTES,
        uploadMs,
        downloadMs,
        uploadMbPerSec: throughput(IO_BYTES, uploadMs),
        downloadMbPerSec: throughput(IO_BYTES, downloadMs),
        intact: echoed?.length === IO_BYTES,
      },
      ...(res.stderr ? { stderr: res.stderr.slice(0, 500) } : {}),
    };
  },

  summarize(iterations: IterationResult[]): Record<string, unknown> {
    const outs = iterations.map((i) => i.output as SprintOutput | undefined).filter(Boolean) as SprintOutput[];
    const correct = outs.filter((o) => o.correct).length;
    const computeSamples = outs.map((o) => o.computeMs).filter((v): v is number => v !== null);
    const up = outs.map((o) => o.io?.uploadMbPerSec).filter((v): v is number => typeof v === 'number');
    const down = outs.map((o) => o.io?.downloadMbPerSec).filter((v): v is number => typeof v === 'number');
    return {
      iterationsCompleted: iterations.length,
      correctAnswers: correct,
      correctnessRate: iterations.length ? correct / iterations.length : 0,
      fileRoundTripOk: outs.filter((o) => o.fileRoundTrip).length,
      meanInSandboxComputeMs: computeSamples.length
        ? computeSamples.reduce((a, b) => a + b, 0) / computeSamples.length
        : null,
      uploadMbPerSec: median(up),
      downloadMbPerSec: median(down),
      payloadIntact: outs.length > 0 && outs.every((o) => o.io?.intact),
    };
  },
};

function emptyIo(): SprintOutput['io'] {
  return {
    bytes: IO_BYTES,
    uploadMs: null,
    downloadMs: null,
    uploadMbPerSec: null,
    downloadMbPerSec: null,
    intact: false,
  };
}

/** The instrumentation layer already timed the call; read it back by label. */
function stepMs(rec: TaskContext['rec'], label: string): number | null {
  const step = rec.steps.find((s) => s.name === label && s.ok);
  return step ? step.durationMs : null;
}

function throughput(bytes: number, ms: number | null): number | null {
  if (ms === null || ms <= 0) return null;
  return Number((bytes / 1024 / 1024 / (ms / 1000)).toFixed(2));
}

/** Median, not mean — one slow transfer should not define the figure. */
function median(v: number[]): number | null {
  if (v.length === 0) return null;
  const s = [...v].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Number(((s[mid - 1]! + s[mid]!) / 2).toFixed(2));
}

/** Providers sometimes prepend noise; take the last line that parses as a JSON object. */
function parseJsonLine(text: string): Record<string, unknown> | null {
  const lines = text.trim().split('\n').reverse();
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const v = JSON.parse(t) as unknown;
      if (v && typeof v === 'object') return v as Record<string, unknown>;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}
