export interface DacShipmentResult {
  guia: string;
  trackingUrl?: string; // Real DAC tracking URL extracted from the <a> href
  screenshotPath?: string;
}

export interface DacCredentials {
  username: string;
  password: string;
}
