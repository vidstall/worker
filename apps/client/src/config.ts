/** DVConf client configuration — reads from Vite environment variables. */

interface AppConfig {
  PACKAGE_ID: string;
  NETWORK_REGISTRY_ID: string;
  USER_REGISTRY_ID: string;
  ROOM_MANAGER_ID: string;
  SIGNALING_URL: string;
  SUI_NETWORK: 'localnet' | 'testnet';
}

function requireEnv(name: string): string {
  const value = import.meta.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}. Check your .env file.`);
  }
  return value as string;
}

export const CONFIG: AppConfig = {
  PACKAGE_ID: requireEnv('VITE_PACKAGE_ID'),
  NETWORK_REGISTRY_ID: requireEnv('VITE_NETWORK_REGISTRY_ID'),
  USER_REGISTRY_ID: requireEnv('VITE_USER_REGISTRY_ID'),
  ROOM_MANAGER_ID: requireEnv('VITE_ROOM_MANAGER_ID'),
  SIGNALING_URL: requireEnv('VITE_SIGNALING_URL'),
  SUI_NETWORK: requireEnv('VITE_SUI_NETWORK') as 'localnet' | 'testnet',
};
