/**
 * Create the first V0.1.2 production administrator without opening public
 * registration or putting a plaintext password in stdout, a shell history, or
 * a repository file. 密码由环境变量提供（.env），不随机生成。
 *
 * This is a production database write. It is intentionally fail-closed and
 * must only be run after a separate production-write authorization.
 */
import { eq } from "drizzle-orm";
import { settings } from "../src/config/env.js";
import { createDatabase } from "../src/db/client.js";
import { users } from "../src/db/schema.js";
import { hashPassword, normalizeUsername } from "../src/modules/auth/service.js";

const confirmation = "CREATE_INITIAL_PRODUCTION_ADMIN";
const usernamePattern = /^[a-z0-9][a-z0-9_.-]{2,63}$/;

interface Input {
  username?: string;
  displayName?: string;
  passwordEnv?: string;
  apply: boolean;
  schema?: string;
  confirmation?: string;
  help: boolean;
}

async function main(): Promise<void> {
  const input = parseArgs(process.argv.slice(2));
  if (input.help) return printHelp();

  if (!input.apply || input.confirmation !== confirmation) {
    throw new Error(`拒绝执行：这是生产写操作。需要同时提供 --apply 和 --confirm ${confirmation}`);
  }
  // 守卫的意图是「别写错库」，不是「schema 必须叫 prod」。写死名字会让 schema
  // 名与环境名耦合（见 docs/contracts/environment-governance.md §2），改为要求
  // 调用方显式声明目标 schema 并与运行配置逐字比对：仍然 fail-closed，且不再
  // 绑定任何特定名称。
  const declaredSchema = requireValue(input.schema, "--schema");
  if (declaredSchema !== settings.postgresSchema) {
    throw new Error(
      `拒绝执行：--schema 声明为 ${declaredSchema}，但 POSTGRES_SCHEMA 实为 ${settings.postgresSchema}`,
    );
  }
  // 这里原来要求 AUTH_REGISTRATION_ENABLED=false，本意是「建首个管理员时别让注册
  // 敞着」。S57 之后邮箱自注册始终开放，这个开关只为旧部署清单能解析而保留，不再是
  // 任何访问控制（src/config/env.ts 同处注释、以及全仓无第二个读取点可证）。留着它
  // 的唯一效果是：.env.example 默认 true，dev:up 第 3 步照文档跑必然被自己挡下。
  // fail-closed 由 --apply/--confirm、--schema 逐字比对、ADMIN_USERNAMES 包含性、
  // 密码来自环境变量、以及重名拒绝这五层负责，删掉这一条不减少任何真实防护。

  const username = normalizeUsername(requireValue(input.username, "--username"));
  if (!usernamePattern.test(username)) {
    throw new Error("用户名需为 3 至 64 位小写字母、数字、点、横线或下划线");
  }
  if (!settings.adminUsernames.includes(username)) {
    throw new Error("拒绝执行：ADMIN_USERNAMES 必须已包含该用户名，避免创建后无法管理");
  }

  const displayName = (input.displayName?.trim() || username);
  if (displayName.length > 128) throw new Error("显示名称不能超过 128 个字符");

  // DC 2026-07-27:「代码逻辑应该是读取环境变量,不要随机密码」。
  // 原来每次都生成随机密码再写文件,后果是每跑一次 dev:reset,DC 的登录密码就变
  // 一次——他得回去翻文件。密码固定在 .env 里,谁都不用记。
  const passwordEnvName = input.passwordEnv?.trim() || "ADMIN_INITIAL_PASSWORD";
  const password = process.env[passwordEnvName]?.trim();
  if (!password) {
    throw new Error(`拒绝执行:环境变量 ${passwordEnvName} 未设置。密码由 .env 提供,本脚本不生成随机密码`);
  }
  if (password.length < settings.authPasswordMinLength) {
    throw new Error(`拒绝执行:${passwordEnvName} 长度不足 ${settings.authPasswordMinLength} 位`);
  }

  const handle = createDatabase();
  try {
    const existing = await handle.db.select({ id: users.id }).from(users)
      .where(eq(users.username, username)).limit(1);
    if (existing.length > 0) throw new Error("拒绝执行：该用户名已存在；请通过已登录管理员重置密码");

    const passwordHash = await hashPassword(password);
    const now = new Date();
    const created = await handle.db.insert(users).values({
      id: crypto.randomUUID(),
      username,
      displayName,
      passwordHash,
      active: true,
      // 必须显式写入。迁移 016 只提升「迁移执行时已存在」的用户，而 Day-0 引导
      // 恰恰发生在迁移之后：不写这一行，新环境的第一个管理员会落成 role=member，
      // 能登录却没有任何管理权限，且没有第二个管理员可以把它提上去。
      role: "admin",
      createdAt: now,
      updatedAt: now,
    }).returning({
      id: users.id, username: users.username, displayName: users.displayName, role: users.role,
    });
    if (!created[0]) throw new Error("创建管理员失败");

    console.log(JSON.stringify({
      status: "created",
      username: created[0].username,
      display_name: created[0].displayName,
      role: created[0].role,
      password_source: `环境变量 ${passwordEnvName}`,
      next_step: "密码来自 .env,固定不变;要改就改 .env 再重建。",
    }));
  } finally {
    await handle.pool.end();
  }
}

function parseArgs(args: readonly string[]): Input {
  const input: Input = { apply: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") input.help = true;
    else if (arg === "--apply") input.apply = true;
    else if (arg === "--username") input.username = takeValue(args, ++index, arg);
    else if (arg === "--display-name") input.displayName = takeValue(args, ++index, arg);
    else if (arg === "--password-env") input.passwordEnv = takeValue(args, ++index, arg);
    else if (arg === "--confirm") input.confirmation = takeValue(args, ++index, arg);
    else if (arg === "--schema") input.schema = takeValue(args, ++index, arg);
    else throw new Error(`未知参数：${arg}`);
  }
  return input;
}

function takeValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} 需要一个值`);
  return value;
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} 必填`);
  return value;
}

function printHelp(): void {
  console.log(`\n用法（仅在获得单独的生产写授权后执行）：\n\n  node --import tsx scripts/bootstrap-production-admin.ts \\\n    --apply --confirm ${confirmation} \\\n    --username <lowercase-admin> \\\n    --display-name <name> \\\n    --schema <目标 schema，须与 POSTGRES_SCHEMA 一致> \\\n    --password-env <环境变量名，默认 ADMIN_INITIAL_PASSWORD>\n\n前置：--schema 与 POSTGRES_SCHEMA 逐字一致，且 ADMIN_USERNAMES 已包含该用户名。\n密码从环境变量读取（放 .env，固定不变），本脚本不生成随机密码、也从不在 stdout 输出密码。\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "bootstrap failed");
  process.exitCode = 1;
});
