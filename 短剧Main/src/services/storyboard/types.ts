export interface StoryboardHeaderMap {
  episode: string | null;
  shotNo: string | null;
  screenDescription: string | null;
  cameraMotion: string | null;
  shotSizeAngle: string | null;
  dialogue: string | null;
  scene: string | null;
  soundEffect: string | null;
  referenceImageHeaders: string[];
  storyboardImageHeaders: string[];
}

export interface StoryboardExcelRow {
  sheetName: string;
  rowNumber: number;
  episode: string | null;
  shotNo: string | null;
  screenDescription: string | null;
  cameraMotion: string | null;
  shotSizeAngle: string | null;
  dialogue: string | null;
  scene: string | null;
  soundEffect: string | null;
  referenceImageNote: string | null;
  storyboardImageNote: string | null;
  rawFields: Record<string, string>;
}
