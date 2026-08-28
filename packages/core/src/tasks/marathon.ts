import type { IterationResult } from '../types.js';
import type { Task, TaskContext } from './types.js';

const APP_PY = `from flask import Flask, jsonify, request

app = Flask(__name__)

@app.get("/health")
def health():
    return jsonify(status="ok")

@app.get("/sum/<int:a>/<int:b>")
def add(a, b):
    return jsonify(result=a + b)

@app.post("/echo")
def echo():
    payload = request.get_json(silent=True) or {}
    return jsonify(echo=payload)
`;

const TESTS_PY = `from app import app
import pytest

@pytest.fixture
def client():
    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c

def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.get_json()["status"] == "ok"

def test_sum(client):
    r = client.get("/sum/2/3")
    assert r.get_json()["result"] == 5

def test_echo(client):
    r = client.post("/echo", json={"hi": "there"})
    assert r.get_json()["echo"] == {"hi": "there"}
`;

/** Step (e): a test that asserts 2+2==5 — must fail, then get fixed. */
const BROKEN_TEST_PY = `from app import app
import pytest

@pytest.fixture
def client():
    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c

def test_sum_regression(client):
    r = client.get("/sum/2/2")
    assert r.get_json()["result"] == 5, "deliberate failure"
`;

const FIXED_TEST_PY = BROKEN_TEST_PY.replace(
  'assert r.get_json()["result"] == 5, "deliberate failure"',
  'assert r.get_json()["result"] == 4',
);

const WORKDIR = '/tmp/marathon';

export interface MarathonOutput {
  installOk: boolean;
  installSeconds: number | null;
  /** Did files written in an earlier exec survive to a later one? */
  filePersistence: boolean;
  /** Did `pip install` in step (a) still work in step (d)? */
  depPersistence: boolean;
  greenSuite: { passed: number; failed: number; ok: boolean } | null;
  brokenSuite: { passed: number; failed: number; failedAsExpected: boolean } | null;
  repairedSuite: { passed: number; failed: number; ok: boolean } | null;
  /** The full a->e cycle completed as specified. */
  completedFullCycle: boolean;
  notes: string[];
}

interface PytestCounts {
  passed: number;
  failed: number;
  errors: number;
}

/**
 * MARATHON — one sandbox, many steps.
 * Proves (or disproves) that installed deps and written files persist across
 * separate exec() calls, and exercises a realistic edit/test/fix loop.
 */
