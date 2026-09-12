import { defineCloudflareConfig } from '@opennextjs/cloudflare';

// Every route in this app is `force-dynamic`: a demo link's `expired` state
// flips the moment a call starts, so nothing here may ever be served from a
// cache. That leaves no incremental cache, tag cache or revalidation queue to
// configure — the defaults are exactly right, and wiring an R2 or KV binding
// in here would be paying for a cache that must always miss.
export default defineCloudflareConfig({});
