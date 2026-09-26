import type { NextAuthOptions } from 'next-auth'
import GoogleProvider from 'next-auth/providers/google'
import { prisma } from '@/lib/prisma'

const MILO_EMAIL = 'rey.amado8509@gmail.com'
const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

// Pure JWT auth — no DB adapter required.
// Users are verified via allowedEmails; session is a signed cookie.
// TODO: Add PrismaAdapter once DB-backed sessions are needed.
export const authOptions: NextAuthOptions = {
  session: { strategy: 'jwt' },
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  callbacks: {
    async signIn({ user }) {
      // Comma-separated allowlist from env, e.g. ALLOWED_EMAILS="you@example.com,teammate@example.com"
      const allowedEmails = (process.env.ALLOWED_EMAILS ?? '')
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean)
      if (allowedEmails.length === 0) return false // lock down by default until configured
      return allowedEmails.includes((user.email ?? '').toLowerCase())
    },
    async jwt({ token, user, account }) {
      if (user) {
        token.id = user.id
        token.email = user.email
      }
      // The ordinary Hermy HQ login remains identity-only. The Milo connect
      // button explicitly requests gmail.readonly and this stores only the
      // refresh token for the single authorized mailbox.
      if (
        account?.refresh_token &&
        user?.email?.toLowerCase() === MILO_EMAIL &&
        (account.scope || '').includes(GMAIL_READONLY_SCOPE)
      ) {
        try {
          await prisma.dataStore.upsert({
            where: { key: 'milo-gmail-credentials' },
            update: {
              data: {
                email: MILO_EMAIL,
                refreshToken: account.refresh_token,
                connectedAt: new Date().toISOString(),
              },
            },
            create: {
              key: 'milo-gmail-credentials',
              data: {
                email: MILO_EMAIL,
                refreshToken: account.refresh_token,
                connectedAt: new Date().toISOString(),
              },
            },
          })
        } catch (error) {
          console.error('Milo Gmail credential storage failed', error)
        }
      }
      return token
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub ?? ''
        session.user.email = token.email as string
      }
      return session
    },
  },
  pages: {
    signIn: '/login',
  },
}
