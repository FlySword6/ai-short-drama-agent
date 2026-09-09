#!/usr/bin/env node
import { readFileSync } from "node:fs";

function fail(message) {
  console.error(`BLOCK ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const manifest = args[0];
if (!manifest) {
  fail("rendered manifest path is required");
}

let namespace = "";
let albName = "";
for (let index = 1; index < args.length; index += 1) {
  const option = args[index];
  if (option === "--namespace") {
    namespace = args[++index] ?? "";
    continue;
  }
  if (option === "--alb-name") {
    albName = args[++index] ?? "";
    continue;
  }
  fail(`unknown manifest-scope argument: ${option}`);
}
if (!/^shortdrama(-dev|-prod)?$/.test(namespace)) {
  fail("--namespace must be shortdrama, shortdrama-dev or shortdrama-prod");
}
if (!/^shortdrama(-dev|-prod)?-alb$/.test(albName)) {
  fail("--alb-name must be shortdrama-alb, shortdrama-dev-alb or shortdrama-prod-alb");
}

const expectedNamespaced = [
  `ConfigMap/${namespace}/shortdrama-rds-ca`,
  `ConfigMap/${namespace}/shortdrama-runtime`,
  `Deployment/${namespace}/shortdrama`,
  `Ingress/${namespace}/shortdrama`,
  `Namespace//${namespace}`,
  `Service/${namespace}/shortdrama`,
  `ServiceAccount/${namespace}/shortdrama-runtime`,
];
// prod 双入口:HTTP-80 与 HTTPS-443 各一个 Ingress,共享同一 ALBInstance(证书绑定在
// ALBInstance listener,证书中心 cert_center);actualNamespaced 已 sort,插入位置须保持字典序。
if (namespace === "shortdrama-prod") {
  expectedNamespaced.splice(
    expectedNamespaced.indexOf(`Ingress/${namespace}/shortdrama`) + 1,
    0,
    `Ingress/${namespace}/shortdrama-https`,
  );
}
// ALBInstance is a cluster-scoped CRD; kustomize namespace transformers may
// still stamp a metadata.namespace on it, which the API server ignores.
const expectedAlb = new Set([`ALBInstance//${albName}`, `ALBInstance/${namespace}/${albName}`]);

function metadataValue(lines, field) {
  const metadataIndex = lines.findIndex((line) => line === "metadata:");
  if (metadataIndex < 0) return "";
  for (let index = metadataIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== "" && !/^\s/.test(line)) break;
    const match = new RegExp(`^  ${field}: ([A-Za-z0-9.-]+)$`).exec(line);
    if (match) return match[1];
  }
  return "";
}

const documents = readFileSync(manifest, "utf8")
  .split(/^---\s*$/m)
  .map((document) => document.trim())
  .filter(Boolean);

const actual = documents.map((document) => {
  const lines = document.split(/\r?\n/);
  const kind = lines.map((line) => /^kind: ([A-Za-z0-9]+)$/.exec(line)?.[1]).find(Boolean) ?? "";
  const name = metadataValue(lines, "name");
  const namespaceValue = metadataValue(lines, "namespace");
  if (!kind || !name) {
    fail("every release document must have kind and metadata.name");
  }
  return `${kind}/${namespaceValue}/${name}`;
});

const actualAlb = actual.filter((value) => value.startsWith("ALBInstance/"));
const actualNamespaced = actual.filter((value) => !value.startsWith("ALBInstance/")).sort();

if (actualAlb.length !== 1 || !expectedAlb.has(actualAlb[0])) {
  fail(`ALBInstance resource identity differs from the expected ${albName}`);
}
if (
  actualNamespaced.length !== expectedNamespaced.length ||
  actualNamespaced.some((value, index) => value !== expectedNamespaced[index])
) {
  fail("rendered resource set or namespace scope differs from the release package");
}

console.log(`PASS exact resource and namespace scope for ${namespace}`);
