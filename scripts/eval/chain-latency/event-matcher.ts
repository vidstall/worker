/**
 * Exclusive JSONL/log writers and the exact, first-observation event
 * matcher for the P3 chain-latency measurement harness.
 *
 * Extracted verbatim from measure-chain-latency.ts as part of a pure
 * code-movement refactor; no behavior changes.
 */

import {
  closeSync,
  fsyncSync,
  openSync,
  writeSync,
} from 'node:fs';

import type { SuiEvent } from '@mysten/sui/client';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { EVENT_TIMEOUT_MS, MODULE, SCHEMA_VERSION } from './constants.ts';
import type { ObservedTargetEvent, PendingObservation } from './types.ts';
import { asError, nowPair } from './util.ts';

export class ExclusiveJsonlWriter {
  readonly path: string;
  private readonly fd: number;
  private closed = false;

  constructor(path: string) {
    this.path = path;
    this.fd = openSync(path, 'wx');
  }

  write(record: unknown): void {
    if (this.closed) throw new Error(`writer already closed: ${this.path}`);
    writeSync(this.fd, `${JSON.stringify(record)}\n`, undefined, 'utf8');
    fsyncSync(this.fd);
  }

  close(): void {
    if (this.closed) return;
    fsyncSync(this.fd);
    closeSync(this.fd);
    this.closed = true;
  }
}

export class RunLog {
  private readonly fd: number;
  private closed = false;

  constructor(readonly path: string) {
    this.fd = openSync(path, 'wx');
  }

  write(message: string, context: Record<string, unknown> = {}): void {
    if (this.closed) return;
    const line = JSON.stringify({ at: new Date().toISOString(), message, ...context });
    writeSync(this.fd, `${line}\n`, undefined, 'utf8');
    fsyncSync(this.fd);
    process.stdout.write(`${MODULE}: ${line}\n`);
  }

  close(): void {
    if (this.closed) return;
    fsyncSync(this.fd);
    closeSync(this.fd);
    this.closed = true;
  }
}

/**
 * Exact, first-observation matcher outside EventPoller.
 *
 * Target events are cached by digest so an event that reaches the handler before
 * signAndExecuteTransaction returns is not lost. A duplicate, malformed target,
 * digest/type/room mismatch, or timeout makes the run fail closed.
 */
export class ExactEventMatcher {
  private readonly cachedByDigest = new Map<string, ObservedTargetEvent>();
  private readonly pendingByDigest = new Map<string, PendingObservation>();
  private fatalError: Error | null = null;
  private ignoredEventCount = 0;
  private targetEventCount = 0;

  constructor(
    private readonly targetTypes: ReadonlySet<string>,
    private readonly eventWriter: ExclusiveJsonlWriter,
    private readonly runId: string,
    private readonly traceId: string,
  ) {}

  async observe(event: SuiEvent): Promise<void> {
    const observed = nowPair();
    if (!this.targetTypes.has(event.type)) {
      this.ignoredEventCount += 1;
      return;
    }

    try {
      const txDigest = event.id?.txDigest;
      const eventSeq = event.id?.eventSeq;
      const rawRoomId = (event.parsedJson as { room_id?: unknown } | null)?.room_id;
      if (typeof txDigest !== 'string' || txDigest.length === 0) {
        throw new Error(`target event missing transaction digest: ${event.type}`);
      }
      if (typeof eventSeq !== 'string') {
        throw new Error(`target event missing event sequence: ${event.type} digest=${txDigest}`);
      }
      if (typeof rawRoomId !== 'string') {
        throw new Error(`target event missing room_id: ${event.type} digest=${txDigest}`);
      }

      const target: ObservedTargetEvent = {
        ...observed,
        txDigest,
        eventType: event.type,
        eventSeq,
        roomId: normalizeSuiAddress(rawRoomId),
        timestampMs: event.timestampMs ?? null,
      };
      this.targetEventCount += 1;
      this.eventWriter.write({
        schema_version: SCHEMA_VERSION,
        record_type: 'observed_event',
        run_id: this.runId,
        trace_id: this.traceId,
        tx_digest: target.txDigest,
        event_type: target.eventType,
        event_seq: target.eventSeq,
        room_id: target.roomId,
        chain_timestamp_ms: target.timestampMs,
        observed_wall_iso: target.wallIso,
        observed_wall_epoch_ms: target.wallEpochMs,
        observed_mono_ms: target.monoMs,
      });

      if (this.cachedByDigest.has(txDigest)) {
        throw new Error(`duplicate target event for digest ${txDigest}`);
      }

      const pending = this.pendingByDigest.get(txDigest);
      if (pending === undefined) {
        this.cachedByDigest.set(txDigest, target);
        return;
      }

      this.assertExpected(target, pending.eventType, pending.roomId);
      clearTimeout(pending.timer);
      this.pendingByDigest.delete(txDigest);
      pending.resolve(target);
    } catch (error) {
      const failure = asError(error);
      this.fail(failure);
      throw failure;
    }
  }

