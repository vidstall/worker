/**
 * @dvconf/validator-daemon/daemon -- barrel export.
 *
 * The validator daemon's core lifecycle, split out of the former `index.ts`
 * monolith for readability: `state.ts` (the `DaemonState`/`ActiveRoom`/
 * `ValidatorConfig` types), `bootstrap.ts` (`startHealthMonitor` +
 * `startDaemon`, which itself delegates to `event-pollers.ts` and
 * `measurement-cycle.ts`), and `shutdown.ts` (`stopDaemon` + the F60
 * graceful-shutdown plan/watcher wiring). `canary/` is untouched and is
 * imported directly by `bootstrap.ts` -- it is NOT re-exported here.
 */

export type { ValidatorConfig, ActiveRoom, DaemonState } from './state.js';

export { startHealthMonitor, startDaemon } from './bootstrap.js';

export {
  stopDaemon,
  buildValidatorShutdownPlan,
  startValidatorSelfShutdownWatcher,
  type ValidatorShutdownDeps,
} from './shutdown.js';
