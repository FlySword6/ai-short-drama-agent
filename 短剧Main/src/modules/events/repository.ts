import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { events, users } from "../../db/schema.js";
import type {
  EventAggregation,
  EventAggregationFilter,
  ProductEventRecord,
  RecordProductEventInput,
} from "./types.js";

export interface EventRepository {
  record(userId: string, input: RecordProductEventInput): Promise<ProductEventRecord>;
  aggregate(filter: EventAggregationFilter): Promise<EventAggregation>;
}

export class DrizzleEventRepository implements EventRepository {
  constructor(private readonly db: Database) {}

  async record(userId: string, input: RecordProductEventInput): Promise<ProductEventRecord> {
    const receivedAt = new Date();
    const row = (await this.db.insert(events).values({
      id: randomUUID(),
      userId,
      event: input.event,
      props: input.props,
      occurredAt: input.occurredAt,
      receivedAt,
    }).returning())[0];
    if (!row) throw new Error("Failed to record product event");
    return row;
  }

  async aggregate(filter: EventAggregationFilter): Promise<EventAggregation> {
    const where = aggregateWhere(filter);
    const eventCount = count(events.id);
    const day = sql<string>`to_char(${events.occurredAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
    const [totalRows, byEvent, byUser, byDate] = await Promise.all([
      this.db.select({ count: eventCount }).from(events).where(where),
      this.db.select({ event: events.event, count: eventCount })
        .from(events)
        .where(where)
        .groupBy(events.event)
        .orderBy(desc(eventCount), events.event)
        .limit(100),
      this.db.select({ userId: events.userId, username: users.username, count: eventCount })
        .from(events)
        .innerJoin(users, eq(users.id, events.userId))
        .where(where)
        .groupBy(events.userId, users.username)
        .orderBy(desc(eventCount), users.username)
        .limit(100),
      this.db.select({ date: day, count: eventCount })
        .from(events)
        .where(where)
        .groupBy(day)
        .orderBy(day),
    ]);
    return {
      total: totalRows[0]?.count ?? 0,
      byEvent,
      byUser,
      byDate,
    };
  }
}

function aggregateWhere(filter: EventAggregationFilter): SQL | undefined {
  const conditions: SQL[] = [];
  if (filter.event) conditions.push(eq(events.event, filter.event));
  if (filter.userId) conditions.push(eq(events.userId, filter.userId));
  if (filter.occurredFrom) conditions.push(gte(events.occurredAt, filter.occurredFrom));
  if (filter.occurredTo) conditions.push(lte(events.occurredAt, filter.occurredTo));
  return conditions.length ? and(...conditions) : undefined;
}
