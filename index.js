require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", true);
app.use(cors());

const rateLimitMap = new Map();
const RATE_LIMIT_MS = 10_000;
const RATE_LIMIT_CLEANUP_MS = 60_000;

// ================== HELPERS ==================

function getClientIp(req) {
    return req.ip || req.socket?.remoteAddress || "unknown";
}

function detectPlatform(url) {
    if (url.includes("shopee.")) return "shopee";
    if (url.includes("lazada.")) return "lazada";
    if (url.includes("tiki.")) return "tiki";
    return "unknown";
}
function readProducts() {
    const productsFile = path.join(__dirname, "data", "products.json");

    if (!fs.existsSync(productsFile)) {
        return [];
    }

    try {
        const raw = fs.readFileSync(productsFile, "utf-8");
        const products = JSON.parse(raw);
        return Array.isArray(products) ? products : [];
    } catch {
        return [];
    }
}

function findProductById(id) {
    const products = readProducts();
    return products.find(
        (item) => String(item.id) === String(id) && item.active !== false
    );
}

function validateProductUrl(rawUrl) {
    try {
        const url = new URL(rawUrl);

        if (!["http:", "https:"].includes(url.protocol)) {
            return false;
        }

        const platform = detectPlatform(rawUrl);
        if (platform === "unknown") {
            return false;
        }

        return true;
    } catch {
        return false;
    }
}

function requireAdminKey(req, res, next) {
    const adminKey = req.headers["x-admin-key"];

    if (!process.env.ADMIN_KEY) {
        return res.status(500).json({
            error: "ADMIN_KEY is not configured",
        });
    }

    if (adminKey !== process.env.ADMIN_KEY) {
        return res.status(403).json({
            error: "Forbidden",
        });
    }

    next();
}

function checkRateLimit(ip) {
    const now = Date.now();
    const last = rateLimitMap.get(ip) || 0;

    if (now - last < RATE_LIMIT_MS) {
        return false;
    }

    rateLimitMap.set(ip, now);
    return true;
}

function buildAffiliateLink(productUrl, platform, clickId) {
    // Ưu tiên MasOffer nếu có
    if (process.env.MASOFFER_AFF) {
        const base = process.env.MASOFFER_AFF;
        return `${base}?url=${encodeURIComponent(productUrl)}&aff_sub=${clickId}`;
    }

    // fallback sang Shopee Affiliate
    if (process.env.SHOPEE_AFF) {
        const base = process.env.SHOPEE_AFF;
        return `${base}${encodeURIComponent(productUrl)}`;
    }

    // fallback cuối cùng
    return productUrl;
}

async function logClick(logData) {
    const logDir = path.join(__dirname, "logs");
    const logFile = path.join(logDir, "clicks.log");

    await fs.promises.mkdir(logDir, { recursive: true });
    await fs.promises.appendFile(logFile, JSON.stringify(logData) + "\n", "utf-8");
}

async function readClickHistory() {
    const logFile = path.join(__dirname, "logs", "clicks.log");

    if (!fs.existsSync(logFile)) {
        return [];
    }

    const raw = await fs.promises.readFile(logFile, "utf-8");

    return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            try {
                return JSON.parse(line);
            } catch {
                return null;
            }
        })
        .filter(Boolean)
        .reverse();
}

function sanitizeHistoryItem(item) {
    return {
        clickId: item.clickId || "",
        time: item.time || "",
        productUrl: item.productUrl || "",
        platform: item.platform || "",
        ip: item.ip || "",
        userAgent: item.userAgent || "",
    };
}

// cleanup rate limit map
setInterval(() => {
    const now = Date.now();

    for (const [ip, timestamp] of rateLimitMap.entries()) {
        if (now - timestamp > RATE_LIMIT_CLEANUP_MS) {
            rateLimitMap.delete(ip);
        }
    }
}, RATE_LIMIT_CLEANUP_MS);

// ================== TEST ROUTE ==================

