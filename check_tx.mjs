import { SuiClient } from '@mysten/sui/client';
const client = new SuiClient({ url: 'https://fullnode.devnet.sui.io:443/json-rpc' });
const digest = '5McQ1M4Jf7egTTuStHPxDQWgwJJdRfqA5chfhEH1Exqk';
const r = await client.getTransactionBlock({
  digest,
  options: { showInput: true, showEvents: true, showEffects: true },
});
console.log(JSON.stringify(r, null, 2));
