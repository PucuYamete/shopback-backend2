const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const PORT = 3000;

app.use(cors());

// ================== TEST ROUTE ==================
app.get("/test", (req, res) => {
    res.send("OK BACKEND");
});

function detectPlatform(url) {
    if (url.includes("shopee.")) return "shopee";
    if (url.includes("lazada.")) return "lazada";
    if (url.includes("tiki.")) return "tiki";
    return "unknown";
}

// ================== PREVIEW PRODUCT ==================
app.get("/preview", async (req, res) => {
    const encodedUrl = req.query.u;

    if (!encodedUrl) {
        return res.status(400).json({ error: "Missing URL" });
    }

    let productUrl;
    try {
        productUrl = decodeURIComponent(encodedUrl);
    } catch {
        return res.status(400).json({ error: "Invalid URL" });
    }

    const platform = detectPlatform(productUrl);

    if (platform !== "shopee") {
        return res
            .status(400)
            .json({ error: "Preview only supports Shopee for now" });
    }

    try {
        const { data: html } = await axios.get(productUrl, {
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            },
        });

        const $ = cheerio.load(html);

        const title =
            $("meta[property='og:title']").attr("content") ||
            $("title").text();

        const image =
            $("meta[property='og:image']").attr("content") || "";

        res.json({
            platform,
            title,
            image,
            url: productUrl,
        });
    } catch (err) {
        res.status(500).json({
            error: "Cannot fetch product preview",
        });
    }
});

// ================== SHOPEE REDIRECT + LOG ==================
app.get("/go", (req, res) => {
    const encodedUrl = req.query.u;

    if (!encodedUrl) {
        return res.status(400).send("Missing product URL");
    }

    let productUrl;
    try {
        productUrl = decodeURIComponent(encodedUrl);
    } catch (e) {
        return res.status(400).send("Invalid encoded URL");
    }

    // ✅ VALIDATE PLATFORM (ĐÂY CHÍNH LÀ CHỖ BẠN HỎI)
    const platform = detectPlatform(productUrl);

    if (platform === "unknown") {
        return res.status(400).send("Unsupported platform");
    }

    // ===== LOG CLICK =====
    const logData = {
        time: new Date().toISOString(),
        productUrl,
        platform,
        ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
        userAgent: req.headers["user-agent"],
    };

    const logDir = path.join(__dirname, "logs");
    const logFile = path.join(logDir, "clicks.log");

    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(logFile, JSON.stringify(logData) + "\n");

    // ===== AFFILIATE REDIRECT =====
    let finalLink = "";

    if (platform === "shopee") {
        const AFF_LINK = "https://s.shopee.vn/4q9pO5rkQL";
        finalLink =
            AFF_LINK + "?url=" + encodeURIComponent(productUrl);
    }

    // future: lazada / tiki

    if (!finalLink) {
        return res.status(400).send("Affiliate not configured");
    }

    return res.redirect(302, finalLink);
});

// ================== START SERVER ==================
app.listen(PORT, () => {
    console.log(`Backend running at http://localhost:${PORT}`);
});