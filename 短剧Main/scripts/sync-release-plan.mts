#!/usr/bin/env tsx
/**
 * 版本计划同步:docs/design/version-plan.md → config_entries(release_section)。
 * S31 真源合一机制 B:库是运行时真源,md 是编辑源;冲突以 md 为准往库里推,
 * 反向不自动覆盖(运营在管理界面改过的行不被抹掉)。
 *
 * 走已有 admin HTTP 接口(GET/POST/PUT /api/v1/admin/config-entries),
 * 不直连数据库——这正是「内容改起来不发版」那张卡承诺的能力,拿它自己验一次。
 *
 * 对齐只靠 card_key(文档锚点 <!-- card:... --> ↔ 库内卡片 card_key),
 * 不靠标题文本。行为:
 *   - 文档有、库里没有的卡 → 追加进对应段(新卡 category 默认 feature,
 *     可在管理界面改;本工具从不改已有卡的 category);
 *   - 两边都有但状态/档期与文档不一致 → 以文档为准更新(只动 status/release,
 *     标题/tagline/reason/basis/teaser 一个字都不碰);
 *   - 验收标准 acceptance(S37)改由文档管:文档有 → 以文档为准覆盖/新增;
 *     文档没有而库里有 → 只报告不自动清(清内容不可逆,要人确认)。
 *     它是内部判据、只有 Fable 写,S31「运营在管理界面改过的行不被抹掉」的
 *     顾虑对它不成立;title/tagline/reason 等字段的该保护照旧;
 *   - 库里有、文档没有的卡/段 → 只报告,不自动删(删内容不可逆,要人确认);
 *   - 库里缺 card_key 的卡 → 按 id 兜底对齐并点名提醒跑迁移 027。
 *
 * 默认 dry-run 只打印计划,--apply 才真写;写后立即重算一遍,报「无变化」
 * 才算完(幂等自证)。同一份文档连跑两次,第二次报「无变化」。
 *
 * 环境变量(只从环境取,不硬编码,不打日志):
 *   RELEASE_PLAN_SYNC_API_BASE  必填,API 根地址,如 http://localhost:3000
 *   RELEASE_PLAN_SYNC_TOKEN     管理员会话 token;不给了就用下面的账号密码登录
 *   RELEASE_PLAN_SYNC_USERNAME / RELEASE_PLAN_SYNC_PASSWORD  管理员账号密码
 *
 * 用法:
 *   npx tsx scripts/sync-release-plan.mts [--doc docs/design/version-plan.md]
 *   npx tsx scripts/sync-release-plan.mts --apply
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  expectedCardRelease,
  parseReleasePlanDoc,
  RELEASE_PLAN_DOC_PATH,
  type ReleasePlanDocCard,
  type ReleasePlanDocSection,
} from "../src/modules/config-entries/release-plan-doc.js";
import {
  releaseSectionPayloadSchema,
  type ReleaseCardPayload,
  type ReleaseSectionPayload,
} from "../src/modules/config-entries/types.js";

interface AdminEntry {
  id: string;
  kind: string;
  entry_key: string;
  status: string;
  sort: number;
  payload: unknown;
}

interface Plan {
  /** 文档有库里没有的卡,按段分组。 */
  additions: Array<{ section: string; card: ReleasePlanDocCard }>;
  /** 两边都有但状态/档期/验收漂移,按段分组。 */
  drift: Array<{ section: string; cardKey: string; field: "status" | "release" | "section_status" | "acceptance"; from: string; to: string }>;
  /** 库里有文档没有:只报告。 */
  extras: Array<{ section: string; cardKey: string; title: string; hint?: string }>;
  /** 库里有验收、文档没有:只报告不自动清(清内容不可逆,要人确认)。 */
  acceptanceExtras: Array<{ section: string; cardKey: string; title: string }>;
  /** 库里缺 card_key 的卡(按 id 兜底对齐了,但应该跑迁移 027 补齐)。 */
  homeless: Array<{ section: string; id: string; title: string }>;
  /** 文档有库里没有的段(整段新建)。 */
  newSections: ReleasePlanDocSection[];
  /** 库里有文档没有的段:只报告。 */
  extraSections: Array<{ entryKey: string; status: string }>;
  /** 结构性问题(段的 payload 认不出等),出现即拒绝写。 */
  errors: string[];
}

interface Write {
  action: "create" | "update";
  entryKey: string;
  id?: string;
  sort?: number;
  payload: ReleaseSectionPayload;
}

