import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import * as XLSX from "xlsx";
import crypto from "crypto";
import { RateLimiterMemory } from "rate-limiter-flexible";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const app        = express();
const PORT       = process.env.PORT || 3000;

// ─── Rate Limiter (100 requests / 15 min per IP) ──────────────
const rateLimiter = new RateLimiterMemory({ points: 100, duration: 900 });

// ─── File Upload Config ───────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  fileFilter: (_, file, cb) => {
    const allowed = [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "text/csv",
      "application/csv",
    ];
    const allowedExt = /\.(xlsx|xls|csv)$/i;
    if (allowed.includes(file.mimetype) || allowedExt.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error("Only Excel and CSV files are supported."));
    }
  },
});

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ─── Security Headers ─────────────────────────────────────────
app.use((_, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  next();
});

// ─── Request Logger ───────────────────────────────────────────
app.use((req, _, next) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  req.requestId = requestId;
  console.log(`[${new Date().toISOString()}] [${requestId}] ${req.method} ${req.path}`);
  next();
});

// ─── In-Memory Cache (TTL: 10 minutes) ───────────────────────
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

function getCacheKey(buffer, question) {
  const hash = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);
  return `${hash}:${(question || "").slice(0, 64)}`;
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return entry.value;
}

function cacheSet(key, value) {
  if (cache.size > 200) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(key, { value, ts: Date.now() });
}

// ─── Parse Excel / CSV → JSON ─────────────────────────────────
function parseFile(buffer, mimetype, originalname) {
  const isCSV = /\.csv$/i.test(originalname) || mimetype === "text/csv";
  const workbook = XLSX.read(buffer, {
    type: "buffer",
    cellDates: true,
    cellNF: true,
    raw: false,
  });

  const results = [];
  const sheetsToProcess = isCSV ? [workbook.SheetNames[0]] : workbook.SheetNames.slice(0, 5);

  for (const sheetName of sheetsToProcess) {
    const sheet = workbook.Sheets[sheetName];
    const rows  = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: false });
    if (rows.length === 0) continue;

    const columns = Object.keys(rows[0]);
    results.push({ sheetName, rows, columns, totalRows: rows.length });
  }

  if (results.length === 0) throw new Error("No data found in uploaded file.");
  return results;
}

// ─── Descriptive Statistics ───────────────────────────────────
function computeStats(rows, columns) {
  const stats = {};

  for (const col of columns) {
    const allValues = rows.map(r => r[col]);
    const nonNull   = allValues.filter(v => v !== null && v !== "" && v !== undefined);
    const numeric   = nonNull.map(v => parseFloat(String(v).replace(/,/g, ""))).filter(v => !isNaN(v));
    const missing   = allValues.length - nonNull.length;

    if (numeric.length > nonNull.length * 0.5 && numeric.length >= 3) {
      const sorted   = [...numeric].sort((a, b) => a - b);
      const n        = numeric.length;
      const sum      = numeric.reduce((a, b) => a + b, 0);
      const mean     = sum / n;

      const q1  = sorted[Math.floor(n * 0.25)];
      const q3  = sorted[Math.floor(n * 0.75)];
      const iqr = q3 - q1;

      const median = n % 2 === 0
        ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
        : sorted[Math.floor(n / 2)];

      const variance  = numeric.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / n;
      const skewness  = n >= 3
        ? numeric.reduce((a, b) => a + Math.pow((b - mean) / Math.sqrt(variance || 1), 3), 0) / n
        : 0;
      const kurtosis  = n >= 4
        ? numeric.reduce((a, b) => a + Math.pow((b - mean) / Math.sqrt(variance || 1), 4), 0) / n - 3
        : 0;

      // Outlier detection (IQR method)
      const outliers = numeric.filter(v => v < q1 - 1.5 * iqr || v > q3 + 1.5 * iqr);

      stats[col] = {
        type: "numeric",
        count: n,
        missing,
        missingPct: +((missing / allValues.length) * 100).toFixed(1),
        mean: +mean.toFixed(4),
        median: +median.toFixed(4),
        mode: computeMode(numeric),
        min: sorted[0],
        max: sorted[n - 1],
        range: +(sorted[n - 1] - sorted[0]).toFixed(4),
        std: +Math.sqrt(variance).toFixed(4),
        variance: +variance.toFixed(4),
        q1: +q1.toFixed(4),
        q3: +q3.toFixed(4),
        iqr: +iqr.toFixed(4),
        skewness: +skewness.toFixed(4),
        kurtosis: +kurtosis.toFixed(4),
        outlierCount: outliers.length,
        cv: mean !== 0 ? +((Math.sqrt(variance) / Math.abs(mean)) * 100).toFixed(2) : null,
        sum: +sum.toFixed(4),
      };
    } else {
      const strValues = nonNull.map(String);
      const freq      = {};
      strValues.forEach(v => { freq[v] = (freq[v] || 0) + 1; });
      const sorted    = Object.entries(freq).sort((a, b) => b[1] - a[1]);

      stats[col] = {
        type: "categorical",
        count: nonNull.length,
        missing,
        missingPct: +((missing / allValues.length) * 100).toFixed(1),
        unique: Object.keys(freq).length,
        top: sorted.slice(0, 10).map(([val, count]) => ({ val, count })),
        topVal: sorted[0]?.[0] ?? null,
        topFreq: sorted[0]?.[1] ?? 0,
        topFreqPct: nonNull.length > 0
          ? +((sorted[0]?.[1] / nonNull.length) * 100).toFixed(1)
          : 0,
      };
    }
  }

  return stats;
}

