#!/usr/bin/env node
import { X509Certificate } from "node:crypto";

const encoded = process.argv[2] ?? "";

function fail(message) {
  console.error(`BLOCK ${message}`);
  process.exit(1);
}

if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
  fail("RDS CA is not canonical base64");
}

let certificate;
try {
  certificate = new X509Certificate(Buffer.from(encoded, "base64"));
} catch {
  fail("RDS CA does not decode to an X.509 certificate");
}

if (!certificate.ca) fail("RDS certificate is not a CA certificate");
const now = Date.now();
const validFrom = Date.parse(certificate.validFrom);
const validTo = Date.parse(certificate.validTo);
if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || now < validFrom || now > validTo) {
  fail("RDS CA certificate is not currently valid");
}

console.log("PASS parseable current RDS CA certificate");
console.log(`RDS_CA_FINGERPRINT_SHA256=${certificate.fingerprint256.replaceAll(":", "").toLowerCase()}`);
