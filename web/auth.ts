import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";

// JWT session strategy — no database adapter. The Go API never sees these
// (encrypted JWE) session cookies; the /api/backend proxy mints short-lived
// HS256 JWTs instead.
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google, GitHub],
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  callbacks: {
    jwt({ token, account }) {
      if (account) {
        token.provider = account.provider;
        token.providerId = account.providerAccountId;
      }
      return token;
    },
    session({ session, token }) {
      // Expose the OAuth identity so the proxy can mint sub=provider:id.
      (session as ProviderSession).provider = token.provider as string;
      (session as ProviderSession).providerId = token.providerId as string;
      return session;
    },
  },
});

export type ProviderSession = {
  provider?: string;
  providerId?: string;
  user?: { email?: string | null; name?: string | null; image?: string | null };
};
