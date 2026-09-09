#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const schema = "shortdrama-vke-release-evidence/v1";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = realpathSync(path.resolve(scriptDir, "../.."));

function fail(message) {
  console.error(`BLOCK ${message}`);
  process.exit(1);
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`evidence field ${field} must be a non-empty string`);
  }
  return value;
}

function parseArguments(argv) {
  const expected = {
    releaseCommit: "",
    target: "",
    rdsHost: "",
    adminUsernames: "",
    albInstanceId: "",
    domain: "",
    namespace: "",
    rdsCaFingerprint: "",
  };
  const receipts = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const valueOptions = new Map([
      ["--release-commit", "releaseCommit"],
      ["--target", "target"],
      ["--rds-host", "rdsHost"],
      ["--admin-usernames", "adminUsernames"],
      ["--alb-instance-id", "albInstanceId"],
      ["--domain", "domain"],
      ["--namespace", "namespace"],
      ["--rds-ca-fingerprint", "rdsCaFingerprint"],
    ]);
    if (valueOptions.has(option)) {
      expected[valueOptions.get(option)] = argv[++index] ?? "";
      continue;
    }
    if (option === "--receipt") {
      const pair = argv[++index] ?? "";
      const separator = pair.indexOf("=");
      if (separator < 1) fail("--receipt must use check=path@sha256:digest");
      receipts.set(pair.slice(0, separator), pair.slice(separator + 1));
      continue;
    }
    fail(`unknown evidence-validator argument: ${option}`);
  }
  if (!/^[0-9a-f]{40}$/.test(expected.releaseCommit)) fail("release commit must be a full SHA");
  if (!/^c[a-z][A-Za-z0-9]+$/.test(expected.target)) fail("target must be an explicit VKE cluster ID");
  if (!/^[A-Za-z0-9.-]+$/.test(expected.rdsHost)) fail("expected RDS host is invalid");
  if (!/^[a-z0-9][a-z0-9,._-]*$/.test(expected.adminUsernames)) fail("expected administrator list is invalid");
  if (!/^[ac]lb-[A-Za-z0-9-]+$/.test(expected.albInstanceId)) fail("expected ALB instance ID is invalid");
  if (
    expected.domain !== "" &&
    (!/^[A-Za-z0-9.-]+$/.test(expected.domain) || expected.domain.endsWith(".invalid"))
  ) {
    fail("expected domain is invalid");
  }
  if (!["shortdrama", "shortdrama-dev", "shortdrama-prod"].includes(expected.namespace)) {
    fail("release namespace must be shortdrama, shortdrama-dev or shortdrama-prod");
  }
  if (!/^[0-9a-f]{64}$/.test(expected.rdsCaFingerprint)) fail("RDS CA fingerprint must be SHA-256");
  return { expected, receipts };
}

