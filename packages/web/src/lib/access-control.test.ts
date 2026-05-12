import { describe, it, expect } from "vitest";
import {
  parseAllowlist,
  parseBooleanEnv,
  checkAccessAllowed,
  extractVerifiedEmails,
  findPrimaryVerifiedEmail,
  chooseAccessEmails,
} from "./access-control";

describe("parseAllowlist", () => {
  it("returns empty array for undefined", () => {
    expect(parseAllowlist(undefined)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseAllowlist("")).toEqual([]);
  });

  it("parses single value", () => {
    expect(parseAllowlist("user1")).toEqual(["user1"]);
  });

  it("parses comma-separated values", () => {
    expect(parseAllowlist("user1,user2,user3")).toEqual(["user1", "user2", "user3"]);
  });

  it("trims whitespace", () => {
    expect(parseAllowlist("  user1 , user2  ,  user3  ")).toEqual(["user1", "user2", "user3"]);
  });

  it("converts to lowercase", () => {
    expect(parseAllowlist("User1,USER2,UsEr3")).toEqual(["user1", "user2", "user3"]);
  });

  it("filters empty values", () => {
    expect(parseAllowlist("user1,,user2,  ,user3")).toEqual(["user1", "user2", "user3"]);
  });
});

describe("parseBooleanEnv", () => {
  it("returns false for undefined and empty values", () => {
    expect(parseBooleanEnv(undefined)).toBe(false);
    expect(parseBooleanEnv("")).toBe(false);
    expect(parseBooleanEnv("   ")).toBe(false);
  });

  it("returns true only for true", () => {
    expect(parseBooleanEnv("true")).toBe(true);
    expect(parseBooleanEnv(" TRUE ")).toBe(true);
    expect(parseBooleanEnv("false")).toBe(false);
    expect(parseBooleanEnv("1")).toBe(false);
  });
});

