import { sprintTask } from './sprint.js';
import { marathonTask } from './marathon.js';
import { escapeTask } from './escape.js';
import { relayTask } from './relay.js';
import type { Task } from './types.js';

const TASKS: Record<string, Task> = {
  sprint: sprintTask,
  marathon: marathonTask,
  escape: escapeTask,
  relay: relayTask,
};

/** Aliases so `--task escape-room` and `--task escaperoom` both work. */
const ALIASES: Record<string, string> = {
  'escape-room': 'escape',
  escaperoom: 'escape',
};

export const IMPLEMENTED_TASKS = Object.keys(TASKS);
export const PLANNED_TASKS = ['sprint', 'marathon', 'escape', 'relay'];

export function getTask(name: string): Task | undefined {
  const key = name.toLowerCase().trim();
  return TASKS[ALIASES[key] ?? key];
}

export { sprintTask, marathonTask, escapeTask, relayTask };
export { PROBE_NAMES } from './escape.js';
export type { ProbeOutcome, ProbeResult, EscapeOutput } from './escape.js';
export type { MarathonOutput } from './marathon.js';
export type { ShardOutput, RelayReduction } from './relay.js';
export type { SprintOutput } from './sprint.js';
export type { Task, TaskContext, FleetContext, FleetTask, PerSandboxTask } from './types.js';
