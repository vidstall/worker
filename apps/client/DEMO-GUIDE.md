# DVConf Demo Guide

Step-by-step to run the full v1 integration demo.

## Prerequisites

- Node.js >= 20
- `sui` CLI installed (`cargo install --locked --git https://github.com/MystenLabs/sui.git sui`)
- Sui Wallet browser extension (Chrome/Edge)
- Camera + microphone

## Step 1: Deploy Contracts to Localnet

### Start Local Sui Network

**Windows** (PowerShell):
```powershell
# Kill any stale Sui process first
taskkill /F /IM sui.exe 2>$null

# Set logging so you can see output (Windows requires this!)
$env:RUST_LOG="off,sui_node=info"

# Start localnet
sui client test-publish --gas-budget 500000000 --skip-dependency-verification --build-env localnet
```

**macOS / Linux** (bash):
```bash
RUST_LOG="off,sui_node=info" sui start --force-regenesis --with-faucet
```

Wait 30-90 seconds. You should eventually see:
```
Fullnode RPC URL: http://127.0.0.1:9000
Faucet URL: http://127.0.0.1:9123
```

**Verify the node is running** (in a new terminal):
```bash
curl http://127.0.0.1:9000
# Expected: 405 Method Not Allowed (this means the node IS running)
```

### Connect CLI to Localnet

```bash
# Add localnet environment (skip if already exists)
sui client new-env --alias localnet --rpc http://127.0.0.1:9000

# Switch to localnet
sui client switch --env localnet

# Get gas tokens
sui client faucet --url http://127.0.0.1:9123/gas
```

Wait ~10 seconds for tokens to arrive, then verify:
```bash
sui client gas
```

### Publish the DVConf Package

```bash
cd C:\Thesis\dvconf\dvconf-contracts
sui client publish --gas-budget 500000000 --skip-dependency-verification
```

From the publish output, copy these IDs:

| Field | Look for |
|-------|----------|
| `PACKAGE_ID` | "Published Objects" -> PackageID |
| `NETWORK_REGISTRY_ID` | Created shared object with type `::network_registry::NetworkRegistry` |
| `MINER_STORE_ID` | Created shared object with type `::miner_store::MinerStore` |
| `ADMIN_CAP_ID` | Created object with type `::caps::AdminCap` |
| `TREASURY_CAP_ID` | Created object with type `::token::DVCONF` (TreasuryCap) |

Example:
PACKAGE_ID=0x7fb53777369462ab485953da930bbee12f514f188e79cc305676a696c7192cec                                                   NETWORK_REGISTRY_ID=0xac6291213240cfbf6c1b716d5dbd30a855311de61ee51cf9296db5eb9fac0ba5
  MINER_STORE_ID=0x05ed583714be5cd9a6f79115d7bee15747962d99d9da6820aa9b74f3f68897e7                                             
  ADMIN_CAP_ID=0x2e8537fa0c2f7a3efd9544e25f51f36dec43b4c2a4499cd4be18813bd8330ae5
  TREASURY_CAP_ID=0x11a86964bac2b78ea14cacef69e36d65ac10091e35d1a906a26000445f2a5e3e

## Step 2: Create Phase 2 Registries

Run these 5 commands (replace `$PKG` and `$ADMIN_CAP` with your IDs):

```bash
# Set variables (paste your IDs)
PKG=0x...your_package_id
ADMIN_CAP=0x...your_admin_cap_id

# Create UserRegistry
sui client call --package $PKG --module user_registry --function create \
  --args $ADMIN_CAP --gas-budget 50000000

# Create ValidatorRegistry
sui client call --package $PKG --module validator_registry --function create \
  --args $ADMIN_CAP --gas-budget 50000000

# Create RelayRegistry
sui client call --package $PKG --module relay_registry --function create \
  --args $ADMIN_CAP --gas-budget 50000000

# Create ControlPlaneRegistry
sui client call --package $PKG --module control_plane_registry --function create \
  --args $ADMIN_CAP --gas-budget 50000000

# Create RoomManager
sui client call --package $PKG --module room_manager --function create \
  --args $ADMIN_CAP --gas-budget 50000000
```

Each command outputs a created shared object. Copy these IDs:

| Command | Copy the shared object ID as |
|---------|------------------------------|
| user_registry::create | `USER_REGISTRY_ID` |
| validator_registry::create | `VALIDATOR_REGISTRY_ID` |
| relay_registry::create | `RELAY_REGISTRY_ID` |
| control_plane_registry::create | `CP_REGISTRY_ID` |
| room_manager::create | `ROOM_MANAGER_ID` |

**Tip**: In the output, look for `Created Objects` -> the one with `owner: Shared` is your registry ID.

## Step 3: Configure the Client

Edit `apps/client/src/config.ts` with your IDs:

```typescript
export const CONFIG = {
  PACKAGE_ID: '0x...your_package_id',
  NETWORK_REGISTRY_ID: '0x...your_network_registry_id',
  USER_REGISTRY_ID: '0x...your_user_registry_id',
  ROOM_MANAGER_ID: '0x...your_room_manager_id',
  SIGNALING_URL: 'ws://localhost:8080',
  SUI_NETWORK: 'localnet' as const,
} as const;
```

Also update `src/main.tsx` -- change `defaultNetwork` to `"localnet"`:

