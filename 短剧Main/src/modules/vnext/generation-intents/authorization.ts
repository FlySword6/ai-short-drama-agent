import { sql } from "drizzle-orm";
import { settings } from "../../../config/env.js";
import type { Database } from "../../../db/client.js";
import { AppError, ForbiddenError } from "../../../shared/errors.js";
import { assertGenerationPilotCreditAccess } from "../../account-credits/generationAccess.js";
import { effectivePaidBudgetFen } from "../../generation/factory.js";
import type { PendingIntentAuthorization } from "./service.js";

export class VnextPendingIntentAuthorization implements PendingIntentAuthorization {
  constructor(
    private readonly vnextDatabase: Database,
    private readonly mainDatabase: Database,
  ) {}

  async assertBudgetAndAccountAccess(actorId: string, _projectId: string, estimatedCostFen: number): Promise<void> {
    const budgetFen = effectivePaidBudgetFen(settings);
    if (budgetFen <= 0 || estimatedCostFen > budgetFen) {
      throw new AppError(
        422,
        "generation_budget_unavailable",
        budgetFen <= 0 ? "付费生成预算尚未配置，当前不能创建待确认意图" : `预计费用超过单次可用预算 ${budgetFen} 分`,
      );
    }
    await assertGenerationPilotCreditAccess(this.mainDatabase, actorId, {
      enabled: settings.generationPilotCreditGateEnabled,
    });
  }

  async assertReferenceAssetAccess(actorId: string, projectId: string, referenceVersionIds: string[]): Promise<void> {
    if (referenceVersionIds.length === 0) return;
    const requestedIds = `{${referenceVersionIds.join(",")}}`;
    const result = await this.vnextDatabase.execute<{ reference_version_id: string }>(sql`
      WITH requested(reference_version_id) AS (
        SELECT unnest(${requestedIds}::uuid[])
      ), authorized AS (
        SELECT v.id AS reference_version_id
        FROM vnext.storyboard_cell_versions v
        WHERE v.project_id = ${projectId}::uuid
        UNION
        SELECT b.id AS reference_version_id
        FROM vnext.storyboard_boards b
        WHERE b.project_id = ${projectId}::uuid
        UNION
        SELECT c.id AS reference_version_id
        FROM vnext.script_confirmations c
        WHERE c.project_id = ${projectId}::uuid
        UNION
        SELECT a.id AS reference_version_id
        FROM vnext.imported_assets a
        WHERE a.review_status = 'approved'
        UNION
        SELECT vv.id AS reference_version_id
        FROM vnext.video_versions vv
        WHERE vv.project_id = ${projectId}::uuid
      )
      SELECT r.reference_version_id::text
      FROM requested r
      LEFT JOIN authorized a ON a.reference_version_id = r.reference_version_id
      WHERE a.reference_version_id IS NULL`);
    if (result.rows.length > 0) {
      throw new ForbiddenError("部分参考版本不存在、未获授权或尚未通过素材审核");
    }
    const membership = await this.vnextDatabase.execute<{ allowed: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM vnext.project_members
        WHERE project_id = ${projectId}::uuid AND user_id = ${actorId}::uuid
      ) AS allowed`);
    if (!membership.rows[0]?.allowed) throw new ForbiddenError("你没有使用这些参考版本的权限");
  }
}