export const marathonTask: Task = {
  name: 'marathon',
  description: 'Stateful session: pip install, Flask app, pytest, break a test, fix it, re-run.',
  mode: 'perSandbox',
  defaultIterations: 1,

  async run(ctx: TaskContext): Promise<MarathonOutput> {
    const { provider, handle } = ctx;
    const notes: string[] = [];
    const out: MarathonOutput = {
      installOk: false,
      installSeconds: null,
      filePersistence: false,
      depPersistence: false,
      greenSuite: null,
      brokenSuite: null,
      repairedSuite: null,
      completedFullCycle: false,
      notes,
    };

    await provider.exec(handle, `mkdir -p ${WORKDIR}`, { timeoutMs: 30_000 }, 'mkdir');

    // (a) install deps.
    // Debian-based images ship PEP 668 "externally managed" Pythons, where a
    // bare `pip install` refuses. Fall back in the SAME exec so this stays one
    // measured step rather than an exec-level retry.
    const PIP = 'python3 -m pip install --quiet --disable-pip-version-check';
    const install = await provider.exec(
      handle,
      `{ ${PIP} flask pytest 2>&1 && echo __PIP_PLAIN__; } || ` +
        `{ ${PIP} --break-system-packages flask pytest 2>&1 && echo __PIP_BREAK_SYSTEM__; }`,
      { timeoutMs: 300_000 },
      'a:pip-install',
    );
    out.installOk = install.exitCode === 0;
    if (install.stdout.includes('__PIP_BREAK_SYSTEM__')) {
      notes.push('pip needed --break-system-packages (PEP 668 externally-managed image)');
    }
    if (!out.installOk) {
      notes.push(`pip install failed (exit ${install.exitCode}): ${tail(install.stdout || install.stderr)}`);
      return out;
    }

    // (b) write the Flask app
    const wroteApp = await provider.writeFile(handle, `${WORKDIR}/app.py`, APP_PY, 'b:write-app');
    if (!wroteApp) {
      notes.push('writeFile failed for app.py');
      return out;
    }

    // (c) write the passing test suite
    await provider.writeFile(handle, `${WORKDIR}/test_app.py`, TESTS_PY, 'c:write-tests');

    // Persistence probes: a *separate* exec must still see the file and the dep.
    const seesFile = await provider.exec(
      handle, `test -f ${WORKDIR}/app.py && echo PRESENT`, { timeoutMs: 30_000 }, 'probe:file-persistence',
    );
    out.filePersistence = seesFile.stdout.includes('PRESENT');

    const seesDep = await provider.exec(
      handle, 'python3 -c "import flask, pytest; print(\'DEPS_OK\')"', { timeoutMs: 60_000 }, 'probe:dep-persistence',
    );
    out.depPersistence = seesDep.stdout.includes('DEPS_OK');
    if (!out.depPersistence) {
      notes.push('installed deps did NOT survive across exec calls');
    }

    // (d) run the suite and parse output
    const green = await provider.exec(
      handle, `cd ${WORKDIR} && python3 -m pytest -q test_app.py 2>&1`, { timeoutMs: 180_000 }, 'd:pytest-green',
    );
    const greenCounts = parsePytest(green.stdout || green.stderr);
    out.greenSuite = { passed: greenCounts.passed, failed: greenCounts.failed, ok: green.exitCode === 0 };
    if (green.exitCode !== 0) {
      notes.push(`baseline suite was not green (exit ${green.exitCode}): ${tail(green.stdout)}`);
    }

    // (e) introduce a failing test, confirm it fails, fix it, confirm green
    await provider.writeFile(handle, `${WORKDIR}/test_regression.py`, BROKEN_TEST_PY, 'e:write-broken');
    const broken = await provider.exec(
      handle, `cd ${WORKDIR} && python3 -m pytest -q test_regression.py 2>&1`, { timeoutMs: 180_000 }, 'e:pytest-broken',
    );
    const brokenCounts = parsePytest(broken.stdout || broken.stderr);
    out.brokenSuite = {
      passed: brokenCounts.passed,
      failed: brokenCounts.failed,
      // A non-zero exit here is the CORRECT outcome, not an error.
      failedAsExpected: broken.exitCode !== 0 && brokenCounts.failed > 0,
    };
    if (!out.brokenSuite.failedAsExpected) {
      notes.push('deliberately-broken test did not fail as expected');
    }

    await provider.writeFile(handle, `${WORKDIR}/test_regression.py`, FIXED_TEST_PY, 'e:write-fix');
    const repaired = await provider.exec(
      handle, `cd ${WORKDIR} && python3 -m pytest -q 2>&1`, { timeoutMs: 180_000 }, 'e:pytest-repaired',
    );
    const repairedCounts = parsePytest(repaired.stdout || repaired.stderr);
    out.repairedSuite = {
      passed: repairedCounts.passed,
      failed: repairedCounts.failed,
      ok: repaired.exitCode === 0,
    };
    if (!out.repairedSuite.ok) {
      notes.push(`suite still red after fix: ${tail(repaired.stdout)}`);
    }

    out.completedFullCycle = Boolean(
      out.installOk &&
        out.filePersistence &&
        out.depPersistence &&
        out.greenSuite?.ok &&
        out.brokenSuite?.failedAsExpected &&
        out.repairedSuite?.ok,
    );
    return out;
  },

  summarize(iterations: IterationResult[]): Record<string, unknown> {
    const outs = iterations
      .map((i) => i.output as MarathonOutput | undefined)
      .filter((o): o is MarathonOutput => Boolean(o));
    if (outs.length === 0) return { completedFullCycle: 0 };
    const installTimes = iterations
      .flatMap((i) => i.steps.filter((s) => s.name === 'a:pip-install').map((s) => s.durationMs));
    return {
      completedFullCycle: outs.filter((o) => o.completedFullCycle).length,
      filePersistence: outs.every((o) => o.filePersistence),
      depPersistence: outs.every((o) => o.depPersistence),
      brokeAndFixed: outs.filter((o) => o.brokenSuite?.failedAsExpected && o.repairedSuite?.ok).length,
      meanPipInstallMs: installTimes.length
        ? installTimes.reduce((a, b) => a + b, 0) / installTimes.length
        : null,
    };
  },
};

/** Parse pytest's `-q` summary line, e.g. "2 failed, 3 passed in 0.41s". */
export function parsePytest(text: string): PytestCounts {
  const counts: PytestCounts = { passed: 0, failed: 0, errors: 0 };
  for (const m of text.matchAll(/(\d+)\s+(passed|failed|error|errors)\b/g)) {
    const n = Number.parseInt(m[1]!, 10);
    const kind = m[2]!;
    if (kind === 'passed') counts.passed = n;
    else if (kind === 'failed') counts.failed = n;
    else counts.errors = n;
  }
  return counts;
}

function tail(s: string, n = 300): string {
  const t = s.trim();
  return t.length <= n ? t : `…${t.slice(-n)}`;
}