```tsx
<SuiClientProvider networks={networkConfig} defaultNetwork="localnet">
```

## Step 4: Configure the Daemons (Optional -- for full demo)

Create `C:\Thesis\dvconf\dvconf-daemons\.env`:

```env
SUI_NETWORK=localnet
PACKAGE_ID=0x...your_package_id
NETWORK_REGISTRY_ID=0x...your_network_registry_id
MINER_STORE_ID=0x...your_miner_store_id
CP_REGISTRY_ID=0x...your_cp_registry_id
RELAY_REGISTRY_ID=0x...your_relay_registry_id
VALIDATOR_REGISTRY_ID=0x...your_validator_registry_id
USER_REGISTRY_ID=0x...your_user_registry_id
ROOM_MANAGER_ID=0x...your_room_manager_id
CP_KEYPAIR=suiprivkey...
SUI_PRIVATE_KEY=suiprivkey...
LOG_LEVEL=info
HEARTBEAT_INTERVAL_MS=30000
EVENT_POLL_INTERVAL_MS=3000
```

To get your private key in bech32 format:
```bash
# Show your active address
sui client active-address

# Export the key (look for the bech32 key starting with 'suiprivkey')
sui keytool export --key-identity <your-address>
```

## Step 5: Start Everything

Open 4 terminals in `C:\Thesis\dvconf\dvconf-daemons`:

```bash
# Terminal 1: Sui localnet (already running from Step 1)

# Terminal 2: Signaling server
pnpm dev:signaling

# Terminal 3: CP daemon (optional -- shows scoring on room create)
pnpm dev:cp

# Terminal 4: Client app
pnpm dev:client
```

## Step 6: Demo Flow

1. Open `http://localhost:5173` in Chrome
2. Click **Connect Wallet** -> approve in Sui Wallet extension
3. Type a display name -> click **Register** -> approve TX
4. Click **Create Room** -> approve TX -> room ID appears
5. Click **Copy** to copy the room ID
6. Open `http://localhost:5173` in a **second tab** (same browser)
7. Connect same wallet (already registered, will handle gracefully)
8. Paste the room ID -> click **Join**
9. Go back to first tab -> click **Join** with same room ID
10. Both tabs should show video from your camera

**Check Terminal 3** (CP daemon) -- you should see:
```
Room created: { roomId: "0x...", creator: "0x...", relayMode: 0 }
Relay scoring complete (vote NOT submitted -- deferred to v2)
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `sui start` shows no output (Windows) | Set `$env:RUST_LOG="off,sui_node=info"` first. Kill stale processes with `taskkill /F /IM sui.exe` |
| `sui start` port error (os error 10013) | Port reserved by Hyper-V. Run as admin: `net stop winnat && net start winnat`, then retry |
| "Camera access denied" | Allow camera in browser permissions |
| TX fails with error 542 | Already registered -- this is OK, click Join |
| TX fails with error 500 | Network is paused -- check NetworkRegistry |
| No remote video | Both tabs must click Join. Check browser console for WebRTC errors |
| Signaling not connecting | Ensure `pnpm dev:signaling` is running on port 8080 |
| Wallet not showing localnet | In Sui Wallet settings -> add custom RPC: `http://127.0.0.1:9000` |
| CP daemon crash on start | Check `.env` has all required IDs and valid private key |
| `sui client faucet` goes to testnet | Use `sui client faucet --url http://127.0.0.1:9123/gas` for localnet |

## For Testnet (Alternative)

If localnet is giving you trouble, use testnet instead. Phase 1 is already deployed.

### 1. Switch to Testnet

```bash
sui client switch --env testnet
```

### 2. Get Testnet SUI

Go to https://faucet.sui.io and paste your address.

### 3. Create Phase 2 Registries

Use the IDs from `dvconf-contracts/.env.testnet`:

```bash
# IDs from .env.testnet (Phase 1 deploy)
PKG=0xf7cf30b14c70c62271674f45098ba7c912d5bcf9e44896e1fb700723c45d3ef3
ADMIN_CAP=0x940c5a4f4e40b7c44f8fe478a3a1800bb271cd2f41e9ed5446a7c92eabd6b12b

# Create all 5 registries
sui client call --package $PKG --module user_registry --function create \
  --args $ADMIN_CAP --gas-budget 50000000

sui client call --package $PKG --module validator_registry --function create \
  --args $ADMIN_CAP --gas-budget 50000000

sui client call --package $PKG --module relay_registry --function create \
  --args $ADMIN_CAP --gas-budget 50000000

sui client call --package $PKG --module control_plane_registry --function create \
  --args $ADMIN_CAP --gas-budget 50000000

sui client call --package $PKG --module room_manager --function create \
  --args $ADMIN_CAP --gas-budget 50000000
```

Copy the shared object IDs from each command output (same as Step 2 above).

### 4. Configure Client for Testnet

The client already defaults to testnet. Just update `config.ts` with your new registry IDs:
- `USER_REGISTRY_ID` -- from user_registry::create output
- `ROOM_MANAGER_ID` -- from room_manager::create output

The `PACKAGE_ID` and `NETWORK_REGISTRY_ID` are already filled in.

### 5. Run the Demo

Same as Step 5 above (signaling + client). No Sui node needed -- testnet is remote.
