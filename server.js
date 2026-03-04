import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import * as XLSX from "xlsx";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const app        = express();
const PORT       = process.env.PORT || 3000;
const upload     = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── Parse Excel → JSON ──────────────────────────────────────
function parseExcel(buffer) {
  const workbook  = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  const sheet     = workbook.Sheets[sheetName];
  const rows      = XLSX.utils.sheet_to_json(sheet, { defval: null });
  const columns   = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { rows, columns, sheetName, totalRows: rows.length };
}

// ─── Compute statistics ──────────────────────────────────────
function computeStats(rows, columns) {
  const stats = {};
  for (const col of columns) {
    const values  = rows.map(r => r[col]).filter(v => v !== null && v !== "");
    const numeric = values.map(Number).filter(v => !isNaN(v));

    if (numeric.length > 0) {
      const sorted = [...numeric].sort((a, b) => a - b);
      const sum    = numeric.reduce((a, b) => a + b, 0);
      const mean   = sum / numeric.length;
      const median = sorted.length % 2 === 0
        ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        : sorted[Math.floor(sorted.length / 2)];
      const variance = numeric.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / numeric.length;

      stats[col] = {
        type: "numeric",
        count: numeric.length,
        mean: +mean.toFixed(4),
        median: +median.toFixed(4),
        min: sorted[0],
        max: sorted[sorted.length - 1],
        std: +Math.sqrt(variance).toFixed(4),
      };
    } else {
      const unique = [...new Set(values)];
      stats[col] = {
        type: "categorical",
        count: values.length,
        unique: unique.length,
        top: unique.slice(0, 5),
      };
    }
  }
  return stats;
}

// ─── Compute correlations ─────────────────────────────────────
function computeCorrelations(rows, columns, stats) {
  const numericCols = columns.filter(c => stats[c]?.type === "numeric");
  const correlations = [];

  for (let i = 0; i < numericCols.length; i++) {
    for (let j = i + 1; j < numericCols.length; j++) {
      const colA = numericCols[i];
      const colB = numericCols[j];
      const pairs = rows
        .map(r => [Number(r[colA]), Number(r[colB])])
        .filter(([a, b]) => !isNaN(a) && !isNaN(b));

      if (pairs.length < 3) continue;

      const n   = pairs.length;
      const sumA = pairs.reduce((s, [a]) => s + a, 0);
      const sumB = pairs.reduce((s, [, b]) => s + b, 0);
      const sumAB = pairs.reduce((s, [a, b]) => s + a * b, 0);
      const sumA2 = pairs.reduce((s, [a]) => s + a * a, 0);
      const sumB2 = pairs.reduce((s, [, b]) => s + b * b, 0);
      const num = n * sumAB - sumA * sumB;
      const den = Math.sqrt((n * sumA2 - sumA ** 2) * (n * sumB2 - sumB ** 2));
      const r   = den === 0 ? 0 : +(num / den).toFixed(4);

      if (Math.abs(r) > 0.3) correlations.push({ colA, colB, r });
    }
  }

  return correlations.sort((a, b) => Math.abs(b.r) - Math.abs(a.r)).slice(0, 10);
}

// ─── Build Claude prompt ──────────────────────────────────────
function buildPrompt(columns, stats, correlations, sampleRows, question) {
  const statsStr = JSON.stringify(stats, null, 2);
  const corrStr  = JSON.stringify(correlations, null, 2);
  const sampleStr = JSON.stringify(sampleRows.slice(0, 5), null, 2);

  return `You are DashboardX, an expert data analyst. A user has uploaded a spreadsheet and you must analyze it.

COLUMNS: ${columns.join(", ")}

STATISTICS:
${statsStr}

TOP CORRELATIONS:
${corrStr}

SAMPLE ROWS (first 5):
${sampleStr}

USER QUESTION: ${question || "Give me a full analysis of this dataset."}

Respond ONLY as valid JSON with this exact shape:
{
  "summary": "<2-3 sentence plain English overview of what this dataset contains and represents>",
  "insights": [
    { "title": "<short insight title>", "detail": "<1-2 sentence explanation with specific numbers>", "type": "positive|negative|neutral|warning" }
  ],
  "variables": [
    { "name": "<column name>", "explanation": "<what this variable likely represents and its characteristics>", "notable": "<one notable observation>" }
  ],
  "charts": [
    { "type": "bar|line|scatter|pie", "title": "<chart title>", "x": "<column name for x axis>", "y": "<column name for y axis or null>", "reason": "<why this chart is useful>" }
  ],
  "conclusion": "<2-3 sentence analytical conclusion with key takeaways>"
}

Provide 3-6 insights, explain the 3-5 most important variables, and suggest 2-4 charts. Be specific with numbers from the statistics.`;
}

// ─── API: Upload + Analyze ────────────────────────────────────
app.post("/api/analyze", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });

    const question = req.body.question || "";
    const { rows, columns, sheetName, totalRows } = parseExcel(req.file.buffer);

    if (rows.length === 0) return res.status(400).json({ error: "Spreadsheet appears to be empty." });

    const stats        = computeStats(rows, columns);
    const correlations = computeCorrelations(rows, columns, stats);
    const prompt       = buildPrompt(columns, stats, correlations, rows, question);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data  = await response.json();
    const raw   = data.content?.map(b => b.text || "").join("") || "";
    const clean = raw.replace(/```json|```/g, "").trim();
    const analysis = JSON.parse(clean);

    res.json({
      meta: { sheetName, totalRows, columns: columns.length },
      stats,
      correlations,
      analysis,
      // Send back sample data for chart rendering
      chartData: rows.slice(0, 100),
      columns,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Analysis failed. Check your file and try again." });
  }
});

app.listen(PORT, () => console.log(`DashboardX running at http://localhost:${PORT}`));