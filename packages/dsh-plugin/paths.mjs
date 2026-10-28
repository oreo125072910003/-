import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// The old desktop may have been started by a packaged app, whose Roaming
// directory differs from DSH's. Choose an existing database, never a new empty
// identity merely because the launcher environment changed.
const contract = new URL(fs.existsSync(new URL('./payload/', import.meta.url)) ? './payload/packages/contracts/product-data.cjs' : '../contracts/product-data.cjs', import.meta.url);
export const { resolveProductDataRoot } = createRequire(import.meta.url)(fileURLToPath(contract));
