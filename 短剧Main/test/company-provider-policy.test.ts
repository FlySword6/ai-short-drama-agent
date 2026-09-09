import assert from "node:assert/strict";
import test from "node:test";
import {
  isCompanyProviderAllowed,
  normalizeCompanyProviderAllowlist,
} from "../src/shared/companyProviderPolicy.js";

test("R195-5 defaults to the Ark company account and treats ByteDance audio as Ark", () => {
  const allowlist = normalizeCompanyProviderAllowlist(undefined);
  assert.equal(isCompanyProviderAllowed("ark", allowlist), true);
  assert.equal(isCompanyProviderAllowed("openspeech", allowlist), true);
  assert.equal(isCompanyProviderAllowed("minimax", allowlist), false);
  assert.equal(isCompanyProviderAllowed("newapi", allowlist), false);
});

test("R195-5 enables company newapi through one allowlist entry", () => {
  const allowlist = normalizeCompanyProviderAllowlist(["ark", "newapi"]);
  assert.equal(isCompanyProviderAllowed("ark", allowlist), true);
  assert.equal(isCompanyProviderAllowed("newapi", allowlist), true);
});

test("temporary async gateway still requires the explicit company account entry", () => {
  assert.equal(
    isCompanyProviderAllowed("suchuang", normalizeCompanyProviderAllowlist(["ark"])),
    false,
  );
  assert.equal(
    isCompanyProviderAllowed("suchuang", normalizeCompanyProviderAllowlist(["ark", "suchuang"])),
    true,
  );
});

test("R195-5 rejects unknown provider-account names at startup", () => {
  assert.throws(
    () => normalizeCompanyProviderAllowlist(["ark", "typo-provider"]),
    /Unsupported company provider account/,
  );
});
