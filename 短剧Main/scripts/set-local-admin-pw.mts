// 只改本地 docker 库（127.0.0.1）的 admin 密码，方便本机开发登录。
// 判据：连接串必须是本机；不是本机就拒绝执行，防止误改云端。
import { Client } from "pg";
import { hashPassword } from "../src/modules/auth/service.js";

const HOST = "127.0.0.1";
const NEW_PASSWORD = process.env.LOCAL_DEV_ADMIN_PASSWORD ?? "admin12345";

const client = new Client({
  host: HOST, port: 5432, user: "shortdrama",
  password: process.env.LOCAL_PG_PASSWORD, database: "shortdrama",
});

async function main(): Promise<void> {
  await client.connect();
  const who = await client.query<{ h: string }>("select inet_server_addr()::text as h");
  const addr = who.rows[0]?.h ?? "";
  if (addr && !addr.startsWith("127.") && !addr.startsWith("172.") && !addr.startsWith("192.168.")) {
    throw new Error(`拒绝执行:目标库不是本机(${addr})`);
  }
  const hash = await hashPassword(NEW_PASSWORD);
  for (const schema of ["app", "lite"]) {
    const r = await client.query(
      `update ${schema}.users set password_hash = $1, updated_at = now() where username = 'admin'`,
      [hash],
    );
    console.log(`${schema}.users admin 更新行数: ${r.rowCount}`);
  }
  console.log(`本地 admin 密码已设为: ${NEW_PASSWORD}`);
}

main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; })
  .finally(() => { void client.end(); });
