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

const ALLOWED_EXTENSIONS = [".xlsx",".xls",".csv",".json",".txt",".md",".pdf",".pptx",".ppt",".docx",".doc"];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    ALLOWED_EXTENSIONS.includes(ext) ? cb(null, true) : cb(new Error(`Unsupported file type: ${ext}`));
  },
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── File type detection ──────────────────────────────────────
function getFileType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if ([".xlsx",".xls",".csv"].includes(ext)) return "spreadsheet";
  if (ext === ".json")                        return "json";
  if ([".txt",".md"].includes(ext))           return "text";
  if (ext === ".pdf")                         return "pdf";
  if ([".pptx",".ppt"].includes(ext))         return "presentation";
  if ([".docx",".doc"].includes(ext))         return "document";
  return "unknown";
}

// ─── Parsers ──────────────────────────────────────────────────
function parseSpreadsheet(buffer, filename) {
  const ext      = path.extname(filename).toLowerCase();
  const input    = ext === ".csv" ? buffer.toString("utf-8") : buffer;
  const workbook = XLSX.read(input, { type: ext === ".csv" ? "string" : "buffer" });
  const sheetName = workbook.SheetNames[0];
  const rows     = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: null });
  const columns  = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { rows, columns, sheetName, totalRows: rows.length, fileType: "spreadsheet", isTabular: true };
}

