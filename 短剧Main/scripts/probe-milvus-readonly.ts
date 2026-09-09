#!/usr/bin/env -S npx --no-install tsx

/**
 * Minimal, read-only Milvus preflight probe for a release environment.
 *
 * It accepts a deliberately narrow, isolated env file and calls only
 * `hasCollection` and `describeCollection`.  It never initializes the
 * application's vector store because that path may create a collection.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { parse as parseDotenv } from "dotenv";

const require = createRequire(import.meta.url);
const allowedKeys = new Set([
  "MILVUS_URI",
  "MILVUS_USER",
  "MILVUS_PASSWORD",
  "MILVUS_COLLECTION_ASSET_ENTITY",
]);

interface ProbeEnvironment {
  uri?: string;
  user?: string;
  password?: string;
  collection?: string;
}

interface MilvusClient {
  hasCollection(input: { collection_name: string }): Promise<boolean | { value?: boolean }>;
  describeCollection(input: { collection_name: string }): Promise<unknown>;
  closeConnection?(): Promise<void> | void;
}

function usage(): string {
  return [
    "Usage: npx --no-install tsx scripts/probe-milvus-readonly.ts --env-file <gitignored-env>",
    "The env file must explicitly contain MILVUS_URI, MILVUS_USER, MILVUS_PASSWORD, and MILVUS_COLLECTION_ASSET_ENTITY.",
  ].join("\n");
}

function parseArgs(args: readonly string[]): string {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(usage());
    process.exit(0);
  }
  if (args.length !== 2 || args[0] !== "--env-file" || !args[1] || args[1].startsWith("-")) {
    throw new Error(usage());
  }
  return path.resolve(args[1]);
}

function parseEnvironment(contents: string): ProbeEnvironment {
  const parsed = parseDotenv(contents);
  for (const key of Object.keys(parsed)) {
    if (!allowedKeys.has(key)) throw new Error(`Env file contains unsupported key: ${key}`);
  }
  return {
    uri: parsed.MILVUS_URI?.trim(),
    user: parsed.MILVUS_USER?.trim(),
    password: parsed.MILVUS_PASSWORD,
    collection: parsed.MILVUS_COLLECTION_ASSET_ENTITY?.trim(),
  };
}

function requireEnvironment(environment: ProbeEnvironment): Required<ProbeEnvironment> {
  if (!environment.uri || !environment.user || !environment.password || !environment.collection) {
    throw new Error("Milvus readonly probe requires explicit URI, user, password, and asset collection in the isolated env file");
  }
  return environment as Required<ProbeEnvironment>;
}

function fieldNames(description: unknown): string[] {
  if (typeof description !== "object" || description === null) return [];
  const schema = (description as { schema?: { fields?: unknown } }).schema;
  if (!Array.isArray(schema?.fields)) return [];
  return schema.fields.flatMap((field) =>
    typeof field === "object" && field !== null && typeof (field as { name?: unknown }).name === "string"
      ? [(field as { name: string }).name]
      : [],
  );
}

async function main(): Promise<void> {
  const environment = requireEnvironment(parseEnvironment(await readFile(parseArgs(process.argv.slice(2)), "utf8")));
  const { MilvusClient } = require("@zilliz/milvus2-sdk-node") as {
    MilvusClient: new (options: { address: string; username: string; password: string; timeout: number }) => MilvusClient;
  };
  const client = new MilvusClient({
    address: environment.uri.replace(/^https?:\/\//, ""),
    username: environment.user,
    password: environment.password,
    timeout: 8_000,
  });
  try {
    const rawExists = await client.hasCollection({ collection_name: environment.collection });
    const exists = typeof rawExists === "boolean" ? rawExists : rawExists.value === true;
    const description = exists ? await client.describeCollection({ collection_name: environment.collection }) : undefined;
    console.log(JSON.stringify({
      status: "ok",
      collection: environment.collection,
      collection_exists: exists,
      field_names: fieldNames(description),
      operations: ["hasCollection", ...(exists ? ["describeCollection"] : [])],
    }));
  } finally {
    await client.closeConnection?.();
  }
}

main().catch(() => {
  // Do not surface endpoint, username, password, or raw SDK errors in a release receipt.
  console.error(JSON.stringify({ status: "blocked", category: "milvus_connectivity_or_authentication" }));
  process.exitCode = 1;
});
