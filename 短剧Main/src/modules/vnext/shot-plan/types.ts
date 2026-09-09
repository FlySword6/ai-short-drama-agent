export interface ShotPlanCharacterDraft {
  key: string;
  name: string;
  description: string;
}

export interface ShotPlanSceneDraft {
  key: string;
  title: string;
  summary: string;
  position: number;
}

export interface ShotPlanShotDraft {
  key: string;
  sceneKey: string;
  position: number;
  shotSize: string;
  cameraMovement: string;
  action: string;
  rhythm: string;
  dialogue: string;
  sound: string;
}

export interface ShotPlanDraft {
  schemaVersion: 1;
  characters: ShotPlanCharacterDraft[];
  scenes: ShotPlanSceneDraft[];
  shots: ShotPlanShotDraft[];
  warnings: string[];
}

export interface FormalShotPlanFacts {
  confirmationId: string;
  confirmedAt: Date;
  characters: Array<ShotPlanCharacterDraft & { id: string }>;
  scenes: Array<ShotPlanSceneDraft & { id: string }>;
  shots: Array<ShotPlanShotDraft & { id: string; sceneId: string }>;
}