app.get("/products", (req, res) => {
    const products = readProducts();

    const publicProducts = products
        .filter((item) => item.active !== false)
        .map((item) => ({
            id: item.id,
            title: item.title,
            platform: item.platform,
            category: item.category || "HOT",
            productUrl: item.productUrl,
            image: item.image || "",
            active: item.active !== false,
        }));

    res.json(publicProducts);
});

// ================== PREVIEW PRODUCT ==================

app.get("/preview", async (req, res) => {
    const encodedUrl = req.query.u;

    if (!encodedUrl) {
        return res.status(400).json({
            error: "Missing URL",
        });
    }

    let productUrl;

    try {
        productUrl = decodeURIComponent(encodedUrl);
    } catch {
        return res.status(400).json({
            error: "Invalid encoded URL",
        });
    }

    if (!validateProductUrl(productUrl)) {
        return res.status(400).json({
            error: "Invalid or unsupported URL",
        });
    }

    const platform = detectPlatform(productUrl);

    if (platform !== "shopee") {
        return res.status(400).json({
            error: "Preview currently only supports Shopee",
        });
    }

    try {
        const { data: html } = await axios.get(productUrl, {
            timeout: 8000,
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
            },
        });

        const $ = cheerio.load(html);

        const title =
            $("meta[property='og:title']").attr("content")?.trim() ||
            $("title").text()?.trim() ||
            "";

        const image =
            $("meta[property='og:image']").attr("content")?.trim() || "";

        return res.json({
            platform,
            title,
            image,
            url: productUrl,
            previewAvailable: Boolean(title || image),
        });
    } catch (error) {
        console.error("Preview fetch error:", error.message);

        return res.json({
            platform,
            title: "",
            image: "",
            url: productUrl,
            previewAvailable: false,
        });
    }
});

// ================== REDIRECT + LOG ==================

app.get("/go", (req, res) => {
    const id = req.query.id;
    if (!id) {
        return res.status(400).send("Missing product id");
    }

    const product = findProductById(id);
    if (!product) {
        return res.status(404).send("Product not found");
    }

    const affiliateUrl = product.affiliateUrl;
    if (!affiliateUrl) {
        return res.status(400).send("Missing affiliate URL");
    }

    const platform = detectPlatform(affiliateUrl);
    if (platform !== "shopee") {
        return res.status(400).send("Only Shopee affiliate links are supported");
    }

    // ===== RATE LIMIT =====
    const ip = getClientIp(req);
    const now = Date.now();
    const last = rateLimitMap.get(ip) || 0;

    if (now - last < 10_000) {
        return res
            .status(429)
            .send("Too many requests, slow down");
    }

    rateLimitMap.set(ip, now);

    // ===== LOG CLICK =====
    const logData = {
        time: new Date().toISOString(),
        productId: product.id,
        title: product.title,
        productUrl: product.productUrl,
        affiliateUrl: product.affiliateUrl,
        platform: "shopee",
        ip,
        userAgent: req.headers["user-agent"],
    };

    const logDir = path.join(__dirname, "logs");
    const logFile = path.join(logDir, "clicks.log");

    fs.mkdirSync(logDir, { recursive: true });
    logClick(logData)

    return res.redirect(302, affiliateUrl);
});

// ================== VIEW CLICK HISTORY ==================

app.get("/history", requireAdminKey, async (req, res) => {
    try {
        const items = await readClickHistory();
        return res.json(items.map(sanitizeHistoryItem));
    } catch (error) {
        console.error("History read error:", error.message);
        return res.status(500).json({
            error: "Cannot read click history",
        });
    }
});

// ================== ROOT ROUTE ==================

app.get("/", (req, res) => {
    res.send("Affiliate backend is running");
});

// ================== START SERVER ==================
console.log("RUNNING FILE:", __filename);
app.listen(PORT, () => {
    console.log(`Backend running at http://localhost:${PORT}`);
});