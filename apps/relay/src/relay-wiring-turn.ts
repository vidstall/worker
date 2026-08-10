/**
 * DVConf Relay Daemon — TURN context construction.
 *
 * Pure extraction from relay-wiring-context.ts / index.ts's Step 4. S30.C:
 * build optional TurnContext when ENABLE_TURN_DELIVERY=1 + CP_DAEMON_RPC_URL
 * + TURN_RPC_TOKEN are set. The signaling layer delegates the credential
 * fetch per createTransport so it stays decoupled from the cp-daemon RPC
 * plumbing.
 */

import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Logger } from '@dvconf/shared';
import type { TurnContext } from './signaling/index.js';
import { deriveCoturnUrl } from './coturn-url.js';
import { fetchTurnCredential } from './turn-fetcher.js';

export interface TurnContextParams {
  logger: Logger;
  endpointUrl: string;
  signer: Pick<Ed25519Keypair, 'toSuiAddress'>;
}

export function buildTurnContext(params: TurnContextParams): TurnContext | undefined {
  const { logger, endpointUrl, signer } = params;

  return process.env['ENABLE_TURN_DELIVERY'] === '1' &&
    process.env['CP_DAEMON_RPC_URL'] &&
    process.env['TURN_RPC_TOKEN']
    ? (() => {
        const coturnUrl = deriveCoturnUrl(endpointUrl);
        if (!coturnUrl) {
          logger.warn(
            { endpointUrl },
            'ENABLE_TURN_DELIVERY=1 but endpointUrl unparseable; TURN disabled',
          );
          return undefined;
        }
        const cpRpcUrl = process.env['CP_DAEMON_RPC_URL']!;
        const token = process.env['TURN_RPC_TOKEN']!;
        const stunUrl = process.env['STUN_URL'] ?? 'stun:stun.l.google.com:19302';
        const myMinerId = signer.toSuiAddress();
        logger.info(
          { coturnUrl, cpRpcUrl, stunUrl },
          'TURN delivery enabled; relay will inline iceServers in transportCreated',
        );
        return {
          buildIceServers: async (peerId: string) => {
            const cred = await fetchTurnCredential({
              cpRpcUrl,
              token,
              targetMinerId: myMinerId,
              userId: peerId,
            });
            if (cred === null) return null;
            return [
              { urls: stunUrl },
              {
                urls: [coturnUrl],
                username: cred.username,
                credential: cred.password,
              },
            ];
          },
        };
      })()
    : undefined;
}