function readCardKey(card: Record<string, unknown>): string | undefined {
  const key = card.card_key;
  return typeof key === "string" && key.trim() ? key.trim() : undefined;
}

function newCardPayload(card: ReleasePlanDocCard, section: ReleasePlanDocSection): ReleaseCardPayload {
  return {
    id: card.cardKey,
    card_key: card.cardKey,
    title: card.title,
    tagline: card.body,
    status: section.status,
    category: "feature",
    release: expectedCardRelease(section),
    ...(card.reason ? { reason: card.reason } : {}),
    ...(card.basis ? { basis: card.basis } : {}),
    ...(card.acceptance ? { acceptance: card.acceptance } : {}),
  };
}

/** 以库内现状为底,只追加缺失卡、只修状态/档期/验收漂移;其余字段一概不碰。 */
function mergeSectionPayload(
  base: ReleaseSectionPayload,
  section: ReleasePlanDocSection,
  pending: Pick<Plan, "additions" | "drift" | "acceptanceExtras">,
): ReleaseSectionPayload {
  const merged: ReleaseSectionPayload = {
    ...base,
    status: section.status,
    cards: base.cards.map((card) => ({ ...card })),
  };
  const byKey = new Map<string, ReleaseCardPayload>();
  for (const card of merged.cards) {
    const key = readCardKey(card as unknown as Record<string, unknown>) ?? card.id;
    byKey.set(key, card);
  }
  for (const docCard of section.cards) {
    const existing = byKey.get(docCard.cardKey);
    if (!existing) {
      merged.cards.push(newCardPayload(docCard, section));
      pending.additions.push({ section: section.entryKey, card: docCard });
      continue;
    }
    if (existing.status !== section.status) {
      pending.drift.push({ section: section.entryKey, cardKey: docCard.cardKey, field: "status", from: existing.status, to: section.status });
      existing.status = section.status;
    }
    const release = expectedCardRelease(section);
    if (existing.release !== release) {
      pending.drift.push({ section: section.entryKey, cardKey: docCard.cardKey, field: "release", from: existing.release, to: release });
      existing.release = release;
    }
    // acceptance 由文档管(S37):文档有 → 以文档为准;文档没有而库里有 →
    // 只报告不自动清(清内容不可逆),payload 里原样保留。
    if (docCard.acceptance !== undefined) {
      if (existing.acceptance !== docCard.acceptance) {
        pending.drift.push({ section: section.entryKey, cardKey: docCard.cardKey, field: "acceptance", from: existing.acceptance ?? "(空)", to: docCard.acceptance });
        existing.acceptance = docCard.acceptance;
      }
    } else if (existing.acceptance !== undefined) {
      pending.acceptanceExtras.push({ section: section.entryKey, cardKey: docCard.cardKey, title: existing.title });
    }
  }
  if (base.status !== section.status) {
    pending.drift.push({ section: section.entryKey, cardKey: "(段)", field: "section_status", from: base.status, to: section.status });
  }
  return merged;
}

export type { AdminEntry, Plan, Write };

