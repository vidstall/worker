import { useCallback, useState } from 'react';
import { useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { CONFIG } from '../config';

export function useChain() {
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const [loading, setLoading] = useState(false);

  const registerUser = useCallback(async (displayName: string) => {
    setLoading(true);
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: `${CONFIG.PACKAGE_ID}::user_registry::register_user`,
        arguments: [
          tx.object(CONFIG.NETWORK_REGISTRY_ID),
          tx.object(CONFIG.USER_REGISTRY_ID),
          tx.pure.vector('u8', Array.from(new TextEncoder().encode(displayName))),
        ],
      });
      await signAndExecute({ transaction: tx });
      return true;
    } catch (err) {
      // E_ALREADY_REGISTERED (540) — treat as success
      if (String(err).includes('540')) return true;
      console.error('registerUser failed:', err);
      return false;
    } finally {
      setLoading(false);
    }
  }, [signAndExecute]);

  const createRoom = useCallback(async (): Promise<string | null> => {
    setLoading(true);
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: `${CONFIG.PACKAGE_ID}::room_manager::create_room`,
        arguments: [
          tx.object(CONFIG.NETWORK_REGISTRY_ID),
          tx.object(CONFIG.ROOM_MANAGER_ID),
          tx.object(CONFIG.USER_REGISTRY_ID),
          tx.pure.u8(0), // relay_mode: SFU
        ],
      });
      const result = await signAndExecute({
        transaction: tx,
        options: { showEvents: true },
      });
      // Extract room_id from RoomCreated event
      const roomEvent = (result as any).events?.find(
        (e: any) => typeof e.type === 'string' && e.type.includes('::room_manager::RoomCreated'),
      );
      const roomId = roomEvent?.parsedJson?.room_id;
      if (!roomId) {
        throw new Error('Room created on-chain but RoomCreated event was not returned. Please check the transaction.');
      }
      return roomId;
    } catch (err) {
      console.error('createRoom failed:', err);
      return null;
    } finally {
      setLoading(false);
    }
  }, [signAndExecute]);

  return { registerUser, createRoom, loading };
}
