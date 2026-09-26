export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET() {
  try {
    // Try DataStore first (synced by scanner)
    const row = await prisma.dataStore.findUnique({ where: { key: "youtube-outliers" } });
    if (row?.data) {
      return NextResponse.json(row.data);
    }

    return NextResponse.json({
      videos: [],
      totalOutliers: 0,
      nicheCounts: {},
      scannedAt: null,
      error: 'No outlier data synced yet.',
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to read outlier data', details: String(err) },
      { status: 500 }
    );
  }
}
