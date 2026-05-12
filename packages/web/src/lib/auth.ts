import type { NextAuthOptions } from "next-auth";
import GitHubProvider from "next-auth/providers/github";
import { DEFAULT_APP_NAME } from "@open-inspect/shared";
import {
  checkAccessAllowed,
  chooseAccessEmails,
  extractVerifiedEmails,
  findPrimaryVerifiedEmail,
  parseAllowlist,
  parseBooleanEnv,
} from "./access-control";

// Extend NextAuth types to include GitHub-specific user info
declare module "next-auth" {
  interface Session {
    user: {
      id?: string; // GitHub user ID
      login?: string; // GitHub username
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    accessToken?: string;
    refreshToken?: string;
    accessTokenExpiresAt?: number; // Unix timestamp in milliseconds
    githubUserId?: string;
    githubLogin?: string;
  }
}

export const authOptions: NextAuthOptions = {
  debug: process.env.NODE_ENV === "development" || process.env.NEXTAUTH_DEBUG === "true",
  providers: [
    GitHubProvider({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      authorization: {
        params: {
          scope: "read:user user:email repo",
        },
      },
      userinfo: {
        url: "https://api.github.com/user",
        async request({ client, tokens }) {
          // Standard userinfo call — same as NextAuth's default GitHub provider.
          const profile = (await client.userinfo(tokens.access_token ?? "")) as {
            email?: string | null;
            [key: string]: unknown;
          };

          // Fetch the full email list so the access-control gate can consider
          // verified secondary emails, not just the single email /user returns.
          let verifiedEmails: string[] = [];
          try {
            // GitHub's REST API requires a User-Agent header. Node's fetch sets one by
            // default; Cloudflare Workers' fetch does not — without this, /user/emails
            // returns 403 "Request forbidden by administrative rules" in CF Workers
            // even when the App has Email addresses permission.
            const res = await fetch("https://api.github.com/user/emails", {
              headers: {
                Authorization: `token ${tokens.access_token ?? ""}`,
                "User-Agent": DEFAULT_APP_NAME,
                Accept: "application/vnd.github+json",
              },
            });
            if (res.ok) {
              const emailsResponse = (await res.json()) as unknown;
              verifiedEmails = extractVerifiedEmails(emailsResponse);

              // Preserve NextAuth's default fallback: if /user returned no email,
              // pick the primary verified email so user.email stays populated.
              if (!profile.email) {
                const primary = findPrimaryVerifiedEmail(emailsResponse);
                if (primary) profile.email = primary;
              }
            }
          } catch {
            // Fail soft: keep verifiedEmails = []. signIn falls back to user.email.
          }

          return { ...profile, email: profile.email ?? undefined, verifiedEmails };
        },
      },
    }),
  ],
  callbacks: {
    async signIn({ profile, user }) {
      const config = {
        allowedDomains: parseAllowlist(process.env.ALLOWED_EMAIL_DOMAINS),
        allowedUsers: parseAllowlist(process.env.ALLOWED_USERS),
        unsafeAllowAllUsers: parseBooleanEnv(process.env.UNSAFE_ALLOW_ALL_USERS),
      };

      const githubProfile = profile as { login?: string; verifiedEmails?: string[] };
      const emails = chooseAccessEmails(githubProfile.verifiedEmails, user.email);

      const isAllowed = checkAccessAllowed(config, {
        githubUsername: githubProfile.login,
        emails,
      });

      if (!isAllowed) {
        return false;
      }
      return true;
    },
    async jwt({ token, account, profile }) {
      if (account) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token as string | undefined;
        // expires_at is in seconds, convert to milliseconds (only set if provided)
        token.accessTokenExpiresAt = account.expires_at ? account.expires_at * 1000 : undefined;
      }
      if (profile) {
        // GitHub profile includes id (numeric) and login (username)
        const githubProfile = profile as { id?: number; login?: string };
        if (githubProfile.id) {
          token.githubUserId = githubProfile.id.toString();
        }
        if (githubProfile.login) {
          token.githubLogin = githubProfile.login;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.githubUserId;
        session.user.login = token.githubLogin;
      }
      return session;
    },
  },
  pages: {
    error: "/access-denied",
  },
};
