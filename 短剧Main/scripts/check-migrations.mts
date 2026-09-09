#!/usr/bin/env tsx
/**
 * 迁移体检(纯静态,不连库)。S22 数据库工程护栏 A 包。
 *
 * 四条检查:
 *   1. 编号连续且唯一:001…N 不许跳号、不许重号;无法被迁移器识别的文件名直接报错
 *      (迁移器会静默跳过它们,比跳号更隐蔽)。
 *   2. {{schema}} 占位符完整:必须成对、不许出现未知占位符;渲染后不得残留 {{ 或 }}。
 *   3. checksum 台账(migrations/ledger.json):已入账迁移禁止事后修改——迁移器在
 *      已应用的库上会发现 checksum 不一致,本检查把发现时机提前到提交前。
 *   4. 外部扩展集中声明(migrations/extensions.json):迁移若依赖 pg_trgm 之类的
 *      数据库扩展,必须登记;迁移体内禁止 CREATE EXTENSION(扩展是 DBA 预置条件,
 *      schema 级发布账号不该为此拿库级 CREATE 权限)。
 *
 * 用法:
 *   tsx scripts/check-migrations.mts                  全量校验,任一失败 exit 1
 *   tsx scripts/check-migrations.mts --update-ledger  为新迁移追加台账(拒绝改旧账)
 *   tsx scripts/check-migrations.mts --list-extensions 列出本套迁移需要的数据库扩展
 */
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 与 src/db/migrate.ts 的 migrationFilePattern 保持一致(额外捕获序号)。 */
export const migrationFilePattern = /^(\d+)_[a-z0-9_]+\.sql$/;
export const schemaPlaceholder = "{{schema}}";

export const defaultMigrationsDirectory = path.resolve("migrations");
export const ledgerFileName = "ledger.json";
export const extensionsFileName = "extensions.json";

export interface MigrationInventory {
  /** 能被迁移器识别的迁移文件,已按文件名排序。 */
  files: string[];
  /** migrations/ 下存在但迁移器会静默跳过的 .sql 文件——一律视为错误。 */
  unrecognized: string[];
}

export async function listMigrationFiles(directory: string): Promise<MigrationInventory> {
  const entries = (await readdir(directory)).filter((name) => name.endsWith(".sql"));
  const files = entries.filter((name) => migrationFilePattern.test(name)).sort((a, b) => a.localeCompare(b));
  const unrecognized = entries.filter((name) => !migrationFilePattern.test(name)).sort();
  return { files, unrecognized };
}

/** 检查 1:编号必须恰好覆盖 1..N,不许跳号、重号;文件名必须能被迁移器识别。 */
export function checkNumbering(inventory: MigrationInventory): string[] {
  const errors: string[] = [];
  for (const name of inventory.unrecognized) {
    errors.push(
      `迁移文件名无法被迁移器识别(会被静默跳过): ${name}——必须形如 022_some_thing.sql(小写字母/数字/下划线)`,
    );
  }
  const numbers = new Map<number, string[]>();
  for (const name of inventory.files) {
    const serial = Number(migrationFilePattern.exec(name)![1]);
    numbers.set(serial, [...(numbers.get(serial) ?? []), name]);
  }
  for (const [serial, names] of [...numbers.entries()].sort((a, b) => a[0] - b[0])) {
    if (names.length > 1) {
      errors.push(`迁移号 ${String(serial).padStart(3, "0")} 重号: ${names.join(", ")}——多包并行时迁移号区间由 Fable 分配`);
    }
  }
  const serials = [...numbers.keys()].sort((a, b) => a - b);
  if (serials.length > 0) {
    const max = serials[serials.length - 1]!;
    for (let expected = 1; expected <= max; expected += 1) {
      if (!numbers.has(expected)) {
        errors.push(`迁移号跳号: 缺 ${String(expected).padStart(3, "0")}(已有 001…${String(max).padStart(3, "0")})`);
      }
    }
  }
  return errors;
}

/** 检查 2(单文件):占位符必须成对、只许出现 {{schema}},渲染后不得残留花括号。 */
export function checkPlaceholders(source: string, fileName: string): string[] {
  const errors: string[] = [];
  const residue = source.split(schemaPlaceholder).join("");
  const unknown = residue.match(/\{\{[^{}]*\}\}/);
  if (unknown) {
    errors.push(`${fileName}: 未知占位符 ${unknown[0]}——迁移器只渲染 {{schema}},其他占位符会原样带进数据库`);
  }
  // 去掉合法占位符和成形的 {{...}} 令牌后仍残留花括号,才是不成对。
  const rendered = residue.replace(/\{\{[^{}]*\}\}/g, "");
  if (rendered.includes("{{") || rendered.includes("}}")) {
    errors.push(`${fileName}: {{schema}} 占位符不成对,渲染后会残留花括号`);
  }
  return errors;
}

