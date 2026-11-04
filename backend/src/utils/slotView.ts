// What the API may show about a test slot. Sealed slots expose only what is already on chain.

export const REVEALED_STATUSES = ['Passed', 'Failed', 'Unanswered', 'Ignored', 'Void', 'Invalid', 'Misdirected'] as const;
export const VISIBLE_STATUSES = ['Committed', ...REVEALED_STATUSES];

export const slotSelect = {
  slotIndex: true,
  commitment: true,
  status: true,
  contained: true,
  expiresAt: true,
  revealedPayee: true,
  revealedSalt: true,
  revealedInvoiceId: true,
  revealTxHash: true,
  revealedAt: true,
  sweptTxHash: true,
} as const;

type SlotRow = {
  slotIndex: number | null;
  commitment: string;
  status: string;
  contained: boolean;
  expiresAt: Date | null;
  revealedPayee: string | null;
  revealedSalt: string | null;
  revealedInvoiceId: string | null;
  revealTxHash: string | null;
  revealedAt: Date | null;
  sweptTxHash: string | null;
};

export const isRevealed = (s: { status: string; revealedAt: Date | null }): boolean =>
  s.revealedAt !== null && (REVEALED_STATUSES as readonly string[]).includes(s.status);

export const toSlotView = (s: SlotRow) =>
  isRevealed(s)
    ? { ...s, revealed: true as const }
    : { slotIndex: s.slotIndex, commitment: s.commitment, status: 'Committed', expiresAt: s.expiresAt, revealed: false as const };
