export type LabelStatus = 'PENDING' | 'CREATED' | 'COMPLETED' | 'FAILED' | 'SKIPPED';
export type PaymentType = 'REMITENTE' | 'DESTINATARIO';

export interface LabelSummary {
  id: string;
  shopifyOrderName: string;
  customerName: string;
  dacGuia: string | null;
  status: LabelStatus;
  paymentType: PaymentType;
  totalUyu: number;
  city: string;
  department: string;
  pdfUrl: string | null;
  emailSent: boolean;
  createdAt: string;
}
