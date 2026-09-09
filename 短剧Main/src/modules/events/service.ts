import type { EventRepository } from "./repository.js";
import type { EventAggregationFilter, RecordProductEventInput } from "./types.js";

export class EventService {
  constructor(private readonly repository: EventRepository) {}

  record(userId: string, input: RecordProductEventInput) {
    return this.repository.record(userId, input);
  }

  aggregate(filter: EventAggregationFilter) {
    return this.repository.aggregate(filter);
  }
}
