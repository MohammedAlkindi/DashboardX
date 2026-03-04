/* ─── DashboardX — Frontend Logic ───────────────────────────── */
const uploadScreen   = document.getElementById("uploadScreen");
const loadingScreen  = document.getElementById("loadingScreen");
const dashboardScreen = document.getElementById("dashboardScreen");
const dropzone       = document.getElementById("dropzone");
const fileInput      = document.getElementById("fileInput");
const fileNameDisplay = document.getElementById("fileNameDisplay");
const questionInput  = document.getElementById("questionInput");
const analyzeBtn     = document.getElementById("analyzeBtn");
const errorBox       = document.getElementById("errorBox");
const resetBtn       = document.getElementById("resetBtn");

// Dashboard elements
const dashTitle      = document.getElementById("dashTitle");
const dashMeta       = document.getElementById("dashMeta");
const summaryText    = document.getElementById("summaryText");
const insightsList   = document.getElementById("insightsList");
const varList        = document.getElementById("varList");
const statGrid       = document.getElementById("statGrid");
const chartsGrid     = document.getElementById("chartsGrid");
const corrSection    = document.getElementById("corrSection");
const corrList       = document.getElementById("corrList");
const conclusionText = document.getElementById("conclusionText");

// Loading steps
const steps = [
  document.getElementById("step1"),
  document.getElementById("step2"),
  document.getElementById("step3"),
  document.getElementById("step4"),
];

let selectedFile = null;
let chartInstances = [];

// ─── File handling ────────────────────────────────────────────
fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) selectFile(file);
});

dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("drag-over");
});

dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag-over"));

dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  if (file) selectFile(file);
});

function selectFile(file) {
  selectedFile = file;
  fileNameDisplay.textContent = file.name;
  fileNameDisplay.style.display = "inline-block";
  analyzeBtn.disabled = false;
  hideError();
}

// ─── Analyze ──────────────────────────────────────────────────
analyzeBtn.addEventListener("click", runAnalysis);
resetBtn.addEventListener("click", resetDashboard);

async function runAnalysis() {
  if (!selectedFile) return;

  showScreen("loading");
  hideError();
  animateLoadingSteps();

  const formData = new FormData();
  formData.append("file", selectedFile);
  formData.append("question", questionInput.value.trim());

  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      body: formData,
    });

    const data = await response.json();

    if (!response.ok) throw new Error(data.error || "Analysis failed.");

    await delay(500); // Let final step show
    renderDashboard(data);
    showScreen("dashboard");

  } catch (err) {
    showScreen("upload");
    showError(err.message);
  }
}

// ─── Loading animation ────────────────────────────────────────
function animateLoadingSteps() {
  steps.forEach(s => s.classList.remove("active"));
  steps[0].classList.add("active");

  const delays = [800, 1600, 2400];
  delays.forEach((d, i) => {
    setTimeout(() => {
      steps[i].classList.remove("active");
      if (steps[i + 1]) steps[i + 1].classList.add("active");
    }, d);
  });
}