function computeMode(nums) {
  const freq = {};
  nums.forEach(v => { freq[v] = (freq[v] || 0) + 1; });
  const max  = Math.max(...Object.values(freq));
  const mode = Object.keys(freq).find(k => freq[k] === max);
  return mode !== undefined ? +parseFloat(mode).toFixed(4) : null;
}

// ─── Pearson Correlation Matrix ───────────────────────────────
function computeCorrelations(rows, columns, stats) {
  const numericCols  = columns.filter(c => stats[c]?.type === "numeric");
  const correlations = [];
  const matrix       = {};

  for (let i = 0; i < numericCols.length; i++) {
    for (let j = i + 1; j < numericCols.length; j++) {
      const colA  = numericCols[i];
      const colB  = numericCols[j];
      const pairs = rows
        .map(r => [parseFloat(r[colA]), parseFloat(r[colB])])
        .filter(([a, b]) => !isNaN(a) && !isNaN(b));

      if (pairs.length < 5) continue;

      const n    = pairs.length;
      const sumA = pairs.reduce((s, [a]) => s + a, 0);
      const sumB = pairs.reduce((s, [, b]) => s + b, 0);
      const sumAB = pairs.reduce((s, [a, b]) => s + a * b, 0);
      const sumA2 = pairs.reduce((s, [a]) => s + a * a, 0);
      const sumB2 = pairs.reduce((s, [, b]) => s + b * b, 0);
      const num  = n * sumAB - sumA * sumB;
      const den  = Math.sqrt((n * sumA2 - sumA ** 2) * (n * sumB2 - sumB ** 2));
      const r    = den === 0 ? 0 : +(num / den).toFixed(4);

      // t-test for significance
      const tStat = r * Math.sqrt((n - 2) / (1 - r * r + 1e-10));
      const pValue = approximatePValue(Math.abs(tStat), n - 2);

      const entry = { colA, colB, r, n: pairs.length, tStat: +tStat.toFixed(3), pValue: +pValue.toFixed(4), significant: pValue < 0.05 };
      correlations.push(entry);

      if (!matrix[colA]) matrix[colA] = {};
      if (!matrix[colB]) matrix[colB] = {};
      matrix[colA][colB] = r;
      matrix[colB][colA] = r;
    }
  }

  return {
    top: correlations.sort((a, b) => Math.abs(b.r) - Math.abs(a.r)).slice(0, 15),
    matrix,
    numericCols,
  };
}

// Approximate two-tailed p-value using t-distribution approximation
function approximatePValue(t, df) {
  const x  = df / (df + t * t);
  const a  = df / 2;
  const b  = 0.5;
  const ib = incompleteBeta(x, a, b);
  return Math.min(1, ib);
}

function incompleteBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta) / a;
  return front * betaCF(x, a, b);
}

