import { BadRequestError } from "../../shared/errors.js";
import { buildStoryboardPreview } from "./preview.js";
import type { ProjectAccessActor } from "../project-access/types.js";
import type { StoryboardImportRecord, StoryboardImportRepository, StoryboardParser } from "./types.js";

export class StoryboardImportService {
  constructor(
    private readonly parser: StoryboardParser,
    private readonly repository: StoryboardImportRepository,
  ) {}

  async preview(input: {
    projectId: string;
    actor: ProjectAccessActor;
    fileName: string;
    content: Buffer;
  }): Promise<StoryboardImportRecord> {
    const rows = await this.parser.parse(input.content);
    const preview = buildStoryboardPreview(rows);
    return this.repository.createPreview({
      projectId: input.projectId,
      uploadedBy: input.actor.id,
      fileName: input.fileName,
      preview,
    });
  }

  async confirm(input: {
    importId: string;
    projectId: string;
    actor: ProjectAccessActor;
  }): Promise<StoryboardImportRecord> {
    const record = await this.repository.getById(input.importId);
    if (!record || record.projectId !== input.projectId) {
      throw new BadRequestError("分镜导入记录不存在");
    }
    if (record.uploadedBy !== input.actor.id) {
      throw new BadRequestError("无权确认这份分镜导入");
    }
    if (record.status === "confirmed") return record;
    if (!record.preview.canConfirm) {
      throw new BadRequestError("预览仍有错误，不能确认导入");
    }
    return this.repository.confirm({
      importId: record.id,
      projectId: record.projectId,
      actor: input.actor,
      rows: record.preview.rows,
    });
  }
}
