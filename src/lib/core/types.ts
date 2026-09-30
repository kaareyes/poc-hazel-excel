export interface OpenItem {
  customerId: string;
  customerName: string;
  document: string;
  postingDate: string | null;
  dueDate: string | null;
  amountCents: number;
  termCode: string;
  termDays: number | null;
  dimension: string;
  sourceRow: number;
}

export interface Payment {
  customerId: string;
  date: string;
  amountCents: number;
  sourceRow: number;
}

export interface Dataset {
  kind: "sample" | "upload";
  name: string;
  asOf: string;
  currency: string;
  dimensionLabel: string;
  items: OpenItem[];
  payments: Payment[];
  notes: string[];
}

export interface Bucket {
  key: string;
  label: string;
  from: number; // inclusive days overdue; bucket 0 = current uses from 0/to 0
  to: number | null;
}

export interface RiskRule {
  balanceCents: number;
  overduePct: number;
}

export interface CalcConfig {
  asOf: string;
  buckets: Bucket[];
  risk: RiskRule;
}

export interface CustomerRow {
  customerId: string;
  name: string;
  dimensions: string[];
  terms: string[];
  balanceCents: number;
  overdueCents: number;
  overduePct: number | null; // null when balance <= 0 (credit)
  oldestDue: string | null;
  maxDaysOverdue: number;
  lastPayment: string | null;
  lastPaymentCents: number | null;
  daysSincePayment: number | null;
  paidThisWeekCents: number;
  paidLastWeekCents: number;
  highRisk: boolean;
  itemCount: number;
}

export interface DashboardMetrics {
  totalCents: number;
  overdueCents: number;
  currentCents: number;
  overduePct: number | null;
  customerCount: number;
  overdueCustomers: number;
  itemCount: number;
  undatedItems: number;
  paymentsThisWeekCents: number; // week to date
  paymentsSameDaysLastWeekCents: number; // like-for-like
  paymentsLastWeekCents: number; // last full week
  wowPct: number | null; // like-for-like
  aging: { bucket: Bucket; cents: number; count: number }[];
  byTerm: { label: string; balanceCents: number; overdueCents: number; customers: number }[];
  byDimension: { value: string; balanceCents: number; overdueCents: number; customers: number }[];
  weekly: { weekStart: string; cents: number; partial: boolean }[];
  customers: CustomerRow[];
  paymentWindow: { from: string; to: string } | null;
}