/** 纯函数:文档段 × 库内条目 → 变更计划与待写清单。不写库、不发请求。 */
export function buildPlan(sections: ReleasePlanDocSection[], entries: AdminEntry[]): { plan: Plan; writes: Write[] } {
  const plan: Plan = { additions: [], drift: [], extras: [], acceptanceExtras: [], homeless: [], newSections: [], extraSections: [], errors: [] };
  const writes: Write[] = [];
  const docKeys = new Map(sections.map((section, index) => [section.entryKey, index]));

  for (const section of sections) {
    const entry = entries.find((item) => item.entry_key === section.entryKey);
    if (!entry) {
      plan.newSections.push(section);
      const payload: ReleaseSectionPayload = {
        title: section.title,
        status: section.status,
        note: "",
        cards: section.cards.map((card) => newCardPayload(card, section)),
      };
      writes.push({ action: "create", entryKey: section.entryKey, sort: sections.indexOf(section) + 1, payload });
      continue;
    }
    const parsed = releaseSectionPayloadSchema.safeParse(entry.payload);
    if (!parsed.success) {
      plan.errors.push(`段 ${section.entryKey} 库内 payload 不符合 release_section 格式,为安全起见跳过本段(${parsed.error.issues.length} 处问题)`);
      continue;
    }
    for (const card of parsed.data.cards) {
      if (!readCardKey(card as unknown as Record<string, unknown>)) {
        plan.homeless.push({ section: section.entryKey, id: card.id, title: card.title });
      }
    }
    // 先收进临时清单,合并结果过了校验才落进正式计划——校验不过就整段跳过,
    // 不留半截动作。
    const pending: Pick<Plan, "additions" | "drift" | "acceptanceExtras"> = { additions: [], drift: [], acceptanceExtras: [] };
    const merged = mergeSectionPayload(parsed.data, section, pending);
    const reparsed = releaseSectionPayloadSchema.safeParse(merged);
    if (!reparsed.success) {
      plan.errors.push(`段 ${section.entryKey} 合并后的 payload 过不了校验(${reparsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}),拒绝写入`);
      continue;
    }
    plan.additions.push(...pending.additions);
    plan.drift.push(...pending.drift);
    plan.acceptanceExtras.push(...pending.acceptanceExtras);
    if (pending.additions.length + pending.drift.length > 0) {
      writes.push({ action: "update", entryKey: section.entryKey, id: entry.id, payload: reparsed.data });
    }
    const docCardKeys = new Set(section.cards.map((card) => card.cardKey));
    for (const card of parsed.data.cards) {
      const key = readCardKey(card as unknown as Record<string, unknown>) ?? card.id;
      if (!docCardKeys.has(key)) {
        const elsewhere = sections.find((other) => other.entryKey !== section.entryKey && other.cards.some((docCard) => docCard.cardKey === key));
        plan.extras.push({
          section: section.entryKey,
          cardKey: key,
          title: card.title,
          ...(elsewhere ? { hint: `同一 key 在文档的 ${elsewhere.entryKey} 段里,可能是挪了档期` } : {}),
        });
      }
    }
  }

  for (const entry of entries) {
    if (!docKeys.has(entry.entry_key)) {
      plan.extraSections.push({ entryKey: entry.entry_key, status: entry.status });
    }
  }
  return { plan, writes };
}

/** 漂移值打印成单行:验收是多行文本,换行折叠、超长截断。 */
function preview(value: string): string {
  const flat = value.replaceAll("\n", "⏎");
  return flat.length > 60 ? `${flat.slice(0, 60)}…(共 ${flat.length} 字)` : flat;
}

