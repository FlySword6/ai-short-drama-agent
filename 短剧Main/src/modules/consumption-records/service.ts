import type { ConsumptionRecordsRepository } from "./repository.js";
import type { ConsumptionRecordFilter, ConsumptionRecordPage } from "./types.js";
import { AppError } from "../../shared/errors.js";

export class ConsumptionRecordsService {
  constructor(private readonly repository: ConsumptionRecordsRepository) {}

  list(actorId: string, filter: ConsumptionRecordFilter): Promise<ConsumptionRecordPage> {
    if (filter.taskType === "image" || filter.taskType === "video") {
      throw new AppError(
        422,
        "ledger_media_kind_unavailable",
        "消耗记录暂时不能按图片或视频筛选。请改按生成或 AI 辅助查看，或取消这个筛选。",
      );
    }
    return this.repository.list(actorId, filter);
  }
}
