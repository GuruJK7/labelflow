export type JobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'PARTIAL';
export type JobTrigger = 'CRON' | 'WEBHOOK' | 'MANUAL' | 'MCP';
export type JobType = 'PROCESS_ORDERS' | 'RETRY_FAILED';

export interface JobResult {
  jobId: string;
  status: JobStatus;
  totalOrders: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  durationMs: number;
  errors: Array<{ orderId: string; orderName: string; error: string }>;
}

export interface JobSummary {
  id: string;
  status: JobStatus;
  trigger: JobTrigger;
  totalOrders: number;
  successCount: number;
  failedCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}
