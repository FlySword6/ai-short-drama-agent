import type {
  AssetCopyRepository,
  PersonalAssetCopyResult,
} from "./copyRepository.js";

export type AssetCopyPort = Pick<AssetCopyRepository, "copyCommonToPersonal">;

export class AssetCopyService {
  constructor(private readonly repository: AssetCopyPort) {}

  copyCommonToPersonal(
    actorId: string,
    sourceAssetId: string,
  ): Promise<PersonalAssetCopyResult> {
    return this.repository.copyCommonToPersonal(actorId, sourceAssetId);
  }
}
