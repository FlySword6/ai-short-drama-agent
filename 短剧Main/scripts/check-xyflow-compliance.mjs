import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT_PACKAGE_PATH = "node_modules/@xyflow/react";
const RECEIPT_ROOT = "docs/compliance/xyflow";
const NOTICE_PATH = `${RECEIPT_ROOT}/NOTICE`;
const SBOM_PATH = `${RECEIPT_ROOT}/sbom.spdx.json`;
const THIRD_PARTY_NOTICES_PATH = "THIRD_PARTY_NOTICES";
const WRITE_MODE = process.argv.includes("--write");

// This focused manifest is intentionally pinned. A lockfile update must be reviewed
// together with its SPDX and license receipts instead of silently regenerating them.
const expectedPackages = {
  "node_modules/@types/d3-color": ["3.1.3", "sha512-iO90scth9WAbmgv7ogoq57O9YpKmFBbmoEoCHDB2xMBY0+/KVrqAaCDyCE16dUspeOvIxFFRI+0sEtqDqy2b4A==", "MIT", "LICENSE", "c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383"],
  "node_modules/@types/d3-drag": ["3.0.7", "sha512-HE3jVKlzU9AaMazNufooRJ5ZpWmLIoc90A37WU2JMmeq28w1FQqCZswHZ3xR+SuxYftzHq6WU6KJHvqxKzTxxQ==", "MIT", "LICENSE", "c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383"],
  "node_modules/@types/d3-interpolate": ["3.0.4", "sha512-mgLPETlrpVV1YRJIglr4Ez47g7Yxjl1lj7YKsiMCb27VJH9W8NVM6Bb9d8kkpG/uAQS5AmbA48q2IAolKKo1MA==", "MIT", "LICENSE", "c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383"],
  "node_modules/@types/d3-selection": ["3.0.11", "sha512-bhAXu23DJWsrI45xafYpkQ4NtcKMwWnAC/vKrd2l+nxMFuvOT3XMYTIj2opv8vq8AO5Yh7Qac/nSeP/3zjTK0w==", "MIT", "LICENSE", "c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383"],
  "node_modules/@types/d3-transition": ["3.0.9", "sha512-uZS5shfxzO3rGlu0cC3bjmMFKsXv+SmZZcgp0KD22ts4uGXp5EVYGzu/0YdwZeKmddhcAccYtREJKkPfXkZuCg==", "MIT", "LICENSE", "c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383"],
  "node_modules/@types/d3-zoom": ["3.0.8", "sha512-iqMC4/YlFCSlO8+2Ii1GGGliCAY4XdeG748w5vQUbevlbDu0zSjH/+jojorQVBK/se0j6DUFNPBGSqD3YWYnDw==", "MIT", "LICENSE", "c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383"],
  "node_modules/@xyflow/react": ["12.10.1", "sha512-5eSWtIK/+rkldOuFbOOz44CRgQRjtS9v5nufk77DV+XBnfCGL9HAQ8PG00o2ZYKqkEU/Ak6wrKC95Tu+2zuK3Q==", "MIT", "LICENSE", "023119ac20fb1c8c9930abe0bcd196989a1960388529a96fc43cebf96f07c9ff"],
  "node_modules/@xyflow/react/node_modules/zustand": ["4.5.7", "sha512-CHOUy7mu3lbD6o6LJLfllpjkzhHXSBlX8B9+qPddUsIfeF5S/UZ5q0kmCsnRqT1UHFQZchNFDDzMbQsuesHWlw==", "MIT", "LICENSE", "c1e6e266563517467b1bf874817d23e426f3149252bd7d42758cd697514b8417"],
  "node_modules/@xyflow/system": ["0.0.75", "sha512-iXs+AGFLi8w/VlAoc/iSxk+CxfT6o64Uw/k0CKASOPqjqz6E0rb5jFZgJtXGZCpfQI6OQpu5EnumP5fGxQheaQ==", "MIT", "LICENSE", "023119ac20fb1c8c9930abe0bcd196989a1960388529a96fc43cebf96f07c9ff"],
  "node_modules/classcat": ["5.0.5", "sha512-JhZUT7JFcQy/EzW605k/ktHtncoo9vnyW/2GspNYwFlN1C/WmjuV/xtS04e9SOkL2sTdw0VAZ2UGCcQ9lR6p6w==", "MIT", "LICENSE.md", "f101c761d255d0dddc77dd8a9327733b03d381798ec54a1bb718367207b48a8e"],
  "node_modules/d3-color": ["3.1.0", "sha512-zg/chbXyeBtMQ1LbD/WSoW2DpC3I0mpmPdW+ynRTj/x2DAWYrIY7qeZIHidozwV24m4iavr15lNwIwLxRmOxhA==", "ISC", "LICENSE", "faa682e3e430941f958d26180458f5934a62f58dac4d70ccdd15608c15d0f884"],
  "node_modules/d3-dispatch": ["3.0.1", "sha512-rzUyPU/S7rwUflMyLc1ETDeBj0NRuHKKAcvukozwhshr6g6c5d8zh4c2gQjY2bZ0dXeGLWc1PF174P2tVvKhfg==", "ISC", "LICENSE", "e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee"],
  "node_modules/d3-drag": ["3.0.0", "sha512-pWbUJLdETVA8lQNJecMxoXfH6x+mO2UQo8rSmZ+QqxcbyA3hfeprFgIT//HW2nlHChWeIIMwS2Fq+gEARkhTkg==", "ISC", "LICENSE", "e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee"],
  "node_modules/d3-ease": ["3.0.1", "sha512-wR/XK3D3XcLIZwpbvQwQ5fK+8Ykds1ip7A2Txe0yxncXSdq1L9skcG7blcedkOX+ZcgxGAmLX1FrRGbADwzi0w==", "BSD-3-Clause", "LICENSE", "b989d9085148d21ff64a75e14462aefa06b2589a55553b07b1460c70081c7d08"],
  "node_modules/d3-interpolate": ["3.0.1", "sha512-3bYs1rOD33uo8aqJfKP3JWPAibgw8Zm2+L9vBKEHJ2Rg+viTR7o5Mmv5mZcieN+FRYaAOWX5SJATX6k1PWz72g==", "ISC", "LICENSE", "e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee"],
  "node_modules/d3-selection": ["3.0.0", "sha512-fmTRWbNMmsmWq6xJV8D19U/gw/bwrHfNXxrIN+HfZgnzqTHp9jOmKMhsTUjXOJnZOdZY9Q28y4yebKzqDKlxlQ==", "ISC", "LICENSE", "e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee"],
  "node_modules/d3-timer": ["3.0.1", "sha512-ndfJ/JxxMd3nw31uyKoY2naivF+r29V+Lc0svZxe1JvvIRmi8hUsrMvdOwgS1o6uBHmiz91geQ0ylPP0aj1VUA==", "ISC", "LICENSE", "e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee"],
  "node_modules/d3-transition": ["3.0.1", "sha512-ApKvfjsSR6tg06xrL434C0WydLr7JewBB3V+/39RMHsaXTOG0zmt/OAXeng5M5LBm0ojmxJrpomQVZ1aPvBL4w==", "ISC", "LICENSE", "e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee"],
  "node_modules/d3-zoom": ["3.0.0", "sha512-b8AmV3kfQaqWAuacbPuNbL6vahnOJflOhexLzMMNLga62+/nh0JzvJ0aO/5a5MVgUFGS7Hu1P9P03o3fJkDCyw==", "ISC", "LICENSE", "e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee"],
  "node_modules/use-sync-external-store": ["1.6.0", "sha512-Pp6GSwGP/NrPIrxVFAIkOQeyw8lFenOHijQWkUTrDvrF4ALqylP2C/KCkeS9dpUM3KvYRQhna5vt7IL95+ZQ9w==", "MIT", "LICENSE", "da6d3703ed11cbe42bd212c725957c98da23cbff1998c05fa4b3d976d1a58e93"],
};

