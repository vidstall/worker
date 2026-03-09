import { ConnectButton, useCurrentAccount } from '@mysten/dapp-kit';

export function WalletConnect() {
  const account = useCurrentAccount();

  return (
    <div style={{ padding: '16px', textAlign: 'center' }}>
      <ConnectButton />
      {account && (
        <p style={{ marginTop: 8, fontSize: 14, color: '#666' }}>
          {account.address.slice(0, 10)}...{account.address.slice(-6)}
        </p>
      )}
    </div>
  );
}
