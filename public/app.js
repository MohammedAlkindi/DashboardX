/* ─── DashboardX — Frontend Logic ───────────────────────────── */
const uploadScreen    = document.getElementById("uploadScreen");
const loadingScreen   = document.getElementById("loadingScreen");
const dashboardScreen = document.getElementById("dashboardScreen");
const dropzone        = document.getElementById("dropzone");
const dropzoneIcon    = document.getElementById("dropzoneIcon");
const fileInput       = document.getElementById("fileInput");
const fileListEl      = document.getElementById("fileList");
const questionInput   = document.getElementById("questionInput");
const analyzeBtn      = document.getElementById("analyzeBtn");
const errorBox        = document.getElementById("errorBox");
const resetBtn        = document.getElementById("resetBtn");
const loadingFileCount = document.getElementById("loadingFileCount");

const dashTitle         = document.getElementById("dashTitle");
const dashMeta          = document.getElementById("dashMeta");
const crossSummarySection = document.getElementById("crossSummarySection");
const crossSummaryText  = document.getElementById("crossSummaryText");
const crossGrid         = document.getElementById("crossGrid");
const crossInsights     = document.getElementById("crossInsights");
const crossConclusion   = document.getElementById("crossConclusion");
const fileTabs          = document.getElementById("fileTabs");
const tabsBar           = document.getElementById("tabsBar");
const summaryText       = document.getElementById("summaryText");
const insightsList      = document.getElementById("insightsList");
const varList           = document.getElementById("varList");
const varListTitle      = document.getElementById("varListTitle");
const statGrid          = document.getElementById("statGrid");
const statsSection      = document.getElementById("statsSection");
const chartsGrid        = document.getElementById("chartsGrid");
const chartsSection     = document.getElementById("chartsSection");
const corrSection       = document.getElementById("corrSection");
const corrList          = document.getElementById("corrList");
const conclusionText    = document.getElementById("conclusionText");
const topicsSection     = document.getElementById("topicsSection");
const topicsList        = document.getElementById("topicsList");
const rawTextSection    = document.getElementById("rawTextSection");
const rawTextPreview    = document.getElementById("rawTextPreview");

const steps = [document.getElementById("step1"),document.getElementById("step2"),
               document.getElementById("step3"),document.getElementById("step4")];

const FILE_ICONS = {
  xlsx:"📊",xls:"📊",csv:"📋",json:"🗂️",pdf:"📄",
  pptx:"📑",ppt:"📑",docx:"📝",doc:"📝",txt:"🔤",md:"🔤",
};
const MAX_FILES = 10;

let selectedFiles  = [];
let chartInstances = [];
let allFileResults = [];
let activeTabIdx   = 0;

// ─── File handling ────────────────────────────────────────────
fileInput.addEventListener("change", (e) => handleFiles([...e.target.files]));
dropzone.addEventListener("dragover",  (e) => { e.preventDefault(); dropzone.classList.add("drag-over"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag-over"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault(); dropzone.classList.remove("drag-over");
  handleFiles([...e.dataTransfer.files]);
});

function handleFiles(incoming) {
  const combined = [...selectedFiles];
  for (const f of incoming) {
    if (combined.length >= MAX_FILES) break;
    if (!combined.find(x => x.name === f.name && x.size === f.size)) combined.push(f);
  }
  selectedFiles = combined;
  renderFileList();
}

function renderFileList() {
  if (selectedFiles.length === 0) {
    fileListEl.style.display = "none";
    dropzoneIcon.textContent = "📁";
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = "Analyze with Claude →";
    return;
  }

  dropzoneIcon.textContent = selectedFiles.length === 1
    ? (FILE_ICONS[selectedFiles[0].name.split(".").pop().toLowerCase()] || "📁")
    : "📁";

  fileListEl.style.display = "flex";
  fileListEl.innerHTML = selectedFiles.map((f, i) => {
    const ext  = f.name.split(".").pop().toLowerCase();
    const icon = FILE_ICONS[ext] || "📄";
    const size = f.size > 1024*1024 ? `${(f.size/1024/1024).toFixed(1)}MB` : `${(f.size/1024).toFixed(0)}KB`;
    return `<div class="file-chip">
      <span class="file-chip-icon">${icon}</span>
      <span class="file-chip-name">${f.name}</span>
      <span class="file-chip-size">${size}</span>
      <button class="file-chip-remove" onclick="removeFile(${i})">×</button>
    </div>`;
  }).join("");

  if (selectedFiles.length < MAX_FILES) {
    fileListEl.innerHTML += `<label class="add-more-btn" for="fileInput">+ Add more</label>`;
  }

  analyzeBtn.disabled = false;
  analyzeBtn.textContent = selectedFiles.length === 1
    ? "Analyze with Claude →"
    : `Analyze ${selectedFiles.length} files with Claude →`;
}

function removeFile(idx) {
  selectedFiles.splice(idx, 1);
  fileInput.value = "";
  renderFileList();
}

// ─── Analyze ──────────────────────────────────────────────────
analyzeBtn.addEventListener("click", runAnalysis);
resetBtn.addEventListener("click", resetDashboard);

async function runAnalysis() {
  if (selectedFiles.length === 0) return;
  showScreen("loading");
  hideError();
  animateLoadingSteps();

  const isMulti  = selectedFiles.length > 1;
  const question = questionInput.value.trim();

  if (isMulti) {
    loadingFileCount.textContent = `Analyzing ${selectedFiles.length} files in parallel...`;
  }

  const formData = new FormData();
  formData.append("question", question);

  if (isMulti) {
    selectedFiles.forEach(f => formData.append("files", f));
  } else {
    formData.append("file", selectedFiles[0]);
  }

  try {
    const endpoint = isMulti ? "/api/analyze-multi" : "/api/analyze";
    const response = await fetch(endpoint, { method:"POST", body:formData });
    const data     = await response.json();
    if (!response.ok) throw new Error(data.error || "Analysis failed.");
    await delay(500);

    if (isMulti) {
      renderMultiDashboard(data);
    } else {
      allFileResults = [data];
      renderSingleFile(data, false);
    }
    showScreen("dashboard");
  } catch (err) {
    showScreen("upload");
    showError(err.message);
  }
}

function animateLoadingSteps() {
  steps.forEach(s => s.classList.remove("active"));
  steps[0].classList.add("active");
  [900, 1800, 2700].forEach((d, i) => {
    setTimeout(() => {
      steps[i].classList.remove("active");
      if (steps[i+1]) steps[i+1].classList.add("active");
    }, d);
  });
}

// ─── Multi-file dashboard ─────────────────────────────────────
function renderMultiDashboard(data) {
  const { files, crossSummary, totalFiles, successCount } = data;
  allFileResults = files;

  // Topbar
  dashTitle.textContent = `${totalFiles} File Analysis`;
  dashMeta.innerHTML = `
    <span class="meta-chip">${successCount} ANALYZED</span>
    ${totalFiles - successCount > 0 ? `<span class="meta-chip" style="color:var(--red);">${totalFiles - successCount} FAILED</span>` : ""}
    <span class="meta-chip">CLAUDE SONNET</span>
  `;

  // Cross-file summary
  if (crossSummary && successCount > 1) {
    crossSummarySection.style.display = "";
    crossSummaryText.textContent = crossSummary.summary;

    // Common themes + differences
    crossGrid.innerHTML = "";
    const themes = crossSummary.commonThemes || [];
    const diffs  = crossSummary.differences  || [];

    if (themes.length > 0) {
      const col = document.createElement("div");
      col.innerHTML = `<div class="cross-col-title">🔗 Common Themes</div>` +
        themes.map(t => `<div class="cross-item theme"><strong>${t.theme}</strong><p>${t.detail}</p></div>`).join("");
      crossGrid.appendChild(col);
    }
    if (diffs.length > 0) {
      const col = document.createElement("div");
      col.innerHTML = `<div class="cross-col-title">↔ Key Differences</div>` +
        diffs.map(d => `<div class="cross-item diff"><strong>${d.aspect}</strong><p>${d.detail}</p></div>`).join("");
      crossGrid.appendChild(col);
    }

    // Cross insights
    crossInsights.innerHTML = (crossSummary.insights||[]).map(ins =>
      `<div class="insight-item ${ins.type||"neutral"}" style="margin-bottom:8px;">
        <div class="insight-title">${ins.title}</div>
        <div class="insight-detail">${ins.detail}</div>
      </div>`
    ).join("");

    crossConclusion.textContent = crossSummary.conclusion;
  } else {
    crossSummarySection.style.display = "none";
  }

  // Tabs
  fileTabs.style.display = "";
  tabsBar.innerHTML = files.map((f, i) => {
    const ext  = f.filename.split(".").pop().toLowerCase();
    const icon = FILE_ICONS[ext] || "📄";
    const hasErr = !!f.error;
    return `<button class="tab-btn ${i === 0 ? "active" : ""} ${hasErr ? "tab-error" : ""}"
      onclick="switchTab(${i})">${icon} ${f.filename}${hasErr ? " ⚠" : ""}</button>`;
  }).join("");

  // Render first tab
  activeTabIdx = 0;
  renderSingleFile(files[0], true);
}

function switchTab(idx) {
  activeTabIdx = idx;
  document.querySelectorAll(".tab-btn").forEach((b, i) => b.classList.toggle("active", i === idx));
  chartInstances.forEach(c => c.destroy());
  chartInstances = [];
  renderSingleFile(allFileResults[idx], true);
}

// ─── Single file renderer ─────────────────────────────────────
function renderSingleFile(data, isTabbed) {
  chartInstances.forEach(c => c.destroy());
  chartInstances = [];

  if (data.error) {
    summaryText.textContent = `Failed to analyze this file: ${data.error}`;
    insightsList.innerHTML = "";
    varList.innerHTML = "";
    statsSection.style.display = "none";
    rawTextSection.style.display = "none";
    chartsSection.style.display = "none";
    corrSection.style.display = "none";
    topicsSection.style.display = "none";
    conclusionText.textContent = "";
    return;
  }

  const { meta, stats, correlations, analysis, chartData, columns, rawText } = data;

  if (!isTabbed) {
    const fileTypeLabel = { spreadsheet:"SPREADSHEET",json:"JSON",text:"TEXT FILE",pdf:"PDF",presentation:"POWERPOINT",document:"WORD DOC" }[meta.fileType]||meta.fileType.toUpperCase();
    dashTitle.textContent = meta.filename || "Analysis Complete";
    dashMeta.innerHTML = `
      <span class="meta-chip">${meta.totalRows.toLocaleString()} ${meta.isTabular?"ROWS":"LINES"}</span>
      ${meta.isTabular ? `<span class="meta-chip">${meta.columns} COLUMNS</span>` : ""}
      ${meta.pages    ? `<span class="meta-chip">${meta.pages} PAGES</span>` : ""}
      <span class="meta-chip file-type-chip">${fileTypeLabel}</span>
      <span class="meta-chip">CLAUDE SONNET</span>
    `;
    crossSummarySection.style.display = "none";
    fileTabs.style.display = "none";
  }

  summaryText.textContent = analysis.summary;

  insightsList.innerHTML = (analysis.insights||[]).map(ins => `
    <div class="insight-item ${ins.type||"neutral"}">
      <div class="insight-title">${ins.title}</div>
      <div class="insight-detail">${ins.detail}</div>
    </div>`).join("");

  varListTitle.textContent = meta.isTabular ? "Variable Explanations" : "Key Sections";
  varList.innerHTML = (analysis.variables||[]).map(v => `
    <div class="var-item">
      <div class="var-name">${v.name}</div>
      <div class="var-explanation">${v.explanation}</div>
      <div class="var-notable">→ ${v.notable}</div>
    </div>`).join("");

  const topics = analysis.topics || [];
  if (topics.length > 0) {
    topicsSection.style.display = "";
    topicsList.innerHTML = topics.map(t => `
      <div class="topic-item importance-${t.importance||"medium"}">
        <div class="topic-header">
          <span class="topic-name">${t.name}</span>
          <span class="topic-importance">${t.importance||"medium"}</span>
        </div>
        <div class="topic-summary">${t.summary}</div>
      </div>`).join("");
  } else {
    topicsSection.style.display = "none";
  }

  if (meta.isTabular && Object.keys(stats).length > 0) {
    statsSection.style.display = "";
    rawTextSection.style.display = "none";
    statGrid.innerHTML = Object.entries(stats).map(([col, s]) => {
      if (s.type === "numeric") return `<div class="stat-card">
        <div class="stat-col-name">${col}</div><span class="stat-type-badge numeric">numeric</span>
        ${statRow("mean",s.mean)}${statRow("median",s.median)}${statRow("min",s.min)}${statRow("max",s.max)}${statRow("std",s.std)}${statRow("count",s.count)}
      </div>`;
      return `<div class="stat-card">
        <div class="stat-col-name">${col}</div><span class="stat-type-badge categorical">categorical</span>
        ${statRow("count",s.count)}${statRow("unique",s.unique)}
        <div class="stat-row"><span class="stat-key">top values</span><span class="stat-val" style="font-size:10px;">${(s.top||[]).join(", ")}</span></div>
      </div>`;
    }).join("");
  } else {
    statsSection.style.display = "none";
    if (rawText) { rawTextSection.style.display = ""; rawTextPreview.textContent = rawText; }
    else rawTextSection.style.display = "none";
  }

  if (correlations && correlations.length > 0) {
    corrSection.style.display = "";
    corrList.innerHTML = correlations.map(c => {
      const isPos = c.r >= 0, pct = Math.abs(c.r) * 100;
      return `<div class="corr-item">
        <div class="corr-cols">${c.colA} ↔ ${c.colB}</div>
        <div class="corr-bar-wrap"><div class="corr-bar ${isPos?"positive":"negative"}" style="width:${pct}%"></div></div>
        <div class="corr-val ${isPos?"positive":"negative"}">${c.r>0?"+":""}${c.r}</div>
      </div>`;
    }).join("");
  } else corrSection.style.display = "none";

  const charts = analysis.charts || [];
  if (charts.length > 0 && meta.isTabular) {
    chartsSection.style.display = "";
    chartsGrid.innerHTML = "";
    charts.forEach((spec, idx) => {
      const card = document.createElement("div");
      card.className = "chart-card animate";
      card.style.animationDelay = `${idx * 0.08}s`;
      const canvasId = `chart-${idx}`;
      card.innerHTML = `<div class="chart-title">${spec.title}</div><div class="chart-reason">${spec.reason}</div><canvas id="${canvasId}" class="chart-canvas" height="220"></canvas>`;
      chartsGrid.appendChild(card);
      setTimeout(() => renderChart(canvasId, spec, chartData, stats), 50);
    });
  } else chartsSection.style.display = "none";

  conclusionText.textContent = analysis.conclusion;
}

// ─── Chart rendering ──────────────────────────────────────────
function renderChart(canvasId, spec, data, stats) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const { x: xCol, y: yCol, type } = spec;
  const colors = ["#2563eb","#16a34a","#d97706","#dc2626","#7c3aed","#0891b2"];

  try {
    let cfg;
    if (type === "pie") {
      const counts = {};
      data.forEach(r => { const v = String(r[xCol]??"null"); counts[v]=(counts[v]||0)+1; });
      const labels = Object.keys(counts).slice(0,8);
      cfg = { type:"doughnut", data:{ labels, datasets:[{ data:labels.map(l=>counts[l]), backgroundColor:colors, borderWidth:2, borderColor:"#fff" }] }, options:{ plugins:{legend:{position:"bottom",labels:{font:{size:11},boxWidth:12}}}, responsive:true } };
    } else if (type === "bar") {
      const isNumX = stats[xCol]?.type === "numeric";
      if (isNumX && yCol) {
        const vals = data.map(r=>[Number(r[xCol]),Number(r[yCol])]).filter(([a,b])=>!isNaN(a)&&!isNaN(b));
        const xv = vals.map(([x])=>x), mn=Math.min(...xv), mx=Math.max(...xv), bins=10, step=(mx-mn)/bins;
        const bkts = Array.from({length:bins},(_,i)=>({label:`${(mn+i*step).toFixed(1)}`,sum:0,cnt:0}));
        vals.forEach(([x,y])=>{ const i=Math.min(Math.floor((x-mn)/step),bins-1); bkts[i].sum+=y; bkts[i].cnt++; });
        cfg = { type:"bar", data:{ labels:bkts.map(b=>b.label), datasets:[{label:yCol,data:bkts.map(b=>b.cnt>0?+(b.sum/b.cnt).toFixed(2):0),backgroundColor:"#2563eb22",borderColor:"#2563eb",borderWidth:1.5,borderRadius:4}] }, options:chartOptions(xCol,yCol) };
      } else {
        const counts={};
        data.forEach(r=>{ const v=String(r[xCol]??"null"); counts[v]=(counts[v]||0)+(yCol?Number(r[yCol])||1:1); });
        const sorted=Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,12);
        cfg = { type:"bar", data:{ labels:sorted.map(([k])=>k), datasets:[{label:yCol||"count",data:sorted.map(([,v])=>v),backgroundColor:"#2563eb22",borderColor:"#2563eb",borderWidth:1.5,borderRadius:4}] }, options:chartOptions(xCol,yCol||"count") };
      }
    } else if (type === "scatter" && yCol) {
      const pts=data.map(r=>({x:Number(r[xCol]),y:Number(r[yCol])})).filter(p=>!isNaN(p.x)&&!isNaN(p.y)).slice(0,200);
      cfg = { type:"scatter", data:{ datasets:[{label:`${xCol} vs ${yCol}`,data:pts,backgroundColor:"#2563eb44",borderColor:"#2563eb",borderWidth:1,pointRadius:4}] }, options:chartOptions(xCol,yCol) };
    } else if (type === "line" && yCol) {
      const pts=data.map((r,i)=>({x:i,y:Number(r[yCol])})).filter(p=>!isNaN(p.y)).slice(0,100);
      cfg = { type:"line", data:{ labels:pts.map(p=>p.x), datasets:[{label:yCol,data:pts.map(p=>p.y),borderColor:"#2563eb",backgroundColor:"#2563eb11",borderWidth:2,pointRadius:2,fill:true,tension:0.3}] }, options:chartOptions("index",yCol) };
    }
    if (cfg) chartInstances.push(new Chart(ctx, cfg));
  } catch (e) {
    console.warn("Chart error:", e);
    canvas.parentElement.innerHTML += `<p style="font-size:12px;color:var(--text-3);text-align:center;">Could not render chart.</p>`;
  }
}

