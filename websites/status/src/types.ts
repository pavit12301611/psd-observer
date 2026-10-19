export interface HourlyStat {
  hour: string;
  success_rate: number | null;
}

export interface ModelStatus {
  name: string;
  overall_success_rate: number | null;
  hourly_stats: HourlyStat[];
}

export interface StatusResponse {
  checked_at: string;
  window_hours: number;
  models: ModelStatus[];
}