export function computeChecksum(source: string): string {
  // 与 src/db/migrate.ts 的 checksum 算法逐字节一致。
  // 规范化 CRLF → LF，保证 Windows 与 Linux 产生相同 checksum。
  return createHash("sha256").update(source.replace(/\r\n?/g, "\n")).digest("hex");
}

export interface MigrationLedger {
  version: 1;
  checksums: Record<string, string>;
}

async function readLedger(ledgerPath: string): Promise<MigrationLedger | undefined> {
  let raw: string;
  try {
    raw = await readFile(ledgerPath, "utf8");
  } catch {
    return undefined;
  }
  const parsed = JSON.parse(raw) as MigrationLedger;
  if (parsed.version !== 1 || typeof parsed.checksums !== "object" || parsed.checksums === null) {
    throw new Error(`${ledgerPath} 格式非法: 期望 { "version": 1, "checksums": { … } }`);
  }
  return parsed;
}

/** 检查 3:每个迁移都已入账且内容未变;台账不得登记不存在的文件。 */
export async function checkLedger(
  directory: string,
  files: string[],
  ledgerPath: string,
): Promise<string[]> {
  const ledger = await readLedger(ledgerPath);
  if (!ledger) {
    return [`缺少 checksum 台账 ${ledgerPath}——运行 tsx scripts/check-migrations.mts --update-ledger 生成`];
  }
  const errors: string[] = [];
  for (const name of files) {
    const source = await readFile(path.join(directory, name), "utf8");
    const recorded = ledger.checksums[name];
    if (!recorded) {
      errors.push(`${name}: 新迁移未入账——提交前运行 tsx scripts/check-migrations.mts --update-ledger`);
    } else if (recorded !== computeChecksum(source)) {
      errors.push(
        `${name}: 已入账迁移的内容发生变化——已应用的迁移禁止事后修改(checksum 会在目标库上报错),请改回或新增迁移`,
      );
    }
  }
  for (const name of Object.keys(ledger.checksums)) {
    if (!files.includes(name)) {
      errors.push(`${name}: 台账登记了不存在的迁移文件——迁移与台账必须一一对应`);
    }
  }
  return errors;
}

/** 台账只增不改:新迁移追加 checksum;已有条目内容对不上时拒绝并报告。 */
export async function updateLedger(
  directory: string,
  files: string[],
  ledgerPath: string,
): Promise<{ added: string[]; errors: string[] }> {
  const ledger = (await readLedger(ledgerPath)) ?? { version: 1 as const, checksums: {} };
  const errors: string[] = [];
  const added: string[] = [];
  const next: Record<string, string> = { ...ledger.checksums };
  for (const name of files) {
    const checksum = computeChecksum(await readFile(path.join(directory, name), "utf8"));
    const recorded = next[name];
    if (!recorded) {
      next[name] = checksum;
      added.push(name);
    } else if (recorded !== checksum) {
      errors.push(`${name}: 已入账,禁止用 --update-ledger 覆盖旧 checksum——已应用的迁移禁止事后修改`);
    }
  }
  for (const name of Object.keys(next)) {
    if (!files.includes(name)) errors.push(`${name}: 台账登记了不存在的迁移文件`);
  }
  if (errors.length === 0) {
    const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
    await writeFile(ledgerPath, `${JSON.stringify({ version: 1, checksums: sorted }, null, 2)}\n`, "utf8");
  }
  return { added, errors };
}

export interface ExtensionDeclaration {
  name: string;
  requiredBy: string[];
  note?: string;
}

export interface ExtensionRegistry {
  version: 1;
  extensions: ExtensionDeclaration[];
}

export async function readExtensionRegistry(registryPath: string): Promise<ExtensionRegistry> {
  const parsed = JSON.parse(await readFile(registryPath, "utf8")) as ExtensionRegistry;
  if (parsed.version !== 1 || !Array.isArray(parsed.extensions)) {
    throw new Error(`${registryPath} 格式非法: 期望 { "version": 1, "extensions": [ … ] }`);
  }
  return parsed;
}

/** 迁移体里引用的扩展名,形如 pg_extension WHERE extname = 'pg_trgm'。 */
export function findReferencedExtensions(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/extname\s*=\s*'([A-Za-z0-9_]+)'/g)) {
    found.add(match[1]!);
  }
  return [...found].sort();
}

