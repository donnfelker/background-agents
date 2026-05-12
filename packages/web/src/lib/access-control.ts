export interface AccessControlConfig {
  allowedDomains: string[];
  allowedUsers: string[];
  unsafeAllowAllUsers: boolean;
}

export interface AccessCheckParams {
  githubUsername?: string;
  emails?: string[];
}

/**
 * Parse comma-separated environment variable into a lowercase, trimmed array
 */
export function parseAllowlist(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function parseBooleanEnv(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

/**
 * From a GitHub `/user/emails` API response, return the email marked as both
 * `primary: true` AND `verified: true`. Returns undefined if no such entry
 * exists or the response is malformed.
 *
 * Used as the public-email fallback when GitHub's `/user` endpoint returns no
 * email — NextAuth still needs `user.email` populated for downstream consumers.
 * Requiring verified prevents an unverified primary from leaking through.
 */
export function findPrimaryVerifiedEmail(apiResponse: unknown): string | undefined {
  if (!Array.isArray(apiResponse)) return undefined;
  for (const item of apiResponse) {
    if (item === null || typeof item !== "object") continue;
    const record = item as { email?: unknown; primary?: unknown; verified?: unknown };
    if (record.primary !== true) continue;
    if (record.verified !== true) continue;
    if (typeof record.email !== "string") continue;
    return record.email;
  }
  return undefined;
}

/**
 * Choose the list of emails to check against access-control allowlists.
 *
 * Prefers the verified-emails list when populated; otherwise falls back to a
 * single (lowercased) email if one is available; otherwise returns [].
 * Used by the NextAuth `signIn` callback to bridge the GitHub provider output
 * to `checkAccessAllowed`.
 */
export function chooseAccessEmails(
  verifiedEmails: string[] | undefined,
  fallbackEmail: string | null | undefined
): string[] {
  if (verifiedEmails && verifiedEmails.length > 0) {
    return verifiedEmails;
  }
  if (fallbackEmail) {
    return [fallbackEmail.toLowerCase()];
  }
  return [];
}

/**
 * Extract verified email addresses from a GitHub `/user/emails` API response.
 *
 * Defensive: returns [] if the response is not an array or items don't have the
 * expected { email: string, verified: true } shape. Lowercases the address so
 * downstream domain comparisons can be case-insensitive without re-normalizing.
 */
export function extractVerifiedEmails(apiResponse: unknown): string[] {
  if (!Array.isArray(apiResponse)) return [];
  const result: string[] = [];
  for (const item of apiResponse) {
    if (item === null || typeof item !== "object") continue;
    const record = item as { email?: unknown; verified?: unknown };
    if (typeof record.email !== "string") continue;
    if (record.verified !== true) continue;
    result.push(record.email.toLowerCase());
  }
  return result;
}

/**
 * Check if a user is allowed to sign in based on access control configuration.
 *
 * Returns true if:
 * - Both allowlists are empty and unsafeAllowAllUsers is true
 * - User's GitHub username is in allowedUsers
 * - ANY of the user's email-domain pairs is in allowedDomains
 *
 * Logic is OR-based across both allowlists and across emails within the list:
 * matching either allowlist (or any email in the list) grants access.
 */
export function checkAccessAllowed(
  config: AccessControlConfig,
  params: AccessCheckParams
): boolean {
  const { allowedDomains, allowedUsers, unsafeAllowAllUsers } = config;
  const { githubUsername, emails } = params;

  // Empty allowlists only permit sign-in when explicitly enabled.
  if (allowedDomains.length === 0 && allowedUsers.length === 0) {
    return unsafeAllowAllUsers;
  }

  // Check explicit user allowlist (GitHub username)
  if (githubUsername && allowedUsers.includes(githubUsername.toLowerCase())) {
    return true;
  }

  if (emails && emails.length > 0) {
    for (const email of emails) {
      const domain = email.toLowerCase().split("@")[1];
      if (domain && allowedDomains.includes(domain)) {
        return true;
      }
    }
  }

  return false;
}