// ─── Render dashboard ─────────────────────────────────────────
function renderDashboard(data) {
  const { meta, stats, correlations, analysis, chartData, columns } = data;

  // Destroy old charts
  chartInstances.forEach(c => c.destroy());
  chartInstances = [];

  // Meta
  dashTitle.textContent = meta.sheetName || "Analysis Complete";
  dashMeta.innerHTML = `
    <span class="meta-chip">${meta.totalRows.toLocaleString()} ROWS</span>
    <span class="meta-chip">${meta.columns} COLUMNS</span>
    <span class="meta-chip">CLAUDE SONNET</span>
  `;

  // Summary
  summaryText.textContent = analysis.summary;

  // Insights
  insightsList.innerHTML = "";
  (analysis.insights || []).forEach(ins => {
    const div = document.createElement("div");
    div.className = `insight-item ${ins.type || "neutral"}`;
    div.innerHTML = `
      <div class="insight-title">${ins.title}</div>
      <div class="insight-detail">${ins.detail}</div>
    `;
    insightsList.appendChild(div);
  });

  // Variables
  varList.innerHTML = "";
  (analysis.variables || []).forEach(v => {
    const div = document.createElement("div");
    div.className = "var-item";
    div.innerHTML = `
      <div class="var-name">${v.name}</div>
      <div class="var-explanation">${v.explanation}</div>
      <div class="var-notable">→ ${v.notable}</div>
    `;
    varList.appendChild(div);
  });

  // Statistics
  statGrid.innerHTML = "";
  Object.entries(stats).forEach(([col, s]) => {
    const card = document.createElement("div");
    card.className = "stat-card";

    if (s.type === "numeric") {
      card.innerHTML = `
        <div class="stat-col-name">${col}</div>
        <span class="stat-type-badge numeric">numeric</span>
        ${statRow("mean",   s.mean)}
        ${statRow("median", s.median)}
        ${statRow("min",    s.min)}
        ${statRow("max",    s.max)}
        ${statRow("std",    s.std)}
        ${statRow("count",  s.count)}
      `;
    } else {
      card.innerHTML = `
        <div class="stat-col-name">${col}</div>
        <span class="stat-type-badge categorical">categorical</span>
        ${statRow("count",  s.count)}
        ${statRow("unique", s.unique)}
        <div class="stat-row"><span class="stat-key">top values</span><span class="stat-val" style="font-size:10px;max-width:90px;overflow:hidden;text-overflow:ellipsis;">${(s.top || []).join(", ")}</span></div>
      `;
    }
    statGrid.appendChild(card);
  });

  // Correlations
  if (correlations && correlations.length > 0) {
    corrSection.style.display = "";
    corrList.innerHTML = "";
    correlations.forEach(c => {
      const isPos = c.r >= 0;
      const pct   = Math.abs(c.r) * 100;
      const div   = document.createElement("div");
      div.className = "corr-item";
      div.innerHTML = `
        <div class="corr-cols">${c.colA} ↔ ${c.colB}</div>
        <div class="corr-bar-wrap">
          <div class="corr-bar ${isPos ? "positive" : "negative"}" style="width:${pct}%"></div>
        </div>
        <div class="corr-val ${isPos ? "positive" : "negative"}">${c.r > 0 ? "+" : ""}${c.r}</div>
      `;
      corrList.appendChild(div);
    });
  }

  // Charts
  chartsGrid.innerHTML = "";
  (analysis.charts || []).forEach((chartSpec, idx) => {
    const card = document.createElement("div");
    card.className = "chart-card animate";
    card.style.animationDelay = `${idx * 0.08}s`;

    const canvasId = `chart-${idx}`;
    card.innerHTML = `
      <div class="chart-title">${chartSpec.title}</div>
      <div class="chart-reason">${chartSpec.reason}</div>
      <canvas id="${canvasId}" class="chart-canvas" height="220"></canvas>
    `;
    chartsGrid.appendChild(card);

    // Render chart after DOM insertion
    setTimeout(() => renderChart(canvasId, chartSpec, chartData, stats), 50);
  });

  // Conclusion
  conclusionText.textContent = analysis.conclusion;
}