function chartOptions(xLabel, yLabel) {
  return { responsive:true, plugins:{legend:{display:false}}, scales:{
    x:{ ticks:{font:{size:10},maxTicksLimit:8}, grid:{color:"#f0ede6"}, title:{display:true,text:xLabel,font:{size:11},color:"#9e9b93"} },
    y:{ ticks:{font:{size:10}}, grid:{color:"#f0ede6"}, title:{display:!!yLabel,text:yLabel||"",font:{size:11},color:"#9e9b93"} },
  }};
}

function statRow(key, val) { return `<div class="stat-row"><span class="stat-key">${key}</span><span class="stat-val">${val}</span></div>`; }

function showScreen(name) {
  uploadScreen.style.display    = name==="upload"    ? "" : "none";
  loadingScreen.style.display   = name==="loading"   ? "" : "none";
  dashboardScreen.style.display = name==="dashboard" ? "" : "none";
}

function showError(msg) { errorBox.textContent=msg; errorBox.style.display=""; }
function hideError()    { errorBox.style.display="none"; errorBox.textContent=""; }

function resetDashboard() {
  selectedFiles=[]; fileInput.value=""; allFileResults=[]; activeTabIdx=0;
  fileListEl.style.display="none"; dropzoneIcon.textContent="📁";
  questionInput.value=""; analyzeBtn.disabled=true;
  analyzeBtn.textContent="Analyze with Claude →";
  chartInstances.forEach(c=>c.destroy()); chartInstances=[];
  hideError(); showScreen("upload");
}

function delay(ms) { return new Promise(r=>setTimeout(r,ms)); }