function flattenObject(obj, prefix = "", result = {}) {
  for (const [key, val] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}.${key}` : key;
    if (typeof val === "object" && val !== null && !Array.isArray(val)) flattenObject(val, newKey, result);
    else result[newKey] = Array.isArray(val) ? JSON.stringify(val) : val;
  }
  return result;
}

function parseJSON(buffer) {
  const raw = JSON.parse(buffer.toString("utf-8"));
  let rows = [], columns = [];
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "object") {
    rows = raw.map(r => typeof r === "object" ? r : { value: r });
    columns = [...new Set(rows.flatMap(r => Object.keys(r || {})))];
  } else if (typeof raw === "object" && !Array.isArray(raw)) {
    const f = flattenObject(raw); rows = [f]; columns = Object.keys(f);
  } else {
    rows = [{ value: JSON.stringify(raw) }]; columns = ["value"];
  }
  return { rows, columns, sheetName: "JSON", totalRows: rows.length, fileType: "json",
    isTabular: rows.length > 1 && columns.length > 1, rawText: JSON.stringify(raw, null, 2).slice(0, 8000) };
}

function parseText(buffer) {
  const text = buffer.toString("utf-8");
  const lines = text.split("\n").filter(l => l.trim());
  return { rows: lines.map((l, i) => ({ line: i + 1, content: l.trim() })), columns: ["line","content"],
    sheetName: "Text", totalRows: lines.length, fileType: "text", isTabular: false, rawText: text.slice(0, 8000) };
}

async function parsePDF(buffer) {
  const PDFParser = (await import("pdf2json")).default;
  const tmpPath   = path.join(os.tmpdir(), `dx_${Date.now()}.pdf`);
  fs.writeFileSync(tmpPath, buffer);
  return new Promise((resolve, reject) => {
    const parser = new PDFParser(null, 1);
    parser.on("pdfParser_dataError", (err) => {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      reject(new Error("PDF parsing failed: " + err.parserError));
    });
    parser.on("pdfParser_dataReady", () => {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      const fullText = parser.getRawTextContent();
      const lines    = fullText.split("\n").filter(l => l.trim());
      resolve({ rows: lines.map((l, i) => ({ line: i + 1, content: l.trim() })), columns: ["line","content"],
        sheetName: "PDF", totalRows: lines.length, fileType: "pdf", isTabular: false,
        rawText: fullText.slice(0, 8000), pages: parser.data?.Pages?.length || 0 });
    });
    parser.loadPDF(tmpPath);
  });
}

async function parseOfficeFile(buffer, filename, fileType) {
  const tmpPath = path.join(os.tmpdir(), `dx_${Date.now()}${path.extname(filename)}`);
  fs.writeFileSync(tmpPath, buffer);
  try {
    const text  = await officeParser.parseOfficeAsync(tmpPath);
    const lines = text.split("\n").filter(l => l.trim());
    return { rows: lines.map((l, i) => ({ line: i + 1, content: l.trim() })), columns: ["line","content"],
      sheetName: fileType === "presentation" ? "Presentation" : "Document",
      totalRows: lines.length, fileType, isTabular: false, rawText: text.slice(0, 8000) };
  } finally { try { fs.unlinkSync(tmpPath); } catch (_) {} }
}

// ─── Statistics ───────────────────────────────────────────────
function computeStats(rows, columns) {
  const stats = {};
  for (const col of columns) {
    if (col === "line") continue;
    const values  = rows.map(r => r[col]).filter(v => v !== null && v !== "" && v !== undefined);
    const numeric = values.map(Number).filter(v => !isNaN(v));
    if (numeric.length > 0 && numeric.length >= values.length * 0.5) {
      const sorted = [...numeric].sort((a, b) => a - b);
      const sum = numeric.reduce((a, b) => a + b, 0);
      const mean = sum / numeric.length;
      const median = sorted.length % 2 === 0
        ? (sorted[sorted.length/2-1] + sorted[sorted.length/2]) / 2
        : sorted[Math.floor(sorted.length/2)];
      const variance = numeric.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / numeric.length;
      stats[col] = { type:"numeric", count:numeric.length, mean:+mean.toFixed(4), median:+median.toFixed(4),
        min:sorted[0], max:sorted[sorted.length-1], std:+Math.sqrt(variance).toFixed(4) };
    } else {
      const unique = [...new Set(values.map(String))];
      stats[col] = { type:"categorical", count:values.length, unique:unique.length, top:unique.slice(0,5) };
    }
  }
  return stats;
}

function computeCorrelations(rows, columns, stats) {
  const numericCols = columns.filter(c => stats[c]?.type === "numeric");
  const correlations = [];
  for (let i = 0; i < numericCols.length; i++) {
    for (let j = i+1; j < numericCols.length; j++) {
      const colA = numericCols[i], colB = numericCols[j];
      const pairs = rows.map(r => [Number(r[colA]), Number(r[colB])]).filter(([a,b]) => !isNaN(a) && !isNaN(b));
      if (pairs.length < 3) continue;
      const n = pairs.length;
      const sumA = pairs.reduce((s,[a])=>s+a,0), sumB = pairs.reduce((s,[,b])=>s+b,0);
      const sumAB = pairs.reduce((s,[a,b])=>s+a*b,0);
      const sumA2 = pairs.reduce((s,[a])=>s+a*a,0), sumB2 = pairs.reduce((s,[,b])=>s+b*b,0);
      const num = n*sumAB - sumA*sumB;
      const den = Math.sqrt((n*sumA2 - sumA**2)*(n*sumB2 - sumB**2));
      const r = den === 0 ? 0 : +(num/den).toFixed(4);
      if (Math.abs(r) > 0.3) correlations.push({ colA, colB, r });
    }
  }
  return correlations.sort((a,b) => Math.abs(b.r)-Math.abs(a.r)).slice(0,10);
}

// ─── Prompts ──────────────────────────────────────────────────
function buildTabularPrompt(columns, stats, correlations, sampleRows, question) {
  return `You are DashboardX, an expert data analyst. Analyze this dataset.
COLUMNS: ${columns.join(", ")}
STATISTICS: ${JSON.stringify(stats, null, 2)}
TOP CORRELATIONS: ${JSON.stringify(correlations, null, 2)}
SAMPLE ROWS: ${JSON.stringify(sampleRows.slice(0, 5), null, 2)}
USER QUESTION: ${question || "Give me a full analysis."}
Respond ONLY as valid JSON with NO markdown fences:
{"summary":"<2-3 sentence overview>","insights":[{"title":"<title>","detail":"<detail with numbers>","type":"positive|negative|neutral|warning"}],"variables":[{"name":"<col>","explanation":"<what it represents>","notable":"<observation>"}],"charts":[{"type":"bar|line|scatter|pie","title":"<title>","x":"<col>","y":"<col or null>","reason":"<why>"}],"topics":[],"conclusion":"<2-3 sentence conclusion>"}
Provide 3-6 insights, 3-5 variables, 2-4 charts.`;
}

function buildTextPrompt(fileType, rawText, question) {
  const labels = { pdf:"PDF document", text:"text file", presentation:"PowerPoint presentation", document:"Word document", json:"JSON file" };
  return `You are DashboardX, an expert analyst. Analyze this ${labels[fileType]||"document"}.
CONTENT: ${rawText}
USER QUESTION: ${question || "Analyze this document comprehensively."}
Respond ONLY as valid JSON with NO markdown fences:
{"summary":"<2-3 sentence overview>","insights":[{"title":"<title>","detail":"<finding>","type":"positive|negative|neutral|warning"}],"variables":[{"name":"<topic>","explanation":"<what it covers>","notable":"<observation>"}],"charts":[],"topics":[{"name":"<topic>","summary":"<brief summary>","importance":"high|medium|low"}],"conclusion":"<2-3 sentence conclusion>"}
Provide 4-7 insights and 3-6 key topics.`;
}

function buildCrossSummaryPrompt(fileResults, question) {
  const summaries = fileResults.map((r, i) =>
    `FILE ${i+1} — "${r.filename}" (${r.fileType}):\nSummary: ${r.analysis.summary}\nConclusion: ${r.analysis.conclusion}\nTop insights: ${r.analysis.insights.slice(0,3).map(ins => ins.title + ": " + ins.detail).join(" | ")}`
  ).join("\n\n");

  return `You are DashboardX. The user uploaded ${fileResults.length} files and you have analyzed each one individually. Now provide a cross-file synthesis.

INDIVIDUAL ANALYSES:
${summaries}

USER QUESTION: ${question || "What are the key patterns, similarities, and differences across all these files?"}

Respond ONLY as valid JSON with NO markdown fences:
{
  "summary": "<2-3 sentence overview of what all files together represent>",
  "commonThemes": [{"theme":"<theme name>","detail":"<how it appears across files>"}],
  "differences": [{"aspect":"<aspect>","detail":"<how files differ>"}],
  "insights": [{"title":"<cross-file insight>","detail":"<specific observation spanning files>","type":"positive|negative|neutral|warning"}],
  "conclusion": "<3-4 sentence synthesis conclusion with key cross-file takeaways>"
}
Provide 2-4 common themes, 2-3 differences, and 3-5 cross-file insights.`;
}

// ─── Claude call helper ───────────────────────────────────────
async function callClaude(prompt) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type":"application/json", "x-api-key":process.env.ANTHROPIC_API_KEY, "anthropic-version":"2023-06-01" },
    body: JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:2500, messages:[{ role:"user", content:prompt }] }),
  });
  const data  = await response.json();
  const raw   = data.content?.map(b => b.text||"").join("") || "";
  const clean = raw.replace(/```json\n?|```\n?/g, "").trim();
  return JSON.parse(clean);
}

// ─── Parse a single file ──────────────────────────────────────
async function parseFile(file) {
  const fileType = getFileType(file.originalname);
  switch (fileType) {
    case "spreadsheet": return parseSpreadsheet(file.buffer, file.originalname);
    case "json":        return parseJSON(file.buffer);
    case "text":        return parseText(file.buffer);
    case "pdf":         return await parsePDF(file.buffer);
    case "presentation":
    case "document":    return await parseOfficeFile(file.buffer, file.originalname, fileType);
    default:            throw new Error(`Unsupported file type: ${file.originalname}`);
  }
}

// ─── API: single file ─────────────────────────────────────────
app.post("/api/analyze", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    const question = req.body.question || "";
    const parsed   = await parseFile(req.file);
    const { rows, columns, sheetName, totalRows, isTabular, rawText, pages } = parsed;

    if (rows.length === 0 && !rawText) return res.status(400).json({ error: "File appears empty." });

    const stats        = isTabular && columns.length > 1 ? computeStats(rows, columns) : {};
    const correlations = isTabular && columns.length > 1 ? computeCorrelations(rows, columns, stats) : [];
    const prompt       = isTabular && columns.length > 1
      ? buildTabularPrompt(columns, stats, correlations, rows, question)
      : buildTextPrompt(parsed.fileType, rawText || rows.map(r=>r.content).join("\n"), question);

    const analysis = await callClaude(prompt);

    res.json({
      meta: { sheetName, totalRows, columns:columns.length, fileType:parsed.fileType, isTabular, pages, filename:req.file.originalname, size:req.file.size },
      stats, correlations, analysis, chartData:isTabular ? rows.slice(0,100) : [], columns,
      rawText: isTabular ? null : (rawText||"").slice(0,2000),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Analysis failed." });
  }
});

// ─── API: multi-file ──────────────────────────────────────────
app.post("/api/analyze-multi", upload.array("files", 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: "No files uploaded." });
    if (req.files.length > 10) return res.status(400).json({ error: "Maximum 10 files allowed." });

    const question = req.body.question || "";

    // Analyze each file in parallel
    const fileResults = await Promise.all(req.files.map(async (file) => {
      try {
        const parsed = await parseFile(file);
        const { rows, columns, isTabular, rawText } = parsed;

        const stats        = isTabular && columns.length > 1 ? computeStats(rows, columns) : {};
        const correlations = isTabular && columns.length > 1 ? computeCorrelations(rows, columns, stats) : [];
        const prompt       = isTabular && columns.length > 1
          ? buildTabularPrompt(columns, stats, correlations, rows, question)
          : buildTextPrompt(parsed.fileType, rawText || rows.map(r=>r.content).join("\n"), question);

        const analysis = await callClaude(prompt);

        return {
          filename: file.originalname,
          fileType: parsed.fileType,
          meta: { sheetName:parsed.sheetName, totalRows:parsed.totalRows, columns:columns.length,
            fileType:parsed.fileType, isTabular, pages:parsed.pages, filename:file.originalname, size:file.size },
          stats, correlations, analysis,
          chartData: isTabular ? rows.slice(0,100) : [],
          columns,
          rawText: isTabular ? null : (rawText||"").slice(0,2000),
          error: null,
        };
      } catch (err) {
        return { filename: file.originalname, fileType: getFileType(file.originalname), error: err.message, meta:{}, stats:{}, correlations:[], analysis:null, chartData:[], columns:[] };
      }
    }));

    // Cross-file summary (only for successfully analyzed files)
    const successful = fileResults.filter(r => r.analysis !== null);
    let crossSummary = null;
    if (successful.length > 1) {
      try {
        crossSummary = await callClaude(buildCrossSummaryPrompt(successful, question));
      } catch (err) {
        console.error("Cross-summary failed:", err);
      }
    }

    res.json({ files: fileResults, crossSummary, totalFiles: req.files.length, successCount: successful.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Multi-file analysis failed." });
  }
});

app.listen(PORT, () => console.log(`DashboardX running at http://localhost:${PORT}`));