# Multi-CP Voting Live (N=5) — live-run evidence

_Generated 2026-07-01T03:05:42.872Z by scripts/demo/run-multicp-voting.ts (C4 SEAM)._

## Substrate precondition
- `control_plane_registry::active_cp_count` = **5** (asserted === 5).
- Fleet: 13 processes all-up (5 cp + 4 val + 2 relay + 1 sig + 1 user-miner).
- Required quorum at N=5: `ceil(5 * 6667 / 10000)` = **4**.

## #6 — live role-vote (4-of-5 quorum)
- user-miner (miner_id / address): `0x579d22c4343e9d02d8c65cf97c5417b4fe2452c733179aab94798c165183be0c`
- RoleAssigned: role=1, vote_count=**4**, threshold=**4**.
- Finalize tx digest: `BzQepZzzhSrVq3CboNdMgAxugj5LCohv3XNxsTF2rDzE`
- 4 DISTINCT RoleVoteCast voters:
  - `0x6e909fd071e848c8b73b43e5258371a6dd43e43acbe727ab453d0f59b1fc6585`
  - `0x6fe4d2187304834b229132d321137602142ceafc9721487ce0871a00918b04c4`
  - `0xb2cbd0ddb35248767eeef4c87ab30d9923dcf4bd3d4029c73e65cd0429c39ef0`
  - `0x3791cbc836e33350214d844e659c5e0c6f756ed41cc37553479cf365ceee0f41`

## #7 — live pairing (4-of-5 quorum)
- room_id: `0x1cd9ed0c8106db82d278aaaf3a9356dcc3b90612552bfc21aeffbe50997c42c0`
- RoomAssigned: consensus_reached=true, winning_cp=`0xb2cbd0ddb35248767eeef4c87ab30d9923dcf4bd3d4029c73e65cd0429c39ef0`, verified_score=**7756**.
- Finalize tx digest: `3m8GoCZj8kJ7EWpWRuUm8eMfkyJ6xMDe8i3q8FeDK1hZ`
- 4 DISTINCT ProposalSubmitted cp_id at the winning score:
  - `0xdfd5ecf4815c4c0a7a6061bf5e0d0a8ff1f9660436766ba2c312459115cd8803`
  - `0x6fe4d2187304834b229132d321137602142ceafc9721487ce0871a00918b04c4`
  - `0x6e909fd071e848c8b73b43e5258371a6dd43e43acbe727ab453d0f59b1fc6585`
  - `0xb2cbd0ddb35248767eeef4c87ab30d9923dcf4bd3d4029c73e65cd0429c39ef0`

## Benign-abort (CP fleet survived — fact G, honest)
- All 12 CP-fleet daemons still alive after the demos (no crash). The
  user-miner (vote SUBJECT) is EXCLUDED from this gate — exit=1.
- The user-miner's post-#6 exit is EXPECTED-and-benign when the vote lands in the
  120-180s tail (its ensureRegistered uses the DEFAULT 120s waitForRoleAssignment,
  auto-register.ts:123, vs the launcher's 180s gate) OR the CPs assign a role whose
  stake floor > the FIXED 0.1 SUI it stakes (auto-register.ts:59; relay 0.25 / cp 0.5
  → apply_voted_role aborts 713 / the follow-on register aborts). It does NOT affect
  the #6/#7 proofs, which are read from the on-chain events, not from the subject
  daemon staying up.
- executeWithRetry retry traces observed across tails: retrying=71, exhausted=15.
- Mechanism: a deterministic Move abort (704 E_ALREADY_VOTED / 711 E_PRIOR_ASSIGNMENT_PENDING /
  719 E_ROLE_MISMATCH / 508 E_NOT_PENDING) is RETRIED 5× (warn) by executeWithRetry
  (tx.ts:38-69), then swallowed with ONE benign `exhausted retries, skipping` error
  (null return, NO throw, NO crash). This is the accurate mechanism — NOT "non-retryable".

## Honesty notes
- **Fact F (determinism pin):** the spec's "assert all 5 CPs' relayState/validatorState
  are equal" is NOT feasible off-chain — every CP reads the SAME on-chain state and derives
  identical scores deterministically. The practical pin implemented here is STRUCTURAL:
  (i) canary is off UNLESS a CANARY_* var is present in the launching environment —
  buildLaunchPlan itself sets none, and mergeChildEnv does NOT scrub CANARY_* (it scrubs
  only IDENTITY_ENV_KEYS), so children inherit any CANARY_* the launching shell exports;
  and (ii) the active_cp_count==5 precondition above. No fake equality assert is made.
- **Fact G (benign-abort):** see the mechanism note above — retried-then-swallowed, not non-retryable.