function betaCF(x, a, b) {
  const MAXIT = 100, EPS = 3e-7;
  let qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d; let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function lgamma(z) {
  const c = [76.18009172947146,-86.50532032941677,24.01409824083091,-1.231739572450155,0.1208650973866179e-2,-0.5395239384953e-5];
  let y = z, x = z, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

// ─── Anomaly Detection ─────────────────────────────────────────
function detectAnomalies(rows, columns, stats) {
  const anomalies = [];

  for (const col of columns) {
    const s = stats[col];
    if (s?.type !== "numeric") continue;

    const { mean, std, q1, q3, iqr } = s;
    const lower = q1 - 3 * iqr;
    const upper = q3 + 3 * iqr;

    rows.forEach((row, idx) => {
      const val = parseFloat(row[col]);
      if (!isNaN(val) && (val < lower || val > upper)) {
        const zScore = std > 0 ? Math.abs((val - mean) / std) : 0;
        if (zScore > 3) {
          anomalies.push({
            rowIndex: idx,
            column: col,
            value: val,
            zScore: +zScore.toFixed(2),
            direction: val > mean ? "high" : "low",
          });
        }
      }
    });
  }

  return anomalies.sort((a, b) => b.zScore - a.zScore).slice(0, 20);
}

// ─── Data Quality Report ───────────────────────────────────────
function computeDataQuality(rows, columns, stats) {
  const totalCells = rows.length * columns.length;
  let missingCells = 0;
  let numericCols  = 0;
  let catCols      = 0;
  const issues     = [];

  for (const col of columns) {
    const s = stats[col];
    missingCells += s.missing || 0;

    if (s.type === "numeric") {
      numericCols++;
      if (s.missingPct > 10) issues.push({ col, issue: "high_missing", detail: `${s.missingPct}% missing values` });
      if (s.outlierCount > rows.length * 0.05) issues.push({ col, issue: "many_outliers", detail: `${s.outlierCount} outliers detected` });
      if (Math.abs(s.skewness) > 2) issues.push({ col, issue: "high_skew", detail: `Skewness: ${s.skewness}` });
    } else {
      catCols++;
      if (s.missingPct > 10) issues.push({ col, issue: "high_missing", detail: `${s.missingPct}% missing values` });
      if (s.unique === s.count) issues.push({ col, issue: "all_unique", detail: "All values are unique — may be an ID column" });
      if (s.topFreqPct > 95 && s.unique > 1) issues.push({ col, issue: "low_variance", detail: `${s.topFreqPct}% of rows share the same value` });
    }
  }

  const completeness = +((1 - missingCells / totalCells) * 100).toFixed(1);
  const score = Math.max(0, Math.min(100, completeness - issues.length * 5));

  return { completeness, score: +score.toFixed(1), totalCells, missingCells, numericCols, catCols, issues: issues.slice(0, 10) };
}

// ─── Time Series Detection ─────────────────────────────────────
function detectTimeSeries(rows, columns) {
  const datePatterns = /date|time|year|month|day|period|week|quarter|dt|ts/i;
  const dateCols     = columns.filter(c => datePatterns.test(c));

  const detected = [];
  for (const col of dateCols) {
    const sample = rows.slice(0, 20).map(r => r[col]).filter(Boolean);
    const parseable = sample.filter(v => !isNaN(Date.parse(String(v))));
    if (parseable.length / sample.length > 0.7) {
      detected.push(col);
    }
  }

  return detected;
}

// ─── Build Advanced Claude Prompt ────────────────────────────
function buildPrompt(sheetName, columns, stats, correlations, anomalies, quality, timeCols, sampleRows, question, context) {
  const numericCols = columns.filter(c => stats[c]?.type === "numeric");
  const catCols     = columns.filter(c => stats[c]?.type === "categorical");

  // Slim down stats for prompt — send only key fields
  const statsSlim = {};
  for (const [col, s] of Object.entries(stats)) {
    if (s.type === "numeric") {
      statsSlim[col] = { type: "numeric", count: s.count, mean: s.mean, median: s.median, min: s.min, max: s.max, std: s.std, skewness: s.skewness, outlierCount: s.outlierCount, missingPct: s.missingPct };
    } else {
      statsSlim[col] = { type: "categorical", count: s.count, unique: s.unique, top3: s.top?.slice(0, 3), missingPct: s.missingPct };
    }
  }

  return `You are DashboardX Intelligence Engine — an enterprise-grade AI data analyst used by Fortune 500 companies.

DATASET: "${sheetName}"
ROWS: ${sampleRows.length} (sample) | COLUMNS: ${columns.length}
NUMERIC COLUMNS (${numericCols.length}): ${numericCols.join(", ")}
CATEGORICAL COLUMNS (${catCols.length}): ${catCols.join(", ")}
${timeCols.length > 0 ? `TIME/DATE COLUMNS: ${timeCols.join(", ")}` : ""}
${context ? `DATASET CONTEXT: ${context}` : ""}

DATA QUALITY SCORE: ${quality.score}/100 (Completeness: ${quality.completeness}%)
${quality.issues.length > 0 ? `QUALITY ISSUES: ${quality.issues.map(i => `${i.col}: ${i.detail}`).join(" | ")}` : ""}

STATISTICS:
${JSON.stringify(statsSlim, null, 1)}

TOP CORRELATIONS (Pearson r, p<0.05 marked *):
${correlations.top.map(c => `${c.colA} ↔ ${c.colB}: r=${c.r}${c.significant ? "*" : ""} (n=${c.n})`).join("\n")}

ANOMALIES DETECTED (top by z-score):
${anomalies.slice(0, 8).map(a => `Row ${a.rowIndex}: ${a.column}=${a.value} (z=${a.zScore}, ${a.direction})`).join("\n") || "None detected"}

SAMPLE ROWS (first 5):
${JSON.stringify(sampleRows.slice(0, 5), null, 1)}

USER QUESTION: ${question || "Provide a comprehensive executive-level analysis of this dataset."}

INSTRUCTIONS:
- Be specific — reference actual column names, numbers, and patterns
- Identify business implications, not just statistical observations
- Flag data quality issues that could affect decision-making
- Suggest actionable next steps based on the data
- For correlations, distinguish causation vs correlation clearly
- Use precise statistical language appropriate for an executive audience

Respond ONLY as valid JSON (no markdown, no backticks):
{
  "summary": "<3-4 sentence executive summary — what this data is, what it measures, and the most critical finding>",
  "dataQualityNote": "<1-2 sentences on data reliability and any caveats analysts should know>",
  "insights": [
    {
      "title": "<specific, actionable insight title>",
      "detail": "<2-3 sentences with specific numbers, percentages, and business context>",
      "type": "positive|negative|neutral|warning|critical",
      "metric": "<the key number or stat that drives this insight>",
      "recommendation": "<one specific recommended action>"
    }
  ],
  "variables": [
    {
      "name": "<column name>",
      "explanation": "<what this variable represents in business terms, its distribution characteristics>",
      "notable": "<the most analytically significant observation about this variable>",
      "dataQuality": "<any concerns about this variable's reliability>"
    }
  ],
  "correlations": [
    {
      "pair": "<colA and colB>",
      "strength": "strong|moderate|weak",
      "direction": "positive|negative",
      "businessMeaning": "<what this relationship means in practical terms>",
      "caution": "<any confounding factors or correlation≠causation warnings>"
    }
  ],
  "charts": [
    {
      "type": "bar|line|scatter|pie|histogram",
      "title": "<specific, descriptive chart title>",
      "x": "<column name>",
      "y": "<column name or null>",
      "reason": "<why this visualization reveals important patterns>",
      "expectedInsight": "<what the analyst should look for in this chart>"
    }
  ],
  "anomalies": [
    {
      "description": "<what the anomaly is>",
      "possibleCause": "<likely explanation>",
      "action": "<recommended follow-up>"
    }
  ],
  "nextSteps": [
    "<specific, actionable analytical recommendation>"
  ],
  "conclusion": "<3-4 sentence strategic conclusion summarizing key takeaways, limitations, and recommended decisions>"
}

Provide 4-8 insights, explain the 4-6 most important variables, interpret the top 3 correlations, suggest 3-5 charts, flag 1-3 notable anomalies (if any), and give 3-5 next steps.`;
}

// ─── Claude API Call with Retry ───────────────────────────────
async function callClaude(prompt, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 3000,
          temperature: 0.2,
          system: "You are an expert data analyst. Always respond with valid JSON only — no markdown, no preamble, no backticks.",
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(60000),
      });

      if (!response.ok) {
        const err = await response.text();
        if (response.status === 529 && attempt < retries) {
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        throw new Error(`Claude API error ${response.status}: ${err}`);
      }

      const data = await response.json();
      const raw  = data.content?.map(b => b.text || "").join("") || "";
      const clean = raw.replace(/```json|```/g, "").trim();
      return JSON.parse(clean);

    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

// ─── POST /api/analyze ─────────────────────────────────────────
app.post("/api/analyze", upload.single("file"), async (req, res) => {
  const requestId = req.requestId;

  try {
    // Rate limit
    try {
      await rateLimiter.consume(req.ip || "unknown");
    } catch {
      return res.status(429).json({ error: "Too many requests. Please wait a moment and try again." });
    }

    if (!req.file) return res.status(400).json({ error: "No file uploaded." });

    const question = (req.body.question || "").slice(0, 500);
    const context  = (req.body.context  || "").slice(0, 1000);

    // Cache check
    const cacheKey   = getCacheKey(req.file.buffer, question + context);
    const cachedResult = cacheGet(cacheKey);
    if (cachedResult) {
      console.log(`[${requestId}] Cache hit`);
      return res.json({ ...cachedResult, cached: true });
    }

    // Parse all sheets
    const sheets = parseFile(req.file.buffer, req.file.mimetype, req.file.originalname);
    const primary = sheets[0]; // Analyze primary sheet
    const { sheetName, rows, columns, totalRows } = primary;

    if (rows.length < 2) return res.status(400).json({ error: "Dataset must have at least 2 rows of data." });
    if (columns.length < 1) return res.status(400).json({ error: "No columns detected in the spreadsheet." });

    console.log(`[${requestId}] Analyzing: ${sheetName} — ${totalRows} rows × ${columns.length} cols`);

    // Analytics pipeline
    const stats        = computeStats(rows, columns);
    const corrData     = computeCorrelations(rows, columns, stats);
    const anomalies    = detectAnomalies(rows, columns, stats);
    const quality      = computeDataQuality(rows, columns, stats);
    const timeCols     = detectTimeSeries(rows, columns);

    // Build prompt and call Claude
    const prompt   = buildPrompt(sheetName, columns, stats, corrData, anomalies, quality, timeCols, rows, question, context);
    const analysis = await callClaude(prompt);

    const result = {
      requestId,
      meta: {
        sheetName,
        totalRows,
        columns: columns.length,
        fileName: req.file.originalname,
        fileSize: req.file.size,
        sheets: sheets.map(s => ({ name: s.sheetName, rows: s.totalRows, cols: s.columns.length })),
        analyzedAt: new Date().toISOString(),
      },
      quality,
      stats,
      correlations: corrData.top,
      correlationMatrix: corrData.matrix,
      anomalies,
      timeCols,
      analysis,
      chartData: rows.slice(0, 200),
      columns,
    };

    cacheSet(cacheKey, result);
    res.json(result);

  } catch (err) {
    console.error(`[${requestId}] Error:`, err.message);

    if (err.message.includes("Only Excel")) {
      return res.status(400).json({ error: err.message });
    }
    if (err.message.includes("No data") || err.message.includes("No columns")) {
      return res.status(400).json({ error: err.message });
    }
    if (err.message.includes("Claude API error")) {
      return res.status(502).json({ error: "AI analysis service is temporarily unavailable. Please try again." });
    }

    res.status(500).json({ error: "Analysis failed. Please check your file and try again.", requestId });
  }
});

// ─── GET /api/health ──────────────────────────────────────────
app.get("/api/health", (_, res) => {
  res.json({
    status: "ok",
    version: "2.0.0",
    uptime: process.uptime(),
    cacheSize: cache.size,
    timestamp: new Date().toISOString(),
  });
});

// ─── GET /api/cache/clear ─────────────────────────────────────
app.post("/api/cache/clear", (req, res) => {
  const adminKey = req.headers["x-admin-key"];
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: "Forbidden" });
  }
  cache.clear();
  res.json({ ok: true, message: "Cache cleared." });
});

// ─── 404 Handler ──────────────────────────────────────────────
app.use((_, res) => res.status(404).json({ error: "Route not found." }));

// ─── Global Error Handler ─────────────────────────────────────
app.use((err, _, res, __) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error." });
});

// ─── Graceful Shutdown ────────────────────────────────────────
process.on("SIGTERM", () => {
  console.log("SIGTERM received — shutting down gracefully...");
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`\nDashboardX v2.0 running at http://localhost:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`API Key: ${process.env.ANTHROPIC_API_KEY ? "✓ configured" : "✗ MISSING"}\n`);
});