  waitFor(
    txDigest: string,
    eventType: string,
    roomId: string,
    timeoutMs = EVENT_TIMEOUT_MS,
  ): Promise<ObservedTargetEvent> {
    this.throwIfFatal();
    const normalizedRoomId = normalizeSuiAddress(roomId);
    if (this.pendingByDigest.has(txDigest)) {
      throw new Error(`duplicate observation waiter for digest ${txDigest}`);
    }

    const cached = this.cachedByDigest.get(txDigest);
    if (cached !== undefined) {
      this.assertExpected(cached, eventType, normalizedRoomId);
      this.cachedByDigest.delete(txDigest);
      return Promise.resolve(cached);
    }

    return new Promise<ObservedTargetEvent>((resolveObservation, rejectObservation) => {
      const timer = setTimeout(() => {
        this.pendingByDigest.delete(txDigest);
        const failure = new Error(
          `timed out after ${timeoutMs}ms waiting for ${eventType} digest=${txDigest} room=${normalizedRoomId}`,
        );
        this.fail(failure);
        rejectObservation(failure);
      }, timeoutMs);
      this.pendingByDigest.set(txDigest, {
        eventType,
        roomId: normalizedRoomId,
        resolve: resolveObservation,
        reject: rejectObservation,
        timer,
      });
    });
  }

  stats(): { targetEventCount: number; ignoredEventCount: number } {
    return {
      targetEventCount: this.targetEventCount,
      ignoredEventCount: this.ignoredEventCount,
    };
  }

  assertDrained(): void {
    this.throwIfFatal();
    if (this.pendingByDigest.size !== 0) {
      throw new Error(`matcher still has ${this.pendingByDigest.size} pending observation(s)`);
    }
    if (this.cachedByDigest.size !== 0) {
      throw new Error(
        `matcher has ${this.cachedByDigest.size} unconsumed target event(s): ${[...this.cachedByDigest.keys()].join(',')}`,
      );
    }
  }

  private assertExpected(
    event: ObservedTargetEvent,
    expectedType: string,
    expectedRoomId: string,
  ): void {
    if (event.eventType !== expectedType) {
      throw new Error(
        `event type mismatch for ${event.txDigest}: expected ${expectedType}, got ${event.eventType}`,
      );
    }
    if (event.roomId !== expectedRoomId) {
      throw new Error(
        `event room mismatch for ${event.txDigest}: expected ${expectedRoomId}, got ${event.roomId}`,
      );
    }
  }

  private fail(error: Error): void {
    if (this.fatalError === null) this.fatalError = error;
    for (const [digest, pending] of this.pendingByDigest) {
      clearTimeout(pending.timer);
      pending.reject(
        new Error(`event matcher failed while waiting for ${digest}: ${this.fatalError.message}`),
      );
    }
    this.pendingByDigest.clear();
  }

  private throwIfFatal(): void {
    if (this.fatalError !== null) throw this.fatalError;
  }
}
