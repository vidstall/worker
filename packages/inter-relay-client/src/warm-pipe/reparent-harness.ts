/**
 * Make-before-break re-parent primitive (T6 — §3.4, REQ-RMS-046) — a thin
 * ordering primitive for cascade-tree re-derivation: bring the new parent
 * edge fully up before tearing down the old one.
 *
 * Split out of the former `inter-relay.ts` (see warm-pipe/index.ts).
 */

// ── Make-before-break re-parent primitive (T6 — §3.4, REQ-RMS-046) ──────

/**
 * §3.4 (REQ-RMS-046) — the injected EFFECTS a make-before-break re-parent drives.
 * Kept as callbacks so the ORDERING primitive is unit-provable with a SYNTHETIC
 * layout diff — no real relay death, no live media path (that wiring is T-C).
 *
 * Each effect is a VOID-returning callback so BOTH a sync effect (whose return
 * value is ignored — e.g. `events.push(...)` returning a number) AND an async
 * effect (returning a `Promise<void>`) assign cleanly (TS's void-return
 * relaxation — a bare `void | Promise<void>` union would reject the number).
 * `reparent` `await`s each call, so when an effect IS async the returned promise
 * is awaited and the strict `open → produce → close` order still holds.
 */
export interface ReparentEffects {
  /** Open + connect the NEW parent edge (mint local from the new pipe). */
  openEdge: (parentId: string) => void;
  /** Begin producing the room's media on the NEW (now-open) edge. */
  produceOn: (parentId: string) => void;
  /** Tear down the OLD parent edge — driven ONLY after the new edge is producing. */
  closeEdge: (parentId: string) => void;
}

/** The make-before-break re-parent primitive (see {@link makeReparentHarness}). */
export interface ReparentHarness {
  /**
   * Re-parent a room from `oldParentId` to `newParentId` make-before-break.
   * `oldParentId === null` = the node is acquiring its FIRST parent (nothing to
   * close). `oldParentId === newParentId` = the parent did not change → complete
   * no-op (the live edge is neither re-opened nor torn down).
   */
  reparent(
    roomId: string,
    oldParentId: string | null,
    newParentId: string,
  ): Promise<void>;
}

/**
 * §3.4 (REQ-RMS-046) — build a make-before-break re-parent primitive over the three
 * injected {@link ReparentEffects}. When a node's tree parent changes (layout
 * re-derivation), the node MUST keep local clients on continuous media (no gap):
 *
 *   1. open + connect the NEW parent edge and begin producing on it, THEN
 *   2. ONLY AFTER the new edge is producing, tear down the OLD parent edge.
 *
 * The overlap window (both parents live) is safe: each hop mints a FRESH local id
 * (Task 5/T6 `produceLocalFromPipe` freshId) and the forward drain dedups PER-ROOM
 * on the immutable `originProducerId` (Task 5/B4 `producedOrigins`), so the transient
 * double-parent does NOT double-produce — local clients see the old minted producer
 * until the new one is up.
 *
 * MECHANISM ONLY — this is a thin ordering primitive with injected effects, unit-proven
 * against a synthetic layout diff. It is NOT wired to a real relay death, RoomAssigned
 * handler, or any live fan site; T-C (T7) drives it from a real re-derivation. No retry /
 * error-recovery beyond the strict await-ordering (a throwing effect propagates to the
 * caller, who owns the re-derivation retry).
 *
 * ⚠️ PARTIAL-FAILURE CAVEAT (no rollback). If a mid-sequence effect throws AFTER
 * `openEdge(new)` already succeeded — i.e. `produceOn(new)` or `closeEdge(old)` throws —
 * the exception propagates to the caller but the NEW parent edge is left OPEN with no
 * rollback. A naive caller that just retries the re-derivation would call `openEdge(new)`
 * AGAIN on an already-open edge → double-open / resource leak. Therefore **T-C MUST make
 * `openEdge` idempotent OR close the orphaned new edge before any re-derivation retry.**
 *
 * T-C WIRING OBLIGATIONS (deferred design decisions — resolve these when wiring, do NOT
 * inherit them silently):
 *   - **Room-scoping (M-1):** `reparent(roomId, …)` carries `roomId` but the body never
 *     reads it and the `(parentId) => void` effects can't see it. T-C must pick a model —
 *     thread it (`openEdge(roomId, parentId)`) OR build a per-room harness via closures
 *     (`makeReparentHarness({ openEdge: (pid) => openForRoom(roomId, pid) })`). `roomId` is
 *     a forward-contract placeholder today (pinned by the plan's test signature).
 *   - **Async self-documentation (M-2):** the effect type is `(parentId) => void` (chosen
 *     so the plan's number-returning `events.push(...)` test compiles; `reparent` still
 *     awaits each so async ordering holds). At T-C, consider `(parentId) => void |
 *     Promise<void>` with block-body effects so the async contract is visible in the type,
 *     not just this prose.
 *   - **Root-promotion (M-5):** `newParentId` is non-nullable, so `X → null` (an internal
 *     node promoted to root: close old, open none) is NOT representable. Add it if T-C
 *     needs root-promotion.
 */
export function makeReparentHarness(effects: ReparentEffects): ReparentHarness {
  return {
    async reparent(roomId, oldParentId, newParentId): Promise<void> {
      // Parent unchanged → the re-derivation did not move this node: no-op. Never
      // re-open nor tear down the already-live edge (a re-open+close would gap it).
      if (oldParentId === newParentId) return;
      // MAKE: bring the NEW parent edge fully up (open + connect, then produce) FIRST.
      // Await each so the order holds even when the injected effects are async.
      await effects.openEdge(newParentId);
      await effects.produceOn(newParentId);
      // BREAK: ONLY NOW tear down the OLD parent edge. A node acquiring its FIRST
      // parent (oldParentId === null) has no old edge to close.
      if (oldParentId !== null) {
        await effects.closeEdge(oldParentId);
      }
    },
  };
}
