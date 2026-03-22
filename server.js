import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import * as XLSX from "xlsx";
import officeParser from "officeparser";
import fs from "fs";
import os from "os";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const app        = express();
const PORT       = process.env.PORT || 3000;

const ALLOWED_EXTENSIONS = [
  ".xlsx", ".xls", ".csv",
  ".json",
  ".txt", ".md",
  ".pdf",
  ".pptx", ".ppt",
  ".docx", ".doc",
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.includes(ext)) cb(null, true);
    else cb(new Error(`Unsupported file type: ${ext}`));
  },
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── File type detection ──────────────────────────────────────
function getFileType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if ([".xlsx", ".xls", ".csv"].includes(ext)) return "spreadsheet";
  if (ext === ".json")                          return "json";
  if ([".txt", ".md"].includes(ext))            return "text";
  if (ext === ".pdf")                           return "pdf";
  if ([".pptx", ".ppt"].includes(ext))          return "presentation";
  if ([".docx", ".doc"].includes(ext))          return "document";
  return "unknown";
}

// ─── Parsers ──────────────────────────────────────────────────
function parseSpreadsheet(buffer, filename) {
  const ext      = path.extname(filename).toLowerCase();
  const type     = ext === ".csv" ? "string" : "buffer";
  const input    = ext === ".csv" ? buffer.toString("utf-8") : buffer;
  const workbook = XLSX.read(input, { type });
  const sheetName = workbook.SheetNames[0];
  const sheet    = workbook.Sheets[sheetName];
  const rows     = XLSX.utils.sheet_to_json(sheet, { defval: null });
  const columns  = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { rows, columns, sheetName, totalRows: rows.length, fileType: "spreadsheet", isTabular: true };
}