describe("checkAccessAllowed", () => {
  describe("when both allowlists are empty", () => {
    it("denies all users by default", () => {
      const config = { allowedDomains: [], allowedUsers: [], unsafeAllowAllUsers: false };

      expect(checkAccessAllowed(config, {})).toBe(false);
      expect(checkAccessAllowed(config, { githubUsername: "anyuser" })).toBe(false);
      expect(checkAccessAllowed(config, { emails: ["anyone@example.com"] })).toBe(false);
    });

    it("allows all users when unsafeAllowAllUsers is enabled", () => {
      const config = { allowedDomains: [], allowedUsers: [], unsafeAllowAllUsers: true };

      expect(checkAccessAllowed(config, {})).toBe(true);
      expect(checkAccessAllowed(config, { githubUsername: "anyuser" })).toBe(true);
      expect(checkAccessAllowed(config, { emails: ["anyone@example.com"] })).toBe(true);
    });
  });

  describe("when allowedUsers is set", () => {
    const config = {
      allowedDomains: [],
      allowedUsers: ["alloweduser"],
      unsafeAllowAllUsers: false,
    };

    it("allows users in the list", () => {
      expect(checkAccessAllowed(config, { githubUsername: "alloweduser" })).toBe(true);
    });

    it("allows users with different case", () => {
      expect(checkAccessAllowed(config, { githubUsername: "AllowedUser" })).toBe(true);
      expect(checkAccessAllowed(config, { githubUsername: "ALLOWEDUSER" })).toBe(true);
    });

    it("denies users not in the list", () => {
      expect(checkAccessAllowed(config, { githubUsername: "otheruser" })).toBe(false);
    });

    it("denies when no username provided", () => {
      expect(checkAccessAllowed(config, {})).toBe(false);
      expect(checkAccessAllowed(config, { emails: ["user@example.com"] })).toBe(false);
    });
  });

  describe("when allowedDomains is set", () => {
    const config = {
      allowedDomains: ["company.com"],
      allowedUsers: [],
      unsafeAllowAllUsers: false,
    };

    it("allows users with matching email domain", () => {
      expect(checkAccessAllowed(config, { emails: ["user@company.com"] })).toBe(true);
    });

    it("allows users with different case email", () => {
      expect(checkAccessAllowed(config, { emails: ["User@COMPANY.COM"] })).toBe(true);
    });

    it("denies users with non-matching email domain", () => {
      expect(checkAccessAllowed(config, { emails: ["user@other.com"] })).toBe(false);
    });

    it("denies when no email provided", () => {
      expect(checkAccessAllowed(config, {})).toBe(false);
      expect(checkAccessAllowed(config, { githubUsername: "someuser" })).toBe(false);
    });
  });

  describe("when both allowedUsers and allowedDomains are set (OR logic)", () => {
    const config = {
      allowedDomains: ["company.com"],
      allowedUsers: ["specialuser"],
      unsafeAllowAllUsers: false,
    };

    it("allows users matching username", () => {
      expect(checkAccessAllowed(config, { githubUsername: "specialuser" })).toBe(true);
    });

    it("allows users matching email domain", () => {
      expect(checkAccessAllowed(config, { emails: ["someone@company.com"] })).toBe(true);
    });

    it("allows users matching either condition", () => {
      expect(
        checkAccessAllowed(config, {
          githubUsername: "specialuser",
          emails: ["user@other.com"],
        })
      ).toBe(true);

      expect(
        checkAccessAllowed(config, {
          githubUsername: "otheruser",
          emails: ["user@company.com"],
        })
      ).toBe(true);
    });

    it("denies users matching neither condition", () => {
      expect(
        checkAccessAllowed(config, {
          githubUsername: "randomuser",
          emails: ["user@other.com"],
        })
      ).toBe(false);
    });
  });

  describe("when unsafeAllowAllUsers is true with populated allowlists", () => {
    const config = {
      allowedDomains: ["company.com"],
      allowedUsers: ["specialuser"],
      unsafeAllowAllUsers: true,
    };

    it("still enforces the allowlist for matching users", () => {
      expect(checkAccessAllowed(config, { githubUsername: "specialuser" })).toBe(true);
      expect(checkAccessAllowed(config, { emails: ["user@company.com"] })).toBe(true);
    });

    it("denies users not in the allowlist", () => {
      expect(checkAccessAllowed(config, { githubUsername: "randomuser" })).toBe(false);
      expect(checkAccessAllowed(config, { emails: ["user@other.com"] })).toBe(false);
    });
  });

  describe("multiple values in allowlists", () => {
    const config = {
      allowedDomains: ["company.com", "partner.org"],
      allowedUsers: ["admin", "developer"],
      unsafeAllowAllUsers: false,
    };

    it("allows any user from the list", () => {
      expect(checkAccessAllowed(config, { githubUsername: "admin" })).toBe(true);
      expect(checkAccessAllowed(config, { githubUsername: "developer" })).toBe(true);
    });

    it("allows any domain from the list", () => {
      expect(checkAccessAllowed(config, { emails: ["user@company.com"] })).toBe(true);
      expect(checkAccessAllowed(config, { emails: ["user@partner.org"] })).toBe(true);
    });
  });

  describe("when emails is a list (secondary-email support)", () => {
    const config = {
      allowedDomains: ["company.com"],
      allowedUsers: [],
      unsafeAllowAllUsers: false,
    };

    it("allows when any email's domain matches", () => {
      expect(
        checkAccessAllowed(config, {
          emails: ["alice@personal.com", "alice@company.com"],
        })
      ).toBe(true);
    });

    it("denies when no email's domain matches", () => {
      expect(
        checkAccessAllowed(config, {
          emails: ["alice@personal.com", "alice@other.com"],
        })
      ).toBe(false);
    });

    it("treats an empty list like no email at all", () => {
      expect(checkAccessAllowed(config, { emails: [] })).toBe(false);
    });

    it("matches case-insensitively across the list", () => {
      expect(
        checkAccessAllowed(config, {
          emails: ["Alice@PERSONAL.com", "Alice@COMPANY.com"],
        })
      ).toBe(true);
    });

    it("tolerates malformed entries and keeps checking the rest of the list", () => {
      expect(
        checkAccessAllowed(config, {
          emails: ["not-an-email", "alice@company.com"],
        })
      ).toBe(true);
    });

    it("preserves OR-with-allowedUsers when the username does not match", () => {
      const orConfig = {
        allowedDomains: ["company.com"],
        allowedUsers: ["specialuser"],
        unsafeAllowAllUsers: false,
      };
      expect(
        checkAccessAllowed(orConfig, {
          githubUsername: "randomuser",
          emails: ["alice@personal.com", "alice@company.com"],
        })
      ).toBe(true);
    });
  });
});

