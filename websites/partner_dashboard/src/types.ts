// Amounts are in the currency's smallest unit (cents), as Stripe returns them.
export interface PartnerQuote {
  currency: string;
  unit_amount: number;
  monthly_total: number;
  commission_percent: number;
  monthly_commission: number;
  commission_months: number;
}

export interface PartnerProvisionResponse extends ProvisionOrgResponse {
  partner: string;
  quote: PartnerQuote;
  stripe_schedule_id?: string;
  commission_until?: number;
}

export interface PartnerDeal {
  org_id: string | null;
  company: string | null;
  admin_email: string | null;
  status: string;
  seats: number | null;
  created: number;
  commission_until: number | null;
  latest_invoice: {
    status: string | null;
    amount_due: number | null;
    amount_paid: number | null;
    currency: string | null;
    hosted_invoice_url: string | null;
  } | null;
}

export interface PartnerDealsResponse {
  partner: string;
  commission_percent: number;
  commission_months: number;
  orgs: PartnerDeal[];
}

export interface ProvisionOrgResponse {
  org_id: string;
  owner_email: string;
  seats: number;
  tier: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  invoice_id: string | null;
  hosted_invoice_url: string | null;
  owner_status: 'active' | 'invited';
  team_url: string;
  dry_run?: boolean;
}

export interface OrgMember {
  email: string;
  auth0_user_id: string | null;
  status: 'invited' | 'active' | 'removed';
  invited_at: string | null;
  joined_at: string | null;
  removed_at?: string | null;
  usage?: Record<string, number>;
}

export interface MonthlyPool {
  used: number;
  limit: number;
  remaining: number | null;
  unlimited: boolean;
  resets_at: string;
}

export interface OrgRecord {
  org_id: string;
  name: string;
  owner_email: string;
  tier: string;
  status: string;
  seats_purchased: number;
  seats_used: number;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  monthly_credits: number;
  monthly_pool: MonthlyPool;
  features: Record<string, unknown>;
  members: OrgMember[];
  created_at: string;
}

// Mirrors DASHBOARD_SERVICES in api/orgs.py
export const USAGE_SERVICES = [
  'monitor',
  'agent_creator',
  'email',
  'sms',
  'whatsapp',
  'telegram',
  'discord',
  'slack',
] as const;

export const USAGE_LABELS: Record<string, string> = {
  monitor: 'Monitor',
  agent_creator: 'Creator',
  email: 'Email',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
};
