/**
 * OpenTelemetry bootstrap for the 4 request-serving daemons (relay,
 * signaling, cp-daemon, validator-daemon). Side-effect-only module --
 * MUST be the literal first import in each app's entrypoint, before
 * `dotenv/config`, so auto-instrumentation patches `http`/`undici` before
 * anything else requires them.
 *
 * No-ops entirely when OTEL_EXPORTER_OTLP_ENDPOINT is unset (local dev,
 * tests, bot, and any fleet host before the operator seeds
 * secrets/services/otel.env -- see cli/infra/secrets.py's
 * otel_exporter_vars()) -- so importing this file is always safe.
 *
 * Reads the standard OTEL_EXPORTER_OTLP_* / OTEL_SERVICE_NAME env vars
 * itself (no custom var names invented here) -- deploy_one_service.yml
 * injects these for relay/signaling/cp-daemon/validator-daemon only.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];

if (endpoint) {
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env['OTEL_SERVICE_NAME'] ?? 'dvconf-unknown',
    }),
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Only http/undici matter here -- see the exploration that found
        // no express/fastify anywhere in these 4 daemons, and no official
        // `ws` instrumentation exists (relay/signaling's WS signaling path
        // is hand-instrumented separately, see signaling/index.ts).
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
      }),
    ],
  });

  sdk.start();

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      sdk.shutdown().catch(() => {
        /* best-effort flush on shutdown -- never block process exit on it */
      });
    });
  }
}
