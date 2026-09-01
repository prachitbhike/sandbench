#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';
import {
  DEFAULT_RESOURCES,
  IMPLEMENTED_TASKS,
  PLANNED_TASKS,
  allProviderNames,
  getTask,
  latestPerTask,
  loadAllResults,
  loadEnv,
  locReport,
  getSlot,
  runRace,
  writeResult,
  type ProviderCapabilities,
  type RaceEvent,
} from '@sgp/core';
import { renderRace } from './report.js';
import { ms } from './format.js';

loadEnv();

const program = new Command();
program
  .name('sgp')
  .description('Sandbox Grand Prix — benchmark AI agent sandboxes head to head')
  .version('0.1.0');

program
  .command('race')
  .description('Run a race against one or more providers')
  .option('-t, --task <name>', `task to run (${PLANNED_TASKS.join(', ')})`)
  .option('-p, --providers <list>', 'comma-separated providers', 'e2b,modal,daytona')
  .option('-n, --iterations <count>', 'override iteration count', (v) => Number.parseInt(v, 10))
  .option('--template <id>', 'provider template/image id')
  .option('--image <map>', 'per-provider image, e.g. modal=python:3.12-slim,daytona=python:3.12-slim')
  .option('--vcpus <n>', 'vCPU to request from every provider', (v) => Number.parseFloat(v))
  .option('--mem <mib>', 'memory (MiB) to request from every provider', (v) => Number.parseInt(v, 10))
  .option('--order <mode>', 'interleaved (default) or sequential', 'interleaved')
  .option('--all', 'run every implemented task')
  .option('--formation-lap', 'run one throwaway sandbox per provider before measuring')
  .option('--no-probes', 'skip readiness and exec round-trip micro-probes')
  .option('--quiet', 'suppress live progress')
  .action(async (opts) => {
    const tasks: string[] = opts.all ? IMPLEMENTED_TASKS : [opts.task];
    if (!opts.all && !opts.task) {
      console.error(pc.red('error: --task <name> is required (or use --all)'));
      process.exitCode = 1;
      return;
    }

    const providers = String(opts.providers)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const templates = parseImageMap(opts.image);
    if (templates === null) {
      console.error(pc.red('error: --image expects provider=tag pairs, e.g. --image modal=python:3.12-slim'));
      process.exitCode = 1;
      return;
    }
    // Ask every provider for the same machine, so a timing difference is the
    // platform rather than whatever size each vendor felt like handing out.
    const resources =
      opts.vcpus || opts.mem
        ? {
            vcpus: opts.vcpus ?? DEFAULT_RESOURCES.vcpus,
            memMib: opts.mem ?? DEFAULT_RESOURCES.memMib,
          }
        : undefined;

    for (const taskName of tasks) {
      const task = getTask(taskName);
      if (!task) {
        const planned = PLANNED_TASKS.includes(taskName);
        console.error(
          pc.red(
            planned
              ? `error: task "${taskName}" is not implemented yet (available: ${IMPLEMENTED_TASKS.join(', ')})`
              : `error: unknown task "${taskName}" (available: ${IMPLEMENTED_TASKS.join(', ')})`,
          ),
        );
        process.exitCode = 1;
        continue;
      }

      const result = await runRace({
        task,
        providers,
        ...(opts.iterations ? { iterations: opts.iterations } : {}),
        ...(opts.template ? { template: opts.template } : {}),
        ...(templates ? { templates } : {}),
        ...(resources ? { resources } : {}),
        order: opts.order === 'sequential' ? 'sequential' : 'interleaved',
        ...(opts.formationLap ? { formationLap: true } : {}),
        probes: opts.probes !== false,
        ...(opts.quiet ? {} : { onEvent: liveLogger() }),
      });

      const path = writeResult(result);
      console.log(renderRace(result));
      console.log(pc.dim(`  saved → ${path}\n`));
    }
  });

