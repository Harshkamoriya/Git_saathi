
import { PrismaClient } from "@prisma/client";

declare global {
    // eslint-disable-next-line no-var, no-unused-vars
    var cachedPrismaClient: PrismaClient;
}

// Neon computes scale to zero and can take longer than Prisma's 5s default to wake up.
function withTimeouts(url: string | undefined) {
    if (!url) return url;
    const params: string[] = [];
    if (!/[?&]connect_timeout=/.test(url)) params.push("connect_timeout=30");
    if (!/[?&]pool_timeout=/.test(url)) params.push("pool_timeout=30");
    if (params.length === 0) return url;
    return url + (url.includes("?") ? "&" : "?") + params.join("&");
}

const createClient = () =>
    new PrismaClient({ datasourceUrl: withTimeouts(process.env.DATABASE_URL) });

export let prisma: PrismaClient;
if (process.env.NODE_ENV === "production") {
    prisma = createClient();
} else {
    if (!global.cachedPrismaClient) {
    global.cachedPrismaClient = createClient();
    }
    prisma = global.cachedPrismaClient;
}
