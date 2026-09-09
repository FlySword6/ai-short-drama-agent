export const COMPANY_PROVIDER_NOT_ENABLED_MESSAGE = "该供应商未开通公司账户";

export const COMPANY_PROVIDER_ACCOUNT_IDS = [
  "ark",
  "col",
  "minimax",
  "newapi",
  "suchuang",
  "openai",
  "google",
  "happyhorse",
] as const;

export type CompanyProviderAccountId = typeof COMPANY_PROVIDER_ACCOUNT_IDS[number];

const COMPANY_PROVIDER_ACCOUNT_ID_SET = new Set<string>(COMPANY_PROVIDER_ACCOUNT_IDS);
const PROVIDER_ACCOUNT_BY_ADAPTER: Readonly<Record<string, CompanyProviderAccountId>> = {
  ark: "ark",
  col: "col",
  openspeech: "ark",
  minimax: "minimax",
  newapi: "newapi",
  suchuang: "suchuang",
  openai: "openai",
  google: "google",
  happyhorse: "happyhorse",
};

export const DEFAULT_COMPANY_PROVIDER_ALLOWLIST: readonly CompanyProviderAccountId[] = ["ark"];

export function normalizeCompanyProviderAllowlist(
  values: readonly string[] | undefined,
): ReadonlySet<CompanyProviderAccountId> {
  const normalized = new Set<CompanyProviderAccountId>();
  for (const rawValue of values ?? DEFAULT_COMPANY_PROVIDER_ALLOWLIST) {
    const value = rawValue.trim().toLowerCase();
    if (!value) continue;
    if (!COMPANY_PROVIDER_ACCOUNT_ID_SET.has(value)) {
      throw new Error(`Unsupported company provider account: ${value}`);
    }
    normalized.add(value as CompanyProviderAccountId);
  }
  return normalized;
}

export function companyProviderAccountForAdapter(
  providerId: string,
): CompanyProviderAccountId | undefined {
  return PROVIDER_ACCOUNT_BY_ADAPTER[providerId.trim().toLowerCase()];
}

export function isCompanyProviderAllowed(
  providerId: string,
  allowlist: ReadonlySet<CompanyProviderAccountId>,
): boolean {
  const accountId = companyProviderAccountForAdapter(providerId);
  return accountId !== undefined && allowlist.has(accountId);
}
