#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';
import {
  IMPLEMENTED_TASKS,
  PLANNED_TASKS,
  allProviderNames,
  getTask,
  latestPerTask,
  loadAllResults,
  loadEnv,
  locReport,
  runRace,
  writeResult,
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
  .option('--all', 'run every implemented task')
  .option('--formation-lap', 'run one throwaway sandbox per provider before measuring')
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
        ...(opts.formationLap ? { formationLap: true } : {}),
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
  .description('Show provider readiness and adapter size')
  .action(() => {
    const names = [...allProviderNames(), 'local'];
    const loc = locReport(names);
    console.log('');
    for (const n of names) {
      const info = loc[n]!;
      const files = info.files.length ? info.files.join(', ') : pc.dim('none');
      const tag = n === 'local' ? pc.dim('  (self-test fixture, no isolation)') : '';
      console.log(`  ${pc.bold(n.padEnd(10))} ${String(info.loc ?? '—').padStart(5)} LOC   ${pc.dim(files)}${tag}`);
    }
    console.log('');
  });

function liveLogger(): (e: RaceEvent) => void {
  return (e) => {
    switch (e.type) {
      case 'race:start':
        console.log(
          `\n${pc.bold(pc.cyan('▸ lights out'))} ${pc.dim(`task=${e.task} providers=${e.providers.join(',')} iterations=${e.iterations}`)}`,
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
        console.log(`    ${mark} lap ${String(e.iteration + 1).padStart(2)}  ${cold.padEnd(14)} total ${ms(e.totalMs)}`);
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
