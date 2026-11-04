import type { Config } from '../domain/config.js';

export interface LocationExposureResult {
  confirmationRequired?: string[];
  exposed?: string[];
}
/** Exposing a location changes Assist access for the entire HA instance. */
export type LocationExposure = (
  config: Config['homeAssistant'],
  entities: string[],
  confirmed: boolean,
) => Promise<LocationExposureResult>;
