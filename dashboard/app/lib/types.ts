export type AdRow = {
  externalId: string;
  title: string;
  link: string;
  searchId: string;
  searchLabel: string | null;
  districtLabel: string | null;
  price: number | null;
  rooms: number | null;
  city: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type LastRun = {
  startedAt: string;
  completedAt?: string;
  status?: string;
  relevantNewAds?: number;
  totalAds?: number;
} | null;

export type RunSummary = {
  startedAt: string;
  completedAt: string | null;
  status: string | null;
  trigger: string | null;
} | null;

export type StateResponse = {
  ads: AdRow[];
  lastRun: LastRun;
  lastScan: RunSummary;
  lastHealthCheck: RunSummary;
  generatedAt: string;
};
