import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { internalSecretMatches } from '@/lib/internal-secret-auth.mjs';

const prisma = new PrismaClient();
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET;
const CACHE_KEYS = ['notion_clients_monthly', 'mcf_monthly', 'ltv_monthly'];

export async function POST(req: Request) {
  const secret = req.headers.get('x-internal-secret');
  if (!internalSecretMatches(secret, INTERNAL_SECRET)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const results = await Promise.all(
    CACHE_KEYS.map(key => prisma.dataStore.delete({ where: { key } }).then(() => ({ key, cleared: true })).catch(() => ({ key, cleared: false })))
  );
  return NextResponse.json({ results });
}
