/**
 * Cloudflare Pages Function: the owner's cloud proxy at /proxy/*.
 * All logic (and its security notes) lives in tools/cloud-proxy.mjs.
 * Set the FAISAL_PROXY_TOKEN secret in the Pages project to turn it on.
 */
import { handleCloudProxy } from '../../tools/cloud-proxy.mjs';

export const onRequest = (context) => handleCloudProxy(context.request, context.env);
