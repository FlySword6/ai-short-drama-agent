export interface RecordProductEventInput {
  event: string;
  props: Record<string, unknown>;
  occurredAt: Date;
}

export interface ProductEventRecord extends RecordProductEventInput {
  id: string;
  userId: string;
  receivedAt: Date;
}

export interface EventAggregationFilter {
  event?: string;
  userId?: string;
  occurredFrom?: Date;
  occurredTo?: Date;
}

export interface EventAggregation {
  total: number;
  byEvent: Array<{ event: string; count: number }>;
  byUser: Array<{ userId: string; username: string; count: number }>;
  byDate: Array<{ date: string; count: number }>;
}
