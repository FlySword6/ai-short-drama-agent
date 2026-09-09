import { buildDashboardSummary } from "./summary.js";
import type { DashboardRepository, UnitPriceInput, UnitPriceRecord } from "./repository.js";

export class DashboardService {
  constructor(private readonly repository: DashboardRepository) {}

  async getSummary(actorId: string) {
    const [data, rows] = await Promise.all([
      this.repository.getDataCounts(actorId),
      this.repository.listCostRows(actorId),
    ]);
    return { data, costs: buildDashboardSummary(rows) };
  }

  getProjectCosts(actorId: string, projectId: string) {
    return this.repository.getProjectCosts(actorId, projectId);
  }

  listUnitPrices(): Promise<UnitPriceRecord[]> {
    return this.repository.listUnitPrices();
  }

  replaceUnitPrice(actorId: string, input: UnitPriceInput): Promise<UnitPriceRecord> {
    return this.repository.replaceUnitPrice(actorId, input);
  }
}
