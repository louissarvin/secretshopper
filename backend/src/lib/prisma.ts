import { PrismaClient } from '../../prisma/generated/client.js';
import { PrismaPg } from '@prisma/adapter-pg';

// One pool per process (pg default max 10).
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

export const prismaQuery = new PrismaClient({ adapter });
