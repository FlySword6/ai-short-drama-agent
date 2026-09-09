import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const batchTwoModulePaths = [
  "account-credits",
  "admin/generations",
  "admin/models",
  "admin/users",
  "ai",
  "audio",
  "auth",
  "capability-tiers",
  "command-palette",
  "config-entries",
  "consumption-records",
  "control-packages",
  "dashboard",
  "delivery",
  "director/commands",
  "director/scene",
  "director/templates",
  "events",
  "generation/defaults",
  "health",
  "object-context",
  "operations",
  "production",
  "project-assets",
  "referenceTests",
  "reviews",
  "script-breakdown",
  "shot-media",
  "storyboard",
  "topic-radar",
  "trash",
  "user-directory",
  "vocabulary",
] as const;

const publicErrorClasses = new Set([
  "AppError",
  "BadRequestError",
  "ConflictError",
  "ForbiddenError",
  "NotFoundError",
  "PayloadTooLargeError",
  "UnauthorizedError",
  "UnprocessableEntityError",
  "CommandValidationError",
  "TemplateApplyError",
  "AiDailyCallLimitError",
]);
const allowedUppercaseTokens = new Set(["AI", "CSV"]);
const forbiddenTechnicalCopy = [
  /52api/iu,
  /V0\.1/iu,
  /方舟|向量模型|原始响应|接口路径|清理计划|多级别名|规范词|终态|可见性数据/iu,
  /\/api\//u,
  /\b(?:4|5)\d{2}\b/u,
  /\b(?:from|to|ts|props|selected|mock)\b/iu,
  /\b(?:project|scene|current|candidate|mediaResult|asset|usage)[A-Z]\w*\b/u,
  /\b(?:project|scene|media|asset|candidate|usage|provider|generation|ai)_[a-z0-9_]+\b/iu,
  /\$\{(?:path|key)\}/u,
  /\.(?:xlsx|xlsm)\b/iu,
];

test("文案批二 33 组的公开错误不含技术词", () => {
  assert.equal(batchTwoModulePaths.length, 33);
  const violations: string[] = [];

  for (const modulePath of batchTwoModulePaths) {
    const absoluteModulePath = path.join(process.cwd(), "src/modules", modulePath);
    for (const filePath of productionTypeScriptFiles(absoluteModulePath)) {
      inspectPublicMessages(filePath, violations);
    }
  }

  assert.deepEqual(violations, [], `公开错误文案命中技术词：\n${violations.join("\n")}`);
});

test("生成提醒展示层不读取 raw failure_reason", () => {
  for (const relativePath of [
    "frontend/shortdrama-rag-demo/src/app.tsx",
    "frontend/shortdrama-rag-demo/src/home-next-step.ts",
  ]) {
    const source = fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
    assert.doesNotMatch(source, /notification\.failure_reason/u, `${relativePath} 仍把 raw failure_reason 上屏`);
  }
});

function inspectPublicMessages(filePath: string, violations: string[]): void {
  const source = ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  function visit(node: ts.Node): void {
    if (ts.isNewExpression(node)) {
      const className = node.expression.getText(source);
      if (publicErrorClasses.has(className)) {
        const message = className === "AppError" ? node.arguments?.[2] : node.arguments?.[0];
        if (message) checkMessageExpression(message, filePath, source, violations);
      }
    }
    if (
      ts.isPropertyAssignment(node)
      && propertyName(node.name) === "message"
      && filePath.endsWith(`${path.sep}routes.ts`)
      && isStringLike(node.initializer)
    ) {
      checkMessageExpression(node.initializer, filePath, source, violations);
    }
    node.forEachChild(visit);
  }

  visit(source);
}

function checkMessageExpression(
  expression: ts.Expression,
  filePath: string,
  source: ts.SourceFile,
  violations: string[],
): void {
  const value = expression.getText(source);
  const publicText = displayedLiteralText(expression);
  const reasons = forbiddenTechnicalCopy
    .filter((pattern) => pattern.test(publicText))
    .map((pattern) => pattern.source);
  if (
    /(?:error|failure)Message|\.message\b/u.test(value)
    && (!isStringLike(expression) || ts.isTemplateExpression(expression))
  ) {
    reasons.push("运行时错误原文");
  }
  if (/(?:candidateId|candidate_id|sceneIndex|scene_index|start_line_index|end_line_index|media_result_id|review_status)/u.test(value)) {
    reasons.push("内部标识值");
  }
  for (const token of publicText.match(/[A-Z]{2,}/gu) ?? []) {
    if (!allowedUppercaseTokens.has(token)) reasons.push(`大写缩写 ${token}`);
  }
  if (!reasons.length) return;
  const line = source.getLineAndCharacterOfPosition(expression.getStart(source)).line + 1;
  violations.push(
    `${path.relative(process.cwd(), filePath)}:${line} ${[...new Set(reasons)].join("、")} -> ${value}`,
  );
}

function displayedLiteralText(node: ts.Expression): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [
      node.head.text,
      ...node.templateSpans.map((span) => span.literal.text),
    ].join(" ");
  }
  return "";
}

function isStringLike(node: ts.Node): boolean {
  return ts.isStringLiteral(node)
    || ts.isNoSubstitutionTemplateLiteral(node)
    || ts.isTemplateExpression(node);
}

function propertyName(node: ts.PropertyName | undefined): string | null {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return null;
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
