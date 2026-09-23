module.exports = [
"[externals]/next/dist/compiled/@opentelemetry/api [external] (next/dist/compiled/@opentelemetry/api, cjs)", ((__turbopack_context__, module, exports) => {

var mod = __turbopack_context__.x("next/dist/compiled/@opentelemetry/api", () => require("next/dist/compiled/@opentelemetry/api"));

module.exports = mod;
}),
"[externals]/next/dist/compiled/next-server/app-page-turbo.runtime.dev.js [external] (next/dist/compiled/next-server/app-page-turbo.runtime.dev.js, cjs)", ((__turbopack_context__, module, exports) => {

var mod = __turbopack_context__.x("next/dist/compiled/next-server/app-page-turbo.runtime.dev.js", () => require("next/dist/compiled/next-server/app-page-turbo.runtime.dev.js"));

module.exports = mod;
}),
"[externals]/next/dist/compiled/next-server/app-route-turbo.runtime.dev.js [external] (next/dist/compiled/next-server/app-route-turbo.runtime.dev.js, cjs)", ((__turbopack_context__, module, exports) => {

var mod = __turbopack_context__.x("next/dist/compiled/next-server/app-route-turbo.runtime.dev.js", () => require("next/dist/compiled/next-server/app-route-turbo.runtime.dev.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/work-async-storage.external.js [external] (next/dist/server/app-render/work-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

var mod = __turbopack_context__.x("next/dist/server/app-render/work-async-storage.external.js", () => require("next/dist/server/app-render/work-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/work-unit-async-storage.external.js [external] (next/dist/server/app-render/work-unit-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

var mod = __turbopack_context__.x("next/dist/server/app-render/work-unit-async-storage.external.js", () => require("next/dist/server/app-render/work-unit-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/runtime-reacts.external.js [external] (next/dist/server/runtime-reacts.external.js, cjs)", ((__turbopack_context__, module, exports) => {

var mod = __turbopack_context__.x("next/dist/server/runtime-reacts.external.js", () => require("next/dist/server/runtime-reacts.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/shared/lib/no-fallback-error.external.js [external] (next/dist/shared/lib/no-fallback-error.external.js, cjs)", ((__turbopack_context__, module, exports) => {

var mod = __turbopack_context__.x("next/dist/shared/lib/no-fallback-error.external.js", () => require("next/dist/shared/lib/no-fallback-error.external.js"));

module.exports = mod;
}),
"[externals]/node:stream [external] (node:stream, cjs)", ((__turbopack_context__, module, exports) => {

var mod = __turbopack_context__.x("node:stream", () => require("node:stream"));

module.exports = mod;
}),
"[project]/apps/web/app/api/rag/pdf/route.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "GET",
    ()=>GET,
    "dynamic",
    ()=>dynamic,
    "runtime",
    ()=>runtime
]);
const runtime = "nodejs";
const dynamic = "force-dynamic";
const ALLOWED_HOST = "shasanadesh.up.gov.in";
const ALLOWED_PATH = "/GO/ViewGOPDF_list_user.aspx";
function validateSourceUrl(raw) {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || parsed.hostname !== ALLOWED_HOST || parsed.pathname !== ALLOWED_PATH) {
        throw new Error("Unsupported PDF source URL.");
    }
    if (!parsed.searchParams.has("id1")) {
        throw new Error("PDF source URL is missing id1.");
    }
    parsed.hash = "";
    return parsed;
}
async function GET(request) {
    const raw = request.nextUrl.searchParams.get("url");
    if (!raw) {
        return Response.json({
            message: "Missing url parameter."
        }, {
            status: 400
        });
    }
    let sourceUrl;
    try {
        sourceUrl = validateSourceUrl(raw);
    } catch (error) {
        return Response.json({
            message: error instanceof Error ? error.message : String(error)
        }, {
            status: 400
        });
    }
    try {
        const headers = new Headers();
        const range = request.headers.get("range");
        if (range) {
            headers.set("range", range);
        }
        const upstream = await fetch(sourceUrl, {
            method: "GET",
            headers,
            cache: "no-store",
            redirect: "follow"
        });
        if (!upstream.ok) {
            return Response.json({
                message: `Source PDF returned ${upstream.status}.`
            }, {
                status: 502
            });
        }
        const responseHeaders = new Headers();
        responseHeaders.set("content-type", upstream.headers.get("content-type") ?? "application/pdf");
        responseHeaders.set("cache-control", "private, max-age=300");
        responseHeaders.set("content-disposition", "inline");
        for (const name of [
            "accept-ranges",
            "content-range",
            "content-length",
            "etag",
            "last-modified"
        ]){
            const value = upstream.headers.get(name);
            if (value) {
                responseHeaders.set(name, value);
            }
        }
        return new Response(upstream.body, {
            status: upstream.status,
            headers: responseHeaders
        });
    } catch (error) {
        return Response.json({
            message: error instanceof Error ? error.message : String(error)
        }, {
            status: 502
        });
    }
}
}),
];

//# sourceMappingURL=%5Broot-of-the-server%5D__0_akyso._.js.map