function flattenObject(obj, prefix = "", result = {}) {
  for (const [key, val] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}.${key}` : key;
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      flattenObject(val, newKey, result);
    } else {
      result[newKey] = Array.isArray(val) ? JSON.stringify(val) : val;
    }
  }
  return result;
}

function parseJSON(buffer) {
  const raw = JSON.parse(buffer.toString("utf-8"));
  let rows = [], columns = [];
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "object") {
    rows    = raw.map(r => (typeof r === "object" ? r : { value: r }));
    columns = [...new Set(rows.flatMap(r => Object.keys(r || {})))];
  } else if (typeof raw === "object" && !Array.isArray(raw)) {
    const flattened = flattenObject(raw);
    rows = [flattened]; columns = Object.keys(flattened);
  } else {
    rows = [{ value: JSON.stringify(raw) }]; columns = ["value"];
  }
  const isTabular = rows.length > 1 && columns.length > 1;
  return {
    rows, columns, sheetName: "JSON", totalRows: rows.length,
    fileType: "json", isTabular,
    rawText: JSON.stringify(raw, null, 2).slice(0, 8000),
  };
}

function parseText(buffer) {
  const text  = buffer.toString("utf-8");
  const lines = text.split("\n").filter(l => l.trim());
  const rows  = lines.map((l, i) => ({ line: i + 1, content: l.trim() }));
  return {
    rows, columns: ["line", "content"], sheetName: "Text",
    totalRows: rows.length, fileType: "text", isTabular: false,
    rawText: text.slice(0, 8000),
  };
}

async function parsePDF(buffer) {
  // Dynamically import pdfjs-dist to avoid ESM issues
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const uint8    = new Uint8Array(buffer);
  const loadTask = pdfjsLib.getDocument({
    data: uint8,
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const pdfDoc  = await loadTask.promise;
  const numPages = pdfDoc.numPages;
  let fullText  = "";

  for (let i = 1; i <= numPages; i++) {
    const page    = await pdfDoc.getPage(i);
    const content = await page.getTextContent();
    fullText += content.items.map(item => item.str).join(" ") + "\n";
  }

  const lines = fullText.split("\n").filter(l => l.trim());
  const rows  = lines.map((l, i) => ({ line: i + 1, content: l.trim() }));
  return {
    rows, columns: ["line", "content"], sheetName: "PDF",
    totalRows: rows.length, fileType: "pdf", isTabular: false,
    rawText: fullText.slice(0, 8000), pages: numPages,
  };
}

async function parseOfficeFile(buffer, filename, fileType) {
  const tmpPath = path.join(os.tmpdir(), `dx_${Date.now()}${path.extname(filename)}`);
  fs.writeFileSync(tmpPath, buffer);
  try {
    const text  = await officeParser.parseOfficeAsync(tmpPath);
    const lines = text.split("\n").filter(l => l.trim());
    const rows  = lines.map((l, i) => ({ line: i + 1, content: l.trim() }));
    return {
      rows, columns: ["line", "content"],
      sheetName: fileType === "presentation" ? "Presentation" : "Document",
      totalRows: rows.length, fileType, isTabular: false,
      rawText: text.slice(0, 8000),
    };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

// ─── Statistics ───────────────────────────────────────────────
function computeStats(rows, columns) {
  const stats = {};
  for (const col of columns) {
    if (col === "line") continue;
    const values  = rows.map(r => r[col]).filter(v => v !== null && v !== "" && v !== undefined);
    const numeric = values.map(Number).filter(v => !isNaN(v));
    if (numeric.length > 0 && numeric.length >= values.length * 0.5) {
      const sorted   = [...numeric].sort((a, b) => a - b);
      const sum      = numeric.reduce((a, b) => a + b, 0);
      const mean     = sum / numeric.length;
      const median   = sorted.length % 2 === 0
        ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        : sorted[Math.floor(sorted.length / 2)];
      const variance = numeric.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / numeric.length;
      stats[col] = {
        type: "numeric", count: numeric.length,
        mean: +mean.toFixed(4), median: +median.toFixed(4),
        min: sorted[0], max: sorted[sorted.length - 1],
        std: +Math.sqrt(variance).toFixed(4),
      };
    } else {
      const unique = [...new Set(values.map(String))];
      stats[col] = { type: "categorical", count: values.length, unique: unique.length, top: unique.slice(0, 5) };
    }
  }
  return stats;
}

function computeCorrelations(rows, columns, stats) {
  const numericCols  = columns.filter(c => stats[c]?.type === "numeric");
  const correlations = [];
  for (let i = 0; i < numericCols.length; i++) {
    for (let j = i + 1; j < numericCols.length; j++) {
      const colA  = numericCols[i], colB = numericCols[j];
      const pairs = rows.map(r => [Number(r[colA]), Number(r[colB])]).filter(([a, b]) => !isNaN(a) && !isNaN(b));
      if (pairs.length < 3) continue;
      const n    = pairs.length;
      const sumA = pairs.reduce((s, [a]) => s + a, 0);
      const sumB = pairs.reduce((s, [, b]) => s + b, 0);
      const sumAB = pairs.reduce((s, [a, b]) => s + a * b, 0);
      const sumA2 = pairs.reduce((s, [a]) => s + a * a, 0);
      const sumB2 = pairs.reduce((s, [, b]) => s + b * b, 0);
      const num  = n * sumAB - sumA * sumB;
      const den  = Math.sqrt((n * sumA2 - sumA ** 2) * (n * sumB2 - sumB ** 2));
      const r    = den === 0 ? 0 : +(num / den).toFixed(4);
      if (Math.abs(r) > 0.3) correlations.push({ colA, colB, r });
    }
  }
  return correlations.sort((a, b) => Math.abs(b.r) - Math.abs(a.r)).slice(0, 10);
}

// ─── Claude Prompts ───────────────────────────────────────────
function buildTabularPrompt(columns, stats, correlations, sampleRows, question) {
  return `You are DashboardX, an expert data analyst. Analyze this dataset.

COLUMNS: ${columns.join(", ")}
STATISTICS: ${JSON.stringify(stats, null, 2)}
TOP CORRELATIONS: ${JSON.stringify(correlations, null, 2)}
SAMPLE ROWS (first 5): ${JSON.stringify(sampleRows.slice(0, 5), null, 2)}

USER QUESTION: ${question || "Give me a full analysis of this dataset."}

Respond ONLY as valid JSON with NO markdown fences:
{
  "summary": "<2-3 sentence overview>",
  "insights": [{ "title": "<title>", "detail": "<detail with numbers>", "type": "positive|negative|neutral|warning" }],
  "variables": [{ "name": "<col>", "explanation": "<what it represents>", "notable": "<observation>" }],
  "charts": [{ "type": "bar|line|scatter|pie", "title": "<title>", "x": "<col>", "y": "<col or null>", "reason": "<why>" }],
  "topics": [],
  "conclusion": "<2-3 sentence conclusion>"
}
Provide 3-6 insights, 3-5 variables, 2-4 charts.`;
}

function buildTextPrompt(fileType, rawText, question) {
  const labels = { pdf: "PDF document", text: "text file", presentation: "PowerPoint presentation", document: "Word document", json: "JSON file" };
  return `You are DashboardX, an expert analyst. Analyze this ${labels[fileType] || "document"}.

CONTENT:
${rawText}

USER QUESTION: ${question || "Analyze this document comprehensively."}

Respond ONLY as valid JSON with NO markdown fences:
{
  "summary": "<2-3 sentence overview>",
  "insights": [{ "title": "<title>", "detail": "<finding>", "type": "positive|negative|neutral|warning" }],
  "variables": [{ "name": "<topic/section>", "explanation": "<what it covers>", "notable": "<observation>" }],
  "charts": [],
  "topics": [{ "name": "<topic>", "summary": "<brief summary>", "importance": "high|medium|low" }],
  "conclusion": "<2-3 sentence conclusion>"
}
Provide 4-7 insights and 3-6 key topics.`;
}

// ─── API ──────────────────────────────────────────────────────
app.post("/api/analyze", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });

    const question = req.body.question || "";
    const fileType = getFileType(req.file.originalname);
    let parsed;

    switch (fileType) {
      case "spreadsheet": parsed = parseSpreadsheet(req.file.buffer, req.file.originalname); break;
      case "json":        parsed = parseJSON(req.file.buffer); break;
      case "text":        parsed = parseText(req.file.buffer); break;
      case "pdf":         parsed = await parsePDF(req.file.buffer); break;
      case "presentation":
      case "document":    parsed = await parseOfficeFile(req.file.buffer, req.file.originalname, fileType); break;
      default:            return res.status(400).json({ error: "Unsupported file type." });
    }

    const { rows, columns, sheetName, totalRows, isTabular, rawText, pages } = parsed;

    if (rows.length === 0 && !rawText) {
      return res.status(400).json({ error: "File appears to be empty or could not be parsed." });
    }

    const stats        = (isTabular && columns.length > 1) ? computeStats(rows, columns) : {};
    const correlations = (isTabular && columns.length > 1) ? computeCorrelations(rows, columns, stats) : [];
    const prompt       = isTabular && columns.length > 1
      ? buildTabularPrompt(columns, stats, correlations, rows, question)
      : buildTextPrompt(fileType, rawText || rows.map(r => r.content).join("\n"), question);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2500,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const aiData   = await response.json();
    const raw      = aiData.content?.map(b => b.text || "").join("") || "";
    const clean    = raw.replace(/```json\n?|```\n?/g, "").trim();
    const analysis = JSON.parse(clean);

    res.json({
      meta: { sheetName, totalRows, columns: columns.length, fileType, isTabular, pages, filename: req.file.originalname, size: req.file.size },
      stats, correlations, analysis,
      chartData: isTabular ? rows.slice(0, 100) : [],
      columns,
      rawText: isTabular ? null : (rawText || "").slice(0, 2000),
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Analysis failed." });
  }
});

app.listen(PORT, () => console.log(`DashboardX running at http://localhost:${PORT}`));