declare namespace ExcelJS {
  type CellValue =
    | string
    | number
    | boolean
    | Date
    | null
    | undefined
    | { result?: unknown; text?: unknown; richText?: Array<{ text?: unknown }> };

  interface Cell {
    value: CellValue;
    master?: Cell;
  }

  interface Row {
    getCell(column: number): Cell;
  }

  interface ImageRangeAnchor {
    row: number;
    col: number;
  }

  interface WorksheetImage {
    imageId: string | number;
    range?: {
      tl?: ImageRangeAnchor;
      br?: ImageRangeAnchor;
    };
  }

  interface Worksheet {
    name: string;
    rowCount: number;
    columnCount: number;
    getRow(rowNumber: number): Row;
    getImages(): WorksheetImage[];
  }

  interface RawImage {
    buffer?: ArrayBuffer | Uint8Array;
    extension?: string;
  }

  class Workbook {
    worksheets: Worksheet[];
    xlsx: {
      load(data: ArrayBuffer | Uint8Array | Buffer): Promise<Workbook>;
    };
    getWorksheet(name: string): Worksheet | undefined;
    getImage(imageId: number): RawImage | undefined;
  }
}

declare module "exceljs" {
  export = ExcelJS;
}