// ─── Chart rendering ──────────────────────────────────────────
function renderChart(canvasId, spec, data, stats) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const ctx    = canvas.getContext("2d");
  const xCol   = spec.x;
  const yCol   = spec.y;
  const type   = spec.type;
  const colors = ["#2563eb","#16a34a","#d97706","#dc2626","#7c3aed","#0891b2"];

  try {
    let chartConfig;

    if (type === "pie") {
      // Count values for categorical column
      const counts = {};
      data.forEach(row => {
        const val = String(row[xCol] ?? "null");
        counts[val] = (counts[val] || 0) + 1;
      });
      const labels = Object.keys(counts).slice(0, 8);
      const values = labels.map(l => counts[l]);

      chartConfig = {
        type: "doughnut",
        data: {
          labels,
          datasets: [{ data: values, backgroundColor: colors, borderWidth: 2, borderColor: "#fff" }],
        },
        options: {
          plugins: { legend: { position: "bottom", labels: { font: { size: 11 }, boxWidth: 12 } } },
          responsive: true,
        },
      };

    } else if (type === "bar") {
      const isNumericX = stats[xCol]?.type === "numeric";

      if (isNumericX && yCol) {
        // Bucket numeric x into bins
        const vals = data.map(r => [Number(r[xCol]), Number(r[yCol])]).filter(([a, b]) => !isNaN(a) && !isNaN(b));
        const xVals = vals.map(([x]) => x);
        const min = Math.min(...xVals), max = Math.max(...xVals);
        const bins = 10;
        const step = (max - min) / bins;
        const buckets = Array.from({ length: bins }, (_, i) => ({ label: `${(min + i * step).toFixed(1)}`, sum: 0, count: 0 }));
        vals.forEach(([x, y]) => {
          const i = Math.min(Math.floor((x - min) / step), bins - 1);
          buckets[i].sum += y;
          buckets[i].count++;
        });
        chartConfig = {
          type: "bar",
          data: {
            labels: buckets.map(b => b.label),
            datasets: [{
              label: yCol,
              data: buckets.map(b => b.count > 0 ? +(b.sum / b.count).toFixed(2) : 0),
              backgroundColor: "#2563eb22",
              borderColor: "#2563eb",
              borderWidth: 1.5,
              borderRadius: 4,
            }],
          },
          options: chartOptions(xCol, yCol),
        };
      } else {
        // Categorical bar
        const counts = {};
        data.forEach(row => {
          const val = String(row[xCol] ?? "null");
          counts[val] = (counts[val] || 0) + (yCol ? Number(row[yCol]) || 1 : 1);
        });
        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12);
        chartConfig = {
          type: "bar",
          data: {
            labels: sorted.map(([k]) => k),
            datasets: [{
              label: yCol || "count",
              data: sorted.map(([, v]) => v),
              backgroundColor: "#2563eb22",
              borderColor: "#2563eb",
              borderWidth: 1.5,
              borderRadius: 4,
            }],
          },
          options: chartOptions(xCol, yCol || "count"),
        };
      }

    } else if (type === "scatter" && yCol) {
      const pts = data
        .map(r => ({ x: Number(r[xCol]), y: Number(r[yCol]) }))
        .filter(p => !isNaN(p.x) && !isNaN(p.y))
        .slice(0, 200);

      chartConfig = {
        type: "scatter",
        data: {
          datasets: [{
            label: `${xCol} vs ${yCol}`,
            data: pts,
            backgroundColor: "#2563eb44",
            borderColor: "#2563eb",
            borderWidth: 1,
            pointRadius: 4,
          }],
        },
        options: chartOptions(xCol, yCol),
      };

    } else if (type === "line" && yCol) {
      const pts = data
        .map((r, i) => ({ x: i, y: Number(r[yCol]) }))
        .filter(p => !isNaN(p.y))
        .slice(0, 100);

      chartConfig = {
        type: "line",
        data: {
          labels: pts.map(p => p.x),
          datasets: [{
            label: yCol,
            data: pts.map(p => p.y),
            borderColor: "#2563eb",
            backgroundColor: "#2563eb11",
            borderWidth: 2,
            pointRadius: 2,
            fill: true,
            tension: 0.3,
          }],
        },
        options: chartOptions("index", yCol),
      };
    }

    if (chartConfig) {
      const instance = new Chart(ctx, chartConfig);
      chartInstances.push(instance);
    }

  } catch (e) {
    console.warn("Chart render error:", e);
    canvas.parentElement.innerHTML += `<p style="font-size:12px;color:var(--text-3);text-align:center;">Could not render chart for this data shape.</p>`;
  }
}

function chartOptions(xLabel, yLabel) {
  return {
    responsive: true,
    plugins: {
      legend: { display: false },
    },
    scales: {
      x: {
        ticks: { font: { size: 10 }, maxTicksLimit: 8 },
        grid: { color: "#f0ede6" },
        title: { display: true, text: xLabel, font: { size: 11 }, color: "#9e9b93" },
      },
      y: {
        ticks: { font: { size: 10 } },
        grid: { color: "#f0ede6" },
        title: { display: !!yLabel, text: yLabel || "", font: { size: 11 }, color: "#9e9b93" },
      },
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────
function statRow(key, val) {
  return `<div class="stat-row"><span class="stat-key">${key}</span><span class="stat-val">${val}</span></div>`;
}

function showScreen(name) {
  uploadScreen.style.display    = name === "upload"    ? "" : "none";
  loadingScreen.style.display   = name === "loading"   ? "" : "none";
  dashboardScreen.style.display = name === "dashboard" ? "" : "none";
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.style.display = "";
}

function hideError() {
  errorBox.style.display = "none";
  errorBox.textContent = "";
}

function resetDashboard() {
  selectedFile = null;
  fileInput.value = "";
  fileNameDisplay.style.display = "none";
  questionInput.value = "";
  analyzeBtn.disabled = true;
  chartInstances.forEach(c => c.destroy());
  chartInstances = [];
  hideError();
  showScreen("upload");
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }