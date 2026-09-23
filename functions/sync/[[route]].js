/**
 * Cloudflare Pages Function: the owner's cloud sync at /sync/*.
 * Logic and security notes: tools/cloud-sync.mjs. Needs a D1 database bound
 * as SYNC_DB and the FAISAL_SYNC_TOKEN (or FAISAL_PROXY_TOKEN) secret.
 */
import { handleCloudSync } from '../../tools/cloud-sync.mjs';

export const onRequest = (context) => handleCloudSync(context.request, context.env);
