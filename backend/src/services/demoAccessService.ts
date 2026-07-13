import { prisma } from '../lib/prisma';
import { DemoAccessKeyStatus } from '../../generated/prisma';
import crypto from 'crypto';

const DEMO_KEY_PREFIX = 'pf-';
const DEMO_KEY_LENGTH = 24;

function generateRandomString(length: number): string {
  return crypto.randomBytes(length / 2).toString('hex');
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

export const demoAccessService = {
  generateKey: async () => {
    const randomPart = generateRandomString(DEMO_KEY_LENGTH);
    const key = `${DEMO_KEY_PREFIX}${randomPart}`;

    return await prisma.demoKey.create({
      data: {
        key,
        status: 'UNCLAIMED',
      },
    });
  },

  generateBulkKeys: async (count: number) => {
    const keys = Array.from({ length: count }, () => {
      const randomPart = generateRandomString(DEMO_KEY_LENGTH);
      return `${DEMO_KEY_PREFIX}${randomPart}`;
    });

    return await prisma.demoKey.createMany({
      data: keys.map((key) => ({
        key,
        status: 'UNCLAIMED',
      })),
      skipDuplicates: true,
    });
  },

  validateKey: async (keyInput: string) => {
    const normalizedKey = normalizeKey(keyInput);
    return await prisma.demoKey.findUnique({
      where: { key: normalizedKey },
    });
  },

  claimKey: async (keyInput: string, clerkUserId: string) => {
    const normalizedKey = normalizeKey(keyInput);
    const key = await prisma.demoKey.findUnique({
      where: { key: normalizedKey },
    });

    if (!key) {
      throw new Error('Invalid demo access key');
    }

    if (key.status !== 'UNCLAIMED') {
      throw new Error('Demo key is no longer available');
    }

    // Atomically update key and return
    const claimed = await prisma.demoKey.update({
      where: { id: key.id },
      data: {
        status: 'CLAIMED',
        userId: clerkUserId,
        claimedAt: new Date(),
      },
    });

    return claimed;
  },

  getAccessStatus: async (clerkUserId: string) => {
    const demoKey = await prisma.demoKey.findFirst({
      where: {
        userId: clerkUserId,
        status: 'CLAIMED',
      },
    });

    return {
      hasAccess: !!demoKey,
      demoKey: demoKey ? { id: demoKey.id, claimedAt: demoKey.claimedAt } : null,
    };
  },

  revokeKey: async (keyId: string) => {
    return await prisma.demoKey.update({
      where: { id: keyId },
      data: { status: 'REVOKED' },
    });
  },

  deleteKey: async (keyId: string) => {
    return await prisma.demoKey.delete({
      where: { id: keyId },
    });
  },

  listKeys: async (filter?: { status?: DemoAccessKeyStatus; claimed?: boolean }) => {
    const keys = await prisma.demoKey.findMany({
      where: filter ? {
        status: filter.status,
        ...(filter.claimed !== undefined && {
          userId: filter.claimed ? { not: null } : null,
        }),
      } : undefined,
      orderBy: { createdAt: 'desc' },
    });

    return keys.map((key) => ({
      id: key.id,
      key: key.key,
      status: key.status,
      createdAt: key.createdAt,
      claimedBy: key.userId || undefined,
      claimedAt: key.claimedAt || undefined,
    }));
  },

  getKeyStats: async () => {
    const [total, unclaimed, claimed, revoked, lastKey] = await Promise.all([
      prisma.demoKey.count(),
      prisma.demoKey.count({ where: { status: 'UNCLAIMED' } }),
      prisma.demoKey.count({ where: { status: 'CLAIMED' } }),
      prisma.demoKey.count({ where: { status: 'REVOKED' } }),
      prisma.demoKey.findFirst({ orderBy: { createdAt: 'desc' } }),
    ]);

    const claimRate = total > 0 ? claimed / total : 0;

    return {
      totalKeys: total,
      unclaimedKeys: unclaimed,
      claimedKeys: claimed,
      revokedKeys: revoked,
      claimRate,
      lastKeyGeneratedAt: lastKey?.createdAt,
    };
  },
};
