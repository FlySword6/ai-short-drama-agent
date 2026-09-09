import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import type { StoryboardHeaderMapper } from "./headerMapper.js";
import { StoryboardExcelParser } from "./parser.js";

test("解析所有主要 XML 都带命名空间前缀的标准 xlsx", async () => {
  assertStoryboardRows(await parser().parse(await prefixedWorkbook(true)));
});

test("解析 workbook 使用默认命名空间、其余 XML 带前缀的混合 xlsx", async () => {
  assertStoryboardRows(await parser().parse(await prefixedWorkbook(false)));
});

test("普通 ExcelJS xlsx 的原有解析路径不受影响", async () => {
  const workbook = new ExcelJS.Workbook() as unknown as {
    addWorksheet(name: string): { addRow(values: unknown[]): void };
    xlsx: { writeBuffer(): Promise<Uint8Array> };
  };
  const worksheet = workbook.addWorksheet("第1集分镜");
  worksheet.addRow(["集数", "镜号", "场景", "画面描述"]);
  worksheet.addRow([1, "G01", "雨夜老街", "男子在雨中抬头"]);
  const content = Buffer.from(await workbook.xlsx.writeBuffer());

  assertStoryboardRows(await parser().parse(content));
});

function parser(): StoryboardExcelParser {
  return new StoryboardExcelParser({
    headerMapper: {
      async mapHeaders() {
        return {
          episode: "集数",
          shotNo: "镜号",
          screenDescription: "画面描述",
          cameraMotion: null,
          shotSizeAngle: null,
          dialogue: null,
          scene: "场景",
          soundEffect: null,
          referenceImageHeaders: [],
          storyboardImageHeaders: [],
        };
      },
    } as unknown as StoryboardHeaderMapper,
  });
}

function assertStoryboardRows(rows: Awaited<ReturnType<StoryboardExcelParser["parse"]>>): void {
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.sheetName, "第1集分镜");
  assert.equal(rows[0]?.episode, "1");
  assert.equal(rows[0]?.shotNo, "G01");
  assert.equal(rows[0]?.scene, "雨夜老街");
  assert.equal(rows[0]?.screenDescription, "男子在雨中抬头");
}

async function prefixedWorkbook(prefixWorkbook: boolean): Promise<Buffer> {
  const zip = new JSZip();
  const namespace = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const workbookOpen = prefixWorkbook
    ? `<x:workbook xmlns:x="${namespace}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    : `<workbook xmlns="${namespace}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`;
  const workbookPrefix = prefixWorkbook ? "x:" : "";

  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
      <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
      <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
      <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
    </Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
    </Relationships>`);
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?>
    ${workbookOpen}
      <${workbookPrefix}sheets><${workbookPrefix}sheet name="第1集分镜" sheetId="1" r:id="rId1"/></${workbookPrefix}sheets>
    </${workbookPrefix}workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
      <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
      <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
    </Relationships>`);
  zip.file("xl/sharedStrings.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <x:sst xmlns:x="${namespace}" count="7" uniqueCount="7">
      <x:si><x:t>集数</x:t></x:si><x:si><x:t>镜号</x:t></x:si><x:si><x:t>场景</x:t></x:si><x:si><x:t>画面描述</x:t></x:si>
      <x:si><x:t>G01</x:t></x:si><x:si><x:t>雨夜老街</x:t></x:si><x:si><x:t>男子在雨中抬头</x:t></x:si>
    </x:sst>`);
  zip.file("xl/styles.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <x:styleSheet xmlns:x="${namespace}">
      <x:fonts count="1"><x:font><x:sz val="11"/><x:name val="Calibri"/></x:font></x:fonts>
      <x:fills count="2"><x:fill><x:patternFill patternType="none"/></x:fill><x:fill><x:patternFill patternType="gray125"/></x:fill></x:fills>
      <x:borders count="1"><x:border><x:left/><x:right/><x:top/><x:bottom/><x:diagonal/></x:border></x:borders>
      <x:cellStyleXfs count="1"><x:xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></x:cellStyleXfs>
      <x:cellXfs count="1"><x:xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></x:cellXfs>
      <x:cellStyles count="1"><x:cellStyle name="Normal" xfId="0" builtinId="0"/></x:cellStyles>
    </x:styleSheet>`);
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <x:worksheet xmlns:x="${namespace}">
      <x:sheetData>
        <x:row r="1">
          <x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="B1" t="s"><x:v>1</x:v></x:c>
          <x:c r="C1" t="s"><x:v>2</x:v></x:c><x:c r="D1" t="s"><x:v>3</x:v></x:c>
        </x:row>
        <x:row r="2">
          <x:c r="A2" t="n"><x:v>1</x:v></x:c><x:c r="B2" t="s"><x:v>4</x:v></x:c>
          <x:c r="C2" t="s"><x:v>5</x:v></x:c><x:c r="D2" t="s"><x:v>6</x:v></x:c>
        </x:row>
      </x:sheetData>
    </x:worksheet>`);
  return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
}
