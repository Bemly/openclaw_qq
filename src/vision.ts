import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";

// ── MIME helpers ──────────────────────────────────────────────
const IMAGE_EXT_TO_MIME = new Map<string, string>([
    [".png", "image/png"],
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".gif", "image/gif"],
    [".webp", "image/webp"],
    [".bmp", "image/bmp"],
    [".tif", "image/tiff"],
    [".tiff", "image/tiff"],
    [".heic", "image/heic"],
    [".heif", "image/heif"],
]);

function inferMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    return IMAGE_EXT_TO_MIME.get(ext) || "image/png";
}

// ── Base64 helpers ────────────────────────────────────────────
async function fileToBase64(filePath: string): Promise<{ base64: string; mimeType: string }> {
    const buffer = await fs.readFile(filePath);
    return {
        base64: buffer.toString("base64"),
        mimeType: inferMimeType(filePath),
    };
}

// ── API call ──────────────────────────────────────────────────
interface VisionModelSpec {
    provider: string;
    model: string;
    baseUrl: string;
    apiKey: string;
}

function parseVisionModel(raw: string): Array<{ provider: string; model: string }> {
    return raw
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
        .map(entry => {
            const idx = entry.indexOf("/");
            if (idx === -1) return { provider: "", model: entry };
            return {
                provider: entry.slice(0, idx),
                model: entry.slice(idx + 1),
            };
        })
        .filter(v => v.provider && v.model);
}

function buildVisionApiUrl(baseUrl: string): string {
    const clean = baseUrl.replace(/\/+$/, "");
    if (clean.endsWith("/v1") || clean.endsWith("/compatible-mode/v1")) {
        return `${clean}/chat/completions`;
    }
    return `${clean}/v1/chat/completions`;
}

async function callSingleVisionModel(
    imagePaths: string[],
    prompt: string,
    spec: VisionModelSpec,
): Promise<string | null> {
    const apiUrl = buildVisionApiUrl(spec.baseUrl);

    const imageContents = await Promise.all(
        imagePaths.map(async (imagePath) => {
            const { base64, mimeType } = await fileToBase64(imagePath);
            return {
                type: "image_url" as const,
                image_url: { url: `data:${mimeType};base64,${base64}` },
            };
        })
    );

    const body = JSON.stringify({
        model: spec.model,
        messages: [
            {
                role: "user",
                content: [
                    { type: "text", text: prompt },
                    ...imageContents,
                ],
            },
        ],
        max_tokens: 1000,
    });

    const resp = await fetch(apiUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${spec.apiKey}`,
        },
        body,
    });

    if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        throw new Error(`vision API HTTP ${resp.status}: ${errText.slice(0, 300)}`);
    }

    const json = await resp.json() as any;
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content === "string" && content.trim()) {
        return content.trim();
    }
    return null;
}

// ── Rate limiting ─────────────────────────────────────────────
let lastVisionApiCallTs = 0;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitVisionRateLimit(rateLimitMs: number): Promise<void> {
    if (rateLimitMs <= 0) return;
    const elapsed = Date.now() - lastVisionApiCallTs;
    if (elapsed < rateLimitMs) {
        const waitMs = rateLimitMs - elapsed;
        console.log(`[QQ-vision] rate limiting: waiting ${waitMs}ms before next API call...`);
        await sleep(waitMs);
    }
    lastVisionApiCallTs = Date.now();
}

// ── Main entry ────────────────────────────────────────────────
export interface VisionContext {
    imagePaths: string[];
    visionModelRaw: string;
    visionPrompt: string;
    visionRateLimitMs?: number;
    providers: Record<string, { baseUrl?: string; apiKey?: string }>;
}

export interface VisionResult {
    description: string | null;
    model: string;
    error?: string;
}

export async function describeImages(ctx: VisionContext): Promise<VisionResult> {
    const models = parseVisionModel(ctx.visionModelRaw);
    if (models.length === 0) {
        return { description: null, model: "", error: "no vision model configured" };
    }
    if (ctx.imagePaths.length === 0) {
        return { description: null, model: "", error: "no image paths provided" };
    }

    for (const { provider, model } of models) {
        const providerConfig = ctx.providers[provider];
        if (!providerConfig?.baseUrl || !providerConfig?.apiKey) {
            const err = `provider ${provider} not found or missing baseUrl/apiKey`;
            console.log(`[QQ-vision] skip ${provider}/${model}: ${err}`);
            continue;
        }

        const spec: VisionModelSpec = {
            provider,
            model,
            baseUrl: providerConfig.baseUrl,
            apiKey: providerConfig.apiKey,
        };

        try {
            // 调用 API 前先等 rate limit
            if (ctx.visionRateLimitMs && ctx.visionRateLimitMs > 0) {
                await waitVisionRateLimit(ctx.visionRateLimitMs);
            }
            console.log(`[QQ-vision] calling ${provider}/${model} with ${ctx.imagePaths.length} image(s)...`);
            const startTs = Date.now();
            const description = await callSingleVisionModel(ctx.imagePaths, ctx.visionPrompt, spec);
            const elapsed = Date.now() - startTs;
            if (description) {
                console.log(`[QQ-vision] ${provider}/${model} success (${elapsed}ms, ${description.length} chars)`);
                return { description, model: `${provider}/${model}` };
            }
            console.log(`[QQ-vision] ${provider}/${model} returned empty (${elapsed}ms)`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`[QQ-vision] ${provider}/${model} failed: ${msg}`);
        }
    }

    return { description: null, model: "", error: "all vision models exhausted" };
}
