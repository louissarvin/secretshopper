/** Prisma BigInt columns break JSON serialization; send them as strings. */
export const jsonSafe = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) as T;