describe("extractVerifiedEmails", () => {
  it("returns lowercased verified emails", () => {
    const response = [
      { email: "Alice@CORP.com", verified: true, primary: true },
      { email: "alice@personal.com", verified: true, primary: false },
    ];
    expect(extractVerifiedEmails(response)).toEqual(["alice@corp.com", "alice@personal.com"]);
  });

  it("filters out unverified emails", () => {
    const response = [
      { email: "alice@corp.com", verified: true, primary: true },
      { email: "spoof@evil.com", verified: false, primary: false },
    ];
    expect(extractVerifiedEmails(response)).toEqual(["alice@corp.com"]);
  });

  it("returns [] for an empty array", () => {
    expect(extractVerifiedEmails([])).toEqual([]);
  });

  it("returns [] for non-array input", () => {
    expect(extractVerifiedEmails(null)).toEqual([]);
    expect(extractVerifiedEmails(undefined)).toEqual([]);
    expect(extractVerifiedEmails("oops")).toEqual([]);
    expect(extractVerifiedEmails({ email: "x@y.com", verified: true })).toEqual([]);
  });

  it("skips items missing required fields", () => {
    const response = [
      { email: "alice@corp.com", verified: true },
      { email: 123, verified: true },
      { verified: true },
      null,
      "not-an-object",
      { email: "bob@corp.com", verified: "yes" }, // not boolean true
    ];
    expect(extractVerifiedEmails(response)).toEqual(["alice@corp.com"]);
  });
});

describe("findPrimaryVerifiedEmail", () => {
  it("returns the email when an entry is both primary and verified", () => {
    const response = [
      { email: "secondary@corp.com", primary: false, verified: true },
      { email: "primary@corp.com", primary: true, verified: true },
    ];
    expect(findPrimaryVerifiedEmail(response)).toBe("primary@corp.com");
  });

  it("returns undefined when the primary entry is not verified", () => {
    const response = [{ email: "primary@corp.com", primary: true, verified: false }];
    expect(findPrimaryVerifiedEmail(response)).toBeUndefined();
  });

  it("returns undefined when no entry is marked primary", () => {
    const response = [
      { email: "alice@corp.com", primary: false, verified: true },
      { email: "bob@corp.com", primary: false, verified: true },
    ];
    expect(findPrimaryVerifiedEmail(response)).toBeUndefined();
  });

  it("returns undefined for non-array input", () => {
    expect(findPrimaryVerifiedEmail(null)).toBeUndefined();
    expect(findPrimaryVerifiedEmail(undefined)).toBeUndefined();
    expect(findPrimaryVerifiedEmail("oops")).toBeUndefined();
    expect(
      findPrimaryVerifiedEmail({ email: "x@y.com", primary: true, verified: true })
    ).toBeUndefined();
  });

  it("skips malformed items and continues searching", () => {
    const response = [
      null,
      "not-an-object",
      { email: 123, primary: true, verified: true }, // non-string email
      { primary: true, verified: true }, // missing email
      { email: "alice@corp.com", primary: true, verified: true },
    ];
    expect(findPrimaryVerifiedEmail(response)).toBe("alice@corp.com");
  });

  it("preserves casing — caller is responsible for normalization", () => {
    const response = [{ email: "Primary@Corp.com", primary: true, verified: true }];
    expect(findPrimaryVerifiedEmail(response)).toBe("Primary@Corp.com");
  });
});

describe("chooseAccessEmails", () => {
  it("returns verifiedEmails when the list is non-empty", () => {
    expect(chooseAccessEmails(["a@x.com", "b@y.com"], "fallback@z.com")).toEqual([
      "a@x.com",
      "b@y.com",
    ]);
  });

  it("falls back to a single lowercased email when verifiedEmails is empty", () => {
    expect(chooseAccessEmails([], "Fallback@Z.com")).toEqual(["fallback@z.com"]);
  });

  it("falls back to a single lowercased email when verifiedEmails is undefined", () => {
    expect(chooseAccessEmails(undefined, "Fallback@Z.com")).toEqual(["fallback@z.com"]);
  });

  it("returns [] when both inputs are missing", () => {
    expect(chooseAccessEmails(undefined, undefined)).toEqual([]);
    expect(chooseAccessEmails(undefined, null)).toEqual([]);
    expect(chooseAccessEmails([], undefined)).toEqual([]);
    expect(chooseAccessEmails([], null)).toEqual([]);
  });

  it("returns [] when fallbackEmail is an empty string", () => {
    expect(chooseAccessEmails(undefined, "")).toEqual([]);
    expect(chooseAccessEmails([], "")).toEqual([]);
  });

  it("does not lowercase entries in verifiedEmails (caller's responsibility)", () => {
    // extractVerifiedEmails already lowercases, so chooseAccessEmails returns
    // its input untouched when the list is non-empty.
    expect(chooseAccessEmails(["Already@LOWERCASED.com"], "ignored@x.com")).toEqual([
      "Already@LOWERCASED.com",
    ]);
  });
});
