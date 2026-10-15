import type { Job, ToolContext } from '../../domain/models.js';
export interface JobResult {
  output: string;
  deliver?: boolean;
  voice?: boolean;
  afterDelivery?: () => void;
}
export type JobHandler = (job: Job, context: ToolContext) => Promise<JobResult>;
export type JobHandlers = Record<string, JobHandler>;
