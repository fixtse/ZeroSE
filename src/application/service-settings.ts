import type { Config } from '../domain/config.js';

export type ServiceConfig = Omit<Config, 'host' | 'port' | 'apiKey' | 'dataDir' | 'database'>;
export interface ServiceSettingsPort {
  initialize(value: ServiceConfig): Promise<void>;
  read(): Promise<{ revision: number; value: ServiceConfig }>;
  update(revision: number, value: ServiceConfig): Promise<boolean>;
}
export function serviceConfig(config: Config): ServiceConfig {
  const { host, port, apiKey, dataDir, database, ...services } = config;
  return services;
}
