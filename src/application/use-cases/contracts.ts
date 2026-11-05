import type { Job, ToolContext } from '../../domain/models.js';
import type { Capability } from '../../domain/access.js';
export interface JobResult {
  output: string;
  choices?: string[];
  deliver?: boolean;
  voice?: boolean;
  requiredCapabilities?: Capability[];
  afterDelivery?: () => Promise<void>;
}
export type JobHandler = (job: Job, context: ToolContext) => Promise<JobResult>;
export type JobHandlers = Record<string, JobHandler>;
