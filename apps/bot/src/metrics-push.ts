/**
 * Bot-side direct-to-Prometheus-Pushgateway quality-metric push -- apps/bot's
 * counterpart to services/client/client/src/lib/metrics-push.ts (browser
 * client). Both exist for the same reason: relay's `POST /stats/report`
 * bridge (apps/relay/src/metrics-request-handlers.ts's handleStatsReport,
 * folded into the dvconf_relay_peer_* gauge family) requires the caller to
 * know its CURRENT relay's URL, so a standby cutover (or a primary that's
 * simply dead) either misroutes the report or silently drops it. The
 * browser client already migrated off that bridge entirely; this gives the
 * bot the same fix -- without it, cli/observer/metrics_user.py::
 * collect_user_sample() (and every Grafana panel keyed off
 * dvconf_relay_peer_*, e.g. peer-quality.json's $room/$peer variables) never
 * sees a bot session at all, even though relay's own SERVER-observed
 * dvconf_rtc_* metrics (rtc-quality-metrics.ts) are unaffected and keep
 * working either way.
 *
 * FIELD_METRIC_NAME below is a hand-kept MIRROR of both
 * metrics-server.ts's PEER_QUALITY_METRIC_INFO and the client's own
 * metrics-push.ts copy -- three separate packages (bot / relay / client)
 * with no shared package between them, so keep the name list in sync by
 * hand if any of them changes.
 *
 * Deliberately no avg/min/max aggregate lines (unlike the client's version):
 * the client tracks a running session aggregate elsewhere
 * (useRoomConnectionQuality.ts) that the bot has no equivalent of yet: only
 * the live `dvconf_relay_peer_*` gauges below are pushed. peer-quality.json's
 * "(Session Average)" panels simply won't show bot rows until that's added
 * -- the "(Live)" panels (and the Is-Bot / room variable resolution that was
 * silently broken without ANY dvconf_relay_peer_* data) are what this fixes.
 */
import type { Logger } from '@dvconf/shared';

const FIELD_METRIC_NAME: Record<string, string> = {
  latencyMs: 'dvconf_relay_peer_latency_ms',
  packetLoss: 'dvconf_relay_peer_packet_loss',
  jitterMs: 'dvconf_relay_peer_jitter_ms',
  bitrateUpKbps: 'dvconf_relay_peer_bitrate_up_kbps',
  bitrateDownKbps: 'dvconf_relay_peer_bitrate_down_kbps',
  resolutionWidth: 'dvconf_relay_peer_resolution_width',
  resolutionHeight: 'dvconf_relay_peer_resolution_height',
  framerate: 'dvconf_relay_peer_framerate',
  packetReorderingRate: 'dvconf_relay_peer_packet_reordering_rate',
  encodeLatencyMs: 'dvconf_relay_peer_encode_latency_ms',
  decodeLatencyMs: 'dvconf_relay_peer_decode_latency_ms',
  freezeCount: 'dvconf_relay_peer_freeze_count',
  pauseCount: 'dvconf_relay_peer_pause_count',
  connectionSetupMs: 'dvconf_relay_peer_connection_setup_ms',
  iceSuccess: 'dvconf_relay_peer_ice_success',
  reconnectMs: 'dvconf_relay_peer_reconnect_ms',
  avSyncDriftMs: 'dvconf_relay_peer_av_sync_drift_ms',
};

/** Prometheus label-value escaping: backslash, then quote, then newline (order matters). */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** job/instance grouping key ONLY -- roomId/peerId ride as inline labels on
 *  each metric line instead (see buildExpositionBody), since Pushgateway
 *  400s a push where a grouping-key path segment collides with a label the
 *  metric body also sets. Distinct job name from the client's
 *  ("dvconf_bot" vs. "dvconf_client") -- no dashboard panel filters on this
 *  job label today (they all match on peerId/roomId directly, see e.g.
 *  peer-quality.json's `peerId=~"bot-.*"` Is-Bot panel), so this is purely
 *  a provenance label, not load-bearing for any query. */
function pushgatewayUrl(baseUrl: string, peerId: string): string {
  return `${baseUrl}/metrics/job/dvconf_bot/instance/${encodeURIComponent(peerId)}`;
}

function buildExpositionBody(roomId: string, peerId: string, sample: Record<string, number | boolean>): string {
  const labels = `roomId="${escapeLabelValue(roomId)}",peerId="${escapeLabelValue(peerId)}"`;
  const lines: string[] = [];
  for (const field of Object.keys(FIELD_METRIC_NAME)) {
    const name = FIELD_METRIC_NAME[field];
    const raw = sample[field];
    if (raw === undefined) continue;
    const value = typeof raw === 'boolean' ? (raw ? 1 : 0) : raw;
    lines.push(`${name}{${labels}} ${value}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Best-effort direct push of one quality sample to the observer Pushgateway.
 * No-op if `baseUrl`/`authToken` are unset (Pushgateway not registered yet,
 * or this is a local/test run with no observer stack) -- must never disrupt
 * the bot's actual media session, same posture as the relay-bridge POST
 * this replaces.
 */
export function pushBotQualitySample(
  baseUrl: string,
  authToken: string,
  roomId: string,
  peerId: string,
  sample: Record<string, number | boolean>,
  logger?: Logger,
): void {
  if (!baseUrl || !authToken) return;
  const url = pushgatewayUrl(baseUrl, peerId);
  const body = buildExpositionBody(roomId, peerId, sample);
  void fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/plain',
      Authorization: `Bearer ${authToken}`,
    },
    body,
  }).catch((err: unknown) => logger?.warn({ module: 'bot-metrics-push', err }, 'Pushgateway PUT failed'));
}

/**
 * Clears this peer's grouping key from the Pushgateway on session end --
 * otherwise Pushgateway (unlike a scrape target) holds the last-pushed
 * values forever, so a bot that already left keeps reporting stale
 * "current" numbers to every dashboard indefinitely. Mirrors the client's
 * clearClientQualityPush() exactly.
 */
export function clearBotQualityPush(baseUrl: string, authToken: string, peerId: string, logger?: Logger): void {
  if (!baseUrl || !authToken) return;
  const url = pushgatewayUrl(baseUrl, peerId);
  void fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${authToken}` },
  }).catch((err: unknown) => logger?.warn({ module: 'bot-metrics-push', err }, 'Pushgateway DELETE failed'));
}