const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const lockPackages = lock.packages ?? {};

function packageName(packagePath) {
  return packagePath.split("node_modules/").at(-1);
}

function packageSlug(packagePath) {
  return packagePath
    .replaceAll("node_modules/", "")
    .replaceAll("@", "")
    .replaceAll("/", "--");
}

function spdxId(packagePath) {
  return `SPDXRef-Package-${packageSlug(packagePath)}`;
}

function receiptPath(packagePath) {
  return `${RECEIPT_ROOT}/licenses/${packageSlug(packagePath)}/LICENSE`;
}

function resolveDependency(fromPackagePath, dependencyName, required) {
  let directory = fromPackagePath;
  while (true) {
    const candidate = path.posix.join(directory, "node_modules", dependencyName);
    if (lockPackages[candidate]) return candidate;
    const parent = path.posix.dirname(directory);
    if (parent === directory || parent === ".") break;
    directory = parent;
  }
  const rootCandidate = path.posix.join("node_modules", dependencyName);
  if (lockPackages[rootCandidate]) return rootCandidate;
  if (required) {
    assert.fail(`${fromPackagePath} cannot resolve required runtime dependency ${dependencyName}`);
  }
  return undefined;
}

function runtimeDependencyNames(entry) {
  return [
    ...Object.keys(entry.dependencies ?? {}).map((name) => [name, true]),
    ...Object.keys(entry.optionalDependencies ?? {}).map((name) => [name, false]),
  ].sort(([left], [right]) => left.localeCompare(right));
}

