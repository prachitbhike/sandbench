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

export interface SprintOutput {
  value: number | null;
  expected: number;
  correct: boolean;
  computeMs: number | null;
  exitCode: number;
  /** Whether readFile round-tripped the same answer stdout reported. */
  fileRoundTrip: boolean;
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
    const { provider, handle } = ctx;

    const wrote = await provider.writeFile(handle, '/tmp/sprint.py', SCRIPT, 'write:script');
    if (!wrote) {
      return {
        value: null, expected: EXPECTED, correct: false, computeMs: null,
        exitCode: -1, fileRoundTrip: false, stderr: 'writeFile failed',
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

    return {
      value,
      expected: EXPECTED,
      correct: value === EXPECTED,
      computeMs,
      exitCode: res.exitCode,
      fileRoundTrip,
      ...(res.stderr ? { stderr: res.stderr.slice(0, 500) } : {}),
    };
  },

  summarize(iterations: IterationResult[]): Record<string, unknown> {
    const outs = iterations.map((i) => i.output as SprintOutput | undefined).filter(Boolean) as SprintOutput[];
    const correct = outs.filter((o) => o.correct).length;
    const computeSamples = outs.map((o) => o.computeMs).filter((v): v is number => v !== null);
    return {
      iterationsCompleted: iterations.length,
      correctAnswers: correct,
      correctnessRate: iterations.length ? correct / iterations.length : 0,
      fileRoundTripOk: outs.filter((o) => o.fileRoundTrip).length,
      meanInSandboxComputeMs: computeSamples.length
        ? computeSamples.reduce((a, b) => a + b, 0) / computeSamples.length
        : null,
    };
  },
};

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