/**
 * 检查 4:迁移引用的每个扩展都必须集中在 extensions.json 登记且注明依赖它的迁移;
 * 登记必须与实际引用一一对应;迁移体内禁止 CREATE EXTENSION。
 */
export async function checkExtensions(
  directory: string,
  files: string[],
  registryPath: string,
): Promise<string[]> {
  const errors: string[] = [];
  let registry: ExtensionRegistry;
  try {
    registry = await readExtensionRegistry(registryPath);
  } catch (error) {
    return [`无法读取扩展声明 ${registryPath}: ${error instanceof Error ? error.message : String(error)}`];
  }

  const declared = new Map<string, ExtensionDeclaration>();
  for (const entry of registry.extensions) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name)) {
      errors.push(`extensions.json: 扩展名非法: ${JSON.stringify(entry.name)}`);
      continue;
    }
    if (declared.has(entry.name)) {
      errors.push(`extensions.json: 扩展 ${entry.name} 重复登记`);
      continue;
    }
    declared.set(entry.name, entry);
  }

  const referencedByFile = new Map<string, string[]>();
  for (const name of files) {
    const source = await readFile(path.join(directory, name), "utf8");
    if (/CREATE\s+EXTENSION/i.test(source)) {
      errors.push(
        `${name}: 迁移体内禁止 CREATE EXTENSION——扩展是 DBA 预置条件,只需在 migrations/extensions.json 登记`,
      );
    }
    referencedByFile.set(name, findReferencedExtensions(source));
    for (const extension of referencedByFile.get(name)!) {
      const entry = declared.get(extension);
      if (!entry) {
        errors.push(`${name}: 依赖扩展 ${extension} 但未在 migrations/extensions.json 登记`);
      } else if (!entry.requiredBy.includes(name)) {
        errors.push(`${name}: 依赖扩展 ${extension},但 extensions.json 里 ${extension}.requiredBy 未列入本迁移`);
      }
    }
  }

  for (const entry of registry.extensions) {
    if (entry.requiredBy.length === 0) {
      errors.push(`extensions.json: ${entry.name}.requiredBy 为空——登记必须指向依赖它的迁移`);
    }
    for (const name of entry.requiredBy) {
      if (!files.includes(name)) {
        errors.push(`extensions.json: ${entry.name}.requiredBy 引用了不存在的迁移 ${name}`);
      } else if (!referencedByFile.get(name)!.includes(entry.name)) {
        errors.push(`extensions.json: ${entry.name}.requiredBy 列入 ${name},但该迁移并未引用 ${entry.name}`);
      }
    }
  }
  return errors;
}

export async function runAllChecks(migrationsDirectory: string): Promise<string[]> {
  const inventory = await listMigrationFiles(migrationsDirectory);
  const ledgerPath = path.join(migrationsDirectory, ledgerFileName);
  const registryPath = path.join(migrationsDirectory, extensionsFileName);
  const errors: string[] = [];
  errors.push(...await checkLedger(migrationsDirectory, inventory.files, ledgerPath));
  errors.push(...await checkExtensions(migrationsDirectory, inventory.files, registryPath));
  errors.push(...checkNumbering(inventory));
  for (const name of inventory.files) {
    const source = await readFile(path.join(migrationsDirectory, name), "utf8");
    errors.push(...checkPlaceholders(source, name));
  }
  return errors;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const directory = defaultMigrationsDirectory;
  if (args.has("--list-extensions")) {
    const registry = await readExtensionRegistry(path.join(directory, extensionsFileName));
    for (const entry of registry.extensions) {
      process.stdout.write(`${entry.name}\t(requiredBy: ${entry.requiredBy.join(", ")})\n`);
    }
    return;
  }
  if (args.has("--update-ledger")) {
    const inventory = await listMigrationFiles(directory);
    const { added, errors } = await updateLedger(directory, inventory.files, path.join(directory, ledgerFileName));
    for (const name of added) process.stdout.write(`入账新迁移: ${name}\n`);
    if (errors.length > 0) {
      for (const error of errors) process.stderr.write(`✖ ${error}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(added.length === 0 ? "台账已是最新\n" : `台账更新完成,新增 ${added.length} 条\n`);
    return;
  }

  const errors = await runAllChecks(directory);
  if (errors.length > 0) {
    process.stderr.write(`迁移体检失败(${errors.length} 项):\n`);
    for (const error of errors) process.stderr.write(`✖ ${error}\n`);
    process.exitCode = 1;
    return;
  }
  const inventory = await listMigrationFiles(directory);
  process.stdout.write(
    `迁移体检通过: ${inventory.files.length} 个迁移,编号连续唯一、占位符完整、checksum 台账一致、扩展依赖已登记\n`,
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