function deriveClosure() {
  const queue = [ROOT_PACKAGE_PATH];
  const visited = new Set();
  const edges = new Set();

  while (queue.length > 0) {
    const packagePath = queue.shift();
    if (visited.has(packagePath)) continue;
    const entry = lockPackages[packagePath];
    assert.ok(entry, `${packagePath} is missing from package-lock.json`);
    visited.add(packagePath);

    for (const [dependencyName, required] of runtimeDependencyNames(entry)) {
      const dependencyPath = resolveDependency(packagePath, dependencyName, required);
      if (!dependencyPath) continue;
      edges.add(`${packagePath}\0${dependencyPath}`);
      queue.push(dependencyPath);
    }
  }

  return {
    packagePaths: [...visited].sort(),
    edges: [...edges].map((edge) => edge.split("\0")).sort(([sourceA, targetA], [sourceB, targetB]) =>
      sourceA.localeCompare(sourceB) || targetA.localeCompare(targetB)),
  };
}

function integrityChecksum(integrity, packagePath) {
  const match = /^(sha(?:1|256|384|512))-([A-Za-z0-9+/]+=*)$/.exec(integrity ?? "");
  assert.ok(match, `${packagePath} has unsupported or missing integrity`);
  return {
    algorithm: match[1].toUpperCase(),
    checksumValue: Buffer.from(match[2], "base64").toString("hex"),
  };
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

const closure = deriveClosure();
const expectedPaths = Object.keys(expectedPackages).sort();
assert.deepEqual(closure.packagePaths, expectedPaths, "xyflow recursive runtime dependency closure drifted");

const receiptContents = new Map();
for (const packagePath of closure.packagePaths) {
  const entry = lockPackages[packagePath];
  const [version, integrity, license, licenseSource, licenseReceiptSha256] = expectedPackages[packagePath];
  assert.equal(entry.version, version, `${packagePath} version drifted`);
  assert.equal(entry.integrity, integrity, `${packagePath} integrity drifted`);
  assert.equal(entry.license, license, `${packagePath} declared license drifted`);
  assert.match(entry.resolved ?? "", /^https:\/\/registry\.npmjs\.org\//, `${packagePath} resolved URL is missing or unexpected`);
  integrityChecksum(entry.integrity, packagePath);

  let receipt;
  if (WRITE_MODE) {
    receipt = await readFile(path.posix.join(packagePath, licenseSource));
    assert.equal(sha256(receipt), licenseReceiptSha256, `${packagePath} installed LICENSE does not match the reviewed receipt`);
  } else {
    receipt = await readFile(receiptPath(packagePath));
    assert.equal(sha256(receipt), licenseReceiptSha256, `${packagePath} focused LICENSE receipt drifted`);
  }
  receiptContents.set(packagePath, receipt);
}

const packages = closure.packagePaths.map((packagePath) => {
  const entry = lockPackages[packagePath];
  const checksum = integrityChecksum(entry.integrity, packagePath);
  const licenseReceiptSha256 = expectedPackages[packagePath][4];
  return {
    SPDXID: spdxId(packagePath),
    name: packageName(packagePath),
    versionInfo: entry.version,
    downloadLocation: entry.resolved,
    filesAnalyzed: false,
    checksums: [checksum],
    licenseConcluded: entry.license,
    licenseDeclared: entry.license,
    copyrightText: "NOASSERTION",
    comment: `Focused LICENSE receipt: ${receiptPath(packagePath)} (SHA-256: ${licenseReceiptSha256}); focused NOTICE receipt: ${NOTICE_PATH}#${packageSlug(packagePath)}`,
    externalRefs: [{
      referenceCategory: "PACKAGE-MANAGER",
      referenceType: "purl",
      referenceLocator: `pkg:npm/${encodeURIComponent(packageName(packagePath)).replace("%2F", "/")}@${entry.version}`,
    }],
  };
});

const relationships = closure.edges.map(([source, target]) => ({
  spdxElementId: spdxId(source),
  relationshipType: "DEPENDS_ON",
  relatedSpdxElement: spdxId(target),
}));
const namespaceFingerprint = sha256(JSON.stringify({ packages, relationships }));
const expectedSbom = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: "shortdrama-xyflow-focused-runtime-closure-sbom",
  documentNamespace: `https://github.com/col-shortdrama/zhongwen-shortdrama-main/sbom/xyflow/${namespaceFingerprint}`,
  creationInfo: {
    created: "2026-08-14T00:00:00Z",
    creators: ["Tool: scripts/check-xyflow-compliance.mjs"],
  },
  documentDescribes: [spdxId(ROOT_PACKAGE_PATH)],
  packages,
  relationships,
};

const noticeSections = closure.packagePaths.map((packagePath) => {
  const entry = lockPackages[packagePath];
  const checksum = integrityChecksum(entry.integrity, packagePath);
  const receipt = receiptPath(packagePath);
  return [
    `## ${packageName(packagePath)} ${entry.version} {#${packageSlug(packagePath)}}`,
    "",
    `- Lockfile path: \`${packagePath}\``,
    `- Resolved URL: ${entry.resolved}`,
    `- Integrity: \`${entry.integrity}\``,
    `- Integrity-derived ${checksum.algorithm}: \`${checksum.checksumValue}\``,
    `- Declared license: ${entry.license}`,
    `- Focused LICENSE receipt: \`${receipt}\``,
    `- LICENSE receipt SHA-256: \`${expectedPackages[packagePath][4]}\``,
    "- Upstream NOTICE file: not present in the installed package",
    "",
  ].join("\n");
});
const expectedNotice = [
  "# xyflow dependency compliance receipt",
  "",
  "Scope: the complete recursive runtime dependency closure reachable through package-lock.json dependencies and installed optionalDependencies from root @xyflow/react. Peer dependencies are supplied by the application and are outside this focused closure. This is not a whole-repository audit.",
  "",
  `Closure: ${packages.length} packages; ${relationships.length} DEPENDS_ON relationships.`,
  "",
  ...noticeSections,
].join("\n");

const thirdPartyRows = closure.packagePaths.map((packagePath) => {
  const entry = lockPackages[packagePath];
  return `| \`${packageName(packagePath)}\` | ${entry.version} | ${entry.license} | \`${entry.integrity}\` | \`${receiptPath(packagePath)}\` |`;
});
const expectedThirdPartyNotices = [
  "# Third-party notices",
  "",
  "## @xyflow/react recursive runtime dependency closure",
  "",
  "This focused notice covers the packages reachable from `@xyflow/react` through lockfile runtime dependencies. It is not a whole-repository audit. Full metadata, checksums, dependency relationships, and receipt hashes are recorded in `docs/compliance/xyflow/`.",
  "",
  "| Package | Version | License | Lockfile integrity | Focused LICENSE receipt |",
  "| --- | --- | --- | --- | --- |",
  ...thirdPartyRows,
  "",
  "The vNext persistent canvas uses this dependency closure only for browser interaction. Project GraphDocument persistence, revision control, and authorization remain application-owned.",
  "",
].join("\n");

if (WRITE_MODE) {
  for (const packagePath of closure.packagePaths) {
    const destination = receiptPath(packagePath);
    await mkdir(path.posix.dirname(destination), { recursive: true });
    await writeFile(destination, receiptContents.get(packagePath));
  }
  await writeFile(SBOM_PATH, `${JSON.stringify(expectedSbom, null, 2)}\n`);
  await writeFile(NOTICE_PATH, expectedNotice);
  await writeFile(THIRD_PARTY_NOTICES_PATH, expectedThirdPartyNotices);
} else {
  const actualSbom = JSON.parse(await readFile(SBOM_PATH, "utf8"));
  assert.deepEqual(actualSbom, expectedSbom, "xyflow SPDX artifact drifted from the reviewed lockfile closure");
  assert.equal(await readFile(NOTICE_PATH, "utf8"), expectedNotice, "xyflow focused NOTICE receipt drifted");
  assert.equal(await readFile(THIRD_PARTY_NOTICES_PATH, "utf8"), expectedThirdPartyNotices, "THIRD_PARTY_NOTICES xyflow closure drifted");

  const actualLicenseFiles = [];
  for (const directory of await readdir(`${RECEIPT_ROOT}/licenses`, { withFileTypes: true })) {
    if (!directory.isDirectory()) {
      actualLicenseFiles.push(`${RECEIPT_ROOT}/licenses/${directory.name}`);
      continue;
    }
    for (const file of await readdir(`${RECEIPT_ROOT}/licenses/${directory.name}`, { withFileTypes: true })) {
      actualLicenseFiles.push(`${RECEIPT_ROOT}/licenses/${directory.name}/${file.name}`);
    }
  }
  assert.deepEqual(
    actualLicenseFiles.sort(),
    closure.packagePaths.map(receiptPath).sort(),
    "xyflow focused LICENSE receipt inventory drifted",
  );
}

process.stdout.write(`xyflow compliance OK: ${packages.length} packages, ${relationships.length} runtime dependency relationships\n`);