program
  .command('report')
  .description('Compare the latest run of each task')
  .option('--json', 'emit raw JSON instead of a table')
  .option('-t, --task <name>', 'only this task')
  .option('--all-runs', 'show every run, not just the latest per task')
  .action((opts) => {
    const all = loadAllResults();
    if (all.length === 0) {
      console.error(pc.yellow('No results yet. Run: sgp race --task sprint --providers e2b'));
      process.exitCode = 1;
      return;
    }

    let races = opts.allRuns ? all : [...latestPerTask(all).values()];
    if (opts.task) races = races.filter((r) => r.task === opts.task);

    if (races.length === 0) {
      console.error(pc.yellow(`No results for task "${opts.task}".`));
      process.exitCode = 1;
      return;
    }

    if (opts.json) {
      console.log(JSON.stringify(opts.allRuns || opts.task ? races : races, null, 2));
      return;
    }

    races.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (const r of races) console.log(renderRace(r));
  });

program
  .command('providers')
  .description('Show provider readiness, integration facts and adapter size')
  .action(() => {
    const names = [...allProviderNames(), 'local'];
    const loc = locReport(names);
    console.log('');
    for (const n of names) {
      const info = loc[n]!;
      const slot = getSlot(n);
      let caps: ProviderCapabilities | null = null;
      let missing: string[] = [];
      try {
        const impl = slot?.make?.();
        caps = impl?.capabilities ?? null;
        missing = impl?.missingEnv() ?? [];
      } catch {
        /* constructing an adapter must never break `sgp providers` */
      }
      const ready = missing.length === 0 ? pc.green('ready') : pc.yellow(`needs ${missing.join(', ')}`);
      const tag = n === 'local' ? pc.dim(' (self-test fixture, no isolation)') : '';
      console.log(`  ${pc.bold(n.padEnd(9))} ${ready}${tag}`);
      // Split the line count: the scaffolding is a cost of our integration
      // path, not evidence that the vendor's SDK is harder to use.
      const locLine = info.scaffolding
        ? `${info.adapter ?? 0} lines of adapter + ${info.scaffolding} of scaffolding`
        : `${info.adapter ?? '—'} lines of adapter`;
      console.log(`    ${pc.dim(locLine)}`);
      if (caps) {
        console.log(
          `    ${pc.dim(
            [
              caps.nativeTsSdk ? 'native TS SDK' : `via ${caps.externalRuntime ?? 'external runtime'}`,
              `size: ${caps.resourceControl}`,
              caps.registryImages ? 'registry images' : 'templates only',
              `default image: ${caps.defaultTemplate ?? 'provider default'}`,
            ].join(' · '),
          )}`,
        );
        for (const note of caps.notes ?? []) console.log(`    ${pc.dim(`- ${note}`)}`);
      }
      console.log('');
    }
  });

/** `--image modal=python:3.12-slim,daytona=python:3.12-slim` */
function parseImageMap(raw: unknown): Record<string, string> | undefined | null {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const pair of String(raw).split(',')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) return null;
    out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return out;
}

function liveLogger(): (e: RaceEvent) => void {
  return (e) => {
    switch (e.type) {
      case 'race:start':
        console.log(
          `\n${pc.bold(pc.cyan('▸ lights out'))} ${pc.dim(`task=${e.task} providers=${e.providers.join(',')} laps=${e.iterations} order=${e.order}`)}`,
        );
        break;
      case 'provider:dns':
        console.log(`  ${pc.gray('◦')} ${pc.gray(`${e.provider} DNS — ${e.reason}`)}`);
        break;
      case 'provider:start':
        console.log(`  ${pc.bold(e.provider)} ${pc.dim('warming up…')}`);
        break;
      case 'provider:formationLap':
        console.log(`    ${pc.dim(`formation lap ${e.ok ? 'complete' : 'failed'}`)}`);
        break;
      case 'iteration:end': {
        const mark = e.ok ? pc.green('✓') : pc.red('✗');
        const cold = e.coldStartMs !== undefined ? `cold ${ms(e.coldStartMs)}` : 'cold —';
        const ready = e.timeToReadyMs !== undefined ? `ready ${ms(e.timeToReadyMs)}` : 'ready —';
        console.log(
          `    ${mark} ${pc.bold(e.provider.padEnd(8))} lap ${String(e.iteration + 1).padStart(2)}  ` +
            `${cold.padEnd(13)} ${ready.padEnd(14)} total ${ms(e.totalMs)}`,
        );
        break;
      }
      default:
        break;
    }
  };
}

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(pc.red(`fatal: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
