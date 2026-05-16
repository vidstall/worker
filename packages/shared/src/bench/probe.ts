/**
 * Thin probe utility — wraps an async function or a periodic sample with
 * timing instrumentation. Each daemon owns its own domain-specific probe
 * (mediasoup stats, ping/pong, scoring timer) but shares the timing skeleton
 * to keep the JSONL output uniform.
 */

import type { LatencyMetric } from './types.js';
import type { LatencyWriter } from './writer.js';

/**
 * Wrap an async function so each invocation emits a `LatencyEvent`.
 * Returns a function with the same signature as `fn`.
 */
export function timeAsync<TArgs extends unknown[], TReturn>(
  writer: LatencyWriter | null,
  metric: LatencyMetric,
  fn: (...args: TArgs) => Promise<TReturn>,
  contextFn?: (...args: TArgs) => Record<string, unknown>,
): (...args: TArgs) => Promise<TReturn> {
  if (writer === null) {
    return fn;
  }
  return async (...args: TArgs): Promise<TReturn> => {
    const start = performance.now();
    try {
      return await fn(...args);
    } finally {
      const dur = performance.now() - start;
      writer.write(metric, dur, contextFn ? contextFn(...args) : undefined);
    }
  };
}

/**
 * Wrap a synchronous function so each invocation emits a `LatencyEvent`.
 */
export function timeSync<TArgs extends unknown[], TReturn>(
  writer: LatencyWriter | null,
  metric: LatencyMetric,
  fn: (...args: TArgs) => TReturn,
  contextFn?: (...args: TArgs) => Record<string, unknown>,
): (...args: TArgs) => TReturn {
  if (writer === null) {
    return fn;
  }
  return (...args: TArgs): TReturn => {
    const start = performance.now();
    try {
      return fn(...args);
    } finally {
      const dur = performance.now() - start;
      writer.write(metric, dur, contextFn ? contextFn(...args) : undefined);
    }
  };
}

/**
 * Periodic sampler — invokes `sampleFn` every `intervalMs` and writes the
 * returned value as a `LatencyEvent`. Returns a stop function.
 *
 * `sampleFn` returns `null` to indicate "no sample this tick" (probe not ready,
 * transport stalled, etc.); the writer skips null results.
 */
export function startSampler(
  writer: LatencyWriter | null,
  metric: LatencyMetric,
  intervalMs: number,
  sampleFn: () => Promise<{ value_ms: number; context?: Record<string, unknown> } | null>
    | { value_ms: number; context?: Record<string, unknown> }
    | null,
): () => void {
  if (writer === null) {
    return () => {
      /* no-op */
    };
  }
  const handle = setInterval(() => {
    const result = sampleFn();
    Promise.resolve(result)
      .then((r) => {
        if (r !== null && r !== undefined) {
          writer.write(metric, r.value_ms, r.context);
        }
      })
      .catch(() => {
        /* swallow — probe failures must not crash daemons */
      });
  }, intervalMs);
  return () => clearInterval(handle);
}