function printPlan(plan: Plan): void {
  const out = (line: string) => process.stdout.write(`${line}\n`);
  out(`将新增 ${plan.additions.length} 张卡:`);
  for (const item of plan.additions) out(`  ${item.section} + ${item.card.cardKey}(${item.card.title})`);
  out(`将更新 ${plan.drift.length} 处漂移:`);
  for (const item of plan.drift) out(`  ${item.section} ~ ${item.cardKey}.${item.field}: ${preview(item.from)} → ${preview(item.to)}`);
  out(`将新建 ${plan.newSections.length} 个段:`);
  for (const section of plan.newSections) out(`  ${section.entryKey}(${section.title},${section.cards.length} 卡)`);
  out(`只报告不动手(库里有、文档没有;删内容是不可逆动作,要人确认):`);
  for (const item of plan.extras) out(`  ${item.section} × ${item.cardKey}(${item.title})${item.hint ? `——${item.hint}` : ""}`);
  for (const item of plan.extraSections) out(`  段 ${item.entryKey}(库内状态 ${item.status})整段只报告`);
  for (const item of plan.acceptanceExtras) out(`  ${item.section} × ${item.cardKey}(${item.title})库里有验收标准、文档没有——补进文档,或在管理界面删掉库里的`);
  if (plan.homeless.length > 0) {
    out(`未归属卡片(库内缺 card_key,本次按 id 兜底对齐;请跑迁移 027 补齐):`);
    for (const item of plan.homeless) out(`  ${item.section} ? ${item.id}(${item.title})`);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      apply: { type: "boolean", default: false },
      doc: { type: "string", default: RELEASE_PLAN_DOC_PATH },
    },
  });
  const apply = values.apply === true;
  const docPath = values.doc ?? RELEASE_PLAN_DOC_PATH;

  const apiBase = process.env.RELEASE_PLAN_SYNC_API_BASE?.replace(/\/+$/, "");
  if (!apiBase) {
    throw new Error("缺 RELEASE_PLAN_SYNC_API_BASE(API 根地址,如 http://localhost:3000)——连接信息只从环境变量取");
  }
  let token = process.env.RELEASE_PLAN_SYNC_TOKEN;
  if (!token) {
    const username = process.env.RELEASE_PLAN_SYNC_USERNAME;
    const password = process.env.RELEASE_PLAN_SYNC_PASSWORD;
    if (!username || !password) {
      throw new Error("缺管理员凭据:给 RELEASE_PLAN_SYNC_TOKEN,或 RELEASE_PLAN_SYNC_USERNAME + RELEASE_PLAN_SYNC_PASSWORD");
    }
    token = await login(apiBase, username, password);
  }

  const markdown = await readFile(docPath, "utf8");
  const doc = parseReleasePlanDoc(markdown);
  if (doc.issues.length > 0) {
    for (const issue of doc.issues) process.stderr.write(`✖ 文档结构: ${issue}\n`);
    throw new Error(`文档解析出 ${doc.issues.length} 处结构问题,先修文档再同步`);
  }
  const cardTotal = doc.sections.reduce((total, section) => total + section.cards.length, 0);
  process.stdout.write(`文档:${docPath}(${doc.sections.length} 段 ${cardTotal} 卡,解析零 issue)\n`);

  const entries = await listReleaseSections(apiBase, token);
  process.stdout.write(`接口:${apiBase}(库内 release_section ${entries.length} 段)\n`);

  const { plan, writes } = buildPlan(doc.sections, entries);
  if (plan.errors.length > 0) {
    for (const error of plan.errors) process.stderr.write(`✖ ${error}\n`);
    throw new Error("存在结构性问题,拒绝写入");
  }
  printPlan(plan);

  if (writes.length === 0) {
    process.stdout.write("无变化。\n");
    return;
  }
  if (!apply) {
    process.stdout.write(`以上是 dry-run;确认无误后用 --apply 真写(${writes.length} 笔)。\n`);
    return;
  }

  for (const write of writes) {
    if (write.action === "create") {
      await createSection(apiBase, token, write);
      process.stdout.write(`✔ 已新建段 ${write.entryKey}\n`);
    } else {
      await updateSection(apiBase, token, write);
      process.stdout.write(`✔ 已更新段 ${write.entryKey}\n`);
    }
  }

  // 幂等自证:写完立即重算,必须无变化(报告项除外,它们本来就要人确认)。
  const after = await listReleaseSections(apiBase, token);
  const verification = buildPlan(doc.sections, after);
  const remaining = verification.writes.length;
  if (verification.plan.errors.length > 0 || remaining > 0) {
    for (const error of verification.plan.errors) process.stderr.write(`✖ ${error}\n`);
    throw new Error(`写完重算仍有 ${remaining} 笔待写,幂等自证失败——请把本输出交给 Fable`);
  }
  process.stdout.write(`写入完成并已重算验证:无变化(幂等成立)。报告项 ${verification.plan.extras.length + verification.plan.extraSections.length} 条仍需人工确认。\n`);
}

async function request(apiBase: string, token: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} 返回 ${response.status}:${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : undefined;
}

function unwrap(payload: unknown): Record<string, unknown> {
  const envelope = payload as { ok?: boolean; data?: unknown };
  if (!envelope || envelope.ok !== true || typeof envelope.data !== "object" || envelope.data === null) {
    throw new Error("接口响应形状不对(期望 { ok: true, data: … })");
  }
  return envelope.data as Record<string, unknown>;
}

async function login(apiBase: string, username: string, password: string): Promise<string> {
  const response = await fetch(`${apiBase}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) {
    throw new Error(`登录失败(${response.status})——请确认 RELEASE_PLAN_SYNC_USERNAME/PASSWORD 是管理员账号`);
  }
  const data = unwrap(await response.json()) as { token?: string };
  if (!data.token) throw new Error("登录响应里没有 token");
  return data.token;
}

async function listReleaseSections(apiBase: string, token: string): Promise<AdminEntry[]> {
  const payload = unwrap(await request(apiBase, token, "GET", "/api/v1/admin/config-entries?kind=release_section"));
  const entries = payload.entries;
  if (!Array.isArray(entries)) throw new Error("接口响应里没有 entries 数组");
  return entries as AdminEntry[];
}

async function createSection(apiBase: string, token: string, write: { entryKey: string; sort?: number; payload: ReleaseSectionPayload }): Promise<void> {
  await request(apiBase, token, "POST", "/api/v1/admin/config-entries", {
    kind: "release_section",
    entry_key: write.entryKey,
    status: "published",
    sort: write.sort ?? 0,
    payload: write.payload,
  });
}

async function updateSection(apiBase: string, token: string, write: { id?: string; payload: ReleaseSectionPayload }): Promise<void> {
  if (!write.id) throw new Error("更新段缺 id");
  await request(apiBase, token, "PUT", `/api/v1/admin/config-entries/${write.id}`, {
    kind: "release_section",
    payload: write.payload,
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`✖ ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
