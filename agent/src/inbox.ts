import { INBOX_TOKEN, INBOX_URL, STATE_FILE } from './config.ts';
import { createInbox } from './inboxClient.ts';

// The native agent's inbox, bound to src/config.ts. The MCP server builds its own with createInbox.
export { MAX_INBOX_BYTES, readBounded, type Cursor, type InboxItem, type State } from './inboxClient.ts';

export const { nextInvoice, getVendor, blocklist, whoami, loadState, saveState, advance } = createInbox({ url: INBOX_URL, token: INBOX_TOKEN, stateFile: STATE_FILE });