function loadReceipt(reference, expectedCheck, expected) {
  const match = /^(.+\.json)@sha256:([0-9a-f]{64})$/.exec(reference);
  if (!match) fail(`${expectedCheck} receipt must use path@sha256:<64 hex>`);
  const relativePath = match[1];
  const expectedDigest = match[2];
  if (
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    !relativePath.startsWith("docs/validation/") ||
    path.posix.normalize(relativePath) !== relativePath
  ) {
    fail(`${expectedCheck} receipt must be a normalized path under docs/validation`);
  }

  const absolutePath = path.resolve(repoRoot, relativePath);
  let stat;
  let realPath;
  try {
    stat = lstatSync(absolutePath);
    realPath = realpathSync(absolutePath);
  } catch {
    fail(`${expectedCheck} receipt does not exist: ${relativePath}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || !realPath.startsWith(`${repoRoot}${path.sep}`)) {
    fail(`${expectedCheck} receipt must be a regular in-repository file`);
  }

  const raw = readFileSync(realPath);
  const actualDigest = createHash("sha256").update(raw).digest("hex");
  if (actualDigest !== expectedDigest) fail(`${expectedCheck} receipt SHA-256 does not match`);

  let receipt;
  try {
    receipt = JSON.parse(raw.toString("utf8"));
  } catch {
    fail(`${expectedCheck} receipt is not valid JSON`);
  }
  if (receipt.schema !== schema) fail(`${expectedCheck} receipt schema is invalid`);
  if (receipt.check !== expectedCheck) fail(`${expectedCheck} receipt check name is invalid`);
  if (receipt.status !== "pass") fail(`${expectedCheck} receipt status is not pass`);
  if (receipt.releaseCommit !== expected.releaseCommit) fail(`${expectedCheck} receipt commit does not match release`);
  if (receipt.target !== expected.target) fail(`${expectedCheck} receipt target does not match VKE_TARGET_ID`);
  const observedAt = typeof receipt.observedAt === "string" ? Date.parse(receipt.observedAt) : Number.NaN;
  const now = Date.now();
  if (!Number.isFinite(observedAt) || observedAt > now + 5 * 60_000 || now - observedAt > 24 * 60 * 60_000) {
    fail(`${expectedCheck} receipt observedAt is invalid`);
  }
  if (!receipt.details || typeof receipt.details !== "object" || Array.isArray(receipt.details)) {
    fail(`${expectedCheck} receipt details must be an object`);
  }
  return receipt.details;
}

function validateRds(details, expected) {
  const endpoint = requiredString(details.endpoint, "rds_private_connectivity.details.endpoint").toLowerCase();
  if (endpoint === "localhost" || endpoint.endsWith(".localhost") || endpoint.endsWith(".invalid")) {
    fail("RDS evidence endpoint is not a remote RDS endpoint");
  }
  if (endpoint !== expected.rdsHost.toLowerCase()) fail("RDS evidence endpoint does not match POSTGRES_HOST");
  if (details.caFingerprintSha256 !== expected.rdsCaFingerprint) {
    fail("RDS evidence CA fingerprint does not match the rendered certificate");
  }
  if (details.networkScope !== "private" || details.port !== 5432 || details.tlsMode !== "verify-full" || details.probe !== "pass") {
    fail("RDS evidence must prove private port 5432 with TLS verify-full");
  }
}

function validateAdmin(details, expected) {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(details.username ?? "")) {
    fail("administrator evidence username is invalid");
  }
  requiredString(details.migrationReceipt, "admin_bootstrap.details.migrationReceipt");
  if (!expected.adminUsernames.split(",").includes(details.username)) {
    fail("administrator evidence username is not present in ADMIN_USERNAMES");
  }
  if (details.loginProbe !== "pass" || details.registrationEnabled !== false) {
    fail("administrator evidence must prove migrated login with registration closed");
  }
}

function validateAlb(details, expected) {
  if (
    details.clusterNetworkMode !== "VPC-CNI" ||
    details.passThrough !== true ||
    details.serviceType !== "ClusterIP" ||
    details.controllerPreflight !== "pass" ||
    details.albInstanceId !== expected.albInstanceId ||
    details.domain !== expected.domain ||
    details.namespace !== expected.namespace
  ) {
    fail("ALB preflight evidence does not match the rendered VPC-CNI/ALB/Ingress configuration");
  }
  requiredString(details.controllerVersion, "alb_pod_direct_access_preflight.details.controllerVersion");
}

function validateSecurityGroup(details, expected) {
  if (!/^sg-[A-Za-z0-9-]+$/.test(details.securityGroupId ?? "")) {
    fail("VCI Pod security-group evidence has an invalid security group ID");
  }
  const source = requiredString(details.allowedSource, "vci_pod_security_group_preflight.details.allowedSource");
  if (source !== "100.64.0.0/10") fail("VCI Pod security group source must use the official ALB/control-plane CIDR");
  if (!Array.isArray(details.rulesSnapshot) || details.rulesSnapshot.length !== 1) {
    fail("VCI Pod security-group snapshot must contain exactly one ingress rule");
  }
  const [ingressRule] = details.rulesSnapshot;
  const expectedRuleKeys = ["action", "direction", "port", "protocol", "source"];
  if (
    ingressRule === null ||
    typeof ingressRule !== "object" ||
    Array.isArray(ingressRule) ||
    Object.getPrototypeOf(ingressRule) !== Object.prototype ||
    Object.keys(ingressRule).sort().join(",") !== expectedRuleKeys.join(",") ||
    ingressRule.direction !== "ingress" ||
    ingressRule.action !== "allow" ||
    ingressRule.protocol !== "tcp" ||
    ingressRule.port !== 8000 ||
    ingressRule.source !== "100.64.0.0/10"
  ) {
    fail("VCI Pod security-group snapshot must expose only TCP/8000 to the official ALB/control-plane CIDR");
  }
  requiredString(details.controlPlaneRequestId, "vci_pod_security_group_preflight.details.controlPlaneRequestId");
  if (
    details.allowedPort !== 8000 ||
    details.plannedBypassPolicy !== "deny" ||
    details.requiredEgressConfigured !== true ||
    details.albInstanceId !== expected.albInstanceId ||
    details.namespace !== expected.namespace
  ) {
    fail("VCI Pod security-group preflight does not match the rendered ALB/workload boundary");
  }
}

const validators = new Map([
  ["rds_private_connectivity", validateRds],
  ["admin_bootstrap", validateAdmin],
  ["alb_pod_direct_access_preflight", validateAlb],
  ["vci_pod_security_group_preflight", validateSecurityGroup],
]);

const { expected, receipts } = parseArguments(process.argv.slice(2));
for (const [check, validate] of validators) {
  const reference = receipts.get(check);
  if (!reference) fail(`missing ${check} receipt reference`);
  validate(loadReceipt(reference, check, expected), expected);
}
if (receipts.size !== validators.size) fail("unexpected evidence receipt was supplied");
console.log("PASS structured release evidence receipts");
