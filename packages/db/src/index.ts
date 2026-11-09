import { PrismaClient } from '@prisma/client';

/** Singleton Prisma client (safe for serverless and long-running workers). */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export function getDb(): PrismaClient {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = new PrismaClient();
  }
  return globalForPrisma.prisma;
}

export { PrismaClient };
export * from './crypto';
