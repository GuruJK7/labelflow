export interface DacShipmentResult {
  guia: string;
  trackingUrl?: string; // Real DAC tracking URL extracted from the <a> href
  screenshotPath?: string;
  // AI resolver feedback hook: when an address was resolved by AI, this hash
  // allows process-orders.job.ts to mark the resolution as accepted/rejected
  // after the DAC form fill completes.
  aiResolutionHash?: string;
}

export interface DacCredentials {
  username: string;
  password: string;
}
