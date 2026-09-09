import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

test("S57 migration keeps account debit and cost truth bound to the consumed quote", async () => {
  const source = await readFile(path.resolve("migrations/034_s57_account_registration.sql"), "utf8");
  assert.match(source, /CREATE TABLE IF NOT EXISTS \{\{schema\}\}\.invite_tiers/);
  assert.match(source, /tier_key varchar\(64\) NOT NULL/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS \{\{schema\}\}\.invite_codes/);
  assert.match(source, /max_uses integer NOT NULL DEFAULT 1/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS \{\{schema\}\}\.user_credit_accounts/);
  assert.match(source, /charge_points := NEW\.estimated_cost_fen/);
  assert.match(source, /generation_quotes_debit_account_credit/);
  assert.match(source, /account_credit_duplicate_generation_attempt/);
  assert.match(source, /AT TIME ZONE 'Asia\/Shanghai'/);
  assert.doesNotMatch(source, /unit_price_fen/);
});

test("运营底座迁移幂等播种固定 COLTECH 码和受邀用户额度", async () => {
  const source = await readFile(path.resolve("migrations/049_ops_p0_internal_pilot.sql"), "utf8");
  assert.match(source, /ALTER COLUMN issued_by_user_id DROP NOT NULL/);
  assert.match(source, /ADD CONSTRAINT invite_codes_issuer_provenance_check CHECK/);
  assert.match(
    source,
    /issued_by_user_id IS NOT NULL[\s\S]+id = '3d0222ba-7c6f-4ffc-901f-510c3e4aa003'::uuid[\s\S]+AND code_hash = '9b062e/,
  );
  assert.match(source, /9b062e193fc35fbf9267d3f5ec74324edb9f7dd07f333e7b0eb8c5b8f771638a/);
  assert.match(source, /'COLTE••••'/);
  assert.doesNotMatch(source, /'COLTECH'/);
  assert.match(source, /50000,\s*\n\s*50000,/);
  assert.match(source, /2147483647/);
  assert.match(source, /ON CONFLICT \(code_hash\) DO UPDATE/);
  assert.doesNotMatch(source, /used_count\s*=\s*EXCLUDED\.used_count/);
  assert.doesNotMatch(source, /status\s*=\s*'active'/);
  assert.doesNotMatch(source, /max_uses\s*=\s*2147483647/);
  assert.doesNotMatch(source, /expires_at\s*=\s*NULL/);
});
