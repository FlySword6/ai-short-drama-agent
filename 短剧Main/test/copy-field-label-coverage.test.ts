import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { fieldLabels } from "../src/shared/fieldLabels.js";

const batchTwoModulePaths = [
  "src/modules/account-credits",
  "src/modules/admin/generations",
  "src/modules/admin/models",
  "src/modules/admin/users",
  "src/modules/ai",
  "src/modules/audio",
  "src/modules/auth",
  "src/modules/capability-tiers",
  "src/modules/command-palette",
  "src/modules/config-entries",
  "src/modules/consumption-records",
  "src/modules/control-packages",
  "src/modules/dashboard",
  "src/modules/delivery",
  "src/modules/director/commands",
  "src/modules/director/scene",
  "src/modules/director/templates",
  "src/modules/events",
  "src/modules/generation/defaults",
  "src/modules/health",
  "src/modules/object-context",
  "src/modules/operations",
  "src/modules/production",
  "src/modules/project-assets",
  "src/modules/referenceTests",
  "src/modules/reviews",
  "src/modules/script-breakdown",
  "src/modules/shot-media",
  "src/modules/storyboard",
  "src/modules/topic-radar",
  "src/modules/trash",
  "src/modules/user-directory",
  "src/modules/vocabulary",
] as const;

test("文案批二 33 组的 Zod 字段全部登记中文 fieldLabels", () => {
  assert.equal(batchTwoModulePaths.length, 33);
  const missing = new Map<string, Set<string>>();

  for (const modulePath of batchTwoModulePaths) {
    const absoluteModulePath = path.join(process.cwd(), modulePath);
    for (const filePath of productionTypeScriptFiles(absoluteModulePath)) {
      collectMissingZodFields(filePath, missing);
    }
  }

  const report = [...missing.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([field, locations]) => `${field}: ${[...locations].sort().join(", ")}`);
  assert.deepEqual(report, [], `fieldLabels 缺少批二字段：\n${report.join("\n")}`);
});

function collectMissingZodFields(
  filePath: string,
  missing: Map<string, Set<string>>,
): void {
  const source = ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const isZodObject = method === "object" && node.expression.expression.getText(source) === "z";
      const isZodExtension = method === "extend";
      const shape = node.arguments[0];
      if ((isZodObject || isZodExtension) && shape && ts.isObjectLiteralExpression(shape)) {
        for (const property of shape.properties) {
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
        const rawName = propertyName(property.name);
        if (!rawName) continue;
        const normalized = camelToSnake(rawName);
        if (fieldLabels[normalized]) continue;
        const line = source.getLineAndCharacterOfPosition(property.getStart(source)).line + 1;
        if (!missing.has(normalized)) missing.set(normalized, new Set());
        missing.get(normalized)?.add(`${path.relative(process.cwd(), filePath)}:${line}`);
        }
      }
    }
    node.forEachChild(visit);
  }

  visit(source);
}

function propertyName(node: ts.PropertyName | undefined): string | null {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return null;
}

function camelToSnake(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function* productionTypeScriptFiles(directory: string): Generator<string> {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* productionTypeScriptFiles(absolute);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      yield absolute;
    }
  }
}
