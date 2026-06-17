import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore, collection, addDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── Firebase setup (outside component so it's only initialized once) ──
const firebaseConfig = {
  apiKey: "AIzaSyDuefs2xnxDA6hBPc7I9Eog5ruidFJy-Rk",
  authDomain: "ai-confidence-study.firebaseapp.com",
  projectId: "ai-confidence-study",
  storageBucket: "ai-confidence-study.firebasestorage.app",
  messagingSenderId: "884663245000",
  appId: "1:884663245000:web:1d2a6b70ebc47137f7adfd",
  measurementId: "G-X8B2QV7YS0",
};
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// ── Parsers ──
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = lines[0].split(",").map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(",");
    if (vals.length >= headers.length) {
      const row = {};
      headers.forEach((h, j) => { row[h] = vals[j]?.trim(); });
      rows.push(row);
    }
  }
  return { headers, rows };
}

function parseChromatogramCSV(text) {
  const { rows } = parseCSV(text);
  return rows.map(r => [
    parseFloat(r.t || r.T || r.time || r.Time || Object.values(r)[0]),
    parseFloat(r.Ct || r.ct || r.intensity || r.Intensity || Object.values(r)[1])
  ]).filter(p => !isNaN(p[0]) && !isNaN(p[1]));
}

// Parses the combined explanations JSON produced by
// generate_explanations_from_peaktable.py. Each entry already contains the
// peak's start/end/apex/confidence AND the feature + counterfactual text, so
// we derive both the `peaks` list and the `explanations` list from this
// single file.
//
// Returns: { peaks: [...], explanations: [...] } where the two arrays are
// parallel (peaks[i] corresponds to explanations[i]).
function parseExplanationsJSON(text) {
  try {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) return { peaks: [], explanations: [] };

    const peaks = [];
    const explanations = [];
    arr.forEach((e, i) => {
      const start = typeof e.start_time === "number" ? e.start_time : parseFloat(e.start_time);
      const end = typeof e.end_time === "number" ? e.end_time : parseFloat(e.end_time);
      // Prefer the recomputed apex (the signal max inside the window);
      // fall back to the table-provided apex if recomputed isn't present.
      const apexRaw = e.apex_time_recomputed ?? e.apex_time_table ?? e.apex_time;
      const apex = typeof apexRaw === "number" ? apexRaw : parseFloat(apexRaw);
      if (isNaN(start) || isNaN(end) || isNaN(apex)) return;

      const conf = e.table_confidence_percent ?? e.confidence_percent ?? null;
      peaks.push({
        id: e.peak_id || `det_${i}`,
        apex,
        signal: 0, // not used downstream; kept for shape compatibility
        start,
        end,
        confidence: conf == null ? null : Math.round(conf),
      });

      // Build thresholds object from explicit JSON fields if present,
      // so the ThresholdBar component always has exact values rather
      // than having to re-parse the explanation text.
      const featureText = e.feature_explanation || e.hybrid_explanation || "";
      let thresholds = null;
      if (
        typeof e.prominence_percent_above_threshold === "number" &&
        typeof e.width_percent_above_threshold === "number" &&
        typeof e.height_percent_above_threshold === "number"
      ) {
        thresholds = {
          prominence: e.prominence_percent_above_threshold,
          width:      e.width_percent_above_threshold,
          height:     e.height_percent_above_threshold,
        };
        if (typeof e.snr_percent_above_threshold === "number") {
          thresholds.snr = e.snr_percent_above_threshold;
        }
        if (typeof e.area_percent_above_threshold === "number") {
          thresholds.area = e.area_percent_above_threshold;
        }
      }
      explanations.push({
        feature: featureText,
        counterfactual: e.counterfactual_explanation || "",
        params: null,
        // Pre-parsed threshold margins — used directly by ThresholdBar
        // (falls back to parseThresholdPcts on the feature text if null)
        thresholds,
      });
    });
    return { peaks, explanations };
  } catch {
    return { peaks: [], explanations: [] };
  }
}

function parseGroundTruthJSON(text) {
  try {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) return [];
    return arr.filter(e => typeof e.start === "number" && typeof e.end === "number");
  } catch { return []; }
}

function downsample(data, max = 3000) {
  if (data.length <= max) return data;
  const step = Math.ceil(data.length / max);
  return data.filter((_, i) => i % step === 0);
}

// Nonlinear confidence color: stretches 70–100 range for more visible differentiation
// Maps confidence 0–100 to hue 0–120 (red→green) with power curve
const confHue = c => {
  const t = Math.max(0, Math.min(1, c / 100));
  // Power curve: exponent <1 compresses high end (more color variation near 100)
  const curved = Math.pow(t, 1.8);
  return curved * 120;
};
const confColor = c => `hsl(${confHue(c)}, 75%, 38%)`;
const confBg = c => `hsla(${confHue(c)}, 75%, 38%, 0.12)`;
const fmt = n => n == null ? "—" : Math.abs(n) >= 100 ? n.toFixed(1) : Math.abs(n) >= 10 ? n.toFixed(2) : n.toFixed(3);

// Parse "X% above/below threshold" from feature explanation text
// Returns { prominence, width, height, snr?, area? } where each is a signed number
// (positive = above threshold, negative = below threshold)
// SNR and area are optional — only present when their thresholds were active.
function parseThresholdPcts(featureText) {
  if (!featureText) return null;
  const result = {};
  // Core three criteria (always present)
  const coreParams = ["prominence", "width", "height"];
  for (const p of coreParams) {
    const re = new RegExp(p + "\\s+is\\s+([\\d.]+)%\\s+(above|below)\\s+threshold", "i");
    const m = featureText.match(re);
    if (m) {
      const val = parseFloat(m[1]);
      result[p] = m[2].toLowerCase() === "above" ? val : -val;
    }
  }
  // SNR — labelled as "S/N" in the explanation text
  const snrRe = /S\/N\s+is\s+([\d.]+)%\s+(above|below)\s+threshold/i;
  const snrM = featureText.match(snrRe);
  if (snrM) {
    const val = parseFloat(snrM[1]);
    result.snr = snrM[2].toLowerCase() === "above" ? val : -val;
  }
  // Area
  const areaRe = /area\s+is\s+([\d.]+)%\s+(above|below)\s+threshold/i;
  const areaM = featureText.match(areaRe);
  if (areaM) {
    const val = parseFloat(areaM[1]);
    result.area = areaM[2].toLowerCase() === "above" ? val : -val;
  }
  // Return null only if all three core criteria are missing
  return Object.keys(result).filter(k => ["prominence","width","height"].includes(k)).length === 3 ? result : null;
}

// Threshold bar visualization component
// Renders a horizontal bar with:
// - Center tick mark = threshold
// - Icon positioned left (below threshold) or right (above threshold)
// - Capped at a visual max for very large percentages
function ThresholdBar({ label, pct, width: barWidth = 180 }) {
  // pct is signed: positive = above, negative = below
  // Visual range: clamp to [-200, 200] for display, but show real value in label
  const clampedPct = Math.max(-200, Math.min(200, pct));
  const fraction = clampedPct / 200; // -1 to 1
  const mid = barWidth / 2;
  const iconX = mid + fraction * mid; // 0 to barWidth
  const isAbove = pct >= 0;
  const absVal = Math.abs(pct);

  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
        <span style={{ fontSize: 9, fontWeight: 600, color: "#475569", textTransform: "capitalize" }}>{label}</span>
        <span style={{ fontSize: 9, fontWeight: 600, color: isAbove ? "#059669" : "#dc2626" }}>
          {absVal > 200 ? ">200%" : `${absVal.toFixed(1)}%`} {isAbove ? "above" : "below"}
        </span>
      </div>
      <svg width={barWidth} height={28} style={{ display: "block", overflow: "visible" }}>
        {/* "threshold" label above center tick */}
        <text x={mid} y={8} textAnchor="middle" fontSize={7} fill="#94a3b8">threshold</text>
        {/* Background bar */}
        <rect x={0} y={16} width={barWidth} height={4} rx={2} fill="#e5e7eb" />
        {/* Left half tint (below) */}
        <rect x={0} y={16} width={mid} height={4} rx={2} fill="#fef2f2" style={{ clipPath: `inset(0 ${barWidth - mid}px 0 0)` }} />
        {/* Right half tint (above) */}
        <rect x={mid} y={16} width={mid} height={4} fill="#f0fdf4" />
        {/* Center tick = threshold */}
        <line x1={mid} y1={10} x2={mid} y2={24} stroke="#64748b" strokeWidth={2} />
        {/* Connecting line from center to icon */}
        <line x1={mid} y1={18} x2={iconX} y2={18} stroke={isAbove ? "#059669" : "#dc2626"} strokeWidth={2} />
        {/* Icon at the value position */}
        <circle cx={iconX} cy={18} r={4} fill={isAbove ? "#059669" : "#dc2626"} stroke="#fff" strokeWidth={1} />
        {/* Overflow arrows for clamped values */}
        {pct > 200 && <polygon points={`${barWidth - 1},15 ${barWidth - 1},21 ${barWidth + 4},18`} fill="#059669" />}
        {pct < -200 && <polygon points={`1,15 1,21 -4,18`} fill="#dc2626" />}
      </svg>
    </div>
  );
}
// accuracy metrics removed — recompute from raw logs externally

// Recursively read all files from a dropped folder via File System Access API
async function readDroppedFolder(dataTransfer) {
  const entries = [];
  const items = dataTransfer.items;

  async function readEntry(entry, path) {
    if (entry.isFile) {
      const file = await new Promise(resolve => entry.file(resolve));
      entries.push({ path: path + entry.name, file });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const children = await new Promise((resolve, reject) => {
        const all = [];
        const readBatch = () => {
          reader.readEntries(results => {
            if (results.length === 0) { resolve(all); return; }
            all.push(...results);
            readBatch();
          }, reject);
        };
        readBatch();
      });
      for (const child of children) await readEntry(child, path + entry.name + "/");
    }
  }

  for (let i = 0; i < items.length; i++) {
    const entry = items[i].webkitGetAsEntry?.();
    if (entry) await readEntry(entry, "");
  }
  return entries;
}

// Process files grouped by subfolder.
// fileMap: { "relativePath": "content", ... }
// Paths like "pilot_study_data/12_1_control/12_1_control.csv"
//
// Expected structure (one subfolder per chromatogram):
//   chromatogram_folder/
//     <base>.csv                        — chromatogram data (t, Ct)
//     <base>_explanations.json          — detected peaks + explanations
//     <base>_groundtruthlabels.json     — ground truth peak ranges
//
// The three files within a subfolder are paired by shared base name. If a
// subfolder is missing the explanations or ground truth JSON, the dataset is
// still created but with an empty list for the missing piece.
function processUploadedFiles(fileMap) {
  // Group files by their immediate parent folder
  const folders = {};
  for (const [relPath, content] of Object.entries(fileMap)) {
    const parts = relPath.replace(/\\/g, "/").split("/");
    const fileName = parts[parts.length - 1];

    // Determine folder key: immediate parent of the file
    let folderKey;
    if (parts.length >= 3) {
      folderKey = parts[parts.length - 2];
    } else if (parts.length === 2) {
      folderKey = parts[0];
    } else {
      folderKey = "__root__";
    }

    if (!folders[folderKey]) folders[folderKey] = {};
    folders[folderKey][fileName] = content;
  }

  const folderNames = Object.keys(folders).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (folderNames.length === 0) throw new Error("No files found in the uploaded folder.");

  // If everything is flat (no subfolders), fall back to name-based matching
  if (folderNames.length === 1 && folderNames[0] === "__root__") {
    return processFilesFlat(folders["__root__"]);
  }

  const datasets = [];
  for (const folder of folderNames) {
    if (folder === "__root__") continue; // skip stray files outside subfolders
    const files = folders[folder];
    const fileNames = Object.keys(files);

    // Find chromatogram CSV: has t,Ct columns
    let chromFile = null;
    for (const fn of fileNames) {
      if (!fn.endsWith(".csv")) continue;
      const fl = files[fn].trim().split(/\r?\n/)[0].toLowerCase();
      if (fl.includes(",ct") || fl.includes(",intensity") || fl.startsWith("t,")) {
        chromFile = { name: fn, content: files[fn] };
        break;
      }
    }
    if (!chromFile) continue;

    const data = parseChromatogramCSV(chromFile.content);
    if (data.length === 0) continue;

    // Find ground truth JSON
    let groundTruth = [];
    for (const fn of fileNames) {
      if (!fn.endsWith(".json")) continue;
      const lower = fn.toLowerCase();
      if (lower.includes("groundtruth") || lower.includes("ground_truth") || lower.includes("label")) {
        groundTruth = parseGroundTruthJSON(files[fn]);
        if (groundTruth.length > 0) break;
      }
    }

    // Find explanations JSON (anything ending in _explanations.json, or any
    // remaining JSON that isn't the ground-truth file).
    let peaks = [];
    let explanations = [];
    for (const fn of fileNames) {
      if (!fn.endsWith(".json")) continue;
      const lower = fn.toLowerCase();
      if (lower.includes("groundtruth") || lower.includes("ground_truth") || lower.includes("label")) continue;
      const parsed = parseExplanationsJSON(files[fn]);
      if (parsed.peaks.length > 0) {
        peaks = parsed.peaks;
        explanations = parsed.explanations;
        break;
      }
    }

    datasets.push({ name: `${folder}/${chromFile.name}`, baseName: folder, data, peaks, groundTruth, explanations });
  }

  if (datasets.length === 0) throw new Error("No valid chromatogram subfolders found. Each subfolder should contain a CSV with columns 't' and 'Ct'.");
  return datasets;
}

// Fallback for flat file structures (no subfolders). Pairs each chromatogram
// CSV with its matching _explanations.json and _groundtruthlabels.json by
// base name. No separate peak table is expected.
function processFilesFlat(filesByName) {
  const chromFiles = [];
  const otherFiles = {};
  for (const [name, content] of Object.entries(filesByName)) {
    const fl = content.trim().split(/\r?\n/)[0].toLowerCase();
    if (name.endsWith(".csv") && (fl.includes(",ct") || fl.includes(",intensity") || fl.startsWith("t,"))) {
      chromFiles.push({ name, content });
    } else { otherFiles[name] = content; }
  }
  if (chromFiles.length === 0) throw new Error("No chromatogram CSVs found.");
  chromFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  return chromFiles.map(cf => {
    const baseName = cf.name.replace(/\.csv$/i, "");
    const data = parseChromatogramCSV(cf.content);
    let peaks = [], groundTruth = [], explanations = [];

    for (const suf of ["_groundtruthlabels.json", "_ground_truth.json", "_labels.json"]) {
      if (otherFiles[baseName + suf]) { groundTruth = parseGroundTruthJSON(otherFiles[baseName + suf]); break; }
    }
    for (const suf of ["_explanations.json", "_control.json"]) {
      if (otherFiles[baseName + suf]) {
        const parsed = parseExplanationsJSON(otherFiles[baseName + suf]);
        peaks = parsed.peaks;
        explanations = parsed.explanations;
        break;
      }
    }
    return { name: cf.name, baseName, data, peaks, groundTruth, explanations };
  });
}

// ── Tracker ──
// Central log of everything the participant does. We keep raw event streams
// (not just counters) so that post-hoc analysis can compute any aggregate we
// later decide is interesting without re-running the study.
function createTracker() {
  return {
    sessionStart: Date.now(),

    // ── Counters (legacy, kept for backwards compat) ──
    totalClicks: 0,
    allClickTimestamps: [],     // ms since sessionStart, every click anywhere
    annotationEdits: 0,
    lastActivityTime: Date.now(),
    totalIdleMs: 0,

    // ── Unified interaction log ──────────────────────────────────────────────
    // Every meaningful user action in chronological order. Each entry has:
    //   timeMs        — ms since session start
    //   chromIdx      — which chromatogram was active (0-based)
    //   type          — string event type (see EVENT TYPES below)
    //   peakId        — stable ID of the peak involved (never changes even if apex moves)
    //   peakSpatialIdx— left-to-right rank of the peak at the moment of the event
    //   details       — event-specific payload (see per-type docs below)
    //
    // EVENT TYPES:
    //   "add_peak"         — user clicked "+ Add Peak"; details: { start, apex, end, isAIPeak: false }
    //   "delete_peak"      — user deleted a peak (✕ pill or panel button);
    //                        details: { start, apex, end, confidence, isAIPeak, via: "pill"|"panel" }
    //   "restore_peak"     — user clicked a grayed-out pill to un-delete a peak;
    //                        details: { start, apex, end, confidence, isAIPeak }
    //   "start_drag"       — user began dragging a handle;
    //                        details: { handle: "start"|"apex"|"end", valueAtDragStart,
    //                                   allBoundariesAtStart: { start, apex, end } }
    //   "end_drag"         — user released a handle after dragging;
    //                        details: { handle, from, to, deltaAbs,
    //                                   allBoundariesAfter: { start, apex, end } }
    //   "select_peak"      — user selected a peak via badge, pill, or region click;
    //                        details: { via: "badge"|"pill"|"region"|"fill", start, apex, end }
    //   "chart_click"      — user clicked on the chart background (not a peak, not a handle);
    //                        details: { chartX (data/time units), chartY (signal units),
    //                                   pixelX, pixelY, wasPan: bool }
    //   "zoom"             — viewport domain changed (wheel or pinch);
    //                        details: { domainStart, domainEnd, widthBefore, widthAfter,
    //                                   anchorChartX, direction: "in"|"out" }
    //   "reset_zoom"       — user clicked Reset Zoom button;
    //                        details: { domainBefore: [start, end] }
    //   "pan"              — user finished a pan drag;
    //                        details: { domainBefore: [start,end], domainAfter: [start,end] }
    //   "badge_click"      — user clicked a confidence badge on the chart;
    //                        details: { peakId, confidence, start, apex, end }
    //   "skip_to_surveys"  — user clicked "skip to surveys" early-exit button
    //   "finish_chrom"     — user clicked "Finish & Start Next" or "Finish & Continue to Surveys";
    //                        details: { chromIdx, totalActiveMs, peakCountFinal }
    //   "chrom_start"      — user arrived on a chromatogram (first visit or revisit);
    //                        details: { chromIdx, chromName, timeMs }
    //   "chrom_end"        — user left a chromatogram (navigated away or session ended);
    //                        details: { chromIdx, chromName, timeMs, activeMs }
    //   "survey_nasa_tlx"  — NASA-TLX submitted; details: { responses, overallWorkload, submittedAtMs }
    //   "survey_feedback"  — Feedback survey submitted; details: { responses, submittedAtMs }
    //   "survey_demographics" — Demographics submitted; details: { responses, submittedAtMs }
    interactionLog: [],

    // ── Rich click stream (kept separately for backwards compat) ──
    // Every click captured by the global listener, annotated with what was
    // clicked (via data-track-* attributes walked up from e.target).
    clickLog: [],               // { time, chromIdx, target, peakId?, peakIndex?, x, y }

    // ── Per-chromatogram visit timeline ──
    chromVisits: [],            // { chromIdx, enter, exit? }  (ms since sessionStart)

    // ── Per-chromatogram first-interaction time ──
    firstEditPerChrom: {},      // { [chromIdx]: msSinceSessionStart }

    // ── Hover / deliberation log ──
    hoverLog: [],               // { time, chromIdx, peakId, peakIndex, durationMs, endedInClick }

    // ── Zoom log ──
    zoomLog: [],                // { time, chromIdx, domainStart, domainEnd, width }

    // ── Drag magnitude log ──
    dragLog: [],                // { time, chromIdx, peakId, handle, from, to, deltaAbs }

    // ── Legacy edit log (kept for backwards compat) ──
    editLog: [],                // { type, time, chromIdx, peakId?, peakIndex?, meta? }

    // ── Raw pointer events (pointerdown + pointerup) ──
    // Distinguishes press from release; includes screen coords, chart coords,
    // button identity (0=left,1=mid,2=right), and the UI element targeted.
    pointerEventLog: [],

    // ── Cursor position heatmap — sampled every 500 ms ──
    cursorSampleLog: [],

    // ── Per-chromatogram final state snapshots ──
    // Recorded on "Finish" click: peak list + viewport domain at that moment.
    chromFinalStates: [],

    // ── Periodic annotation snapshots (every 15 s) ──
    // Raw peak list at each snapshot. Lets you reconstruct the annotation
    // trajectory even if individual events were missed.
    // Each entry: { timeMs, chromIdx, peaks: [{ id, start, apex, end, isAIPeak }] }
    annotationSnapshots: [],
  };
}

// Helper used inside AnnotationScreen to push a typed event to T.interactionLog.
// Not a React hook — called imperatively from callbacks.
function pushInteraction(T, type, chromIdx, peakId, peakSpatialIdx, details) {
  T.interactionLog.push({
    timeMs: Date.now() - T.sessionStart,
    chromIdx,
    type,
    peakId: peakId ?? null,
    peakSpatialIdx: peakSpatialIdx ?? null,
    details: details ?? {},
  });
}

// Walk up from an event target looking for a data-track attribute. The nearest
// ancestor with data-track wins. Used by the global click listener so we log
// click TARGETS reliably regardless of how buttons are rendered.
function describeClickTarget(el) {
  let cur = el;
  while (cur && cur !== document.body) {
    if (cur.dataset) {
      if (cur.dataset.track) {
        return {
          target: cur.dataset.track,
          peakId: cur.dataset.peakId || null,
          peakIndex: cur.dataset.peakIndex != null ? parseInt(cur.dataset.peakIndex, 10) : null,
          handle: cur.dataset.handle || null,
        };
      }
    }
    cur = cur.parentElement;
  }
  // Fallback: describe by tag/role so we at least know *something* was clicked.
  if (el && el.tagName) {
    return { target: `raw:${el.tagName.toLowerCase()}`, peakId: null, peakIndex: null, handle: null };
  }
  return { target: "unknown", peakId: null, peakIndex: null, handle: null };
}

// ══════════════════════════════════════════════════════════════════
//  URL-based data loading (GitHub Pages / static hosting)
// ══════════════════════════════════════════════════════════════════
//
// Fetches a manifest.json from the data folder, then fetches each
// dataset's three files (.csv, _explanations.json, _groundtruthlabels.json).
// The manifest is a JSON array of folder names, e.g.:
//   ["12_1_control", "12_1_tiny", "12_2_control", "12_2_tiny"]
//
// Each folder must contain:
//   {folder}/{folder}.csv
//   {folder}/{folder}_explanations.json
//   {folder}/{folder}_groundtruthlabels.json
//
async function loadDatasetsFromURLs(dataBaseUrl) {
  // Normalize base URL — strip trailing slash
  const base = dataBaseUrl.replace(/\/+$/, "");

  // 1. Fetch manifest
  const manifestRes = await fetch(`${base}/manifest.json`);
  if (!manifestRes.ok) throw new Error(`Could not load manifest.json from ${base}/manifest.json (HTTP ${manifestRes.status}). Make sure the file exists in your data folder.`);
  const folders = await manifestRes.json();
  if (!Array.isArray(folders) || folders.length === 0) throw new Error("manifest.json must be a non-empty JSON array of folder names.");

  // 2. Fetch each dataset
  const datasets = [];
  for (const folder of folders) {
    const csvUrl  = `${base}/${folder}/${folder}.csv`;
    const expUrl  = `${base}/${folder}/${folder}_explanations.json`;
    const gtUrl   = `${base}/${folder}/${folder}_groundtruthlabels.json`;

    const [csvRes, expRes, gtRes] = await Promise.all([
      fetch(csvUrl),
      fetch(expUrl).catch(() => null),
      fetch(gtUrl).catch(() => null),
    ]);

    if (!csvRes.ok) throw new Error(`Could not load ${csvUrl} (HTTP ${csvRes.status})`);

    const csvText = await csvRes.text();
    const expText = expRes?.ok ? await expRes.text() : null;
    const gtText  = gtRes?.ok  ? await gtRes.text()  : null;

    const data = parseChromatogramCSV(csvText);
    if (data.length === 0) throw new Error(`${folder}.csv parsed to 0 data points — check the file format.`);

    const { peaks, explanations } = expText ? parseExplanationsJSON(expText) : { peaks: [], explanations: [] };
    const groundTruth = gtText ? parseGroundTruthJSON(gtText) : [];

    datasets.push({ name: `${folder}/${folder}.csv`, baseName: folder, data, peaks, groundTruth, explanations });
  }

  if (datasets.length === 0) throw new Error("No datasets could be loaded from the manifest.");
  return datasets;
}

// ══════════════════════════════════════════════
//  SCREEN 1: Welcome — Name, Viz, File Upload
// ══════════════════════════════════════════════
// Fixed data URL
const DATA_URL = "https://catac0mb.github.io/Peak_Annotator/data";

function WelcomeScreen({ vizMode, onStart }) {
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleStart = async () => {
    if (loading || !vizMode) return;
    setError(null);
    setLoading(true);
    try {
      const datasets = await loadDatasetsFromURLs(DATA_URL);
      const shuffled = [...datasets];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const anonId = "P_" + Date.now().toString(36).toUpperCase() + "_" + Math.random().toString(36).slice(2, 6).toUpperCase();
      onStart({ userName: anonId, vizMode, datasets: shuffled });
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  };

  // Invalid / missing condition in URL — show a clear error rather than a broken page
  if (!vizMode) {
    return (
      <div style={{ fontFamily: "'IBM Plex Sans',system-ui,sans-serif", background: "linear-gradient(160deg,#f0f4ff 0%,#f8f9fb 40%,#faf5ff 100%)", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ maxWidth: 480, width: "100%", padding: 32 }}>
          <div style={{ padding: "24px 28px", background: "#fef2f2", border: "1.5px solid #fca5a5", borderRadius: 14, fontSize: 14, color: "#dc2626", lineHeight: 1.7 }}>
            <div style={{ fontSize: 20, marginBottom: 10 }}>⚠️ Invalid Study Link</div>
            <p style={{ margin: "0 0 10px 0" }}>
              Your study link is missing the required condition parameter. Please return to Prolific and use the exact link provided in the study description.
            </p>
            <p style={{ margin: 0, fontSize: 13, color: "#991b1b" }}>
              If you believe this is an error, contact us at{" "}
              <a href="mailto:jcaitlin@wustl.edu" style={{ color: "#1e40af", fontWeight: 600 }}>jcaitlin@wustl.edu</a>.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "'IBM Plex Sans',system-ui,sans-serif", background: "linear-gradient(160deg,#f0f4ff 0%,#f8f9fb 40%,#faf5ff 100%)", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ maxWidth: 560, width: "100%", padding: 32 }}>

        <h1 style={{ fontSize: 30, fontWeight: 800, color: "#1e293b", marginBottom: 6 }}>Welcome to the Study</h1>
        <p style={{ color: "#64748b", fontSize: 14, marginBottom: 28, lineHeight: 1.6 }}>
          Thank you for participating! Please read the information below before continuing.
        </p>

        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e5e7eb", padding: "24px 28px", marginBottom: 24, boxShadow: "0 2px 12px rgba(0,0,0,.05)" }}>
          <p style={{ margin: "0 0 14px 0", fontSize: 14, color: "#374151", lineHeight: 1.7 }}>
            In this study, you will be annotating chromatogram data. Click the button below to load the study data, and then an <strong>interactive tutorial</strong> will begin automatically.
          </p>
          <div style={{ padding: "14px 18px", background: "#fef3c7", borderRadius: 10, border: "1px solid #fde68a", fontSize: 13, color: "#92400e", lineHeight: 1.6 }}>
            ⚠️ <strong>You may not begin the real task until you have successfully completed all tutorial steps.</strong>
          </div>
        </div>

        {error && (
          <div style={{ padding: "10px 14px", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, fontSize: 12, color: "#dc2626", marginBottom: 14, lineHeight: 1.5 }}>
            {error}
          </div>
        )}

        <button onClick={handleStart} disabled={loading}
          style={{ width: "100%", padding: "16px", borderRadius: 12, border: "none", background: loading ? "#94a3b8" : "#1e40af", color: "#fff", fontSize: 16, fontWeight: 700, cursor: loading ? "not-allowed" : "pointer", letterSpacing: 0.2, boxShadow: loading ? "none" : "0 4px 16px rgba(30,64,175,.3)", transition: "all .15s" }}>
          {loading ? "Loading study data…" : "Click here to load the study data"}
        </button>

      </div>
    </div>
  );
}
// ══════════════════════════════════════════
//  SCREEN 2: Interactive Tutorial (must complete)
// ══════════════════════════════════════════

// Generate a synthetic chromatogram with 3 real peaks + flat region for false positive
function generateTutorialData() {
  const pts = [];
  for (let t = 0; t <= 12; t += 0.02) {
    let y = 5 + Math.sin(t * 0.5) * 1.0 + Math.random() * 0.5; // baseline with gentle drift + noise
    // Peak 1 — large, clear peak centered at t=2.5
    y += 80 * Math.exp(-0.5 * Math.pow((t - 2.5) / 0.35, 2));
    // Peak 2 — medium peak centered at t=5.0 (AI boundaries will be intentionally offset)
    y += 55 * Math.exp(-0.5 * Math.pow((t - 5.0) / 0.40, 2));
    // Peak 3 — smaller but real peak at t=7.5 (the AI will MISS this one)
    y += 35 * Math.exp(-0.5 * Math.pow((t - 7.5) / 0.30, 2));
    // Flat region after t=8.5 with just baseline noise — the AI false-positive will land here
    pts.push([t, y]);
  }
  return pts;
}

// ── Peak validation helpers (adapted from reVISit ChromatogramView) ──
function getTutPeakTolerance(target, toleranceFrac = 0.25, minTol = 0.10, maxTol = 0.60) {
  const w = Math.max(target.end - target.start, 1e-9);
  return Math.max(minTol, Math.min(maxTol, w * toleranceFrac));
}
function isTutWidthReasonable(peak, target, fullRange = 12, maxMult = 5, maxFrac = 0.75) {
  const pw = peak.userEnd - peak.userStart;
  const tw = Math.max(target.end - target.start, 1e-9);
  return pw > 0 && pw <= tw * maxMult && pw <= fullRange * maxFrac;
}

// Ground-truth targets for the three real peaks
const GROUND_TRUTH_PEAKS = [
  { id: "gt1", apex: 2.5, start: 1.4, end: 3.5 },
  { id: "gt2", apex: 5.0, start: 4.2, end: 5.8 },
  { id: "gt3", apex: 7.5, start: 6.9, end: 8.1 },  // the peak the AI misses
];

// AI-detected peaks for tutorial:
// Peak 1: correct detection, but boundaries TOO TIGHT (start/end too close to apex)
// Peak 2: correct detection, good boundaries — leave as is
// Peak 3: FALSE POSITIVE on the flat region around t=9.8 — no real peak here
// NOTE: the AI MISSES the real peak at t=7.5 — user must add it
const TUTORIAL_PEAKS = [
  { id: "tut_1", label: "Peak @ 2.50", apex: 2.5, start: 2.2, end: 2.8, confidence: 95, signal: 85 },
  { id: "tut_2", label: "Peak @ 5.00", apex: 5.0, start: 4.2, end: 5.8, confidence: 68, signal: 60 },
  { id: "tut_3", label: "Peak @ 9.80", apex: 9.8, start: 9.3, end: 10.3, confidence: 28, signal: 7 },
];

const TUTORIAL_EXPLANATIONS = [
  {
    feature: "This peak's prominence is 320.0% above threshold, width is 180.0% above threshold, height is 270.0% above threshold, S/N is 285.0% above threshold, and area is 350.0% above threshold.",
    counterfactual: "If prominence dropped by 76%, this peak would no longer be detected.",
    params: null,
    thresholds: { prominence: 320, width: 180, height: 270, snr: 285, area: 350 },
  },
  {
    feature: "This peak's prominence is 140.0% above threshold, width is 120.0% above threshold, height is 150.0% above threshold, S/N is 85.0% above threshold, and area is 130.0% above threshold.",
    counterfactual: "If width decreased by 55%, this peak would fall below the detection threshold.",
    params: null,
    thresholds: { prominence: 140, width: 120, height: 150, snr: 85, area: 130 },
  },
  {
    feature: "This peak's prominence is 8.0% above threshold, width is 5.0% above threshold, height is 12.0% above threshold, S/N is 55.0% below threshold, and area is 80.0% below threshold.",
    counterfactual: "If prominence dropped by just 8%, this detection would fail. This is a borderline detection.",
    params: null,
    thresholds: { prominence: 8, width: 5, height: 12, snr: -55, area: -80 },
  },
];

function TutorialScreen({ vizMode, onDismiss }) {
  const [step, setStep] = useState(0);
  const [completedSteps, setCompletedSteps] = useState(new Set());

  const isAICondition = vizMode !== "none" && vizMode !== "no_ai";

  // Tutorial chart state
  const tutData = useMemo(() => generateTutorialData(), []);
  const [tutAnnotations, setTutAnnotations] = useState(() =>
    isAICondition
      ? TUTORIAL_PEAKS.map(p => ({ ...p, userStart: p.start, userEnd: p.end, userApex: p.apex, deleted: false }))
      : []
  );
  const [tutDomain, setTutDomain] = useState([0, 12]);
  const [tutSelectedId, setTutSelectedId] = useState(null);
  const [tutHoveredId, setTutHoveredId] = useState(null);
  const tutSvgRef = useRef(null);
  const tutDragRef = useRef(null);
  const [, tutForce] = useState(0);

  // Track specific task completions — reset when the step changes so
  // each step only counts actions taken while it is active.
  const [hasZoomed, setHasZoomed] = useState(false);
  const [hasPanned, setHasPanned] = useState(false);
  const [hasSelectedPeak, setHasSelectedPeak] = useState(false);
  const [hasDragged, setHasDragged] = useState(false);
  const [hasAddedPeak, setHasAddedPeak] = useState(false);
  const [hasDeletedPeak, setHasDeletedPeak] = useState(false);
  const [hasHoveredPeak, setHasHoveredPeak] = useState(false);

  // When the user advances to a new step, reset all per-step flags so
  // previously completed actions don't auto-complete the new step.
  useEffect(() => {
    setHasZoomed(false);
    setHasPanned(false);
    setHasSelectedPeak(false);
    setHasDragged(false);
    setHasAddedPeak(false);
    setHasDeletedPeak(false);
    setHasHoveredPeak(false);
  }, [step]);

  const activeTutPeaks = useMemo(() => tutAnnotations.filter(a => !a.deleted), [tutAnnotations]);
  const showConf = isAICondition && vizMode !== "peaks_only";

  // Dynamic labels: sorted by apex time, so peak numbers update as peaks are added/deleted/moved
  const tutPeaksSorted = useMemo(() => [...activeTutPeaks].sort((a, b) => a.userApex - b.userApex), [activeTutPeaks]);
  const tutPeakLabel = useMemo(() => {
    const m = new Map();
    tutPeaksSorted.forEach((p, i) => m.set(p.id, `Peak @ ${fmt(p.userApex)}`));
    return m;
  }, [tutPeaksSorted]);

  // ── Live validation: Peak 1 boundary correction (AI conditions) ──
  const peak2Validation = useMemo(() => {
    const pk = tutAnnotations.find(a => a.id === "tut_1");
    if (!pk) return { edited: false, apexOk: false, widthOk: false, correct: false, feedback: "" };
    const gt = GROUND_TRUTH_PEAKS[0];
    const tol = getTutPeakTolerance(gt);
    const apexErr = Math.abs(pk.userApex - gt.apex);
    const apexOk = apexErr <= tol;
    const startErr = Math.abs(pk.userStart - gt.start);
    const endErr = Math.abs(pk.userEnd - gt.end);
    const boundsOk = startErr <= tol && endErr <= tol;
    const widthOk = isTutWidthReasonable(pk, gt);
    const moved = Math.abs(pk.userStart - 2.2) > 0.12 || Math.abs(pk.userEnd - 2.8) > 0.12;
    const correct = apexOk && boundsOk && widthOk;

    let feedback = "";
    if (!moved) feedback = "The boundaries are still at the AI's original (too tight) positions. Drag the handles outward to widen them.";
    else if (!widthOk) feedback = "Your peak boundaries are still too narrow. Widen the start and end boundaries.";
    else if (!boundsOk && !apexOk) feedback = "The apex and boundaries are not close enough to the real peak. Keep adjusting.";
    else if (!boundsOk) feedback = "Getting closer! The real peak starts around t\u22481.4 and ends around t\u22483.5.";
    else if (correct) feedback = "Correct! The boundaries now match the real peak.";
    else feedback = "Almost there — keep adjusting the boundaries.";

    return { edited: moved, apexOk, widthOk, boundsOk, correct, feedback };
  }, [tutAnnotations]);

  // ── Live validation: Peak 3 false positive deletion ──
  const falsePositiveDeleted = useMemo(() => {
    const fp = tutAnnotations.find(a => a.id === "tut_3");
    return fp ? fp.deleted : false;
  }, [tutAnnotations]);

  // ── Live validation: AI condition — user adds the missed peak at t≈7.5 ──
  const missedPeakValidation = useMemo(() => {
    if (!isAICondition) return { hasPeak: false, correct: false, feedback: "" };
    const gt = GROUND_TRUTH_PEAKS[2]; // the missed peak at t=7.5
    // user-added peaks don't start with "tut_"
    const userPeaks = activeTutPeaks.filter(p => !p.id.startsWith("tut_"));
    if (userPeaks.length === 0) return { hasPeak: false, correct: false, feedback: "The AI missed a real peak around t\u22487.5. Click \"+ Add Peak\" and place it on that peak." };

    // Find the user peak closest to the target apex
    let best = userPeaks[0];
    for (const p of userPeaks) {
      if (Math.abs(p.userApex - gt.apex) < Math.abs(best.userApex - gt.apex)) best = p;
    }

    const tol = getTutPeakTolerance(gt);
    const apexErr = Math.abs(best.userApex - gt.apex);
    const apexOk = apexErr <= tol;
    const startErr = Math.abs(best.userStart - gt.start);
    const endErr = Math.abs(best.userEnd - gt.end);
    const boundsOk = startErr <= tol && endErr <= tol;
    const widthOk = isTutWidthReasonable(best, gt);
    const correct = apexOk && boundsOk && widthOk;

    let feedback = "";
    if (!apexOk) feedback = "Your peak is not on the missed peak. Move the apex handle closer to t\u22487.5.";
    else if (!widthOk) feedback = "Your tagged peak is too wide. Narrow the boundaries.";
    else if (!boundsOk) feedback = "The apex is in the right spot! Now adjust the start (\u22486.9) and end (\u22488.1) boundaries to fit the peak shape.";
    else if (correct) feedback = "Correct! You found and labeled the peak the AI missed.";
    else feedback = "Almost there — keep adjusting.";

    return { hasPeak: true, correct, feedback };
  }, [isAICondition, activeTutPeaks]);

  // ── Live validation: "none" condition — user-placed peak on Peak 1 ──
  const nonePeakValidation = useMemo(() => {
    if (isAICondition) return { hasPeak: false, correct: false, feedback: "" };
    const gt = GROUND_TRUTH_PEAKS[0]; // Peak 1 at t=2.5
    const userPeaks = activeTutPeaks.filter(p => !p.id.startsWith("tut_"));
    if (userPeaks.length === 0) return { hasPeak: false, correct: false, feedback: "Add a peak using the \"+ Add Peak\" button." };

    // Find the user peak closest to the target apex
    let best = userPeaks[0];
    for (const p of userPeaks) {
      if (Math.abs(p.userApex - gt.apex) < Math.abs(best.userApex - gt.apex)) best = p;
    }

    const tol = getTutPeakTolerance(gt);
    const apexErr = Math.abs(best.userApex - gt.apex);
    const apexOk = apexErr <= tol;
    const startErr = Math.abs(best.userStart - gt.start);
    const endErr = Math.abs(best.userEnd - gt.end);
    const boundsOk = startErr <= tol && endErr <= tol;
    const widthOk = isTutWidthReasonable(best, gt);
    const correct = apexOk && boundsOk && widthOk;

    let feedback = "";
    if (!apexOk) feedback = "That is not the target peak. Move the apex handle closer to t\u22482.5.";
    else if (!widthOk) feedback = "Your tagged peak is too wide. Narrow the boundaries.";
    else if (!boundsOk) feedback = "The apex is on the right peak! Now adjust the start and end boundaries to fit the peak shape (start \u2248 1.4, end \u2248 3.5).";
    else if (correct) feedback = "Correct! Your peak boundaries match the real peak.";
    else feedback = "Almost there — keep adjusting.";

    return { hasPeak: true, correct, feedback };
  }, [isAICondition, activeTutPeaks]);

  // Chart dimensions — full-width matching main annotation screen
  const TW = 1100, TH = 380;
  const tpad = { l: 64, r: 24, t: 24, b: 56 };
  const tPlotW = TW - tpad.l - tpad.r, tPlotH = TH - tpad.t - tpad.b;
  const tHandleY = tpad.t + tPlotH + 22;
  const tYMax = useMemo(() => Math.max(...tutData.map(d => d[1]), 1) * 1.12, [tutData]);

  const txScale = useCallback(v => tpad.l + ((v - tutDomain[0]) / (tutDomain[1] - tutDomain[0] || 1)) * tPlotW, [tutDomain, tPlotW]);
  const txInv = useCallback(px => tutDomain[0] + ((px - tpad.l) / tPlotW) * (tutDomain[1] - tutDomain[0]), [tutDomain, tPlotW]);
  const tyScale = useCallback(v => tpad.t + tPlotH - (v / tYMax) * tPlotH, [tYMax, tPlotH]);

  const tutPathD = useMemo(() => {
    const pts = tutData.filter(d => d[0] >= tutDomain[0] - 0.3 && d[0] <= tutDomain[1] + 0.3);
    if (!pts.length) return "";
    return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${txScale(p[0]).toFixed(1)},${tyScale(p[1]).toFixed(1)}`).join(' ');
  }, [tutData, tutDomain, txScale, tyScale]);

  // getSvgX must apply viewBox→CSS scale so handle drags track the cursor.
  const getSvgX = useCallback(e => {
    const r = tutSvgRef.current?.getBoundingClientRect();
    if (!r) return 0;
    return (e.clientX - r.left) * (TW / r.width);
  }, []);

  // Callback ref attaches wheel listener the moment the tutorial SVG mounts.
  const tutWheelHandlerRef = useRef(null);
  const tutSvgCallbackRef = useCallback(el => {
    if (tutWheelHandlerRef.current && tutSvgRef.current) {
      tutSvgRef.current.removeEventListener('wheel', tutWheelHandlerRef.current);
    }
    tutSvgRef.current = el;
    if (!el) return;
    const handler = (e) => onTutWheelRef.current(e);
    tutWheelHandlerRef.current = handler;
    el.addEventListener('wheel', handler, { passive: false });
  }, []);

  const onTutWheel = useCallback(e => {
    e.preventDefault();
    const r = tutSvgRef.current?.getBoundingClientRect(); if (!r) return;
    const scale = TW / r.width;
    const anchor = txInv((e.clientX - r.left) * scale);
    const factor = e.deltaY > 0 ? 0.82 : 1.22;
    const w = tutDomain[1] - tutDomain[0], nw = Math.max(0.5, Math.min(12, w / factor));
    const a0 = (anchor - tutDomain[0]) / w;
    let a = anchor - a0 * nw, b = a + nw;
    if (a < 0) { a = 0; b = a + nw; } if (b > 12) { b = 12; a = b - nw; }
    setTutDomain([a, b]);
    setHasZoomed(true);
  }, [tutDomain, txInv]);

  // Non-passive wheel listener for tutorial SVG — use stable ref so zoom
  // works immediately without requiring a click first.
  const onTutWheelRef = useRef(onTutWheel);
  useEffect(() => { onTutWheelRef.current = onTutWheel; }, [onTutWheel]);
  const onTutPointerDown = useCallback(e => {
    if (tutDragRef.current?.type === 'handle') return;
    let el = e.target;
    while (el && el !== e.currentTarget) {
      const track = el.dataset?.track;
      if (track && (track.includes('confidence') || track.includes('icon') || track.includes('handle') || track.includes('peak_icon'))) return;
      el = el.parentElement;
    }
    const r = tutSvgRef.current?.getBoundingClientRect();
    const scale = r ? TW / r.width : 1;
    const svgPx = r ? (e.clientX - r.left) * scale : 0;
    const chartX = txInv(svgPx);

    tutDragRef.current = { type: 'pan', startX: e.clientX, startDomain: [...tutDomain], clickChartX: chartX, hasMoved: false };
    tutSvgRef.current?.setPointerCapture(e.pointerId);
  }, [tutDomain, txInv]);

  // Refs for tutorial hot-path scale values
  const tutDomainRef = useRef(tutDomain);
  useEffect(() => { tutDomainRef.current = tutDomain; }, [tutDomain]);
  const txInvRef = useRef(txInv);
  useEffect(() => { txInvRef.current = txInv; }, [txInv]);

  const onTutPointerMove = useCallback(e => {
    const d = tutDragRef.current; if (!d) return;
    const r = tutSvgRef.current?.getBoundingClientRect();
    const viewScale = r ? TW / r.width : 1;

    if (d.type === 'pan') {
      const dx = (e.clientX - d.startX) * viewScale;
      const dD = -(dx / tPlotW) * (d.startDomain[1] - d.startDomain[0]);
      let a = d.startDomain[0] + dD, b = d.startDomain[1] + dD; const w = b - a;
      if (a < 0) { a = 0; b = a + w; } if (b > 12) { b = 12; a = b - w; }
      setTutDomain([a, b]);
      if (Math.abs(dx) > 15) { setHasPanned(true); d.hasMoved = true; }
    }

    if (d.type === 'handle') {
      // Compute txInv inline from live refs
      const dom = tutDomainRef.current;
      const svgX = r ? (e.clientX - r.left) * viewScale : 0;
      const clampedX = Math.max(tpad.l, Math.min(tpad.l + tPlotW, svgX));
      const rawVal = dom[0] + ((clampedX - tpad.l) / tPlotW) * (dom[1] - dom[0]);
      const xVal = rawVal - (d.cursorOffset ?? 0);

      setTutAnnotations(prev => prev.map(a => {
        if (a.id !== d.peakId) return a;
        const u = { ...a };
        if (d.handle === 'start') u.userStart = Math.min(xVal, a.userEnd - 0.05);
        else if (d.handle === 'end') u.userEnd = Math.max(xVal, a.userStart + 0.05);
        else u.userApex = Math.max(a.userStart, Math.min(a.userEnd, xVal));
        return u;
      }));
      tutForce(n => n + 1);
    }
  }, [tPlotW]);

  const onTutPointerUp = useCallback(e => {
    const ds = tutDragRef.current;
    if (ds?.type === 'handle') {
      setHasDragged(true);
    } else if (ds?.type === 'pan' && !ds.hasMoved) {
      // True click — select closest peak by apex
      const chartX = ds.clickChartX;
      if (activeTutPeaks.length > 0) {
        const hit = activeTutPeaks.reduce((a, b) => Math.abs(a.userApex - chartX) <= Math.abs(b.userApex - chartX) ? a : b);
        const nextId = hit.id === tutSelectedId ? null : hit.id;
        setTutSelectedId(nextId);
        setHasSelectedPeak(true);
        if (nextId) { const mid = hit.userApex; const w = tutDomain[1] - tutDomain[0]; setTutDomain([mid - w/2, mid + w/2]); }
      }
    }
    tutDragRef.current = null;
    try { tutSvgRef.current?.releasePointerCapture(e.pointerId); } catch (_) {}
  }, [activeTutPeaks, tutSelectedId, tutDomain]);

  const onTutHandleDown = useCallback((peakId, handle) => e => {
    e.stopPropagation(); e.preventDefault();
    // Record cursor offset relative to handle so drag doesn't snap on first move
    const ann = tutAnnotations.find(a => a.id === peakId);
    const startVal = ann ? (handle === 'start' ? ann.userStart : handle === 'end' ? ann.userEnd : ann.userApex) : null;
    const r = tutSvgRef.current?.getBoundingClientRect();
    const viewScale = r ? TW / r.width : 1;
    const dom = tutDomainRef.current;
    const svgX = r ? (e.clientX - r.left) * viewScale : 0;
    const cursorVal = dom[0] + ((svgX - tpad.l) / tPlotW) * (dom[1] - dom[0]);
    const cursorOffset = startVal != null ? cursorVal - startVal : 0;
    tutDragRef.current = { type: 'handle', peakId, handle, cursorOffset };
    tutSvgRef.current?.setPointerCapture(e.pointerId);
    setTutSelectedId(peakId);
  }, [tutAnnotations, tPlotW]);

  const tutAddPeak = useCallback(() => {
    const mid = (tutDomain[0] + tutDomain[1]) / 2, w = (tutDomain[1] - tutDomain[0]) * 0.05;
    const np = { id: `user_${Date.now()}`, label: `Peak @ ${fmt(mid)}`, apex: mid, signal: 0, start: mid - w, end: mid + w, confidence: null, userStart: mid - w, userEnd: mid + w, userApex: mid, deleted: false };
    setTutAnnotations(prev => [...prev, np]);
    setTutSelectedId(np.id);
    setHasAddedPeak(true);
  }, [tutDomain, tutAnnotations.length]);

  const tutDeletePeak = useCallback(id => {
    setTutAnnotations(prev => prev.map(a => a.id === id ? { ...a, deleted: true } : a));
    if (tutSelectedId === id) setTutSelectedId(null);
    setHasDeletedPeak(true);
  }, [tutSelectedId]);

  // ── Define tutorial steps (condition-specific) ──
  const steps = useMemo(() => {
    const allSteps = [];

    // ── STEP: Welcome (all conditions) ──
    if (isAICondition) {
      allSteps.push({
        title: "Welcome to the Study",
        instruction: vizMode === "peaks_only"
          ? "Welcome, and thank you for participating!\n\nIn this study, you will be shown chromatograms \u2014 graphs that display chemical signal intensity over time. An AI algorithm has already attempted to detect peaks and their boundaries in each chromatogram.\n\nYour job is to review each AI-detected peak region and decide:\n\u2022 Is this actually a real peak, or a false detection?\n\u2022 If it is real, are the detected start and end boundaries correct?\n\nYou may edit a peak's boundaries, delete false detections, or add peaks the AI missed. Below is a practice chromatogram \u2014 complete each step before beginning the real task."
          : "Welcome, and thank you for participating!\n\nIn this study, you will be shown chromatograms \u2014 graphs that display chemical signal intensity over time. An AI algorithm has already attempted to detect peaks in each chromatogram.\n\nYour job is to review each AI-detected peak and decide:\n\u2022 Is this actually a real peak, or a false detection?\n\u2022 If it is a real peak, are the detected start and end boundaries correct?\n\nYou may edit a peak's boundaries if they are wrong, delete false detections, or add peaks the AI missed. Below is a practice chromatogram with 3 AI detections \u2014 one is intentionally wrong. Complete each step of this tutorial before beginning the real task. The tutorial will block you from progressing until you have completed the instructions for each step.",
        task: null,
        isDone: true,
        feedback: null,
      });
    } else {
      allSteps.push({
        title: "Welcome to the Study",
        instruction: "Welcome, and thank you for participating!\n\nIn this study, you will be shown chromatograms — graphs that display chemical signal intensity over time. A peak is a region where the signal rises above the baseline and then returns.\n\nYour job is to find every peak in each chromatogram and label its start (where the signal begins rising), apex (highest point), and end (where the signal returns to baseline).\n\nBelow is a practice chromatogram. Complete each step of this tutorial before beginning the real task. The tutorial will block you from progressing until you have completed the instructions for each step.",
        task: null,
        isDone: true,
        feedback: null,
      });
    }

    // ── STEP: Zoom (all conditions) ──
    allSteps.push({
      title: "Zoom the Chart",
      instruction: "Use your mouse scroll wheel (or trackpad pinch) over the chart to zoom in and out. Try zooming in on one of the peaks now.",
      task: "Scroll to zoom in or out on the chart",
      isDone: hasZoomed,
      feedback: null,
    });

    // ── STEP: Pan (all conditions) ──
    allSteps.push({
      title: "Pan the Chart",
      instruction: "Click and drag on the chart background to pan left or right. Try panning to see different parts of the chromatogram.",
      task: "Click and drag to pan the chart",
      isDone: hasPanned,
      feedback: null,
    });

    if (isAICondition) {
      // ── AI CONDITIONS: review-focused flow ──

      // Confidence icons (only for conditions that show confidence)
      if (vizMode !== "peaks_only") {
        allSteps.push({
          title: "Confidence Icons",
          instruction: "Each AI-detected peak has a colored circle above it showing the algorithm's confidence in that detection:\n\n\u2022 Deep green = very high confidence (90\u2013100%)\n\u2022 Yellow/orange = moderate confidence (40\u201369%)\n\u2022 Red = low confidence (below 40%)\n\nLook at the practice chart: the peak at t\u22482.50 has 95% confidence, the peak at t\u22485.00 has 68%, and the detection at t\u22489.80 has only 28%. Low and moderate-confidence detections are the ones most likely to need your attention.",
          task: null,
          isDone: true,
          feedback: null,
        });
      }

      // Explanation steps
      if (vizMode === "normal_explain") {
        allSteps.push({
          title: "Reading the Explanations",
          instruction: "The peak list is at the bottom of the screen (not a side panel). When you click a peak in that list, an explanation panel appears in the bottom right of the screen showing why the AI detected that peak \u2014 it describes the features (prominence, width, height, signal to noise ratio, and peak area) that contributed to the detection. You may need to scroll down to see the panel.\n\nTry clicking on the detection at t\u22489.80 in the peak list to read why the AI flagged it.",
          task: "Click on a peak to read its explanation",
          isDone: hasHoveredPeak,
          feedback: null,
        });
      }
      if (vizMode === "counterfactual_explain") {
        allSteps.push({
          title: "Reading the Counterfactual Explanations",
          instruction: "The peak list is at the bottom of the screen (not a side panel). When you click a peak in that list, a panel appears in the bottom right of the screen showing a counterfactual explanation \u2014 what would need to change for that detection to fail. For example: \"If the height dropped by just 15%, this peak would fall below the threshold.\" You may need to scroll down to see the panel.\n\nThis reveals each detection's weakest aspect. Try clicking the detection at t\u22489.80 in the peak list to see why it's borderline.",
          task: "Hover over a peak to read its counterfactual explanation",
          isDone: hasHoveredPeak,
          feedback: null,
        });
      }
      if (vizMode === "threshold_bars") {
        allSteps.push({
          title: "Understanding the Five Detection Criteria",
          instruction: "The AI peak-detection algorithm evaluates five properties of every feature of the data. Understanding these will help you assess whether a detection is real:\n\n\u2022 Prominence \u2014 How much a peak \u2018stands out\u2019 above surrounding signal. A prominent peak rises well above its neighbours; a low-prominence bump barely lifts above the baseline. High prominence strongly indicates a real peak.\n\n\u2022 Width \u2014 The horizontal span of the peak at half its height. Very narrow spikes are usually electrical noise or artefacts.\n\n\u2022 Height \u2014 The absolute signal intensity at the peak apex above the baseline. Too-small heights indicate the signal may not have risen meaningfully above background noise.\n\n\u2022 S/N \u2014 Signal-to-Noise Ratio. Measures how large the peak is compared to the random noise fluctuations in the surrounding baseline. A high S/N means the peak is unlikely to be explained by noise alone. Low S/N (e.g., below 2\u20133) suggests the \u2018peak\u2019 could simply be a noise spike.\n\n\u2022 Peak Area \u2014 The total area under the peak curve above the baseline. A real chromatographic peak has meaningful area; a narrow noise spike has near-zero area even if it looks tall.",
          task: null,
          isDone: true,
          feedback: null,
        });
        allSteps.push({
          title: "Reading the Threshold Bars",
          instruction: "The peak list is at the bottom of the screen (not a side panel). When you click a peak in that list, a panel appears in the bottom right of the screen showing five horizontal bars \u2014 one for each criterion above. You may need to scroll down to see these bars.\n\nHow the bars work: the AI algorithm was calibrated on data, and that calibration set a detection threshold for each of the five criteria \u2014 essentially the value a feature must reach for the algorithm to treat it as a peak. The tick mark in the centre of each bar marks that calibrated threshold (the AI parameter for that criterion). Each bar then shows the distance between this particular detected peak\'s own measured quality \u2014 its actual prominence, width, height, S/N, and area \u2014 and the calibrated AI parameter:\n\n\u2022 Green dot to the right \u2192 the peak\'s value is above the threshold \u2014 this criterion supports the detection. The further right, the larger the margin above the AI parameter.\n\u2022 Red dot to the left \u2192 the peak\'s value is below the threshold \u2014 this criterion weakens the detection. The further left, the further the peak falls short of the AI parameter.\n\nKey insight: a detection whose dots sit far to the right on all five bars clears the calibrated thresholds comfortably and is almost certainly a real chromatographic peak. A detection with several dots near the centre or to the left only barely meets (or misses) the AI\'s parameters and is borderline \u2014 look at the signal carefully before accepting it.\n\nLook at the detection at t\u22489.80 \u2014 its S/N and Area bars sit to the left of centre (below threshold), meaning those measured qualities fall short of the calibrated parameters. The algorithm flagged it, but the evidence is weak \u2014 it is likely just baseline noise.\n\nTry clicking on peaks in the peak list at the bottom to see their bars.",
          task: "Click on a peak to see its threshold bars",
          isDone: hasSelectedPeak,
          feedback: null,
        });
      }

      // Select a peak
      allSteps.push({
        title: "Reviewing a Detection",
        instruction: "To review an AI detection, click on its pill in the peak list below the chart. This selects the peak and shows its start, apex, and end boundary lines on the chart, along with draggable handles.\n\nEach pill also has a red \u2715 button \u2014 click it to delete that peak without needing to select it first.\n\nClick on the peak at t\u22482.50 in the peak list to select it.",
        task: "Click a peak pill to select it",
        isDone: hasSelectedPeak,
        feedback: null,
      });

      // Edit boundaries with live validation feedback
      allSteps.push({
        title: "Correcting Peak Boundaries",
        instruction: "The peak at t\u22482.50 is a real peak, but the AI's boundaries are too tight \u2014 the start and end are too close to the apex. When a peak is selected, you'll see three handles below the chart:\n\n\u2022 \u25B6 Start boundary (left-pointing triangle)\n\u2022 \u25C6 Apex position (diamond)\n\u2022 \u25C0 End boundary (right-pointing triangle)\n\nDrag the start handle left and the end handle right to widen the boundaries until the feedback below turns green.",
        task: "Fix the peak at t\u22482.50 \u2014 widen its boundaries to match the real peak",
        isDone: peak2Validation.correct,
        feedback: peak2Validation.feedback,
        feedbackOk: peak2Validation.correct,
      });

      // Delete false positive (Peak 3 at t=9.8 is on a flat region — just noise)
      allSteps.push({
        title: "Deleting a False Detection",
        instruction: "Look at the detection at t\u22489.80" + (vizMode !== "peaks_only" ? " (confidence: 28%)" : "") + " \u2014 it's located in a flat region of the chromatogram with no real signal, just baseline noise. The AI incorrectly flagged a small noise fluctuation as a peak.\n\nWhen you determine that an AI detection is not a real peak, you should delete it. You can delete a peak in two ways:\n\u2022 Click the red \u2715 button on the peak pill in the peak list at the bottom of the screen\n\u2022 Select the peak, then click the \u201cDelete Peak Annotation\u201d button in the action panel on the bottom right\n\nIf you accidentally delete a peak, it stays visible (grayed out) in the list \u2014 click it to restore it.",
        task: "Delete the false detection at t\u22489.80",
        isDone: falsePositiveDeleted,
        feedback: falsePositiveDeleted ? "Correct! You identified and removed the false detection from the flat baseline region." : "The false detection at t\u22489.80 is still present. Click the red \u2715 on its pill to delete it \u2014 notice how the signal there is flat with no real peak shape.",
        feedbackOk: falsePositiveDeleted,
      });

      // Add the missed peak — the AI missed the real peak at t≈7.5
      allSteps.push({
        title: "Adding a Missed Peak",
        instruction: "Look at the chromatogram around t\u22487.5 — there is a real peak there that the AI failed to detect! This happens sometimes, and it's your job to catch these misses.\n\nClick \"+ Add Peak\" in the toolbar, then drag the handles to position the new peak on the bump at t\u22487.5. The real peak runs roughly from t\u22486.9 to t\u22488.1. Adjust until the feedback turns green.",
        task: "Add a peak on the missed bump at t\u22487.5 and position its boundaries correctly",
        isDone: missedPeakValidation.correct,
        feedback: missedPeakValidation.feedback,
        feedbackOk: missedPeakValidation.correct,
      });

    } else {
      // ── NO-VISUALIZATION: manual annotation flow ──

      // Add a peak
      allSteps.push({
        title: "Adding a Peak",
        instruction: "Since there are no pre-loaded detections, you need to find and annotate peaks yourself.\n\nLook at the chart — you can see a tall peak near t\u22482.5. Click the \"+ Add Peak\" button in the toolbar to place a new annotation.",
        task: "Click \"+ Add Peak\" to add a new peak",
        isDone: hasAddedPeak,
        feedback: null,
      });

      // Select — auto-complete if already selected (addPeak auto-selects)
      allSteps.push({
        title: "Select Your Peak",
        instruction: "The peak you just added is already selected — you can see its handles below the chart.\n\nIf it isn't selected, click its pill in the peak list.",
        task: "Select a peak to see its drag handles",
        isDone: hasSelectedPeak || tutSelectedId !== null,
        feedback: null,
      });

      // Adjust with live validation feedback
      allSteps.push({
        title: "Adjusting Peak Boundaries",
        instruction: "With a peak selected, three handles appear below the chart:\n\n\u2022 \u25B6 Start boundary (where the peak begins rising)\n\u2022 \u25C6 Apex (the highest point)\n\u2022 \u25C0 End boundary (where the peak returns to baseline)\n\nDrag the handles to position them on the peak near t\u22482.5 until the feedback below turns green. The real peak runs roughly from t\u22481.4 to t\u22483.5.",
        task: "Place your peak's boundaries on the peak near t\u22482.5",
        isDone: nonePeakValidation.correct,
        feedback: nonePeakValidation.feedback,
        feedbackOk: nonePeakValidation.correct,
      });

      // Delete
      allSteps.push({
        title: "Deleting a Peak",
        instruction: "If you place a peak by mistake or decide a region is not actually a peak, you can delete it in two ways:\n\u2022 Click the red \u2715 button on the peak pill in the peak list at the bottom of the screen\n\u2022 Select the peak, then click the \u201cDelete Peak Annotation\u201d button in the action panel on the bottom right\n\nIf you delete a peak by accident, it stays visible grayed out in the list \u2014 click it to restore it.",
        task: "Delete a peak using the \u2715 button on a pill",
        isDone: hasDeletedPeak,
        feedback: null,
      });
    }

    // ── STEP: Navigation ──
    allSteps.push({
      title: "Moving Between Chromatograms",
      instruction: "When you finish annotating the current chromatogram, click the large blue button below the chart that says \"Finish This Chromatogram & Start Next\" to advance to the next one.\n\nYou cannot go back to a previous chromatogram, so take your time on each one before moving on.",
      task: null,
      isDone: true,
      feedback: null,
    });

    // ── STEP: Final ──
    allSteps.push({
      title: "You're Ready!",
      instruction: isAICondition
        ? "Great job completing the tutorial! To summarize your task:\n\nFor each chromatogram, review every AI-detected peak and ask yourself: \u201cIs this a real peak? Are its boundaries correct?\u201d\n\n\u2022 If the peak is real and boundaries are correct \u2014 leave it as is\n\u2022 If the peak is real but boundaries are wrong \u2014 drag the handles to fix them\n\u2022 If the detection is not a real peak \u2014 click the red \u2715 on its pill to delete it\n\u2022 If the AI missed a real peak \u2014 add it with \u201c+ Add Peak\u201d\n\u2022 Deleted peaks appear grayed out \u2014 click them to restore if needed\n\nWhen you are done with a chromatogram, click the large blue \u201cFinish This Chromatogram & Start Next\u201d button to move on to the next one.\n\n\u26a0\ufe0f IMPORTANT \u2014 YOU DO NOT HAVE TO ANNOTATE EVERY CHROMATOGRAM. There are many chromatograms in this study, and you are not expected to get through all of them. As soon as you no longer want to keep annotating, you should stop and move on to the surveys \u2014 this is completely fine and expected.\n\nTo do that, click the grey button located directly beneath the big blue \u201cFinish This Chromatogram & Start Next\u201d button. It reads \u201cI\u2019m done annotating \u2014 take me to the surveys.\u201d You can click it at any time, after any chromatogram, to jump straight to the surveys.\n\nYou\u2019ll then complete three short surveys. Click \u201cStart Annotating\u201d when you\u2019re ready!"
        : "Great job completing the tutorial! To summarize your task:\n\nFor each chromatogram, find every peak and label its start, apex, and end boundaries using \u201c+ Add Peak\u201d and the drag handles.\n\nA peak is a region where the signal rises clearly above the baseline and then returns. Use zoom and pan to inspect the chromatogram carefully.\n\n\u2022 Use the \u2715 button on a peak pill to delete it, or select it and click Delete Peak Annotation\n\u2022 Deleted peaks appear grayed out \u2014 click them to restore if needed\n\nWhen you are done with a chromatogram, click the large blue \u201cFinish This Chromatogram & Start Next\u201d button to move on to the next one.\n\n\u26a0\ufe0f IMPORTANT \u2014 YOU DO NOT HAVE TO ANNOTATE EVERY CHROMATOGRAM. There are many chromatograms in this study, and you are not expected to get through all of them. As soon as you no longer want to keep annotating, you should stop and move on to the surveys \u2014 this is completely fine and expected.\n\nTo do that, click the grey button located directly beneath the big blue \u201cFinish This Chromatogram & Start Next\u201d button. It reads \u201cI\u2019m done annotating \u2014 take me to the surveys.\u201d You can click it at any time, after any chromatogram, to jump straight to the surveys.\n\nYou\u2019ll then complete three short surveys. Click \u201cStart Annotating\u201d when you\u2019re ready!",
      task: null,
      isDone: true,
      feedback: null,
    });

    return allSteps;
  }, [vizMode, isAICondition, hasZoomed, hasPanned, hasSelectedPeak, hasDragged, hasAddedPeak, hasDeletedPeak, hasHoveredPeak, peak2Validation, falsePositiveDeleted, missedPeakValidation, nonePeakValidation]);

  const canAdvance = steps[step]?.isDone;
  const isLast = step === steps.length - 1;
  const current = steps[step] ?? { title: "", instruction: "", task: null, isDone: true, feedback: null };
  const showChart = step >= 1 && step < steps.length - 1;
  const hasExplanation = vizMode === "normal_explain" || vizMode === "counterfactual_explain";

  // Mini-map context strip
  const tCtxH = 48;
  const tCtxXScale = useCallback(v => tpad.l + ((v - 0) / (12 - 0 || 1)) * tPlotW, [tPlotW]);
  const tCtxYScale = useCallback(v => 5 + (tCtxH - 12) - (v / tYMax) * (tCtxH - 12), [tYMax]);
  const tCtxPath = useMemo(() => {
    const step2 = Math.max(1, Math.floor(tutData.length / 500));
    return tutData.filter((_, i) => i % step2 === 0)
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${tCtxXScale(p[0]).toFixed(1)},${tCtxYScale(p[1]).toFixed(1)}`).join(' ');
  }, [tutData, tCtxXScale, tCtxYScale]);

  // x/y ticks
  const txTicks = useMemo(() => Array.from({ length: 9 }, (_, i) => tutDomain[0] + (i / 8) * (tutDomain[1] - tutDomain[0])), [tutDomain]);
  const tyTicks = useMemo(() => Array.from({ length: 6 }, (_, i) => (i / 5) * tYMax), [tYMax]);

  // Build filled area path for a peak (same as main screen)
  const buildTutPeakAreaPath = useCallback((pk) => {
    const plotBottom = tpad.t + tPlotH;
    const pts = tutData.filter(d => d[0] >= pk.userStart && d[0] <= pk.userEnd);
    if (pts.length < 2) {
      const x0 = txScale(pk.userStart), x1 = txScale(pk.userEnd);
      return `M${x0},${plotBottom} L${x0},${tpad.t} L${x1},${tpad.t} L${x1},${plotBottom} Z`;
    }
    const top = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${txScale(p[0]).toFixed(1)},${tyScale(p[1]).toFixed(1)}`).join(' ');
    const x1 = txScale(pts[pts.length - 1][0]).toFixed(1);
    const x0 = txScale(pts[0][0]).toFixed(1);
    return `${top} L${x1},${plotBottom} L${x0},${plotBottom} Z`;
  }, [tutData, txScale, tyScale, tpad.t, tPlotH]);

  // Tutorial-specific task steps for the task banner
  const tutTaskSteps = vizMode === "none" || vizMode === "no_ai"
    ? [
        { n: 1, label: "Find peaks", desc: "Look for signal rises above the baseline" },
        { n: 2, label: "Add each one", desc: "Click \"+ Add Peak\" then drag handles to fit" },
        { n: 3, label: "Move to next", desc: "When done, click \"Start Annotating\"" },
      ]
    : vizMode === "peaks_only"
    ? [
        { n: 1, label: "Review AI peaks", desc: "Shaded regions show where the AI detected peaks" },
        { n: 2, label: "Keep, edit, or remove", desc: "Adjust boundaries or delete false detections" },
        { n: 3, label: "Add any it missed", desc: "Use \"+ Add Peak\" if the AI missed one" },
      ]
    : [
        { n: 1, label: "Review each peak", desc: "The AI detected numbered peaks on the chart" },
        { n: 2, label: "Keep, edit, or remove", desc: "Click a badge or pill to inspect and decide" },
        { n: 3, label: "Add any it missed", desc: "Use \"+ Add Peak\" if the AI missed one" },
      ];

  return (
    <div style={{ fontFamily: "'IBM Plex Sans',system-ui,sans-serif", background: "#f0f2f5", minHeight: "100vh" }}>

      {/* ── Header — same style as annotation screen ── */}
      <div style={{ background: "linear-gradient(135deg,#1a1a2e,#16213e)", padding: "10px 20px", color: "#fff", display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: -.2 }}>
            Peak Annotator <span style={{ fontWeight: 400, opacity: .55 }}>— Tutorial</span>
          </div>
          <div style={{ fontSize: 11, opacity: .5, marginTop: 1 }}>
            Step {step + 1} of {steps.length}: <strong style={{ opacity: 1 }}>{current.title}</strong>
          </div>
        </div>
        {/* Step dots */}
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {steps.map((_, i) => (
            <div key={i} style={{
              width: 8, height: 8, borderRadius: 4,
              background: i === step ? "#60a5fa" : completedSteps.has(i) ? "#22c55e" : "rgba(255,255,255,.2)",
              transition: "background .2s",
            }} />
          ))}
        </div>

      </div>

      {/* ── Task reminder banner ── */}
      <div style={{ background: "#fff", borderBottom: "2px solid #e5e7eb", padding: "10px 20px", display: "flex", alignItems: "center", gap: 0 }}>
        {tutTaskSteps.map((s, si) => (
          <div key={s.n} style={{ display: "flex", alignItems: "center", gap: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 14px 6px 10px" }}>
              <div style={{ width: 26, height: 26, borderRadius: "50%", background: "#1e40af", color: "#fff", fontSize: 12, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{s.n}</div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#1e293b", lineHeight: 1.2 }}>{s.label}</div>
                <div style={{ fontSize: 11, color: "#64748b", lineHeight: 1.2 }}>{s.desc}</div>
              </div>
            </div>
            {si < tutTaskSteps.length - 1 && (
              <div style={{ color: "#cbd5e1", fontSize: 18, lineHeight: 1, padding: "0 2px" }}>›</div>
            )}
          </div>
        ))}
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button onClick={() => setTutDomain([0, 12])}
            style={{ padding: "5px 12px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", border: "1px solid #d1d5db", background: "#f9fafb", color: "#374151" }}>Reset Zoom</button>
          <span style={{ fontSize: 11, color: "#94a3b8", whiteSpace: "nowrap" }}>{activeTutPeaks.length} peak{activeTutPeaks.length !== 1 ? "s" : ""}</span>
        </div>
      </div>

      {/* ── Step instruction card ── */}
      <div style={{ padding: "12px 20px 0" }}>
        <div style={{ background: "#fff", borderRadius: 12, border: "2px solid #3b82f6", padding: "14px 20px", marginBottom: 0 }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: "#3b82f6", fontWeight: 700, textTransform: "uppercase", letterSpacing: .5, marginBottom: 2 }}>Tutorial Step {step + 1} of {steps.length}</div>
              <h2 style={{ fontSize: 17, fontWeight: 800, color: "#1e293b", margin: "0 0 6px" }}>{current.title}</h2>
              <div style={{ fontSize: 13, color: "#475569", lineHeight: 1.6, whiteSpace: "pre-line" }}>{current.instruction}</div>
            </div>
            {/* Task + feedback */}
            <div style={{ minWidth: 280, maxWidth: 320, flexShrink: 0 }}>
              {current.task && (
                <div style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 8, marginBottom: 8,
                  background: current.isDone ? "#f0fdf4" : "#fffbeb",
                  border: `1px solid ${current.isDone ? "#86efac" : "#fcd34d"}`,
                }}>
                  <span style={{ fontSize: 16 }}>{current.isDone ? "✅" : "👉"}</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: current.isDone ? "#166534" : "#92400e" }}>
                    {current.isDone ? "Done! " : "Task: "}{current.task}
                  </span>
                </div>
              )}
              {current.feedback && (
                <div style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 8,
                  background: current.feedbackOk ? "#f0fdf4" : "#fef3c7",
                  border: `1px solid ${current.feedbackOk ? "#86efac" : "#fbbf24"}`,
                }}>
                  <span style={{ fontSize: 14 }}>{current.feedbackOk ? "✅" : "⚠️"}</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: current.feedbackOk ? "#166534" : "#92400e" }}>{current.feedback}</span>
                </div>
              )}
              {!current.task && !current.feedback && (
                <div style={{ fontSize: 12, color: "#94a3b8", fontStyle: "italic", padding: "8px 0" }}>
                  {isLast ? "Click \"Start Annotating\" when ready." : "Read the instructions, then click Next →"}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Legend strip (AI conditions) ── */}
      {showConf && showChart && (
        <div style={{ background: "#f8fafc", borderBottom: "1px solid #e5e7eb", padding: "6px 20px", display: "flex", alignItems: "center", gap: 16, fontSize: 11, color: "#64748b", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700, color: "#374151", fontSize: 11 }}>Legend:</span>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <svg width={12} height={14}><polygon points="0,2 0,12 10,7" fill="#1e40af" /></svg>
            Start boundary
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <svg width={14} height={14}><polygon points="7,0 14,7 7,14 0,7" fill="#1e40af" /></svg>
            Apex (peak top)
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <svg width={12} height={14}><polygon points="12,2 12,12 2,7" fill="#1e40af" /></svg>
            End boundary
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 48, height: 10, borderRadius: 5, background: "linear-gradient(90deg,hsl(0,75%,38%),hsl(60,75%,38%),hsl(120,75%,38%))", display: "inline-block" }} />
            AI Confidence (low → high)
          </span>
          <span style={{ color: "#94a3b8" }}>· Click a badge on the chart or a pill below to select · Drag handles to adjust · Scroll to zoom · Drag chart to pan</span>
        </div>
      )}
      {!showConf && showChart && (
        <div style={{ background: "#f8fafc", borderBottom: "1px solid #e5e7eb", padding: "6px 20px", display: "flex", alignItems: "center", gap: 16, fontSize: 11, color: "#64748b", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700, color: "#374151", fontSize: 11 }}>Legend:</span>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <svg width={12} height={14}><polygon points="0,2 0,12 10,7" fill="#1e40af" /></svg>
            Start boundary
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <svg width={14} height={14}><polygon points="7,0 14,7 7,14 0,7" fill="#1e40af" /></svg>
            Apex (peak top)
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <svg width={12} height={14}><polygon points="12,2 12,12 2,7" fill="#1e40af" /></svg>
            End boundary
          </span>
          <span style={{ color: "#94a3b8" }}>· Scroll to zoom · Drag to pan · Click a peak pill below to select it · Click ✕ on a pill to delete</span>
        </div>
      )}

      {/* ── Full-width chart ── */}
      {showChart && (
        <>
          <div style={{ padding: "12px 20px 0" }}>
            <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb", overflow: "hidden" }}>
              <svg ref={tutSvgCallbackRef} viewBox={`0 0 ${TW} ${TH}`} width="100%" height={TH}
                style={{ display: "block", cursor: "grab", touchAction: "none", userSelect: "none" }}
                onPointerDown={onTutPointerDown} onPointerMove={onTutPointerMove}
                onPointerUp={onTutPointerUp} onPointerLeave={onTutPointerUp}>

                {/* Grid */}
                {tyTicks.map((v, i) => <line key={`yg${i}`} x1={tpad.l} x2={tpad.l + tPlotW} y1={tyScale(v)} y2={tyScale(v)} stroke="#f1f5f9" />)}
                {txTicks.map((v, i) => <line key={`xg${i}`} x1={txScale(v)} x2={txScale(v)} y1={tpad.t} y2={tpad.t + tPlotH} stroke="#f1f5f9" />)}
                <line x1={tpad.l} x2={tpad.l} y1={tpad.t} y2={tpad.t + tPlotH} stroke="#cbd5e1" />
                <line x1={tpad.l} x2={tpad.l + tPlotW} y1={tpad.t + tPlotH} y2={tpad.t + tPlotH} stroke="#cbd5e1" />
                {tyTicks.map((v, i) => <text key={`yt${i}`} x={tpad.l - 6} y={tyScale(v) + 4} textAnchor="end" fontSize={11} fill="#94a3b8">{v.toFixed(0)}</text>)}
                {txTicks.map((v, i) => <text key={`xt${i}`} x={txScale(v)} y={tpad.t + tPlotH + 14} textAnchor="middle" fontSize={11} fill="#94a3b8">{fmt(v)}</text>)}
                <text x={tpad.l + tPlotW / 2} y={TH - 2} textAnchor="middle" fontSize={12} fontWeight={600} fill="#64748b">Time</text>
                <text x={13} y={tpad.t + tPlotH / 2} textAnchor="middle" fontSize={12} fontWeight={600} fill="#64748b" transform={`rotate(-90,13,${tpad.t + tPlotH / 2})`}>Intensity</text>

                {/* Confidence fill areas */}
                {showConf && activeTutPeaks.map(pk => {
                  const isUserPk = pk.id.startsWith("user_");
                  if (isUserPk || pk.confidence == null) return null;
                  const x0 = txScale(pk.userStart), x1 = txScale(pk.userEnd);
                  if (x1 < tpad.l || x0 > tpad.l + tPlotW) return null;
                  const sel = pk.id === tutSelectedId, hov = pk.id === tutHoveredId;
                  const hue = confHue(pk.confidence);
                  const baseOpacity = sel ? 0.45 : hov ? 0.38 : 0.25;
                  const strokeOpacity = sel ? 0.8 : hov ? 0.6 : 0.4;
                  const areaPath = buildTutPeakAreaPath(pk);
                  return (
                    <g key={`fill${pk.id}`} style={{ cursor: "pointer", pointerEvents: "auto" }}
                      onPointerEnter={() => setTutHoveredId(pk.id)} onPointerLeave={() => setTutHoveredId(null)}
                      onClick={e => { e.stopPropagation(); setTutSelectedId(pk.id === tutSelectedId ? null : pk.id); setHasSelectedPeak(true); }}>
                      <path d={areaPath} fill={`hsla(${hue},75%,45%,${baseOpacity})`}
                        stroke={`hsla(${hue},75%,35%,${strokeOpacity})`} strokeWidth={sel ? 1.5 : 1}
                        style={{ pointerEvents: "visible" }} />
                    </g>
                  );
                })}

                {/* Peaks-only: no fill, selection border only */}
                {vizMode === "peaks_only" && activeTutPeaks.filter(pk => !pk.id.startsWith("user_")).map(pk => {
                  const x0 = Math.max(txScale(pk.userStart), tpad.l);
                  const x1 = Math.min(txScale(pk.userEnd), tpad.l + tPlotW);
                  if (x1 <= x0) return null;
                  const sel = pk.id === tutSelectedId;
                  return (
                    <rect key={`hit${pk.id}`}
                      x={x0} y={tpad.t} width={x1 - x0} height={tPlotH}
                      fill="transparent"
                      stroke={sel ? "#1e40af" : "none"} strokeWidth={sel ? 1.5 : 0}
                      style={{ cursor: "pointer", pointerEvents: "visible" }}
                      onPointerEnter={() => setTutHoveredId(pk.id)} onPointerLeave={() => setTutHoveredId(null)}
                      onClick={e => { e.stopPropagation(); setTutSelectedId(pk.id === tutSelectedId ? null : pk.id); setHasSelectedPeak(true); }} />
                  );
                })}

                {/* Signal line */}
                <path d={tutPathD} fill="none" stroke="#1e293b" strokeWidth={1.5} strokeLinejoin="round" />

                {/* Peak markers */}
                {activeTutPeaks.map(pk => {
                  const aPx = txScale(pk.userApex), sPx = txScale(pk.userStart), ePx = txScale(pk.userEnd);
                  if (aPx < tpad.l - 30 || aPx > tpad.l + tPlotW + 30) return null;
                  const sel = pk.id === tutSelectedId, hov = pk.id === tutHoveredId;
                  const visible = sel || hov;
                  const iconY = Math.min(tyScale(pk.signal || 0) - 22, tpad.t + 34);
                  const isUserPk = pk.id.startsWith("user_");

                  return <g key={`m${pk.id}`}>
                    {visible && <>
                      <line x1={sPx} x2={sPx} y1={tpad.t} y2={tpad.t + tPlotH} stroke="#1e40af" strokeWidth={sel ? 1.5 : 1} strokeDasharray="3 2" opacity={sel ? .75 : .4} />
                      <line x1={aPx} x2={aPx} y1={tpad.t} y2={tpad.t + tPlotH} stroke="#1e40af" strokeWidth={sel ? 1.8 : 1} opacity={sel ? .5 : .3} />
                      <line x1={ePx} x2={ePx} y1={tpad.t} y2={tpad.t + tPlotH} stroke="#1e40af" strokeWidth={sel ? 1.5 : 1} strokeDasharray="3 2" opacity={sel ? .75 : .4} />
                      <rect x={Math.min(sPx, ePx)} y={tHandleY - 2} width={Math.max(4, Math.abs(ePx - sPx))} height={4} rx={2}
                        fill={sel ? "rgba(59,130,246,.25)" : "rgba(100,116,139,.12)"} style={{ pointerEvents: "none" }} />
                    </>}

                    {sel && <>
                      <g onPointerDown={onTutHandleDown(pk.id, 'start')} style={{ cursor: "ew-resize", pointerEvents: "auto" }}>
                        <circle cx={sPx} cy={tHandleY} r={16} fill="transparent" />
                        <polygon points={`${sPx - 9},${tHandleY - 9} ${sPx - 9},${tHandleY + 9} ${sPx + 6},${tHandleY}`} fill="#1e40af" stroke="#fff" strokeWidth={1} />
                      </g>
                      <g onPointerDown={onTutHandleDown(pk.id, 'apex')} style={{ cursor: "ew-resize", pointerEvents: "auto" }}>
                        <circle cx={aPx} cy={tHandleY} r={16} fill="transparent" />
                        <polygon points={`${aPx},${tHandleY - 10} ${aPx + 8},${tHandleY} ${aPx},${tHandleY + 10} ${aPx - 8},${tHandleY}`} fill="#1e40af" stroke="#fff" strokeWidth={1} />
                      </g>
                      <g onPointerDown={onTutHandleDown(pk.id, 'end')} style={{ cursor: "ew-resize", pointerEvents: "auto" }}>
                        <circle cx={ePx} cy={tHandleY} r={16} fill="transparent" />
                        <polygon points={`${ePx + 9},${tHandleY - 9} ${ePx + 9},${tHandleY + 9} ${ePx - 6},${tHandleY}`} fill="#1e40af" stroke="#fff" strokeWidth={1} />
                      </g>
                    </>}

                    {/* Confidence badge */}
                    {showConf && !isUserPk && pk.confidence != null ? (
                      <g style={{ cursor: "pointer", pointerEvents: "auto" }}
                        onPointerEnter={() => setTutHoveredId(pk.id)} onPointerLeave={() => setTutHoveredId(null)}
                        onClick={e => { e.stopPropagation(); setTutSelectedId(pk.id === tutSelectedId ? null : pk.id); setHasSelectedPeak(true); }}>
                        <rect x={aPx - 16} y={iconY - 10} width={32} height={20} rx={10}
                          fill={sel ? confBg(pk.confidence) : "#fff"}
                          stroke={confColor(pk.confidence)} strokeWidth={sel ? 2 : 1.5} />
                        <text x={aPx} y={iconY + 4} textAnchor="middle" fontSize={10} fontWeight={700} fill={confColor(pk.confidence)}>{pk.confidence}</text>
                      </g>
                    ) : showConf && isUserPk ? (
                      <g style={{ cursor: "pointer", pointerEvents: "auto" }}
                        onClick={e => { e.stopPropagation(); setTutSelectedId(pk.id === tutSelectedId ? null : pk.id); setHasSelectedPeak(true); }}>
                        <rect x={aPx - 14} y={iconY - 10} width={28} height={20} rx={10}
                          fill={sel ? "#ecfdf5" : "#fff"} stroke="#059669" strokeWidth={sel ? 2 : 1.5} />
                        <text x={aPx} y={iconY + 4} textAnchor="middle" fontSize={9} fontWeight={700} fill="#059669">+</text>
                      </g>
                    ) : !showConf ? (
                      <g style={{ cursor: "pointer", pointerEvents: "auto" }}
                        onPointerEnter={() => setTutHoveredId(pk.id)} onPointerLeave={() => setTutHoveredId(null)}
                        onClick={e => { e.stopPropagation(); setTutSelectedId(pk.id === tutSelectedId ? null : pk.id); setHasSelectedPeak(true); }}>
                        <circle cx={aPx} cy={iconY} r={10} fill={sel ? "#eff6ff" : "#fff"} stroke="#1e40af" strokeWidth={sel ? 2 : 1.5} />
                        <text x={aPx} y={iconY + 4} textAnchor="middle" fontSize={9} fontWeight={700} fill="#1e40af">P</text>
                      </g>
                    ) : null}

                    {visible && <text x={aPx + 18} y={tpad.t + 20} fontSize={11} fill={sel ? "#1e40af" : "#94a3b8"} fontWeight={sel ? 600 : 400} style={{ pointerEvents: "none" }}>{tutPeakLabel.get(pk.id) || pk.label}</text>}
                  </g>;
                })}

                {/* Peak region hit targets — last so they sit on top and receive clicks */}
                {activeTutPeaks.map(pk => {
                  const x0 = Math.max(txScale(pk.userStart), tpad.l), x1 = Math.min(txScale(pk.userEnd), tpad.l + tPlotW);
                  if (x1 < tpad.l || x0 > tpad.l + tPlotW) return null;
                  const sel = pk.id === tutSelectedId, hov = pk.id === tutHoveredId;
                  return <rect key={`hit${pk.id}`} x={x0} y={tpad.t} width={Math.max(2, x1 - x0)} height={tPlotH}
                    fill="transparent"
                    stroke={sel ? "rgba(59,130,246,.4)" : hov ? "rgba(100,116,139,.2)" : "none"}
                    strokeWidth={sel ? 1.5 : 1}
                    style={{ cursor: "pointer", pointerEvents: "visible" }}
                    onPointerEnter={() => { setTutHoveredId(pk.id); setHasHoveredPeak(true); }}
                    onPointerLeave={() => setTutHoveredId(null)}
                    onClick={e => { e.stopPropagation(); const nextId = pk.id === tutSelectedId ? null : pk.id; setTutSelectedId(nextId); setHasSelectedPeak(true); if (nextId) { const mid = pk.userApex; const w = tutDomain[1] - tutDomain[0]; setTutDomain([mid - w/2, mid + w/2]); } }} />;
                })}
              </svg>

              {/* Mini-map context strip */}
              <div style={{ borderTop: "1px solid #e5e7eb", background: "#fafafa" }}>
                <svg viewBox={`0 0 ${TW} ${tCtxH}`} width="100%" height={tCtxH} style={{ display: "block" }}>
                  <path d={tCtxPath} fill="none" stroke="#94a3b8" strokeWidth={1} />
                  <rect x={tCtxXScale(tutDomain[0])} y={3} width={Math.max(4, tCtxXScale(tutDomain[1]) - tCtxXScale(tutDomain[0]))} height={tCtxH - 6}
                    fill="rgba(59,130,246,.06)" stroke="rgba(59,130,246,.22)" rx={3} />
                </svg>
              </div>
            </div>
          </div>

          {/* ── Bottom panel: peak pills + action area ── */}
          <div style={{ padding: "10px 20px 0", display: "flex", gap: 14, alignItems: "flex-start" }}>
            {/* Peak list */}
            <div style={{ flex: 1, background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb", overflow: "hidden" }}>
              <div style={{ padding: "10px 16px", borderBottom: "1px solid #e5e7eb", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#1e293b" }}>
                    {isAICondition ? "Detected Peaks" : "Your Peaks"}
                  </span>
                  <span style={{ fontSize: 11, color: "#94a3b8", marginLeft: 8 }}>
                    {isAICondition ? "Click any peak to inspect it" : "Click a peak to select and edit it, or add one below"}
                  </span>
                </div>
                <button onClick={tutAddPeak}
                  style={{ padding: "6px 14px", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", border: "2px solid #059669", background: "#ecfdf5", color: "#059669", whiteSpace: "nowrap", flexShrink: 0 }}>
                  {isAICondition ? "+ Add Missed Peak" : "+ Add Peak"}
                </button>
              </div>

              {activeTutPeaks.length === 0 && tutAnnotations.filter(a => a.deleted).length === 0 ? (
                <div style={{ padding: "20px 16px", fontSize: 12, color: "#94a3b8", textAlign: "center" }}>
                  {isAICondition ? "No peaks detected." : "No peaks yet — use the button above to add one."}
                </div>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "10px 14px" }}>
                  {tutPeaksSorted.map((pk, i) => {
                    const sel = pk.id === tutSelectedId, hov = pk.id === tutHoveredId;
                    const isUserPk = pk.id.startsWith("user_");
                    const chipBg = sel ? "#eff6ff" : hov ? "#f8fafc" : "#f1f5f9";
                    const chipBorder = sel ? "2px solid #3b82f6" : "1.5px solid #e2e8f0";
                    const origIdx = TUTORIAL_PEAKS.findIndex(p => p.id === pk.id);
                    const ex = origIdx >= 0 ? TUTORIAL_EXPLANATIONS[origIdx] : null;
                    const txt = hasExplanation && ex ? (vizMode === "normal_explain" ? ex.feature : ex.counterfactual) : null;
                    const tutThresholds = (vizMode === "threshold_bars" && ex) ? (ex.thresholds || parseThresholdPcts(ex.feature)) : null;
                    return (
                      <div key={pk.id}
                        style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "6px 10px 6px 12px", borderRadius: 20, background: chipBg, border: chipBorder, cursor: "pointer", transition: "all .12s" }}
                        onPointerEnter={() => { setTutHoveredId(pk.id); setHasHoveredPeak(true); }}
                        onPointerLeave={() => setTutHoveredId(null)}
                        onClick={() => { const nextId = pk.id === tutSelectedId ? null : pk.id; setTutSelectedId(nextId); setHasSelectedPeak(true); if (nextId) { const mid = pk.userApex; const w = tutDomain[1] - tutDomain[0]; setTutDomain([mid - w/2, mid + w/2]); } }}>
                        {showConf && !isUserPk && pk.confidence != null && (
                          <span style={{ width: 8, height: 8, borderRadius: "50%", background: confColor(pk.confidence), display: "inline-block", flexShrink: 0 }} />
                        )}
                        {isUserPk && <span style={{ fontSize: 10, color: "#059669", fontWeight: 800 }}>+</span>}
                        <span style={{ fontSize: 12, fontWeight: sel ? 700 : 500, color: sel ? "#1e40af" : "#374151" }}>{tutPeakLabel.get(pk.id) || pk.label}</span>
                        {showConf && !isUserPk && pk.confidence != null && (
                          <span style={{ fontSize: 10, fontWeight: 700, color: confColor(pk.confidence), background: confBg(pk.confidence), padding: "1px 5px", borderRadius: 6 }}>{pk.confidence}%</span>
                        )}
                        <span
                          onClick={e => { e.stopPropagation(); tutDeletePeak(pk.id); setHasDeletedPeak(true); }}
                          style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 16, height: 16, borderRadius: "50%", background: "#fecaca", color: "#dc2626", fontSize: 10, fontWeight: 800, cursor: "pointer", flexShrink: 0, lineHeight: 1 }}
                          title="Delete this peak">✕</span>
                      </div>
                    );
                  })}
                  {/* Grayed-out deleted peaks */}
                  {tutAnnotations.filter(a => a.deleted).map(pk => (
                    <div key={`del-${pk.id}`}
                      title="Click to restore"
                      style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "6px 12px", borderRadius: 20, background: "#f8fafc", border: "1.5px dashed #cbd5e1", cursor: "pointer", opacity: 0.55 }}
                      onClick={() => { setTutAnnotations(prev => prev.map(a => a.id === pk.id ? { ...a, deleted: false } : a)); setTutSelectedId(pk.id); }}>
                      <span style={{ fontSize: 10, color: "#94a3b8" }}>↩</span>
                      <span style={{ fontSize: 12, fontWeight: 500, color: "#94a3b8", textDecoration: "line-through" }}>Peak @ {fmt(pk.userApex)}</span>
                      <span style={{ fontSize: 9, color: "#94a3b8" }}>Restore</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Action panel */}
            <div style={{ width: 420, flexShrink: 0 }}>
              {tutSelectedId && activeTutPeaks.find(p => p.id === tutSelectedId) ? (() => {
                const selPk = activeTutPeaks.find(p => p.id === tutSelectedId);
                const selIsUser = selPk.id.startsWith("user_");
                return (
                  <div style={{ background: "#fff", borderRadius: 12, border: "2px solid #3b82f6", overflow: "hidden" }}>
                    <div style={{ padding: "10px 16px", background: "#eff6ff", borderBottom: "1px solid #bfdbfe", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#1e40af" }}>{tutPeakLabel.get(selPk.id) || selPk.label}</div>
                        {showConf && !selIsUser && selPk.confidence != null && (
                          <div style={{ fontSize: 11, color: confColor(selPk.confidence), fontWeight: 600, marginTop: 2 }}>
                            AI Confidence: {selPk.confidence}% — {selPk.confidence >= 80 ? "Very likely a real peak" : selPk.confidence >= 50 ? "Possibly a real peak — check carefully" : "Borderline — check closely"}
                          </div>
                        )}
                        {selIsUser && <div style={{ fontSize: 11, color: "#059669", fontWeight: 600, marginTop: 2 }}>You added this peak</div>}
                      </div>
                      <div style={{ fontSize: 11, color: "#64748b", textAlign: "right" }}>
                        <div>Start: <strong>{fmt(selPk.userStart)}</strong></div>
                        <div>Apex: <strong>{fmt(selPk.userApex)}</strong></div>
                        <div>End: <strong>{fmt(selPk.userEnd)}</strong></div>
                      </div>
                    </div>
                    {/* Threshold bars for threshold_bars condition */}
                    {(() => {
                      const origIdx = TUTORIAL_PEAKS.findIndex(p => p.id === selPk.id);
                      const ex = origIdx >= 0 ? TUTORIAL_EXPLANATIONS[origIdx] : null;
                      const tutThresholds = vizMode === "threshold_bars" && ex ? (ex.thresholds || parseThresholdPcts(ex.feature)) : null;
                      const txt = hasExplanation && ex ? (vizMode === "normal_explain" ? ex.feature : ex.counterfactual) : null;
                      if (!tutThresholds && !txt) return null;
                      return (
                        <div style={{ padding: "10px 16px", borderBottom: "1px solid #e5e7eb", background: "#fafafa" }}>
                          {txt && <div style={{ fontSize: 11, color: "#475569", lineHeight: 1.5, marginBottom: tutThresholds ? 8 : 0 }}>{txt}</div>}
                          {tutThresholds && <>
                            <div style={{ fontSize: 11, fontWeight: 600, color: "#374151", marginBottom: 6 }}>Detection margins:</div>
                            <ThresholdBar label="Prominence" pct={tutThresholds.prominence} width={360} />
                            <ThresholdBar label="Width" pct={tutThresholds.width} width={360} />
                            <ThresholdBar label="Height" pct={tutThresholds.height} width={360} />
                            {tutThresholds.snr != null && <ThresholdBar label="S/N (Signal-to-Noise)" pct={tutThresholds.snr} width={360} />}
                            {tutThresholds.area != null && <ThresholdBar label="Peak Area" pct={tutThresholds.area} width={360} />}
                          </>}
                        </div>
                      );
                    })()}
                    <div style={{ padding: "10px 16px", display: "flex", gap: 8 }}>
                      <div style={{ flex: 1, fontSize: 11, color: "#64748b", lineHeight: 1.5, alignSelf: "center" }}>
                        Drag the ◀ Start, ◆ Apex, ▶ End handles on the chart to adjust boundaries. If this is not a real peak, delete it.
                      </div>
                      <button onClick={() => tutDeletePeak(tutSelectedId)}
                        style={{ padding: "8px 16px", borderRadius: 8, border: "1.5px solid #fca5a5", background: "#fef2f2", color: "#dc2626", fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}>
                        Delete Peak Annotation
                      </button>
                    </div>
                  </div>
                );
              })() : (
                <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb", padding: "20px 18px", textAlign: "center", color: "#94a3b8" }}>
                  <div style={{ fontSize: 28, marginBottom: 8 }}>☝</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#475569", marginBottom: 4 }}>
                    {isAICondition ? "Select a peak to review it" : "Select a peak to edit it"}
                  </div>
                  <div style={{ fontSize: 11, lineHeight: 1.5 }}>
                    Click a peak pill or badge on the chart to select it. Then drag the handles to adjust its boundaries.
                  </div>
                </div>
              )}

              {/* Navigation buttons */}
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => setStep(s => s - 1)} disabled={step === 0}
                    style={{ flex: 1, padding: "10px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", fontSize: 13, fontWeight: 600, cursor: step === 0 ? "not-allowed" : "pointer", opacity: step === 0 ? .4 : 1, color: "#374151" }}>
                    ← Back
                  </button>
                  <button onClick={() => { setCompletedSteps(prev => { const n = new Set(prev); n.add(step); return n; }); if (isLast) onDismiss(); else setStep(s => s + 1); }} disabled={!canAdvance}
                    style={{ flex: 2, padding: "10px 20px", borderRadius: 8, border: "none", background: canAdvance ? (isLast ? "#059669" : "#1e40af") : "#cbd5e1", color: "#fff", fontSize: 13, fontWeight: 700, cursor: canAdvance ? "pointer" : "not-allowed" }}>
                    {isLast ? "✅ Start Annotating" : `Next → ${steps[step + 1] ? steps[step + 1].title : ""}`}
                  </button>
                </div>
                {!canAdvance && current.task && (
                  <div style={{ textAlign: "center", fontSize: 11, color: "#f59e0b", fontWeight: 500 }}>Complete the task above to continue</div>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── Text-only steps (welcome + final) — centered card ── */}
      {!showChart && (
        <div style={{ display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "20px" }}>
          <div style={{ maxWidth: 560, width: "100%", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setStep(s => s - 1)} disabled={step === 0}
                style={{ flex: 1, padding: "12px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", fontSize: 13, fontWeight: 600, cursor: step === 0 ? "not-allowed" : "pointer", opacity: step === 0 ? .4 : 1, color: "#374151" }}>
                ← Back
              </button>
              <button onClick={() => { setCompletedSteps(prev => { const n = new Set(prev); n.add(step); return n; }); if (isLast) onDismiss(); else setStep(s => s + 1); }} disabled={!canAdvance}
                style={{ flex: 2, padding: "12px 20px", borderRadius: 8, border: "none", background: canAdvance ? (isLast ? "#059669" : "#1e40af") : "#cbd5e1", color: "#fff", fontSize: 14, fontWeight: 700, cursor: canAdvance ? "pointer" : "not-allowed" }}>
                {isLast ? "✅ Start Annotating" : "Next →"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════
//  SCREEN 3: Annotation
// ══════════════════════════════════════════
function AnnotationScreen({ datasets, vizMode, userName, prolificParams, onStudyComplete, onQuit }) {
  const [currentIdx, setCurrentIdx] = useState(0);
  const [selectedPeakId, setSelectedPeakId] = useState(null);
  const [hoveredPeakId, setHoveredPeakId] = useState(null);
  const [showTutorial, setShowTutorial] = useState(true);
  const [, forceRender] = useState(0);
  const [tick, setTick] = useState(0);

  const [allAnnotations, setAllAnnotations] = useState(() =>
    datasets.map(ds => {
      // In "none" mode, start blank — no AI detections shown
      if (vizMode === "none" || vizMode === "no_ai") return [];
      return ds.peaks.map((p, i) => ({
        ...p, label: `Peak @ ${fmt(p.apex)}`, userStart: p.start, userEnd: p.end, userApex: p.apex, deleted: false,
      }));
    })
  );

  const [finishedAt, setFinishedAt] = useState(() => datasets.map(() => null));

  const ds = datasets[currentIdx];
  const rawData = ds.data;
  const displayData = useMemo(() => downsample(rawData, 3000), [rawData]);
  const annotations = allAnnotations[currentIdx] || [];
  const groundTruth = ds.groundTruth || [];
  const explanations = ds.explanations || [];
  const activePeaks = useMemo(() => annotations.filter(a => !a.deleted), [annotations]);

  // Dynamic labels: sorted by apex time
  const peaksSorted = useMemo(() => [...activePeaks].sort((a, b) => a.userApex - b.userApex), [activePeaks]);
  const peakLabel = useMemo(() => {
    const m = new Map();
    peaksSorted.forEach((p, i) => m.set(p.id, `Peak @ ${fmt(p.userApex)}`));
    return m;
  }, [peaksSorted]);

  // Map peak ID to its explanation (explanations are indexed by original peak order)
  const explanationMap = useMemo(() => {
    const m = new Map();
    const origPeaks = datasets[currentIdx]?.peaks || [];
    origPeaks.forEach((p, i) => {
      if (explanations[i]) m.set(p.id, explanations[i]);
    });
    return m;
  }, [datasets, currentIdx, explanations]);

  const setAnnotations = useCallback((updater) => {
    setAllAnnotations(prev => {
      const next = [...prev];
      next[currentIdx] = typeof updater === "function" ? updater(prev[currentIdx]) : updater;
      return next;
    });
  }, [currentIdx]);

  const trackerRef = useRef(createTracker());
  const T = trackerRef.current;
  const IDLE_THRESHOLD_MS = 2000;

  // We need the global click listener to know which chromatogram is currently
  // active WITHOUT re-subscribing the listener on every change (which would
  // miss events during re-subscribe). A ref is the reliable way.
  const currentIdxRef = useRef(currentIdx);

  // Refs read by screenToChart (declared early so the global pointer listener,
  // which depends on screenToChart, can reference it without a TDZ error).
  // The actual values are synced into these refs by effects further down,
  // after fpad/fplotW/domain/yMax are computed.
  const fpadRef = useRef(null);
  const fplotWRef = useRef(null);
  const domainRef = useRef(null);
  const yMaxRef = useRef(null);

  // Stable: reads live values from refs, so empty dependency array is correct.
  const screenToChart = useCallback((clientX, clientY) => {
    const r = svgRef.current?.getBoundingClientRect();
    const pad = fpadRef.current, pw = fplotWRef.current, dom = domainRef.current, ymax = yMaxRef.current;
    if (!r || !pad || pw == null || !dom || ymax == null) return null;
    const svgX = (clientX - r.left) * (FW / r.width);
    const svgY = (clientY - r.top)  * (FH / r.height);
    const plotH = FH - pad.t - 56;
    if (svgX < pad.l || svgX > pad.l + pw || svgY < pad.t || svgY > pad.t + plotH) return null;
    return {
      chartX: dom[0] + ((svgX - pad.l) / pw) * (dom[1] - dom[0]),
      chartY: ((pad.t + plotH - svgY) / plotH) * ymax,
    };
  }, []);
  useEffect(() => { currentIdxRef.current = currentIdx; }, [currentIdx]);

  // Helper: stamp the first-edit time for the current chromatogram the first
  // time the participant does anything substantive on it.
  const stampFirstEdit = useCallback(() => {
    const idx = currentIdxRef.current;
    if (T.firstEditPerChrom[idx] == null) {
      T.firstEditPerChrom[idx] = Date.now() - T.sessionStart;
    }
  }, []);

  // Idle accumulation
  useEffect(() => {
    const iv = setInterval(() => { if (Date.now() - T.lastActivityTime >= IDLE_THRESHOLD_MS) T.totalIdleMs += 500; }, 500);
    return () => clearInterval(iv);
  }, []);



  // ── Global pointer + mouse listeners ────────────────────────────────────────
  const cursorSampleTimerRef = useRef(null);
  const lastCursorPos = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const active = () => { T.lastActivityTime = Date.now(); };

    const recordPointerEvent = (e, eventType) => {
      const info = describeClickTarget(e.target);
      const chartCoords = screenToChart(e.clientX, e.clientY);
      T.pointerEventLog.push({
        timeMs:   Date.now() - T.sessionStart,
        chromIdx: currentIdxRef.current,
        eventType,
        screenX:  e.clientX,
        screenY:  e.clientY,
        chartX:   chartCoords?.chartX ?? null,
        chartY:   chartCoords?.chartY ?? null,
        button:   e.button,
        target:   info.target,
        peakId:   info.peakId,
        handle:   info.handle,
      });
    };

    const pointerdown = (e) => { T.lastActivityTime = Date.now(); recordPointerEvent(e, "pointerdown"); };
    const pointerup   = (e) => { recordPointerEvent(e, "pointerup"); };

    const click = (e) => {
      const now = Date.now();
      T.totalClicks++;
      T.allClickTimestamps.push(now);
      T.lastActivityTime = now;
      const info = describeClickTarget(e.target);
      const chartCoords = screenToChart(e.clientX, e.clientY);
      T.clickLog.push({
        time:      now - T.sessionStart,
        chromIdx:  currentIdxRef.current,
        target:    info.target,
        peakId:    info.peakId,
        peakIndex: info.peakIndex,
        handle:    info.handle,
        x: e.clientX, y: e.clientY,        // legacy aliases
        screenX:   e.clientX,
        screenY:   e.clientY,
        chartX:    chartCoords?.chartX ?? null,
        chartY:    chartCoords?.chartY ?? null,
      });
      if (info.target && info.target !== "raw:html" && info.target !== "unknown") stampFirstEdit();
    };

    const mousemove = (e) => {
      T.lastActivityTime = Date.now();
      lastCursorPos.current = { x: e.clientX, y: e.clientY };
    };
    cursorSampleTimerRef.current = setInterval(() => {
      T.cursorSampleLog.push({
        timeMs:   Date.now() - T.sessionStart,
        chromIdx: currentIdxRef.current,
        screenX:  lastCursorPos.current.x,
        screenY:  lastCursorPos.current.y,
      });
    }, 500);

    window.addEventListener("mousemove",  mousemove);
    window.addEventListener("scroll",     active, true);
    window.addEventListener("wheel",      active, { passive: true });
    window.addEventListener("pointerdown", pointerdown, true);
    window.addEventListener("pointerup",   pointerup,   true);
    window.addEventListener("click",       click,       true);
    return () => {
      window.removeEventListener("mousemove",  mousemove);
      window.removeEventListener("scroll",     active, true);
      window.removeEventListener("wheel",      active);
      window.removeEventListener("pointerdown", pointerdown, true);
      window.removeEventListener("pointerup",   pointerup,   true);
      window.removeEventListener("click",       click,       true);
      clearInterval(cursorSampleTimerRef.current);
    };
  }, [stampFirstEdit, screenToChart]);

  // ── Per-chromatogram visit tracking ──
  // Open a visit entry when the current chromatogram changes; close the
  // previous one. Also handles mount (opens visit for initial chromatogram)
  // and unmount (closes the final visit) so totals are exact.
  useEffect(() => {
    const now = Date.now() - T.sessionStart;
    // Close any open visit that isn't this chrom (shouldn't happen, but safe)
    const last = T.chromVisits[T.chromVisits.length - 1];
    if (last && last.exit == null) last.exit = now;
    T.chromVisits.push({ chromIdx: currentIdx, enter: now, exit: null });
    // Log chrom_start to interactionLog
    pushInteraction(T, "chrom_start", currentIdx, null, null, {
      chromIdx: currentIdx,
      chromName: datasets[currentIdx]?.name ?? null,
      timeMs: now,
    });
    return () => {
      const exitMs = Date.now() - T.sessionStart;
      const open = T.chromVisits[T.chromVisits.length - 1];
      if (open && open.exit == null) open.exit = exitMs;
      // Log chrom_end to interactionLog
      pushInteraction(T, "chrom_end", currentIdx, null, null, {
        chromIdx: currentIdx,
        chromName: datasets[currentIdx]?.name ?? null,
        timeMs: exitMs,
        activeMs: open ? (exitMs - open.enter) : null,
      });
    };
  }, [currentIdx]);

  // ── Periodic annotation snapshot (every 15 s) ──
  useEffect(() => {
    const iv = setInterval(() => {
      const snap = (allAnnotations[currentIdx] || [])
        .filter(a => !a.deleted)
        .sort((a, b) => a.userApex - b.userApex)
        .map(a => ({ id: a.id, start: a.userStart, apex: a.userApex, end: a.userEnd, isAIPeak: !a.id.startsWith("user_") }));
      T.annotationSnapshots.push({ timeMs: Date.now() - T.sessionStart, chromIdx: currentIdx, peaks: snap });
      setTick(t => t + 1);
    }, 15000);
    return () => clearInterval(iv);
  }, [allAnnotations, currentIdx]);

  // Spatial (left-to-right by apex) index of a peak among currently active
  // peaks on the CURRENT chromatogram. Lets us analyze whether users edit
  // peaks in left-to-right order or jump around.
  const spatialIndexOf = useCallback((peakId) => {
    const active = (allAnnotations[currentIdxRef.current] || []).filter(a => !a.deleted);
    const sorted = [...active].sort((a, b) => a.userApex - b.userApex);
    return sorted.findIndex(a => a.id === peakId);
  }, [allAnnotations]);

  // Record a semantic edit. `meta` carries event-specific data (e.g. drag
  // deltas). `peakId`, when provided, is annotated with the peak's current
  // left-to-right spatial index so ordering analysis is possible later.
  const logEdit = useCallback((type, peakId = null, meta = null) => {
    T.annotationEdits++;
    const peakIndex = peakId != null ? spatialIndexOf(peakId) : null;
    // Legacy editLog entry
    T.editLog.push({
      type,
      time: Date.now() - T.sessionStart,
      chromIdx: currentIdxRef.current,
      peakId,
      peakIndex,
      ...(meta ? { meta } : {}),
    });
    // Unified interactionLog entry — meta becomes details
    pushInteraction(T, type, currentIdxRef.current, peakId, peakIndex, meta);
    T.lastActivityTime = Date.now();
    stampFirstEdit();
  }, [spatialIndexOf, stampFirstEdit]);

  // Track when a hover on a peak row begins, so we can log dwell time when
  // the hover ends (either by leaving or by clicking). This is a proxy for
  // deliberation — how long did the participant consider a peak before
  // deciding whether to edit it?
  const hoverStartRef = useRef(null);
  const beginHover = useCallback((peakId) => {
    hoverStartRef.current = { peakId, start: Date.now() };
    setHoveredPeakId(peakId);
  }, []);
  const endHover = useCallback((endedInClick = false) => {
    const h = hoverStartRef.current;
    if (h) {
      const duration = Date.now() - h.start;
      // Ignore trivially brief hovers (mouse passing through); only count
      // dwells long enough to suggest the participant was reading.
      if (duration >= 150) {
        T.hoverLog.push({
          time: h.start - T.sessionStart,
          chromIdx: currentIdxRef.current,
          peakId: h.peakId,
          peakIndex: spatialIndexOf(h.peakId),
          durationMs: duration,
          endedInClick,
        });
      }
      hoverStartRef.current = null;
    }
    setHoveredPeakId(null);
  }, [spatialIndexOf]);

  useEffect(() => { setSelectedPeakId(null); setHoveredPeakId(null); hoverStartRef.current = null; }, [currentIdx]);

  // ── Chart ──
  const W = 880, H = 380;
  const pad = { l: 64, r: 20, t: 24, b: 56 };
  const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
  const handleY = pad.t + plotH + 22;

  const xMin = displayData.length > 0 ? displayData[0][0] : 0;
  const xMax = displayData.length > 0 ? displayData[displayData.length - 1][0] : 1;
  const yMax = useMemo(() => Math.max(...displayData.map(d => d[1]), 1) * 1.12, [displayData]);

  const [domain, setDomain] = useState([xMin, xMax]);
  useEffect(() => { setDomain([xMin, xMax]); }, [xMin, xMax]);

  // Log zoom/pan state after it settles. Debounced so that a single wheel
  // gesture doesn't produce dozens of entries — we care about "where did
  // the user end up looking?", not every intermediate frame.
  useEffect(() => {
    const id = setTimeout(() => {
      T.zoomLog.push({
        time: Date.now() - T.sessionStart,
        chromIdx: currentIdxRef.current,
        domainStart: domain[0],
        domainEnd: domain[1],
        width: domain[1] - domain[0],
      });
    }, 200);
    return () => clearTimeout(id);
  }, [domain]);

  const dragStateRef = useRef(null);
  const svgRef = useRef(null);

  const xScale = useCallback(v => pad.l + ((v - domain[0]) / (domain[1] - domain[0] || 1)) * plotW, [domain, plotW]);
  const xInv = useCallback(px => domain[0] + ((px - pad.l) / plotW) * (domain[1] - domain[0]), [domain, plotW]);
  const yScale = useCallback(v => pad.t + plotH - (v / yMax) * plotH, [yMax, plotH]);

  const pathD = useMemo(() => {
    const pts = displayData.filter(d => d[0] >= domain[0] - 0.2 && d[0] <= domain[1] + 0.2);
    if (!pts.length) return "";
    return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(p[0]).toFixed(1)},${yScale(p[1]).toFixed(1)}`).join(' ');
  }, [displayData, domain, xScale, yScale]);

  const ctxH = 52;
  const ctxXScale = useCallback(v => pad.l + ((v - xMin) / (xMax - xMin || 1)) * plotW, [plotW, xMin, xMax]);
  const ctxYScale = useCallback(v => 6 + (ctxH - 14) - (v / yMax) * (ctxH - 14), [yMax]);
  const ctxPath = useMemo(() => {
    const step = Math.max(1, Math.floor(displayData.length / 400));
    return displayData.filter((_, i) => i % step === 0).map((p, i) => `${i === 0 ? 'M' : 'L'}${ctxXScale(p[0]).toFixed(1)},${ctxYScale(p[1]).toFixed(1)}`).join(' ');
  }, [displayData, ctxXScale, ctxYScale]);

  const getSvgX = useCallback(e => { const r = svgRef.current?.getBoundingClientRect(); return r ? (e.clientX - r.left) * (W / r.width) : 0; }, []);

  const onWheel = useCallback(e => {
    e.preventDefault();
    const r = svgRef.current?.getBoundingClientRect(); if (!r) return;
    const anchor = xInv((e.clientX - r.left) * (W / r.width));
    const factor = e.deltaY > 0 ? 0.82 : 1.22;
    const w = domain[1] - domain[0], nw = Math.max(0.1, Math.min(xMax - xMin, w / factor));
    const a0 = (anchor - domain[0]) / w;
    let a = anchor - a0 * nw, b = a + nw;
    if (a < xMin) { a = xMin; b = a + nw; } if (b > xMax) { b = xMax; a = b - nw; }
    setDomain([a, b]);
  }, [domain, xInv, xMax, xMin]);

  const onSvgPointerDown = useCallback(e => {
    dragStateRef.current = { type: 'pan', startX: e.clientX, startDomain: [...domain] };
    svgRef.current?.setPointerCapture(e.pointerId);
  }, [domain]);

  const onSvgPointerMove = useCallback(e => {
    const d = dragStateRef.current; if (!d) return;
    if (d.type === 'pan') {
      const r = svgRef.current?.getBoundingClientRect();
      const scale = r ? W / r.width : 1;
      const dx = (e.clientX - d.startX) * scale, dD = -(dx / plotW) * (d.startDomain[1] - d.startDomain[0]);
      let a = d.startDomain[0] + dD, b = d.startDomain[1] + dD; const w = b - a;
      if (a < xMin) { a = xMin; b = a + w; } if (b > xMax) { b = xMax; a = b - w; }
      setDomain([a, b]);
    }
    if (d.type === 'handle') {
      const xVal = xInv(Math.max(pad.l, Math.min(pad.l + plotW, getSvgX(e))));
      setAnnotations(prev => prev.map(a => {
        if (a.id !== d.peakId) return a;
        const u = { ...a };
        if (d.handle === 'start') u.userStart = Math.min(xVal, a.userEnd - 0.002);
        else if (d.handle === 'end') u.userEnd = Math.max(xVal, a.userStart + 0.002);
        else u.userApex = Math.max(a.userStart, Math.min(a.userEnd, xVal));
        return u;
      }));
      forceRender(n => n + 1);
    }
  }, [plotW, xMin, xMax, xInv, getSvgX, setAnnotations]);

  const onSvgPointerUp = useCallback(e => {
    const ds = dragStateRef.current;
    if (ds?.type === 'handle') {
      // Read final position so we can record the magnitude of this edit.
      const ann = (allAnnotations[currentIdxRef.current] || []).find(a => a.id === ds.peakId);
      const endVal = ann ? (ds.handle === 'start' ? ann.userStart : ds.handle === 'end' ? ann.userEnd : ann.userApex) : null;
      const delta = (ds.startVal != null && endVal != null) ? (endVal - ds.startVal) : null;
      T.dragLog.push({
        time: Date.now() - T.sessionStart,
        chromIdx: currentIdxRef.current,
        peakId: ds.peakId,
        handle: ds.handle,
        from: ds.startVal,
        to: endVal,
        deltaAbs: delta != null ? Math.abs(delta) : null,
      });
      logEdit(`${ds.handle}_drag`, ds.peakId, {
        from: ds.startVal, to: endVal, deltaAbs: delta != null ? Math.abs(delta) : null,
      });
    }
    dragStateRef.current = null;
    try { svgRef.current?.releasePointerCapture(e.pointerId); } catch (_) {}
  }, [logEdit, allAnnotations]);

  const onHandleDown = useCallback((peakId, handle) => e => {
    e.stopPropagation(); e.preventDefault();
    // Remember starting value of whichever handle is being dragged so we can
    // compute the magnitude of the edit on pointer-up.
    const ann = (allAnnotations[currentIdxRef.current] || []).find(a => a.id === peakId);
    const startVal = ann ? (handle === 'start' ? ann.userStart : handle === 'end' ? ann.userEnd : ann.userApex) : null;
    dragStateRef.current = { type: 'handle', peakId, handle, startVal };
    svgRef.current?.setPointerCapture(e.pointerId);
    setSelectedPeakId(peakId);
  }, [allAnnotations]);

  const addPeak = useCallback(() => {
    const mid = (domain[0] + domain[1]) / 2, w = (domain[1] - domain[0]) * 0.04;
    const np = { id: `user_${Date.now()}`, apex: mid, signal: 0, start: mid - w, end: mid + w, confidence: null, label: `Peak @ ${fmt(mid)}`, userStart: mid - w, userEnd: mid + w, userApex: mid, deleted: false };
    setAnnotations(prev => [...prev, np]);
    setSelectedPeakId(np.id);
    logEdit("add_peak", np.id, { start: np.userStart, apex: np.userApex, end: np.userEnd, isAIPeak: false });
  }, [domain, annotations.length, setAnnotations, logEdit]);

  const deletePeak = useCallback((id, via = "panel") => {
    const doomed = (allAnnotations[currentIdxRef.current] || []).find(a => a.id === id);
    setAnnotations(prev => prev.map(a => a.id === id ? { ...a, deleted: true } : a));
    if (selectedPeakId === id) setSelectedPeakId(null);
    logEdit("delete_peak", id, doomed ? {
      start: doomed.userStart,
      apex: doomed.userApex,
      end: doomed.userEnd,
      confidence: doomed.confidence ?? null,
      isAIPeak: !id.startsWith("user_"),
      via,
    } : { via });
  }, [selectedPeakId, setAnnotations, logEdit, allAnnotations]);

  // ── Navigation (auto-saves current) ──
  const saveCurrentAndGo = useCallback((nextIdx) => {
    // Mark current as finished if not already
    setFinishedAt(prev => {
      const next = [...prev];
      if (!next[currentIdx]) next[currentIdx] = Date.now() - T.sessionStart;
      return next;
    });
    setCurrentIdx(nextIdx);
  }, [currentIdx]);

  const goNext = () => { if (currentIdx < datasets.length - 1) saveCurrentAndGo(currentIdx + 1); };
  const goPrev = () => { if (currentIdx > 0) saveCurrentAndGo(currentIdx - 1); };

  // ── Build Results Object ──
  const buildResults = () => {
    // Close any open chromatogram visit so we can sum visit durations exactly.
    // (We also still update `finishedAt` for the "first time the user left this
    // chromatogram" metric, which the old code tracked.)
    const now = Date.now() - T.sessionStart;
    const visits = T.chromVisits.map(v => ({ ...v, exit: v.exit == null ? now : v.exit }));

    const fa = [...finishedAt];
    if (!fa[currentIdx]) fa[currentIdx] = now;

    const clicks = T.allClickTimestamps.map(t => t - T.sessionStart); // normalize to session start
    let totalInterClick = 0;
    for (let i = 1; i < clicks.length; i++) totalInterClick += clicks[i] - clicks[i - 1];

    // ── Linear regression helper (used for several "rate of change" metrics) ──
    const linreg = (xs, ys) => {
      const n = xs.length;
      if (n < 2) return null;
      let sx = 0, sy = 0, sxy = 0, sxx = 0;
      for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxy += xs[i] * ys[i]; sxx += xs[i] * xs[i]; }
      const d = n * sxx - sx * sx;
      if (Math.abs(d) < 1e-12) return null;
      return (n * sxy - sx * sy) / d;
    };

    // ── Click frequency buckets (session-wide) ──
    // Divide the session into 30s buckets and count clicks per bucket. The
    // slope of this series answers "does the user click less over time?".
    const sessionDurMs = Math.max(1, now);
    const BUCKET_MS = 30_000;
    const nBuckets = Math.max(1, Math.ceil(sessionDurMs / BUCKET_MS));
    const clickBuckets = new Array(nBuckets).fill(0);
    for (const t of clicks) {
      const b = Math.min(nBuckets - 1, Math.floor(t / BUCKET_MS));
      clickBuckets[b]++;
    }
    // Clicks per minute slope: regress clicks-per-minute on bucket-midpoint time.
    const clickRateSeries = clickBuckets.map((c, i) => ({
      bucketStartMs: i * BUCKET_MS,
      bucketEndMs: Math.min((i + 1) * BUCKET_MS, sessionDurMs),
      clicks: c,
      clicksPerMinute: c / (Math.min(BUCKET_MS, sessionDurMs - i * BUCKET_MS) / 60_000),
    }));
    const clickRateSlopePerMin = clickRateSeries.length >= 2
      ? linreg(clickRateSeries.map((_, i) => i), clickRateSeries.map(b => b.clicksPerMinute))
      : null;

    // First-half vs second-half click rate (robust fatigue indicator).
    const half = sessionDurMs / 2;
    const firstHalfClicks = clicks.filter(t => t < half).length;
    const secondHalfClicks = clicks.length - firstHalfClicks;
    const firstHalfRate = firstHalfClicks / (half / 60_000);
    const secondHalfRate = secondHalfClicks / (half / 60_000);

    // ── Edit-order analysis ──
    // For each chromatogram, look at the sequence of peakIndex values in the
    // editLog (only edits that touched a specific peak, in time order).
    // Monotonicity score = fraction of consecutive pairs where index did not
    // decrease (1.0 = strict left-to-right, ~0.5 = random, near 0 = right-to-left).
    const computeMonotonicity = (seq) => {
      if (seq.length < 2) return null;
      let nondec = 0;
      for (let i = 1; i < seq.length; i++) if (seq[i] >= seq[i - 1]) nondec++;
      return nondec / (seq.length - 1);
    };

    // ── Per-chromatogram aggregates ──
    const perChrom = datasets.map((d, i) => {
      const ap = (allAnnotations[i] || []).filter(a => !a.deleted);
      const ap_all = allAnnotations[i] || [];
      const chromVisits = visits.filter(v => v.chromIdx === i);
      const totalActiveMs = chromVisits.reduce((s, v) => s + (v.exit - v.enter), 0);
      const visitCount = chromVisits.length;
      const revisitCount = Math.max(0, visitCount - 1);

      const chromClicks = T.clickLog.filter(c => c.chromIdx === i);
      const chromEdits = T.editLog.filter(e => e.chromIdx === i);
      const chromDrags = T.dragLog.filter(dr => dr.chromIdx === i);
      const chromHovers = T.hoverLog.filter(h => h.chromIdx === i);

      // Edit-order sequence for this chromatogram (by peakIndex).
      const orderSeq = chromEdits.filter(e => e.peakIndex != null).map(e => e.peakIndex);
      const monotonicity = computeMonotonicity(orderSeq);
      const uniquePeaksEdited = new Set(chromEdits.filter(e => e.peakId).map(e => e.peakId)).size;

      // Did the user return to a peak after editing a different one? (a
      // direct proxy for the "going back to edit previous annotations" pattern)
      let returnEditCount = 0;
      const lastSeen = {};
      for (let k = 0; k < chromEdits.length; k++) {
        const pid = chromEdits[k].peakId;
        if (!pid) continue;
        if (lastSeen[pid] != null && lastSeen[pid] !== k - 1) {
          // The previous edit of this peak was NOT the immediately prior edit
          // → they edited something else in between, then came back.
          // We only count this when a different peakId was edited between.
          const between = chromEdits.slice(lastSeen[pid] + 1, k)
            .some(e => e.peakId && e.peakId !== pid);
          if (between) returnEditCount++;
        }
        lastSeen[pid] = k;
      }

      // Drag magnitude stats (absolute time units).
      const dragDeltas = chromDrags.map(dr => dr.deltaAbs).filter(v => v != null);
      const meanDrag = dragDeltas.length ? dragDeltas.reduce((a, b) => a + b, 0) / dragDeltas.length : null;
      const maxDrag = dragDeltas.length ? Math.max(...dragDeltas) : null;

      // Re-edits: how many times the SAME (peakId, handle) got dragged more
      // than once. High = uncertainty / iterative refinement.
      const dragKeyCounts = {};
      for (const dr of chromDrags) {
        const k = `${dr.peakId}|${dr.handle}`;
        dragKeyCounts[k] = (dragKeyCounts[k] || 0) + 1;
      }
      const handleReEdits = Object.values(dragKeyCounts).reduce((s, v) => s + Math.max(0, v - 1), 0);

      // AI acceptance: for conditions where peaks were pre-populated by the AI,
      // what fraction of those initial peaks are still present and unmodified
      // at export time? (Undefined for "none" mode, which starts blank.)
      let aiStats = null;
      if (vizMode !== "none" && vizMode !== "no_ai" && d.peaks.length > 0) {
        const originalIds = new Set(d.peaks.map(p => p.id));
        let accepted = 0, modified = 0, deleted = 0;
        const byId = new Map(ap_all.map(a => [a.id, a]));
        for (const orig of d.peaks) {
          const cur = byId.get(orig.id);
          if (!cur || cur.deleted) { deleted++; continue; }
          const EPS = 1e-6;
          const unchanged =
            Math.abs(cur.userStart - orig.start) < EPS &&
            Math.abs(cur.userEnd - orig.end) < EPS &&
            Math.abs(cur.userApex - orig.apex) < EPS;
          if (unchanged) accepted++; else modified++;
        }
        const addedByUser = ap_all.filter(a => !originalIds.has(a.id) && !a.deleted).length;
        aiStats = {
          originalCount: d.peaks.length,
          accepted, modified, deleted, addedByUser,
          acceptanceRate: d.peaks.length > 0 ? accepted / d.peaks.length : null,
        };
      }

      // Per-chromatogram click-rate series (30s buckets over ACTIVE time).
      const chromBuckets = Math.max(1, Math.ceil(totalActiveMs / BUCKET_MS));
      const chromClickBuckets = new Array(chromBuckets).fill(0);
      // Map each click's session-time to its position within this chromatogram's
      // visit timeline (summing prior visits' active-time).
      for (const c of chromClicks) {
        // find which visit the click falls into
        let elapsed = 0;
        for (const v of chromVisits) {
          if (c.time >= v.enter && c.time < v.exit) {
            const within = elapsed + (c.time - v.enter);
            const b = Math.min(chromBuckets - 1, Math.floor(within / BUCKET_MS));
            chromClickBuckets[b]++;
            break;
          }
          elapsed += (v.exit - v.enter);
        }
      }
      const chromClickRateSlope = chromClickBuckets.length >= 2
        ? linreg(chromClickBuckets.map((_, k) => k), chromClickBuckets)
        : null;

      // Hover dwell stats (deliberation proxy).
      const hoverDurations = chromHovers.map(h => h.durationMs);
      const meanHoverMs = hoverDurations.length ? hoverDurations.reduce((a, b) => a + b, 0) / hoverDurations.length : null;
      const hoversWithoutClick = chromHovers.filter(h => !h.endedInClick).length;

      return {
        file: d.name,
        finishedAtMs: fa[i],                   // first exit time (preserved)
        totalActiveMs,                         // sum of all visits → total time editing this chromatogram
        visitCount,
        revisitCount,
        timeToFirstEditMs: T.firstEditPerChrom[i] != null
          ? T.firstEditPerChrom[i] - (chromVisits[0]?.enter ?? 0)
          : null,
        clickCount: chromClicks.length,
        editCount: chromEdits.length,
        uniquePeaksEdited,
        returnEditCount,                       // edits to a peak after editing another one
        editOrderMonotonicity: monotonicity,   // 1 = strict L→R, ~.5 = random
        editOrderSequence: orderSeq,           // raw sequence if you want to plot it
        dragStats: {
          count: chromDrags.length,
          meanAbsDelta: meanDrag,
          maxAbsDelta: maxDrag,
          handleReEdits,                       // same (peak, handle) dragged >1x
        },
        hoverStats: {
          count: chromHovers.length,
          meanDurationMs: meanHoverMs,
          hoversEndedInClick: chromHovers.filter(h => h.endedInClick).length,
          hoversWithoutClick,
        },
        clickRateBuckets: chromClickBuckets,   // per 30s of active time
        clickRateSlope: chromClickRateSlope,
        aiAcceptance: aiStats,                 // null for "none" mode
        annotations: (() => {
          const apActive = ap.filter(a => !a.deleted);
          const apSorted = [...apActive].sort((a, b) => a.userApex - b.userApex);
          const apLabelMap = new Map();
          apSorted.forEach((p, idx) => apLabelMap.set(p.id, `Peak @ ${fmt(p.userApex)}`));
          return ap.map(a => ({ id: a.id, label: apLabelMap.get(a.id) || a.label, start: a.userStart, apex: a.userApex, end: a.userEnd, confidence: a.confidence, deleted: !!a.deleted }));
        })(),
        visits: chromVisits,                   // raw visit list
      };
    });

    // ── Click target frequencies (session-wide) ──
    // How often was each kind of element clicked? Lets us spot condition
    // differences in interaction style (e.g., did explanation users click
    // peak rows more to read explanations?).
    const clickTargetCounts = {};
    for (const c of T.clickLog) {
      clickTargetCounts[c.target] = (clickTargetCounts[c.target] || 0) + 1;
    }

    // ── Session-wide edit-order monotonicity across all chromatograms ──
    // Computed per-chromatogram and averaged, since cross-chromatogram ordering
    // isn't meaningful (each chrom has its own peak set).
    const perChromMonotonicities = perChrom.map(c => c.editOrderMonotonicity).filter(v => v != null);
    const sessionMonotonicity = perChromMonotonicities.length
      ? perChromMonotonicities.reduce((a, b) => a + b, 0) / perChromMonotonicities.length
      : null;
    const totalReturnEdits = perChrom.reduce((s, c) => s + c.returnEditCount, 0);

    return {
      _tracker: T,   // stripped before upload; used by StudyFlow to log survey events
      userName,
      prolificPid: prolificParams?.prolificPid ?? null,
      studyId: prolificParams?.studyId ?? null,
      sessionId: prolificParams?.sessionId ?? null,
      visualizationMode: vizMode,
      sessionDurationMs: now,
      // Randomized presentation order — lets you reconstruct which
      // chromatogram each participant saw at each position.
      chromatogramOrder: datasets.map((ds, i) => ({ position: i + 1, name: ds.name, baseName: ds.baseName })),

      // ── Legacy top-level counters (preserved for backwards compatibility) ──
      totalClicks: T.totalClicks,
      totalAnnotationEdits: T.annotationEdits,
      totalIdleMs: T.totalIdleMs,
      avgInterClickMs: clicks.length > 1 ? totalInterClick / (clicks.length - 1) : 0,
      // ── Click-frequency / fatigue metrics (session-wide) ──
      clickFrequency: {
        bucketMs: BUCKET_MS,
        buckets: clickRateSeries,
        clickRateSlopePerMin,               // negative = slowing down over time
        firstHalfRatePerMin: firstHalfRate,
        secondHalfRatePerMin: secondHalfRate,
        firstVsSecondHalfRatio: firstHalfRate > 0 ? secondHalfRate / firstHalfRate : null,
      },

      // ── NEW: engagement / thoroughness summary ──
      engagement: {
        totalReturnEdits,                    // times the user went back to re-edit a previous peak
        sessionEditOrderMonotonicity: sessionMonotonicity, // ~1 linear, ~.5 jumpy
        clickTargetCounts,                   // histogram of what was clicked
      },

      // ── PRIMARY INTERACTION LOG — every meaningful user action in order ──
      // Each entry: { timeMs, chromIdx, type, peakId, peakSpatialIdx, details }
      // See createTracker() for full documentation of each event type.
      interactionLog: T.interactionLog,

      // ── Raw logs (keep everything — researcher can recompute anything) ──
      editLog:          T.editLog,
      clickLog:         T.clickLog,
      hoverLog:         T.hoverLog,
      zoomLog:          T.zoomLog,
      dragLog:          T.dragLog,
      chromVisits:      visits,
      clickTimestamps:  clicks,

      // ── NEW rich event streams ──
      // Every pointerdown and pointerup — distinguishes press from release,
      // includes screen coords, chart-space coords (time & signal value),
      // button identity, and the UI element that was targeted.
      pointerEventLog:  T.pointerEventLog,

      // Cursor position sampled at 500 ms intervals — spatial heatmap data.
      cursorSampleLog:  T.cursorSampleLog,

      // Snapshot of every peak (start/apex/end) taken when the participant
      // clicks "Finish" on each chromatogram, plus the viewport domain at
      // that moment.
      chromFinalStates: T.chromFinalStates,

      // Raw peak list sampled every 15 s — trajectory reconstruction backup.
      annotationSnapshots: T.annotationSnapshots,

      // ── Per-chromatogram structured summaries ──
      chromatograms: perChrom,
    };
  };

  // ── Export (standalone, without surveys) — local download only ──


  // ── Proceed to surveys ──
  const proceedToSurveys = () => {
    // Mark current chromatogram as finished
    setFinishedAt(prev => {
      const next = [...prev];
      if (!next[currentIdx]) next[currentIdx] = Date.now() - T.sessionStart;
      return next;
    });
    const results = buildResults();
    onStudyComplete(results);
  };

  const xTicks = useMemo(() => Array.from({ length: 9 }, (_, i) => domain[0] + (i / 8) * (domain[1] - domain[0])), [domain]);
  const yTicks = useMemo(() => Array.from({ length: 6 }, (_, i) => (i / 5) * yMax), [yMax]);

  // ── derived display flags ──────────────────────────────────────────────────
  // showConf: whether to show AI confidence icons/scores on the chart
  const showConf = vizMode !== "none" && vizMode !== "no_ai" && vizMode !== "peaks_only";
  // isAICondition: whether AI peaks are pre-loaded (includes peaks_only)
  const isAICondition = vizMode !== "none" && vizMode !== "no_ai";
  const isLastChrom = currentIdx === datasets.length - 1;

  // Always show both fill area AND badge (no toggle needed)
  const fillMode = true;

  // For the selected peak's bottom action panel
  const selPeak = selectedPeakId ? activePeaks.find(p => p.id === selectedPeakId) : null;
  const selEx   = selPeak ? (explanationMap.get(selPeak.id) || null) : null;
  const selHasExplanation = vizMode === "normal_explain" || vizMode === "counterfactual_explain";
  const selTxt  = selHasExplanation ? (selEx ? (vizMode === "normal_explain" ? selEx.feature : selEx.counterfactual) : "No explanation available.") : null;
  // For threshold_bars: use pre-parsed thresholds from JSON if available,
  // fall back to regex-parsing the feature explanation text.
  const selThresholds = (vizMode === "threshold_bars" && selEx)
    ? (selEx.thresholds || parseThresholdPcts(selEx.feature))
    : null;
  const selIsUserPeak = selPeak?.id?.startsWith("user_");

  // Task banner copy (condition-aware)
  const taskSteps = vizMode === "none" || vizMode === "no_ai"
    ? [
        { n: 1, label: "Find peaks", desc: "Look for signal rises above the baseline" },
        { n: 2, label: "Add each one", desc: "Click \"+ Add Peak\" then drag handles to fit" },
        { n: 3, label: "Move to next", desc: "When done, click \"Finish & Start Next\"" },
      ]
    : vizMode === "peaks_only"
    ? [
        { n: 1, label: "Review AI peaks", desc: "Shaded regions show where the AI detected peaks" },
        { n: 2, label: "Keep, edit, or remove", desc: "Adjust boundaries or delete false detections" },
        { n: 3, label: "Add any it missed", desc: "Use \"+ Add Peak\" if the AI missed one" },
      ]
    : [
        { n: 1, label: "Review each peak", desc: "The AI detected the numbered peaks on the chart" },
        { n: 2, label: "Keep, edit, or remove", desc: "Click a peak badge to inspect and decide" },
        { n: 3, label: "Add any it missed", desc: "Use \"+ Add Peak\" if the AI missed one" },
      ];

  // Action descriptions shown in the bottom panel
  const actionInfo = {
    keep: { label: "Keep Peak", emoji: "✓", color: "#059669", bg: "#ecfdf5", border: "#6ee7b7", desc: "The boundaries look correct — accept this detection as-is." },
    edit: { label: "Edit Boundaries", emoji: "✏", color: "#1e40af", bg: "#eff6ff", border: "#93c5fd", desc: "Drag the ◀ Start, ◆ Apex, and ▶ End handles below the chart to adjust where the peak begins and ends." },
    remove: { label: "Remove Peak", emoji: "✕", color: "#dc2626", bg: "#fef2f2", border: "#fca5a5", desc: vizMode === "none" || vizMode === "no_ai" ? "Delete this peak if it does not belong here." : "Delete this detection if it is NOT a real peak (false positive)." },
  };

  // Chart dimensions — full-width responsive via viewBox
  const FW = 1100, FH = 380;
  const fpad = { l: 64, r: 24, t: 24, b: 56 };
  const fplotW = FW - fpad.l - fpad.r;
  const fplotH = FH - fpad.t - fpad.b;
  const fhandleY = fpad.t + fplotH + 22;

  // Recompute scale functions for the full-width chart
  const fxScale = useCallback(v => fpad.l + ((v - domain[0]) / (domain[1] - domain[0] || 1)) * fplotW, [domain, fplotW]);
  const fxInv   = useCallback(px => domain[0] + ((px - fpad.l) / fplotW) * (domain[1] - domain[0]), [domain, fplotW]);
  const fyScale = useCallback(v => fpad.t + fplotH - (v / yMax) * fplotH, [yMax, fplotH]);

  // Build a filled-area SVG path along the real signal for a peak window.
  // Must be defined after fxScale/fyScale/fpad/fplotH.
  const buildPeakAreaPath = useCallback((pk) => {
    const plotBottom = fpad.t + fplotH;
    const pts = displayData.filter(d => d[0] >= pk.userStart && d[0] <= pk.userEnd);
    if (pts.length < 2) {
      const x0 = fxScale(pk.userStart), x1 = fxScale(pk.userEnd);
      return `M${x0},${plotBottom} L${x0},${fpad.t} L${x1},${fpad.t} L${x1},${plotBottom} Z`;
    }
    const top = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${fxScale(p[0]).toFixed(1)},${fyScale(p[1]).toFixed(1)}`).join(' ');
    const x1 = fxScale(pts[pts.length - 1][0]).toFixed(1);
    const x0 = fxScale(pts[0][0]).toFixed(1);
    return `${top} L${x1},${plotBottom} L${x0},${plotBottom} Z`;
  }, [displayData, fxScale, fyScale, fpad.t, fplotH]);

  const fPathD = useMemo(() => {
    const pts = displayData.filter(d => d[0] >= domain[0] - 0.2 && d[0] <= domain[1] + 0.2);
    if (!pts.length) return "";
    return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${fxScale(p[0]).toFixed(1)},${fyScale(p[1]).toFixed(1)}`).join(' ');
  }, [displayData, domain, fxScale, fyScale]);

  const fCtxH = 48;
  const fCtxXScale = useCallback(v => fpad.l + ((v - xMin) / (xMax - xMin || 1)) * fplotW, [fplotW, xMin, xMax]);
  const fCtxYScale = useCallback(v => 5 + (fCtxH - 12) - (v / yMax) * (fCtxH - 12), [yMax]);
  const fCtxPath = useMemo(() => {
    const step = Math.max(1, Math.floor(displayData.length / 500));
    return displayData.filter((_, i) => i % step === 0)
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${fCtxXScale(p[0]).toFixed(1)},${fCtxYScale(p[1]).toFixed(1)}`).join(' ');
  }, [displayData, fCtxXScale, fCtxYScale]);

  // Keep domain in a ref so pointermove can always compute fxInv with current values
  // without depending on stale useCallback closures or useEffect-lagged refs.
  useEffect(() => { domainRef.current = domain; }, [domain]);

  // Keep refs to hot-path scale functions so the pointer-move handler never
  // closes over stale values — avoids the handle lag/jump on each re-render.
  const fxInvRef = useRef(fxInv);
  const fxScaleRef = useRef(fxScale);


  useEffect(() => { fxInvRef.current = fxInv; }, [fxInv]);
  useEffect(() => { fxScaleRef.current = fxScale; }, [fxScale]);
  useEffect(() => { fpadRef.current = fpad; }, [fpad]);
  useEffect(() => { fplotWRef.current = fplotW; }, [fplotW]);
  useEffect(() => { yMaxRef.current = yMax; }, [yMax]);

  // svgCallbackRef attaches the wheel listener the moment the SVG element
  // enters the DOM — fixes the race condition where useEffect([]) ran before
  // the SVG was mounted and the listener never attached.
  const wheelHandlerRef = useRef(null);
  const svgCallbackRef = useCallback(el => {
    if (wheelHandlerRef.current && svgRef.current) {
      svgRef.current.removeEventListener('wheel', wheelHandlerRef.current);
    }
    svgRef.current = el;
    if (!el) return;
    const handler = (e) => fOnWheelRef.current(e);
    wheelHandlerRef.current = handler;
    el.addEventListener('wheel', handler, { passive: false });
  }, []);

  // fGetSvgX converts clientX to SVG viewBox coordinates.
  const fGetSvgX = useCallback(e => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return 0;
    return (e.clientX - r.left) * (FW / r.width);
  }, []);

  // Override original handlers to use full-width scales
  const fOnWheel = useCallback(e => {
    e.preventDefault();
    const r = svgRef.current?.getBoundingClientRect(); if (!r) return;
    const scale = FW / r.width;
    const anchor = fxInv((e.clientX - r.left) * scale);
    const factor = e.deltaY > 0 ? 0.82 : 1.22;
    const w = domain[1] - domain[0], nw = Math.max(0.1, Math.min(xMax - xMin, w / factor));
    const a0 = (anchor - domain[0]) / w;
    let a = anchor - a0 * nw, b = a + nw;
    if (a < xMin) { a = xMin; b = a + nw; } if (b > xMax) { b = xMax; a = b - nw; }
    setDomain([a, b]);
    // Log zoom event to interaction log
    const _zoomMs = Date.now() - T.sessionStart;
    pushInteraction(T, "zoom", currentIdxRef.current, null, null, {
      domainBefore: [domain[0], domain[1]],
      domainAfter:  [a, b],
      widthBefore:  w,
      widthAfter:   nw,
      anchorChartX: anchor,
      direction:    e.deltaY > 0 ? "in" : "out",
      timeMs:       _zoomMs,
    });
    T.zoomLog.push({ time: _zoomMs, chromIdx: currentIdxRef.current,
      domainStart: a, domainEnd: b, width: nw,
      direction: e.deltaY > 0 ? "in" : "out", anchorChartX: anchor });
  }, [domain, fxInv, xMax, xMin]);

  const fOnSvgPointerDown = useCallback(e => {
    // Never overwrite an active handle drag — stopPropagation should prevent
    // this, but guard here too in case of SVG event bubbling edge cases.
    if (dragStateRef.current?.type === 'handle') return;

    let el = e.target;
    while (el && el !== e.currentTarget) {
      const track = el.dataset?.track;
      if (track && (track.includes('confidence') || track.includes('icon') || track.includes('handle') || track.includes('peak_icon'))) return;
      el = el.parentElement;
    }
    const r = svgRef.current?.getBoundingClientRect();
    const scale = r ? FW / r.width : 1;
    const svgPx = r ? (e.clientX - r.left) * scale : 0;
    const chartX = fxInv(svgPx);

    // Select the peak whose apex is closest to the click position.
    // This is evaluated on pointerUp (not here) so we can tell if it was a click vs pan.

    // Store click position for potential peak selection on pointer up
    dragStateRef.current = { type: 'pan', startX: e.clientX, startDomain: [...domain], clickChartX: chartX, hasMoved: false };
    svgRef.current?.setPointerCapture(e.pointerId);
  }, [domain, fxInv]);

  const fOnSvgPointerMove = useCallback(e => {
    const d = dragStateRef.current; if (!d) return;
    const r = svgRef.current?.getBoundingClientRect();
    const viewScale = r ? FW / r.width : 1;

    if (d.type === 'pan') {
      const dx = (e.clientX - d.startX) * viewScale;
      const pw = fplotWRef.current;
      const dD = -(dx / pw) * (d.startDomain[1] - d.startDomain[0]);
      let a = d.startDomain[0] + dD, b = d.startDomain[1] + dD; const w = b - a;
      if (a < xMin) { a = xMin; b = a + w; } if (b > xMax) { b = xMax; a = b - w; }
      setDomain([a, b]);
      if (!d.hasMoved && Math.abs(dx) > 4) d.hasMoved = true;
    }

    if (d.type === 'handle') {
      // Compute fxInv inline from live refs — no stale closure possible
      const pad = fpadRef.current, pw = fplotWRef.current;
      const dom = domainRef.current;
      const svgX = r ? (e.clientX - r.left) * viewScale : 0;
      const clampedX = Math.max(pad.l, Math.min(pad.l + pw, svgX));
      const rawVal = dom[0] + ((clampedX - pad.l) / pw) * (dom[1] - dom[0]);
      // Subtract the offset so the handle stays under the original click spot
      const xVal = rawVal - (d.cursorOffset ?? 0);

      setAnnotations(prev => prev.map(a => {
        if (a.id !== d.peakId) return a;
        const u = { ...a };
        if (d.handle === 'start') u.userStart = Math.min(xVal, a.userEnd - 0.002);
        else if (d.handle === 'end') u.userEnd = Math.max(xVal, a.userStart + 0.002);
        else u.userApex = Math.max(a.userStart, Math.min(a.userEnd, xVal));
        return u;
      }));
      forceRender(n => n + 1);
    }
  }, [xMin, xMax, setAnnotations]);

  const fOnSvgPointerUp = useCallback(e => {
    const ds = dragStateRef.current;
    if (ds?.type === 'handle') {
      const ann = (allAnnotations[currentIdxRef.current] || []).find(a => a.id === ds.peakId);
      const endVal = ann ? (ds.handle === 'start' ? ann.userStart : ds.handle === 'end' ? ann.userEnd : ann.userApex) : null;
      const delta = (ds.startVal != null && endVal != null) ? (endVal - ds.startVal) : null;
      T.dragLog.push({ time: Date.now() - T.sessionStart, chromIdx: currentIdxRef.current, peakId: ds.peakId, handle: ds.handle, from: ds.startVal, to: endVal, deltaAbs: delta != null ? Math.abs(delta) : null });
      logEdit("end_drag", ds.peakId, {
        handle: ds.handle,
        from: ds.startVal,
        to: endVal,
        deltaAbs: delta != null ? Math.abs(delta) : null,
        allBoundariesAfter: ann ? { start: ann.userStart, apex: ann.userApex, end: ann.userEnd } : null,
        allBoundariesAtStart: ds.boundariesAtStart ?? null,
      });
    } else if (ds?.type === 'pan') {
      if (ds.hasMoved) {
        logEdit("pan", null, {
          domainBefore: ds.startDomain,
          domainAfter: [...domain],
        });
      } else {
        // True click (no drag) — select closest peak by apex
        const chartX = ds.clickChartX;
        if (activePeaks.length > 0) {
          const hit = activePeaks.reduce((a, b) => Math.abs(a.userApex - chartX) <= Math.abs(b.userApex - chartX) ? a : b);
          const nextId = hit.id === selectedPeakId ? null : hit.id;
          setSelectedPeakId(nextId);
          if (nextId) { const mid = hit.userApex; const w = domain[1] - domain[0]; setDomain([mid - w/2, mid + w/2]); }
          logEdit("select_peak", hit.id, { via: "region", start: hit.userStart, apex: hit.userApex, end: hit.userEnd });
        } else {
          logEdit("chart_click", null, { chartX, pixelX: e.clientX, pixelY: e.clientY, wasPan: false });
        }
      }
    }
    dragStateRef.current = null;
    try { svgRef.current?.releasePointerCapture(e.pointerId); } catch (_) {}
  }, [logEdit, allAnnotations, domain]);

  const fOnHandleDown = useCallback((peakId, handle) => e => {
    e.stopPropagation(); e.preventDefault();
    const ann = (allAnnotations[currentIdxRef.current] || []).find(a => a.id === peakId);
    const startVal = ann ? (handle === 'start' ? ann.userStart : handle === 'end' ? ann.userEnd : ann.userApex) : null;
    const boundariesAtStart = ann ? { start: ann.userStart, apex: ann.userApex, end: ann.userEnd } : null;
    // Compute cursor offset relative to the handle's current data value so the
    // handle doesn't snap to the cursor on the first move — it stays under the
    // spot where the user clicked and moves relative to that.
    const r = svgRef.current?.getBoundingClientRect();
    const viewScale = r ? FW / r.width : 1;
    const pad = fpadRef.current, pw = fplotWRef.current, dom = domainRef.current;
    const svgX = r ? (e.clientX - r.left) * viewScale : 0;
    const cursorVal = dom[0] + ((svgX - pad.l) / pw) * (dom[1] - dom[0]);
    const cursorOffset = startVal != null ? cursorVal - startVal : 0;
    dragStateRef.current = { type: 'handle', peakId, handle, startVal, boundariesAtStart, cursorOffset };
    svgRef.current?.setPointerCapture(e.pointerId);
    setSelectedPeakId(peakId);
    // Log start_drag immediately
    const peakIdx = spatialIndexOf(peakId);
    pushInteraction(T, "start_drag", currentIdxRef.current, peakId, peakIdx, {
      handle,
      valueAtDragStart: startVal,
      allBoundariesAtStart: boundariesAtStart,
    });
  }, [allAnnotations, spatialIndexOf]);

  // Use a ref to hold the latest fOnWheel so the event listener never needs
  // to be re-registered (re-registration creates a brief gap where scroll falls through).
  const fOnWheelRef = useRef(fOnWheel);
  useEffect(() => { fOnWheelRef.current = fOnWheel; }, [fOnWheel]);

  const xTicksF = useMemo(() => Array.from({ length: 9 }, (_, i) => domain[0] + (i / 8) * (domain[1] - domain[0])), [domain]);
  const yTicksF = useMemo(() => Array.from({ length: 6 }, (_, i) => (i / 5) * yMax), [yMax]);

  return (
    <div style={{ fontFamily: "'IBM Plex Sans',system-ui,sans-serif", background: "#f0f2f5", minHeight: "100vh" }}>
      {showTutorial && <TutorialScreen vizMode={vizMode} onDismiss={() => setShowTutorial(false)} />}
      {showTutorial ? null : (<>

      {/* ── Header ── */}
      <div style={{ background: "linear-gradient(135deg,#1a1a2e,#16213e)", padding: "10px 20px", color: "#fff", display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: -.2 }}>
            Chromatogram Peak Annotator
          </div>
          <div style={{ fontSize: 11, opacity: .5, marginTop: 1 }}>
          </div>
        </div>

        <button onClick={() => setShowTutorial(true)} data-track="open_tutorial"
          style={{ padding: "5px 10px", borderRadius: 7, border: "1px solid rgba(255,255,255,.18)", background: "rgba(255,255,255,.05)", color: "rgba(255,255,255,.55)", fontSize: 11, cursor: "pointer" }}>?</button>
      </div>

      {/* ── Task reminder banner ── */}
      <div style={{ background: "#fff", borderBottom: "2px solid #e5e7eb", padding: "10px 20px", display: "flex", alignItems: "center", gap: 0 }}>
        {taskSteps.map((s, si) => (
          <div key={s.n} style={{ display: "flex", alignItems: "center", gap: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 14px 6px 10px" }}>
              <div style={{ width: 26, height: 26, borderRadius: "50%", background: "#1e40af", color: "#fff", fontSize: 12, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{s.n}</div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#1e293b", lineHeight: 1.2 }}>{s.label}</div>
                <div style={{ fontSize: 11, color: "#64748b", lineHeight: 1.2 }}>{s.desc}</div>
              </div>
            </div>
            {si < taskSteps.length - 1 && (
              <div style={{ color: "#cbd5e1", fontSize: 18, lineHeight: 1, padding: "0 2px" }}>›</div>
            )}
          </div>
        ))}
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button onClick={() => {
            pushInteraction(T, "reset_zoom", currentIdxRef.current, null, null, { domainBefore: [domain[0], domain[1]] });
            setDomain([xMin, xMax]);
          }} data-track="reset_zoom"
            style={{ padding: "5px 12px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", border: "1px solid #d1d5db", background: "#f9fafb", color: "#374151" }}>Reset Zoom</button>
          <span style={{ fontSize: 11, color: "#94a3b8", whiteSpace: "nowrap" }}>{activePeaks.length} peak{activePeaks.length !== 1 ? "s" : ""} annotated</span>
        </div>
      </div>

      {/* ── Legend strip (AI conditions only) ── */}
      {showConf && (
        <div style={{ background: "#f8fafc", borderBottom: "1px solid #e5e7eb", padding: "6px 20px", display: "flex", alignItems: "center", gap: 16, fontSize: 11, color: "#64748b", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700, color: "#374151", fontSize: 11 }}>Legend:</span>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <svg width={12} height={14}><polygon points="0,2 0,12 10,7" fill="#1e40af" /></svg>
            Start boundary
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <svg width={14} height={14}><polygon points="7,0 14,7 7,14 0,7" fill="#1e40af" /></svg>
            Apex (peak top)
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <svg width={12} height={14}><polygon points="12,2 12,12 2,7" fill="#1e40af" /></svg>
            End boundary
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {fillMode ? (
              <svg width={48} height={14}>
                <defs>
                  <linearGradient id="conf-grad-legend" x1="0" x2="1" y1="0" y2="0">
                    <stop offset="0%" stopColor="hsl(0,75%,38%)" stopOpacity="0.35" />
                    <stop offset="50%" stopColor="hsl(60,75%,38%)" stopOpacity="0.35" />
                    <stop offset="100%" stopColor="hsl(120,75%,38%)" stopOpacity="0.35" />
                  </linearGradient>
                </defs>
                <rect x={0} y={2} width={48} height={10} rx={3} fill="url(#conf-grad-legend)" stroke="hsl(60,75%,38%)" strokeWidth={0.5} />
              </svg>
            ) : (
              <span style={{ width: 48, height: 10, borderRadius: 5, background: "linear-gradient(90deg,hsl(0,75%,38%),hsl(60,75%,38%),hsl(120,75%,38%))", display: "inline-block" }} />
            )}
            AI Confidence (low → high)
          </span>
          <span style={{ color: "#94a3b8" }}>
            · Click a badge on the chart or a pill below to select · Drag handles to adjust · Scroll to zoom · Drag chart to pan · Click \u2715 on a pill to delete
          </span>
        </div>
      )}
      {!showConf && (
        <div style={{ background: "#f8fafc", borderBottom: "1px solid #e5e7eb", padding: "6px 20px", display: "flex", alignItems: "center", gap: 16, fontSize: 11, color: "#64748b", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700, color: "#374151", fontSize: 11 }}>Legend:</span>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <svg width={12} height={14}><polygon points="0,2 0,12 10,7" fill="#1e40af" /></svg>
            Start boundary
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <svg width={14} height={14}><polygon points="7,0 14,7 7,14 0,7" fill="#1e40af" /></svg>
            Apex (peak top)
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <svg width={12} height={14}><polygon points="12,2 12,12 2,7" fill="#1e40af" /></svg>
            End boundary
          </span>
          <span style={{ color: "#94a3b8" }}>· Scroll to zoom · Drag to pan · Click a peak in the list below to select and edit it</span>
        </div>
      )}

      {/* ── Full-width chart card ── */}
      <div style={{ padding: "12px 20px 0" }}>
        <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb", overflow: "hidden" }}>
          <svg ref={svgCallbackRef} viewBox={`0 0 ${FW} ${FH}`} width="100%" height={FH} data-track="chart_background"
            style={{ display: "block", cursor: "grab", touchAction: "none", userSelect: "none" }}
            onPointerDown={fOnSvgPointerDown} onPointerMove={fOnSvgPointerMove}
            onPointerUp={fOnSvgPointerUp} onPointerLeave={fOnSvgPointerUp}>

            {/* Grid */}
            {yTicksF.map((v, i) => <line key={`yg${i}`} x1={fpad.l} x2={fpad.l + fplotW} y1={fyScale(v)} y2={fyScale(v)} stroke="#f1f5f9" />)}
            {xTicksF.map((v, i) => <line key={`xg${i}`} x1={fxScale(v)} x2={fxScale(v)} y1={fpad.t} y2={fpad.t + fplotH} stroke="#f1f5f9" />)}
            <line x1={fpad.l} x2={fpad.l} y1={fpad.t} y2={fpad.t + fplotH} stroke="#cbd5e1" />
            <line x1={fpad.l} x2={fpad.l + fplotW} y1={fpad.t + fplotH} y2={fpad.t + fplotH} stroke="#cbd5e1" />
            {yTicksF.map((v, i) => <text key={`yt${i}`} x={fpad.l - 6} y={fyScale(v) + 4} textAnchor="end" fontSize={11} fill="#94a3b8">{v.toFixed(0)}</text>)}
            {xTicksF.map((v, i) => <text key={`xt${i}`} x={fxScale(v)} y={fpad.t + fplotH + 14} textAnchor="middle" fontSize={11} fill="#94a3b8">{fmt(v)}</text>)}
            <text x={fpad.l + fplotW / 2} y={FH - 2} textAnchor="middle" fontSize={12} fontWeight={600} fill="#64748b">Time</text>
            <text x={13} y={fpad.t + fplotH / 2} textAnchor="middle" fontSize={12} fontWeight={600} fill="#64748b" transform={`rotate(-90,13,${fpad.t + fplotH / 2})`}>Intensity</text>

            {/* Confidence fill areas — rendered BELOW the chromatogram line */}
            {fillMode && showConf && activePeaks.map(pk => {
              const isUserPk = pk.id.startsWith("user_");
              if (isUserPk || pk.confidence == null) return null;
              const x0 = fxScale(pk.userStart), x1 = fxScale(pk.userEnd);
              if (x1 < fpad.l || x0 > fpad.l + fplotW) return null;
              const sel = pk.id === selectedPeakId, hov = pk.id === hoveredPeakId;
              const hue = confHue(pk.confidence);
              const baseOpacity = sel ? 0.45 : hov ? 0.38 : 0.25;
              const strokeOpacity = sel ? 0.8 : hov ? 0.6 : 0.4;
              const areaPath = buildPeakAreaPath(pk);
              return (
                <g key={`fill${pk.id}`}
                  data-track="confidence_fill" data-peak-id={pk.id}
                  style={{ cursor: "pointer", pointerEvents: "auto" }}
                  onPointerEnter={() => beginHover(pk.id)} onPointerLeave={() => endHover(false)}
                  onClick={e => { e.stopPropagation(); endHover(true); setSelectedPeakId(pk.id === selectedPeakId ? null : pk.id); logEdit("select_peak", pk.id, { via: "fill", confidence: pk.confidence, start: pk.userStart, apex: pk.userApex, end: pk.userEnd }); }}>
                  <path d={areaPath}
                    fill={`hsla(${hue},75%,45%,${baseOpacity})`}
                    stroke={`hsla(${hue},75%,35%,${strokeOpacity})`}
                    strokeWidth={sel ? 1.5 : 1}
                    style={{ pointerEvents: "visible" }} />
                </g>
              );
            })}

            {/* Peaks-only: no fill, selection border only */}
            {vizMode === "peaks_only" && activePeaks.filter(pk => !pk.id.startsWith("user_")).map(pk => {
              const x0 = Math.max(fxScale(pk.userStart), fpad.l);
              const x1 = Math.min(fxScale(pk.userEnd), fpad.l + fplotW);
              if (x1 <= x0) return null;
              const sel = pk.id === selectedPeakId;
              return (
                <rect key={`hit${pk.id}`}
                  x={x0} y={fpad.t} width={x1 - x0} height={fplotH}
                  fill="transparent"
                  stroke={sel ? "#1e40af" : "none"} strokeWidth={sel ? 1.5 : 0}
                  data-track="peaks_only_fill" data-peak-id={pk.id}
                  style={{ cursor: "pointer", pointerEvents: "visible" }}
                  onPointerEnter={() => beginHover(pk.id)} onPointerLeave={() => endHover(false)}
                  onClick={e => { e.stopPropagation(); endHover(true); setSelectedPeakId(pk.id === selectedPeakId ? null : pk.id); logEdit("select_peak", pk.id, { via: "fill", start: pk.userStart, apex: pk.userApex, end: pk.userEnd }); }} />
              );
            })}

            {/* Chromatogram line */}
            <path d={fPathD} fill="none" stroke="#1e293b" strokeWidth={1.5} strokeLinejoin="round" />

            {/* Peaks */}
            {activePeaks.map(pk => {
              const aPx = fxScale(pk.userApex), sPx = fxScale(pk.userStart), ePx = fxScale(pk.userEnd);
              if (aPx < fpad.l - 30 || aPx > fpad.l + fplotW + 30) return null;
              const sel = pk.id === selectedPeakId, hov = pk.id === hoveredPeakId;
              const visible = sel || hov;
              const iconY = Math.min(fyScale(pk.signal || 0) - 22, fpad.t + 34);
              const isUserPk = pk.id.startsWith("user_");

              return <g key={`m${pk.id}`}>
                {/* Boundary lines & handle track */}
                {visible && <>
                  <line x1={sPx} x2={sPx} y1={fpad.t} y2={fpad.t + fplotH} stroke="#1e40af" strokeWidth={sel ? 1.5 : 1} strokeDasharray="3 2" opacity={sel ? .75 : .4} />
                  <line x1={aPx} x2={aPx} y1={fpad.t} y2={fpad.t + fplotH} stroke="#1e40af" strokeWidth={sel ? 1.8 : 1} opacity={sel ? .5 : .3} />
                  <line x1={ePx} x2={ePx} y1={fpad.t} y2={fpad.t + fplotH} stroke="#1e40af" strokeWidth={sel ? 1.5 : 1} strokeDasharray="3 2" opacity={sel ? .75 : .4} />
                  <rect x={Math.min(sPx, ePx)} y={fhandleY - 2} width={Math.max(4, Math.abs(ePx - sPx))} height={4} rx={2}
                    fill={sel ? "rgba(59,130,246,.25)" : "rgba(100,116,139,.12)"} style={{ pointerEvents: "none" }} />
                </>}

                {/* Drag handles — selected only */}
                {sel && <>
                  <g data-track="handle_start" data-peak-id={pk.id} data-handle="start"
                    onPointerDown={fOnHandleDown(pk.id, 'start')} style={{ cursor: "ew-resize", pointerEvents: "auto" }}>
                    <circle cx={sPx} cy={fhandleY} r={16} fill="transparent" />
                    <polygon points={`${sPx - 9},${fhandleY - 9} ${sPx - 9},${fhandleY + 9} ${sPx + 6},${fhandleY}`} fill="#1e40af" stroke="#fff" strokeWidth={1} />
                  </g>
                  <g data-track="handle_apex" data-peak-id={pk.id} data-handle="apex"
                    onPointerDown={fOnHandleDown(pk.id, 'apex')} style={{ cursor: "ew-resize", pointerEvents: "auto" }}>
                    <circle cx={aPx} cy={fhandleY} r={16} fill="transparent" />
                    <polygon points={`${aPx},${fhandleY - 10} ${aPx + 8},${fhandleY} ${aPx},${fhandleY + 10} ${aPx - 8},${fhandleY}`} fill="#1e40af" stroke="#fff" strokeWidth={1} />
                  </g>
                  <g data-track="handle_end" data-peak-id={pk.id} data-handle="end"
                    onPointerDown={fOnHandleDown(pk.id, 'end')} style={{ cursor: "ew-resize", pointerEvents: "auto" }}>
                    <circle cx={ePx} cy={fhandleY} r={16} fill="transparent" />
                    <polygon points={`${ePx + 9},${fhandleY - 9} ${ePx + 9},${fhandleY + 9} ${ePx - 6},${fhandleY}`} fill="#1e40af" stroke="#fff" strokeWidth={1} />
                  </g>
                </>}

                {/* Confidence badge — always shown and clickable when showConf is true */}
                {showConf && !isUserPk && pk.confidence != null ? (
                  <g data-track="confidence_icon" data-peak-id={pk.id}
                    style={{ cursor: "pointer", pointerEvents: "auto" }}
                    onPointerEnter={() => beginHover(pk.id)} onPointerLeave={() => endHover(false)}
                    onClick={e => { e.stopPropagation(); endHover(true); setSelectedPeakId(pk.id === selectedPeakId ? null : pk.id); logEdit("badge_click", pk.id, { via: "badge", confidence: pk.confidence, start: pk.userStart, apex: pk.userApex, end: pk.userEnd }); }}>
                    <rect x={aPx - 16} y={iconY - 10} width={32} height={20} rx={10}
                      fill={sel ? confBg(pk.confidence) : "#fff"}
                      stroke={confColor(pk.confidence)} strokeWidth={sel ? 2 : 1.5} />
                    <text x={aPx} y={iconY + 4} textAnchor="middle" fontSize={10} fontWeight={700} fill={confColor(pk.confidence)}>{pk.confidence}</text>
                  </g>
                ) : showConf && isUserPk ? (
                  <g data-track="user_peak_icon" data-peak-id={pk.id}
                    style={{ cursor: "pointer", pointerEvents: "auto" }}
                    onClick={e => { e.stopPropagation(); setSelectedPeakId(pk.id === selectedPeakId ? null : pk.id); logEdit("select_peak", pk.id, { via: "badge", start: pk.userStart, apex: pk.userApex, end: pk.userEnd }); }}>
                    <rect x={aPx - 14} y={iconY - 10} width={28} height={20} rx={10}
                      fill={sel ? "#ecfdf5" : "#fff"} stroke="#059669" strokeWidth={sel ? 2 : 1.5} />
                    <text x={aPx} y={iconY + 4} textAnchor="middle" fontSize={9} fontWeight={700} fill="#059669">+</text>
                  </g>
                ) : !showConf ? (
                  <g data-track="peak_icon_noai" data-peak-id={pk.id}
                    style={{ cursor: "pointer", pointerEvents: "auto" }}
                    onPointerEnter={() => beginHover(pk.id)} onPointerLeave={() => endHover(false)}
                    onClick={e => { e.stopPropagation(); endHover(true); setSelectedPeakId(pk.id === selectedPeakId ? null : pk.id); logEdit("badge_click", pk.id, { via: "badge", start: pk.userStart, apex: pk.userApex, end: pk.userEnd }); }}>
                    <circle cx={aPx} cy={iconY} r={10}
                      fill={sel ? "#eff6ff" : "#fff"} stroke="#1e40af" strokeWidth={sel ? 2 : 1.5} />
                    <text x={aPx} y={iconY + 4} textAnchor="middle" fontSize={9} fontWeight={700} fill="#1e40af">P</text>
                  </g>
                ) : null}

                {/* Peak label — hovered or selected */}
                {visible && <text x={aPx + 18} y={fpad.t + 20} fontSize={11} fill={sel ? "#1e40af" : "#94a3b8"} fontWeight={sel ? 600 : 400} style={{ pointerEvents: "none" }}>{peakLabel.get(pk.id) || pk.label}</text>}
              </g>;
            })}

            {/* Peak region hit targets — rendered LAST so they sit on top and
                always receive clicks regardless of what's underneath. Transparent
                fill so they don't obscure the signal or badges visually. */}
            {activePeaks.map(pk => {
              const x0 = Math.max(fxScale(pk.userStart), fpad.l), x1 = Math.min(fxScale(pk.userEnd), fpad.l + fplotW);
              if (x1 < fpad.l || x0 > fpad.l + fplotW) return null;
              const sel = pk.id === selectedPeakId, hov = pk.id === hoveredPeakId;
              return <rect key={`hit${pk.id}`} x={x0} y={fpad.t} width={Math.max(2, x1 - x0)} height={fplotH}
                data-track="peak_shaded_region" data-peak-id={pk.id}
                fill="transparent"
                stroke={sel ? "rgba(59,130,246,.4)" : hov ? "rgba(100,116,139,.2)" : "none"}
                strokeWidth={sel ? 1.5 : 1}
                style={{ cursor: "pointer", pointerEvents: "visible" }}
                onPointerEnter={() => beginHover(pk.id)} onPointerLeave={() => endHover(false)}
                onClick={e => { e.stopPropagation(); endHover(true); const nextId = pk.id === selectedPeakId ? null : pk.id; setSelectedPeakId(nextId); if (nextId) { const mid = pk.userApex; const w = domain[1] - domain[0]; setDomain([mid - w/2, mid + w/2]); } logEdit("select_peak", pk.id, { via: "region", start: pk.userStart, apex: pk.userApex, end: pk.userEnd }); }} />;
            })}
          </svg>

          {/* Mini-map context strip */}
          <div style={{ borderTop: "1px solid #e5e7eb", background: "#fafafa" }}>
            <svg viewBox={`0 0 ${FW} ${fCtxH}`} width="100%" height={fCtxH} style={{ display: "block" }}>
              <path d={fCtxPath} fill="none" stroke="#94a3b8" strokeWidth={1} />
              <rect x={fCtxXScale(domain[0])} y={3} width={Math.max(4, fCtxXScale(domain[1]) - fCtxXScale(domain[0]))} height={fCtxH - 6}
                fill="rgba(59,130,246,.06)" stroke="rgba(59,130,246,.22)" rx={3} />
            </svg>
          </div>
        </div>
      </div>

      {/* ── Bottom panel: peak list + action area ── */}
      <div style={{ padding: "10px 20px 20px", display: "flex", gap: 14, alignItems: "flex-start" }}>

        {/* Peak list */}
        <div style={{ flex: 1, background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb", overflow: "hidden" }}>
          <div style={{ padding: "10px 16px", borderBottom: "1px solid #e5e7eb", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#1e293b" }}>
                {vizMode === "none" || vizMode === "no_ai" ? "Your Peaks" : "Detected Peaks"}
              </span>
              <span style={{ fontSize: 11, color: "#94a3b8", marginLeft: 8 }}>
                {vizMode === "none" || vizMode === "no_ai"
                  ? "Click a peak to select and edit it, or add one below"
                  : "Click any peak to inspect it — then confirm, edit, or remove it below"}
              </span>
            </div>
            <button onClick={addPeak} data-track="add_peak_button"
              style={{ padding: "6px 14px", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", border: "2px solid #059669", background: "#ecfdf5", color: "#059669", whiteSpace: "nowrap", flexShrink: 0 }}>
              {vizMode === "none" || vizMode === "no_ai" ? "+ Add Peak" : "+ Add Missed Peak"}
            </button>
          </div>

          {activePeaks.length === 0 && annotations.filter(a => a.deleted).length === 0 ? (
            <div style={{ padding: "20px 16px", fontSize: 12, color: "#94a3b8", textAlign: "center" }}>
              {vizMode === "none" || vizMode === "no_ai" ? "No peaks yet — use the button above to add one." : "No peaks detected in this chromatogram."}
            </div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "10px 14px" }}>
              {/* Active peaks */}
              {peaksSorted.map((pk, i) => {
                const sel = pk.id === selectedPeakId;
                const hov = pk.id === hoveredPeakId;
                const isUserPk = pk.id.startsWith("user_");
                const chipBg  = sel ? "#eff6ff" : hov ? "#f8fafc" : "#f1f5f9";
                const chipBorder = sel ? "2px solid #3b82f6" : "1.5px solid #e2e8f0";

                return (
                  <div key={pk.id}
                    data-track="peak_row" data-peak-id={pk.id} data-peak-index={i}
                    style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "6px 10px 6px 12px", borderRadius: 20, background: chipBg, border: chipBorder, cursor: "pointer", transition: "all .12s" }}
                    onPointerEnter={() => beginHover(pk.id)} onPointerLeave={() => endHover(false)}
                    onClick={() => { endHover(true); const nextId = pk.id === selectedPeakId ? null : pk.id; setSelectedPeakId(nextId); if (nextId) { const mid = pk.userApex; const w = domain[1] - domain[0]; setDomain([mid - w/2, mid + w/2]); } logEdit("select_peak", pk.id, { via: "pill", confidence: pk.confidence ?? null, start: pk.userStart, apex: pk.userApex, end: pk.userEnd }); }}>
                    {showConf && !isUserPk && pk.confidence != null && (
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: confColor(pk.confidence), display: "inline-block", flexShrink: 0 }} />
                    )}
                    {isUserPk && <span style={{ fontSize: 10, color: "#059669", fontWeight: 800 }}>+</span>}
                    <span style={{ fontSize: 12, fontWeight: sel ? 700 : 500, color: sel ? "#1e40af" : "#374151" }}>{peakLabel.get(pk.id) || pk.label}</span>
                    {showConf && !isUserPk && pk.confidence != null && (
                      <span style={{ fontSize: 10, fontWeight: 700, color: confColor(pk.confidence), background: confBg(pk.confidence), padding: "1px 5px", borderRadius: 6 }}>{pk.confidence}%</span>
                    )}
                    {/* X button to delete */}
                    <span
                      data-track="delete_pill_x" data-peak-id={pk.id}
                      onClick={e => { e.stopPropagation(); deletePeak(pk.id, "pill"); }}
                      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 16, height: 16, borderRadius: "50%", background: "#fecaca", color: "#dc2626", fontSize: 10, fontWeight: 800, cursor: "pointer", flexShrink: 0, lineHeight: 1 }}
                      title="Delete this peak">✕</span>
                  </div>
                );
              })}
              {/* Deleted peaks — grayed out, click to restore */}
              {annotations.filter(a => a.deleted).map((pk) => {
                const deletedLabel = (() => {
                  const allSorted = [...annotations].filter(a => !a.deleted).sort((a,b) => a.userApex - b.userApex);
                  return `Peak @ ${fmt(pk.userApex)}`;
                })();
                return (
                  <div key={`del-${pk.id}`}
                    data-track="peak_row_deleted" data-peak-id={pk.id}
                    title="Click to restore this peak"
                    style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "6px 12px", borderRadius: 20, background: "#f8fafc", border: "1.5px dashed #cbd5e1", cursor: "pointer", opacity: 0.55, transition: "all .12s" }}
                    onClick={() => {
                      setAnnotations(prev => prev.map(a => a.id === pk.id ? { ...a, deleted: false } : a));
                      setSelectedPeakId(pk.id);
                      logEdit("restore_peak", pk.id, {
                        start: pk.userStart,
                        apex: pk.userApex,
                        end: pk.userEnd,
                        confidence: pk.confidence ?? null,
                        isAIPeak: !pk.id.startsWith("user_"),
                      });
                    }}>
                    <span style={{ fontSize: 10, color: "#94a3b8" }}>↩</span>
                    <span style={{ fontSize: 12, fontWeight: 500, color: "#94a3b8", textDecoration: "line-through" }}>{deletedLabel}</span>
                    <span style={{ fontSize: 9, color: "#94a3b8" }}>Restore</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Action panel — shown when a peak is selected */}
        <div style={{ width: 420, flexShrink: 0 }}>
          {selPeak ? (
            <div style={{ background: "#fff", borderRadius: 12, border: "2px solid #3b82f6", overflow: "hidden" }}>
              {/* Selected peak header */}
              <div style={{ padding: "10px 16px", background: "#eff6ff", borderBottom: "1px solid #bfdbfe", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#1e40af" }}>{peakLabel.get(selPeak.id) || selPeak.label}</div>
                  {showConf && !selIsUserPeak && selPeak.confidence != null && (
                    <div style={{ fontSize: 11, color: confColor(selPeak.confidence), fontWeight: 600, marginTop: 2 }}>
                      AI Confidence: {selPeak.confidence}% — {selPeak.confidence >= 80 ? "Very likely a real peak" : selPeak.confidence >= 50 ? "Possibly a real peak — check carefully" : "Borderline — check closely before confirming"}
                    </div>
                  )}
                  {selIsUserPeak && <div style={{ fontSize: 11, color: "#059669", fontWeight: 600, marginTop: 2 }}>You added this peak</div>}
                </div>
                <div style={{ fontSize: 11, color: "#64748b", textAlign: "right" }}>
                  <div>Start: <strong>{fmt(selPeak.userStart)}</strong></div>
                  <div>Apex: <strong>{fmt(selPeak.userApex)}</strong></div>
                  <div>End: <strong>{fmt(selPeak.userEnd)}</strong></div>
                </div>
              </div>

              {/* AI explanation (if applicable) */}
              {selTxt && (
                <div style={{ padding: "8px 16px", background: "#f8fafc", borderBottom: "1px solid #e5e7eb", fontSize: 11, color: "#475569", lineHeight: 1.5 }}>
                  <span style={{ fontWeight: 700, color: "#374151" }}>Why the AI detected this: </span>{selTxt}
                </div>
              )}
              {selThresholds && (
                <div style={{ padding: "8px 16px", background: "#f8fafc", borderBottom: "1px solid #e5e7eb" }}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>
                    Detection margins — how far each value is from its threshold
                  </div>
                  <ThresholdBar label="Prominence" pct={selThresholds.prominence} width={260} />
                  <ThresholdBar label="Width" pct={selThresholds.width} width={260} />
                  <ThresholdBar label="Height" pct={selThresholds.height} width={260} />
                  {selThresholds.snr != null && <ThresholdBar label="S/N (Signal-to-Noise)" pct={selThresholds.snr} width={260} />}
                  {selThresholds.area != null && <ThresholdBar label="Peak Area" pct={selThresholds.area} width={260} />}
                </div>
              )}

              {/* Actions */}
              <div style={{ padding: "10px 16px", display: "flex", gap: 8 }}>
                <div style={{ flex: 1, fontSize: 11, color: "#64748b", lineHeight: 1.5, alignSelf: "center" }}>
                  {vizMode !== "none" && vizMode !== "no_ai" && !selIsUserPeak
                    ? "Drag the \u25C0 Start, \u25C6 Apex, \u25B6 End handles on the chart to adjust boundaries. If this is not a real peak, remove it."
                    : "Drag the \u25C0 Start, \u25C6 Apex, \u25B6 End handles on the chart to adjust boundaries."}
                </div>
                <button onClick={e => { e.stopPropagation(); deletePeak(selPeak.id); }}
                  data-track="delete_button_panel" data-peak-id={selPeak.id}
                  style={{ padding: "8px 16px", borderRadius: 8, border: "1.5px solid #fca5a5", background: "#fef2f2", color: "#dc2626", fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}>
                  Delete Peak Annotation
                </button>
              </div>
            </div>
          ) : (
            <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb", padding: "20px 18px", textAlign: "center", color: "#94a3b8" }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>☝</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#475569", marginBottom: 4 }}>
                {vizMode === "none" || vizMode === "no_ai" ? "Select a peak to edit it" : "Select a peak to review it"}
              </div>
              <div style={{ fontSize: 11, lineHeight: 1.5 }}>
                {vizMode === "none" || vizMode === "no_ai"
                  ? "Click any peak chip above or click a peak badge on the chart to select it. Then drag the handles to adjust its boundaries."
                  : "Click a numbered badge on the chart or a peak chip above. Then decide: keep, edit, or remove it."}
              </div>
            </div>
          )}

          {/* Finish button */}
          <div style={{ marginTop: 10 }}>
            {isLastChrom ? (
              <button onClick={() => {
                const _psL = [...activePeaks].sort((a,b)=>a.userApex-b.userApex).map(p=>({ id:p.id, start:p.userStart, apex:p.userApex, end:p.userEnd, isAIPeak:!p.id.startsWith("user_"), confidence:p.confidence??null }));
                T.chromFinalStates.push({ chromIdx:currentIdx, chromName:ds.name, snapshotTimeMs:Date.now()-T.sessionStart, domain:[...domain], peaks:_psL });
                pushInteraction(T, "finish_chrom", currentIdxRef.current, null, null, { chromIdx:currentIdx, peakCountFinal:activePeaks.length, isLastChrom:true, finalPeaks:_psL, viewportDomain:[...domain] });
                proceedToSurveys();
              }} data-track="nav_to_surveys_bottom"
                style={{ width: "100%", padding: "13px 20px", borderRadius: 10, border: "none", fontSize: 14, fontWeight: 700, cursor: "pointer", background: "linear-gradient(135deg,#059669,#10b981)", color: "#fff", boxShadow: "0 4px 14px rgba(5,150,105,.3)" }}>
                Finish &amp; Continue to Surveys →
              </button>
            ) : (
              <button onClick={() => {
                const _psN = [...activePeaks].sort((a,b)=>a.userApex-b.userApex).map(p=>({ id:p.id, start:p.userStart, apex:p.userApex, end:p.userEnd, isAIPeak:!p.id.startsWith("user_"), confidence:p.confidence??null }));
                T.chromFinalStates.push({ chromIdx:currentIdx, chromName:ds.name, snapshotTimeMs:Date.now()-T.sessionStart, domain:[...domain], peaks:_psN });
                pushInteraction(T, "finish_chrom", currentIdxRef.current, null, null, { chromIdx:currentIdx, peakCountFinal:activePeaks.length, isLastChrom:false, finalPeaks:_psN, viewportDomain:[...domain] });
                goNext();
              }} data-track="nav_next_bottom"
                style={{ width: "100%", padding: "13px 20px", borderRadius: 10, border: "none", fontSize: 14, fontWeight: 700, cursor: "pointer", background: "linear-gradient(135deg,#1e40af,#3b82f6)", color: "#fff", boxShadow: "0 4px 14px rgba(30,64,175,.25)" }}>
                Finish This Chromatogram &amp; Start Next →
              </button>
            )}
            {!isLastChrom && (
              <>
              <button onClick={() => {
                const _chromsDone = finishedAt.filter(t=>t!=null).length;
                const _psS = [...activePeaks].sort((a,b)=>a.userApex-b.userApex).map(p=>({ id:p.id, start:p.userStart, apex:p.userApex, end:p.userEnd, isAIPeak:!p.id.startsWith("user_"), confidence:p.confidence??null }));
                pushInteraction(T, "skip_to_surveys", currentIdxRef.current, null, null, {
                  chromIdx: currentIdx, peaksAnnotated: activePeaks.length,
                  totalChroms: datasets.length, chromsCompleted: _chromsDone,
                  finalPeaks: _psS, viewportDomain: [...domain],
                });
                proceedToSurveys();
              }} data-track="skip_to_surveys"
                style={{ width: "100%", marginTop: 8, padding: "11px 20px", borderRadius: 10, border: "1.5px solid #cbd5e1", fontSize: 13, fontWeight: 600, cursor: "pointer", background: "#f8fafc", color: "#475569" }}>
                I&rsquo;m done annotating &mdash; take me to the surveys &rarr;
              </button>
              <div style={{ marginTop: 6, fontSize: 11, color: "#94a3b8", textAlign: "center", lineHeight: 1.4 }}>
                There are many chromatograms &mdash; you do not have to finish them all. Click the button above whenever you no longer want to keep annotating.
              </div>
              </>
            )}
          </div>
        </div>
      </div>
    </>)}
    </div>
  );
}

// ══════════════════════════════════════════
//  NASA-TLX Survey
// ══════════════════════════════════════════
const NASA_TLX_SCALES = [
  { id: "mentalDemand", label: "Mental Demand", low: "Low", high: "High", desc: "How much mental and perceptual effort did you spend?" },
  { id: "physicalDemand", label: "Physical Demand", low: "Low", high: "High", desc: "How much physical effort did you spend?" },
  { id: "temporalDemand", label: "Temporal Demand", low: "Low", high: "High", desc: "How much time pressure did you feel in order to complete this?" },
  { id: "performance", label: "Performance", low: "Good", high: "Poor", desc: "How successful do you think you were in accomplishing what you were asked to do? (notice the direction of this scale)" },
  { id: "attentionCheck", label: "Attention Check", low: "Low", high: "High", desc: "This question checks whether you are reading carefully. Please set this scale to approximately 75.", isAttentionCheck: true },
  { id: "effort", label: "Effort", low: "Low", high: "High", desc: "How hard did you have to work to accomplish your level of performance?" },
  { id: "frustration", label: "Frustration", low: "Low", high: "High", desc: "How irritated, stressed, discouraged, and annoyed were you?" },
];

function NasaTlxSurvey({ onComplete, onQuit }) {
  const [responses, setResponses] = useState(() => {
    const r = {};
    NASA_TLX_SCALES.forEach(s => { r[s.id] = 50; }); // default to center tick
    return r;
  });
  const [hoveredScale, setHoveredScale] = useState(null);
  const [draggingScale, setDraggingScale] = useState(null);
  const [interacted, setInteracted] = useState(() => {
    const r = {};
    NASA_TLX_SCALES.forEach(s => { r[s.id] = false; });
    return r;
  });

  const handleClick = useCallback((id, val) => {
    setResponses(prev => ({ ...prev, [id]: val }));
    setInteracted(prev => ({ ...prev, [id]: true }));
  }, []);

  // Compute the snapped 0-100 value from a pointer position over the bar element
  const valFromPointer = useCallback((clientX, el) => {
    const rect = el.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.max(0, Math.min(100, Math.round(frac * 100)));
  }, []);

  // Each scale is 0-100 with tick marks every 5 points (21 ticks)
  const TICKS = Array.from({ length: 21 }, (_, i) => i * 5);

  return (
    <div style={{ fontFamily: "'IBM Plex Sans',system-ui,sans-serif", background: "linear-gradient(160deg,#f0f4ff 0%,#f8f9fb 40%,#faf5ff 100%)", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "40px 20px" }}>
      <div style={{ maxWidth: 680, width: "100%", background: "#fff", borderRadius: 16, padding: "32px 36px", boxShadow: "0 4px 24px rgba(0,0,0,.08)" }}>
        <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: .5, marginBottom: 6 }}>Survey 1 of 3</div>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: "#1e293b", marginTop: 0, marginBottom: 4 }}>NASA Task Load Index</h1>
        <p style={{ fontSize: 14, color: "#64748b", marginBottom: 28, lineHeight: 1.5 }}>
          The evalutation you're about to complete is the NASA Task Load Index (TLX). The TLX is a subjective workload assessment tool that allows you to evaluate the workload of a task. It consists of six subscales: Mental Demand, Physical Demand, Temporal Demand, Performance, Effort, and Frustration.
        </p>

        {NASA_TLX_SCALES.map(scale => {
          const val = responses[scale.id];
          const isDragging = draggingScale === scale.id;
          const isHovered = hoveredScale === scale.id || isDragging;
          const touched = interacted[scale.id];
          return (
            <div key={scale.id} style={{ marginBottom: 28 }}
              onMouseEnter={() => setHoveredScale(scale.id)}
              onMouseLeave={() => setHoveredScale(null)}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#1e293b", marginBottom: 2 }}>{scale.label}</div>
              <div style={{ fontSize: 12, color: "#64748b", marginBottom: 10 }}>{scale.desc}</div>

              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 11, color: "#94a3b8", minWidth: 60, textAlign: "right" }}>{scale.low}</span>

                {/* Scale bar with tick marks */}
                <div style={{ flex: 1, position: "relative", height: 40, cursor: "pointer", userSelect: "none", touchAction: "none" }}
                  data-track="nasa_tlx_scale" data-scale-id={scale.id}
                  onPointerDown={e => {
                    e.currentTarget.setPointerCapture(e.pointerId);
                    setDraggingScale(scale.id);
                    handleClick(scale.id, valFromPointer(e.clientX, e.currentTarget));
                  }}
                  onPointerMove={e => {
                    if (draggingScale !== scale.id) return;
                    handleClick(scale.id, valFromPointer(e.clientX, e.currentTarget));
                  }}
                  onPointerUp={e => {
                    setDraggingScale(null);
                    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) {}
                  }}
                  onPointerCancel={() => setDraggingScale(null)}>

                  {/* Horizontal baseline */}
                  <div style={{ position: "absolute", top: 20, left: 0, right: 0, height: 2, background: "#cbd5e1" }} />

                  {/* Tick marks — grow upward from the baseline */}
                  {TICKS.map(t => {
                    const pct = (t / 100) * 100;
                    const isSelected = t === val;
                    const tickH = 14;
                    return (
                      <div key={t} style={{
                        position: "absolute",
                        left: `${pct}%`,
                        top: 22 - tickH,
                        width: isSelected ? 3 : 1,
                        height: tickH,
                        background: isSelected ? "#dc2626" : "#94a3b8",
                        transform: "translateX(-50%)",
                        transition: "background 0.15s",
                      }} />
                    );
                  })}

                  {/* Red indicator for values between ticks */}
                  {touched && val % 5 !== 0 && (
                    <div style={{
                      position: "absolute",
                      left: `${val}%`,
                      top: 22 - 14,
                      width: 3,
                      height: 14,
                      background: "#dc2626",
                      transform: "translateX(-50%)",
                    }} />
                  )}

                  {/* Hover value tooltip */}
                  {isHovered && touched && (
                    <div style={{
                      position: "absolute",
                      left: `${(val / 100) * 100}%`,
                      top: -18,
                      transform: "translateX(-50%)",
                      fontSize: 11,
                      fontWeight: 700,
                      color: "#dc2626",
                      background: "#fff",
                      padding: "1px 5px",
                      borderRadius: 4,
                      border: "1px solid #fecaca",
                      whiteSpace: "nowrap",
                    }}>
                      {val}
                    </div>
                  )}
                </div>

                <span style={{ fontSize: 11, color: "#94a3b8", minWidth: 60 }}>{scale.high}</span>
              </div>
            </div>
          );
        })}

        <button onClick={() => onComplete(responses)} data-track="survey_nasa_tlx_submit"
          style={{ width: "100%", padding: "14px", borderRadius: 12, border: "none", background: "#1e40af", color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer", marginTop: 8 }}>
          Next Survey →
        </button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════
//  UES-LF Survey
// ══════════════════════════════════════════
// ══════════════════════════════════════════
//  Feedback Survey (qualitative + UEQ item)
// ══════════════════════════════════════════
const FEEDBACK_QUESTIONS = [
  { id: "fb_focus", type: "likert", text: "I was able to maintain my focus throughout the entire annotation task.", labels: ["Strongly Disagree", "Disagree", "Neutral", "Agree", "Strongly Agree"] },
  { id: "fb_careful", type: "likert", text: "By the end of the task, I was annotating just as carefully as at the beginning.", labels: ["Strongly Disagree", "Disagree", "Neutral", "Agree", "Strongly Agree"] },
  { id: "fb_ready_stop", type: "likert", text: "I felt ready to stop before the task was finished.", labels: ["Strongly Disagree", "Disagree", "Neutral", "Agree", "Strongly Agree"] },
  { id: "fb_confidence", type: "likert", text: "I felt confident in the accuracy of my annotations.", labels: ["Strongly Disagree", "Disagree", "Neutral", "Agree", "Strongly Agree"] },
  { id: "fb_repetitive", type: "likert", text: "The task started to feel repetitive after a while.", labels: ["Strongly Disagree", "Disagree", "Neutral", "Agree", "Strongly Agree"] },
  { id: "fb_ac", type: "likert", text: "This is an attention check. Please select \"Disagree\" for this question.", labels: ["Strongly Disagree", "Disagree", "Neutral", "Agree", "Strongly Agree"], isAttentionCheck: true, expectedValue: 2 },
  { id: "fb_clarity", type: "likert", text: "The information presented on screen was easy to interpret.", labels: ["Strongly Disagree", "Disagree", "Neutral", "Agree", "Strongly Agree"] },
  { id: "fb_ueq_boring_exciting", type: "semantic_differential", leftLabel: "Boring", rightLabel: "Exciting", text: "Please rate your overall experience with the annotation task. The circles between the two words represent gradations between the opposites. Select the circle that most closely reflects your impression." },
  { id: "fb_other", type: "open", text: "Is there anything else you would like to share about your experience?" },
];

function FeedbackSurvey({ onComplete, onQuit }) {
  const [responses, setResponses] = useState(() => {
    const r = {};
    FEEDBACK_QUESTIONS.forEach(q => {
      if (q.type === "open") r[q.id] = "";
      else r[q.id] = null;
    });
    return r;
  });

  const allAnswered = FEEDBACK_QUESTIONS.every(q => {
    if (q.type === "open") return true; // optional
    return responses[q.id] != null;
  });

  return (
    <div style={{ fontFamily: "'IBM Plex Sans',system-ui,sans-serif", background: "linear-gradient(160deg,#f0f4ff 0%,#f8f9fb 40%,#faf5ff 100%)", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "40px 20px" }}>
      <div style={{ maxWidth: 720, width: "100%", background: "#fff", borderRadius: 16, padding: "32px 36px", boxShadow: "0 4px 24px rgba(0,0,0,.08)" }}>
        <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: .5, marginBottom: 6 }}>Survey 2 of 3</div>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: "#1e293b", marginTop: 0, marginBottom: 4 }}>Your Experience</h1>
        <p style={{ fontSize: 14, color: "#64748b", marginBottom: 24, lineHeight: 1.5 }}>
          Please share your thoughts about the annotation task. Your honest feedback is valuable for improving the study.
        </p>

        {FEEDBACK_QUESTIONS.map((q, idx) => (
          <div key={q.id} style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.5, marginBottom: 8 }}>
              <span style={{ color: "#94a3b8", fontSize: 11, marginRight: 6 }}>{idx + 1}.</span>
              {q.text}
            </div>

            {q.type === "likert" && (
              <div style={{ display: "flex", gap: 0 }}>
                {q.labels.map((label, i) => {
                  const val = i + 1;
                  const sel = responses[q.id] === val;
                  return (
                    <button key={val} onClick={() => setResponses(prev => ({ ...prev, [q.id]: val }))}
                      data-track="survey_feedback_likert" data-question-id={q.id} data-value={val}
                      style={{
                        flex: 1, padding: "8px 4px", borderRadius: 6,
                        border: sel ? "2px solid #3b82f6" : "1px solid #e5e7eb",
                        background: sel ? "#eff6ff" : "#fff",
                        color: sel ? "#1e40af" : "#64748b",
                        fontSize: 11, fontWeight: sel ? 700 : 500, cursor: "pointer", margin: "0 2px",
                        lineHeight: 1.2, textAlign: "center",
                      }}>
                      {label}
                    </button>
                  );
                })}
              </div>
            )}

            {q.type === "semantic_differential" && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "center", marginTop: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#64748b", minWidth: 60, textAlign: "right" }}>{q.leftLabel}</span>
                <div style={{ display: "flex", gap: 8 }}>
                  {[1, 2, 3, 4, 5, 6, 7].map(val => {
                    const sel = responses[q.id] === val;
                    return (
                      <button key={val} onClick={() => setResponses(prev => ({ ...prev, [q.id]: val }))}
                        data-track="survey_feedback_semantic" data-question-id={q.id} data-value={val}
                        style={{
                          width: 28, height: 28, borderRadius: "50%", padding: 0,
                          border: sel ? "3px solid #3b82f6" : "2px solid #cbd5e1",
                          background: sel ? "#3b82f6" : "#fff",
                          cursor: "pointer", transition: "all 0.15s",
                        }}
                        title={`${val}`}
                      />
                    );
                  })}
                </div>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#64748b", minWidth: 60 }}>{q.rightLabel}</span>
              </div>
            )}

            {q.type === "open" && (
              <textarea
                value={responses[q.id]}
                onChange={e => setResponses(prev => ({ ...prev, [q.id]: e.target.value }))}
                placeholder="Type your response here (optional)..."
                style={{
                  width: "100%", minHeight: 80, padding: "10px 12px", borderRadius: 8,
                  border: "1px solid #e5e7eb", fontSize: 13, fontFamily: "inherit",
                  color: "#374151", lineHeight: 1.5, resize: "vertical", boxSizing: "border-box",
                  outline: "none",
                }}
                onFocus={e => e.target.style.borderColor = "#93c5fd"}
                onBlur={e => e.target.style.borderColor = "#e5e7eb"}
              />
            )}
          </div>
        ))}

        {!allAnswered && (
          <div style={{ marginTop: 16, padding: 10, background: "#fef3c7", borderRadius: 8, fontSize: 12, color: "#92400e", textAlign: "center" }}>
            Please answer all required questions before submitting.
          </div>
        )}

        <button onClick={() => { if (allAnswered) onComplete(responses); }} disabled={!allAnswered}
          data-track="survey_feedback_submit"
          style={{ width: "100%", padding: "14px", borderRadius: 12, border: "none", background: allAnswered ? "#1e40af" : "#94a3b8", color: "#fff", fontSize: 15, fontWeight: 700, cursor: allAnswered ? "pointer" : "not-allowed", marginTop: 20 }}>
          Next Survey →
        </button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════
//  Demographics Survey
// ══════════════════════════════════════════
const DEMO_QUESTIONS = [
  { id: "demo_age", section: "Basic Demographics", text: "What is your age range?", required: true, type: "radio",
    options: ["18–24", "25–34", "35–44", "45–54", "55–64", "65+"] },
  { id: "demo_education", section: "Basic Demographics", text: "What is the highest degree or level of education you have completed?", required: true, type: "radio_other",
    options: ["High school diploma or equivalent", "Some college", "Associate degree", "Bachelor's degree", "Master's degree", "Professional degree", "Doctoral degree"] },
  { id: "demo_field", section: "Basic Demographics", text: "Which field is most related to your education or work?", required: true, type: "radio_other",
    options: ["Chemistry / Chemical Engineering", "Biology / Biomedical", "Environmental / Earth Science", "Data Science / Computer Science / Engineering", "Statistics / Math", "Business / Economics", "Arts / Humanities / Social Science"] },
  { id: "demo_chrom_exp", section: "Background Experience", text: "Have you worked with chromatography data before?", required: true, type: "radio",
    options: ["No, never", "Yes, a little (e.g., saw it in a class or once/twice)", "Yes, sometimes (e.g., occasional use at work/research)", "Yes, often (e.g., frequent use in work/research)"] },
  { id: "demo_peak_boundary", section: "Background Experience", text: "How familiar are you with marking peak boundaries (start/end)?", required: true, type: "radio",
    options: ["Not at all familiar", "Slightly familiar", "Somewhat familiar", "Moderately familiar", "Extremely familiar"] },
  { id: "demo_timeseries", section: "Background Experience", text: "How often do you analyze time-series or line-graph data in any domain?", required: true, type: "radio",
    options: ["No, never", "Yes, a little (e.g., for a class or once/twice)", "Yes, sometimes (e.g., occasional use at work/research)", "Yes, often (e.g., frequent use in work/research)"] },
  { id: "demo_linegraph", section: "Visualization Experience", text: "How comfortable are you interpreting line graphs or time-series visualizations?", required: true, type: "radio",
    options: ["Not at all comfortable", "Slightly comfortable", "Somewhat comfortable", "Moderately comfortable", "Extremely comfortable"] },
  { id: "demo_ai_experience", section: "AI & Coding Experience", text: "Describe your experience with AI (e.g., tools you've used, how often, in what context).", required: true, type: "open" },
  { id: "demo_coding_frequency", section: "AI & Coding Experience", text: "How often do you write code (in any programming language)?", required: true, type: "radio_other",
    options: ["Never", "Rarely (a few times a year)", "Sometimes (a few times a month)", "Often (weekly)", "Daily"] },
  { id: "demo_coding_comfort", section: "AI & Coding Experience", text: "How comfortable are you reading or writing code to accomplish a task (e.g., data analysis, scripting, web development)?", required: true, type: "radio",
    options: ["Not at all comfortable", "Slightly comfortable", "Somewhat comfortable", "Moderately comfortable", "Extremely comfortable"] },
];

function DemographicsSurvey({ onComplete, onQuit }) {
  const [responses, setResponses] = useState(() => {
    const r = {};
    DEMO_QUESTIONS.forEach(q => {
      if (q.type === "open") r[q.id] = "";
      else r[q.id] = null;
    });
    return r;
  });
  const [otherText, setOtherText] = useState(() => {
    const r = {};
    DEMO_QUESTIONS.filter(q => q.type === "radio_other").forEach(q => { r[q.id] = ""; });
    return r;
  });

  const allAnswered = DEMO_QUESTIONS.every(q => {
    if (!q.required) return true;
    if (q.type === "open") return (responses[q.id] || "").trim().length > 0;
    const val = responses[q.id];
    if (val === null) return false;
    if (val === "Other" && (otherText[q.id] || "").trim().length === 0) return false;
    return true;
  });

  let currentSection = "";

  return (
    <div style={{ fontFamily: "'IBM Plex Sans',system-ui,sans-serif", background: "linear-gradient(160deg,#f0f4ff 0%,#f8f9fb 40%,#faf5ff 100%)", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "40px 20px" }}>
      <div style={{ maxWidth: 680, width: "100%", background: "#fff", borderRadius: 16, padding: "32px 36px", boxShadow: "0 4px 24px rgba(0,0,0,.08)" }}>
        <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: .5, marginBottom: 6 }}>Survey 3 of 3</div>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: "#1e293b", marginTop: 0, marginBottom: 4 }}>Demographics</h1>
        <p style={{ fontSize: 14, color: "#64748b", marginBottom: 24, lineHeight: 1.5 }}>
          Tell us a bit about yourself. This helps us understand how different backgrounds relate to annotation performance.
        </p>

        {DEMO_QUESTIONS.map((q, idx) => {
          let sectionHeader = null;
          if (q.section !== currentSection) {
            currentSection = q.section;
            sectionHeader = (
              <div key={`sec_${q.section}`} style={{ padding: "12px 0 6px", marginTop: idx > 0 ? 8 : 0, borderTop: idx > 0 ? "2px solid #e5e7eb" : "none" }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "#1e40af", textTransform: "uppercase", letterSpacing: .5 }}>{q.section}</span>
              </div>
            );
          }

          if (q.type === "open") {
            return (
              <div key={q.id}>
                {sectionHeader}
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.5, marginBottom: 8 }}>
                    {q.text}{q.required && <span style={{ color: "#dc2626", marginLeft: 2 }}>*</span>}
                  </div>
                  <textarea
                    value={responses[q.id]}
                    onChange={e => setResponses(prev => ({ ...prev, [q.id]: e.target.value }))}
                    placeholder="Type your response here..."
                    style={{
                      width: "100%", minHeight: 80, padding: "10px 12px", borderRadius: 8,
                      border: "1px solid #e5e7eb", fontSize: 13, fontFamily: "inherit",
                      color: "#374151", lineHeight: 1.5, resize: "vertical", boxSizing: "border-box",
                      outline: "none",
                    }}
                    onFocus={e => e.target.style.borderColor = "#93c5fd"}
                    onBlur={e => e.target.style.borderColor = "#e5e7eb"}
                  />
                </div>
              </div>
            );
          }

          const hasOther = q.type === "radio_other";
          const opts = hasOther ? [...q.options, "Other"] : q.options;
          return (
            <div key={q.id}>
              {sectionHeader}
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.5, marginBottom: 8 }}>
                  {q.text}{q.required && <span style={{ color: "#dc2626", marginLeft: 2 }}>*</span>}
                </div>
                {(() => {
                  const isLikert = opts.length >= 4 && opts.every(o => o.split(/\s+/).length <= 3);
                  return (
                    <div style={{ display: "flex", flexDirection: isLikert ? "row" : "column", gap: isLikert ? 0 : 6 }}>
                      {opts.map(opt => {
                        const sel = responses[q.id] === opt;
                        return (
                          <button key={opt} onClick={() => setResponses(prev => ({ ...prev, [q.id]: opt }))}
                            data-track="survey_demographics_option" data-question-id={q.id} data-value={opt}
                            style={{
                              padding: "8px 14px", borderRadius: 6,
                              ...(isLikert ? { flex: 1, margin: "0 2px", textAlign: "center" } : { width: "100%", textAlign: "left" }),
                              border: sel ? "2px solid #3b82f6" : "1px solid #e5e7eb",
                              background: sel ? "#eff6ff" : "#fff",
                              color: sel ? "#1e40af" : "#64748b",
                              fontSize: isLikert ? 11 : 12, fontWeight: sel ? 700 : 500, cursor: "pointer",
                              lineHeight: 1.2, transition: "all 0.15s",
                            }}>
                            {opt}
                          </button>
                        );
                      })}
                    </div>
                  );
                })()}
                {hasOther && responses[q.id] === "Other" && (
                  <input type="text" value={otherText[q.id] || ""} placeholder="Please specify"
                    onChange={e => setOtherText(prev => ({ ...prev, [q.id]: e.target.value }))}
                    style={{ marginTop: 8, padding: "8px 12px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13, width: "100%", boxSizing: "border-box", outline: "none" }}
                    onFocus={e => e.target.style.borderColor = "#93c5fd"}
                    onBlur={e => e.target.style.borderColor = "#d1d5db"} />
                )}
              </div>
            </div>
          );
        })}

        {!allAnswered && (
          <div style={{ marginTop: 16, padding: 10, background: "#fef3c7", borderRadius: 8, fontSize: 12, color: "#92400e", textAlign: "center" }}>
            Please answer all required questions before submitting.
          </div>
        )}

        <button onClick={() => { if (allAnswered) { const out = {}; DEMO_QUESTIONS.forEach(q => { if (q.type === "open") { out[q.id] = responses[q.id]; } else { out[q.id] = responses[q.id] === "Other" ? `Other: ${otherText[q.id]}` : responses[q.id]; } }); onComplete(out); } }} disabled={!allAnswered}
          data-track="survey_demographics_submit"
          style={{ width: "100%", padding: "14px", borderRadius: 12, border: "none", background: allAnswered ? "#059669" : "#94a3b8", color: "#fff", fontSize: 15, fontWeight: 700, cursor: allAnswered ? "pointer" : "not-allowed", marginTop: 20 }}>
          Submit &amp; Finish Study
        </button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════
//  Completion Screen
// ══════════════════════════════════════════
// status: "uploading" | "success" | "error"
function CompletionScreen({ status, onRetry }) {
  const PROLIFIC_CODE = "CEJ155DD";
  return (
    <div style={{ fontFamily: "'IBM Plex Sans',system-ui,sans-serif", background: "linear-gradient(160deg,#f0f4ff 0%,#f8f9fb 40%,#faf5ff 100%)", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ maxWidth: 480, width: "100%", textAlign: "center", padding: 32 }}>

        {status === "uploading" && (
          <>
            <div style={{ fontSize: 40, marginBottom: 16 }}>⏳</div>
            <h1 style={{ fontSize: 24, fontWeight: 800, color: "#1e293b", marginBottom: 8 }}>Saving your results…</h1>
            <p style={{ fontSize: 15, color: "#64748b", lineHeight: 1.6 }}>
              Please <strong>do not close this tab</strong> while your data is being uploaded.
              Your completion code will appear here once saving is complete.
            </p>
          </>
        )}

        {status === "success" && (
          <>
            <div style={{ fontSize: 56, marginBottom: 16 }}>&#10003;</div>
            <h1 style={{ fontSize: 28, fontWeight: 800, color: "#059669", marginBottom: 8 }}>Study Complete</h1>
            <p style={{ fontSize: 15, color: "#64748b", lineHeight: 1.6, marginBottom: 24 }}>
              Thank you for participating! Your results have been saved successfully.
            </p>
            <div style={{ padding: "20px 24px", background: "#f0fdf4", borderRadius: 12, border: "2px solid #86efac", marginBottom: 20 }}>
              <p style={{ fontSize: 13, fontWeight: 700, color: "#166534", margin: "0 0 8px 0", textTransform: "uppercase", letterSpacing: "0.05em" }}>Your Prolific Completion Code</p>
              <p style={{ fontSize: 32, fontWeight: 900, color: "#15803d", margin: 0, letterSpacing: "0.1em" }}>{PROLIFIC_CODE}</p>
              <p style={{ fontSize: 12, color: "#166534", marginTop: 8, marginBottom: 0 }}>Copy this code and paste it into Prolific to receive your payment.</p>
            </div>
          </>
        )}

        {status === "error" && (
          <>
            <div style={{ fontSize: 40, marginBottom: 16 }}>⚠️</div>
            <h1 style={{ fontSize: 24, fontWeight: 800, color: "#dc2626", marginBottom: 8 }}>Upload Failed</h1>
            <p style={{ fontSize: 15, color: "#64748b", lineHeight: 1.6, marginBottom: 20 }}>
              Your results could not be saved — this is usually caused by a network issue.
              Please check your internet connection and try again.
              <br /><br />
              <strong>Do not close this tab.</strong> Your data is still in memory and can be re-uploaded by clicking the button below.
            </p>
            <button onClick={onRetry}
              style={{ width: "100%", padding: "14px", borderRadius: 12, border: "none", background: "#1e40af", color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer", marginBottom: 12 }}>
              Retry Upload
            </button>
            <p style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.5 }}>
              If this keeps failing, please contact us at{" "}
              <a href="mailto:jcaitlin@wustl.edu" style={{ color: "#1e40af", fontWeight: 600 }}>jcaitlin@wustl.edu</a>{" "}
              and we will ensure you receive your payment.
            </p>
          </>
        )}

        {status === "success" && (
          <div style={{ marginTop: 16, padding: "16px 20px", background: "#f8fafc", borderRadius: 10, border: "1px solid #e5e7eb" }}>
            <p style={{ fontSize: 13, color: "#475569", lineHeight: 1.6, margin: 0 }}>
              If you have any questions or comments about this study, please contact us at{" "}
              <a href="mailto:jcaitlin@wustl.edu" style={{ color: "#1e40af", fontWeight: 600, textDecoration: "none" }}>jcaitlin@wustl.edu</a>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Root ──
export default function App() {
  const [session, setSession] = useState(null);

  // Parse all URL params once on load
  const { prolificParams, urlCondition } = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const VALID_CONDITIONS = ["no_ai", "peaks_only", "confidence", "threshold_bars"];
    const c = params.get("condition");
    return {
      prolificParams: {
        prolificPid: params.get("PROLIFIC_PID") || null,
        studyId: params.get("STUDY_ID") || null,
        sessionId: params.get("SESSION_ID") || null,
      },
      // null if the param is missing or not one of the four valid values
      urlCondition: VALID_CONDITIONS.includes(c) ? c : null,
    };
  }, []);

  if (!session) {
    return (
      <WelcomeScreen
        vizMode={urlCondition}
        onStart={(s) => setSession({ ...s, ...prolificParams })}
      />
    );
  }
  return <StudyFlow session={session} />;
}

// ── Study Flow (manages annotation → surveys → export) ──
function StudyFlow({ session }) {
  // phase: "annotate" | "nasa_tlx" | "feedback" | "demographics" | "complete"
  const [phase, setPhase] = useState("annotate");
  const [annotationResults, setAnnotationResults] = useState(null);
  const [nasaTlxResults, setNasaTlxResults] = useState(null);
  const [feedbackResults, setFeedbackResults] = useState(null);
  // uploadStatus: "uploading" | "success" | "error"
  const [uploadStatus, setUploadStatus] = useState("uploading");
  // Keep final results in a ref so the retry button can re-attempt without
  // needing to rebuild the entire results object.
  const finalResultsRef = useRef(null);

  const handleAnnotationDone = (results) => {
    setAnnotationResults(results);
    setPhase("nasa_tlx");
  };

  const handleNasaDone = (responses) => {
    setNasaTlxResults({ ...responses, submittedAtMs: Date.now() });
    setPhase("feedback");
  };

  const handleFeedbackDone = (responses) => {
    setFeedbackResults({ ...responses, submittedAtMs: Date.now() });
    setPhase("demographics");
  };

  // ── Quit handler: export whatever data is available and go to completion ──
  const handleQuit = useCallback((partialAnnotationResults) => {
    // Use provided annotation results (from annotation screen quit) or stored results
    const annResults = partialAnnotationResults || annotationResults;

    if (!annResults) {
      // Quit before any annotation data — just go to completion with no export
      setPhase("complete");
      return;
    }

    // Build partial export with whatever we have
    const partialExport = {
      ...annResults,
      quitEarly: true,
      quitPhase: phase,
      surveys: {},
      flatSummary: {
        participant: annResults.userName,
        condition: annResults.visualizationMode,
        quitEarly: true,
        quitPhase: phase,
      },
    };

    // If we have NASA-TLX results, include them
    if (nasaTlxResults) {
      const nasaTlxScored = {};
      const nasaRealScales = NASA_TLX_SCALES.filter(s => !s.isAttentionCheck);
      NASA_TLX_SCALES.forEach(s => {
        nasaTlxScored[s.id] = { raw: nasaTlxResults[s.id], score: nasaTlxResults[s.id], isAttentionCheck: !!s.isAttentionCheck };
      });
      const nasaOverall = nasaRealScales.reduce((sum, s) => sum + nasaTlxResults[s.id], 0) / nasaRealScales.length;
      partialExport.surveys.nasaTLX = {
        rawResponses: nasaTlxResults,
        subscaleScores: nasaTlxScored,
        overallWorkload: Math.round(nasaOverall * 100) / 100,
      };
    }

    // If we have feedback results, include them
    if (feedbackResults) {
      partialExport.surveys.feedback = { responses: feedbackResults };
    }

    // Upload partial results to Firebase silently — no local download fallback
    const { _tracker: _qt, ...partialUploadData } = partialExport;
    addDoc(collection(db, "study_results"), {
      submittedAt: new Date(),
      userName: session.userName,
      data: partialUploadData,
    }).catch(err => {
      console.error("Firebase upload failed (quit early):", err);
    });

    setPhase("complete");
  }, [phase, annotationResults, nasaTlxResults, feedbackResults, session.userName]);

  const handleDemographicsDone = async (demographicsResponses) => {
    // Build final export
    const nasaTlx = nasaTlxResults;
    const feedbackResponses = feedbackResults;

    // Compute NASA-TLX subscale scores (each 0-100 scale, values already in range)
    const nasaTlxScored = {};
    const nasaRealScales = NASA_TLX_SCALES.filter(s => !s.isAttentionCheck);
    NASA_TLX_SCALES.forEach(s => {
      nasaTlxScored[s.id] = { raw: nasaTlx[s.id], score: nasaTlx[s.id], isAttentionCheck: !!s.isAttentionCheck };
    });
    const nasaOverall = nasaRealScales.reduce((sum, s) => sum + nasaTlx[s.id], 0) / nasaRealScales.length;

    // Feedback attention check
    const fbAC = FEEDBACK_QUESTIONS.find(q => q.isAttentionCheck);
    const fbACPassed = fbAC ? feedbackResponses[fbAC.id] === fbAC.expectedValue : null;

    // Merge with annotation data
    const finalResults = {
      ...annotationResults,
      surveys: {
        nasaTLX: {
          rawResponses: nasaTlx,
          subscaleScores: nasaTlxScored,
          overallWorkload: Math.round(nasaOverall * 100) / 100,
        },
        feedback: {
          responses: feedbackResponses,
        },
        demographics: {
          responses: demographicsResponses,
        },
      },
      attentionChecks: {
        nasaTLX: { value: nasaTlx.attentionCheck, expected: 75, passed: Math.abs(nasaTlx.attentionCheck - 75) <= 15 },
        feedback: { value: fbAC ? feedbackResponses[fbAC.id] : null, expected: fbAC?.expectedValue, passed: fbACPassed },
      },
      // Flat summary row for easy ANOVA/Friedman analysis
      flatSummary: {
        participant: annotationResults.userName,
        condition: annotationResults.visualizationMode,
        sessionDurationMs: annotationResults.sessionDurationMs,
        totalClicks: annotationResults.totalClicks,
        totalAnnotationEdits: annotationResults.totalAnnotationEdits,
        totalIdleMs: annotationResults.totalIdleMs,
        avgInterClickMs: annotationResults.avgInterClickMs,
        // click-frequency / fatigue indicators
        clickRateSlopePerMin: annotationResults.clickFrequency?.clickRateSlopePerMin ?? null,
        firstHalfClicksPerMin: annotationResults.clickFrequency?.firstHalfRatePerMin ?? null,
        secondHalfClicksPerMin: annotationResults.clickFrequency?.secondHalfRatePerMin ?? null,
        halfRatioSecondOverFirst: annotationResults.clickFrequency?.firstVsSecondHalfRatio ?? null,
        // NEW: engagement / thoroughness
        totalReturnEdits: annotationResults.engagement?.totalReturnEdits ?? null,
        sessionEditOrderMonotonicity: annotationResults.engagement?.sessionEditOrderMonotonicity ?? null,
        // NASA-TLX subscales (0-100)
        nasaTLX_mentalDemand: nasaTlx.mentalDemand,
        nasaTLX_physicalDemand: nasaTlx.physicalDemand,
        nasaTLX_temporalDemand: nasaTlx.temporalDemand,
        nasaTLX_performance: nasaTlx.performance,
        nasaTLX_effort: nasaTlx.effort,
        nasaTLX_frustration: nasaTlx.frustration,
        nasaTLX_overall: Math.round(nasaOverall * 100) / 100,
        // Feedback: UEQ boring/exciting (1-7)
        fb_ueq_boring_exciting: feedbackResponses.fb_ueq_boring_exciting,
        // Demographics
        ...demographicsResponses,
        // Per-chromatogram accuracy + NEW per-chromatogram timing/engagement
        ...annotationResults.chromatograms.reduce((acc, c, i) => {
          const key = `chrom${i + 1}`;
          // per-chromatogram engagement columns
          acc[`${key}_totalActiveMs`] = c.totalActiveMs;
          acc[`${key}_revisitCount`] = c.revisitCount;
          acc[`${key}_timeToFirstEditMs`] = c.timeToFirstEditMs;
          acc[`${key}_clickCount`] = c.clickCount;
          acc[`${key}_editCount`] = c.editCount;
          acc[`${key}_uniquePeaksEdited`] = c.uniquePeaksEdited;
          acc[`${key}_returnEditCount`] = c.returnEditCount;
          acc[`${key}_editOrderMonotonicity`] = c.editOrderMonotonicity;
          acc[`${key}_meanDragAbsDelta`] = c.dragStats?.meanAbsDelta ?? null;
          acc[`${key}_handleReEdits`] = c.dragStats?.handleReEdits ?? null;
          acc[`${key}_meanHoverMs`] = c.hoverStats?.meanDurationMs ?? null;
          acc[`${key}_hoversWithoutClick`] = c.hoverStats?.hoversWithoutClick ?? null;
          if (c.aiAcceptance) {
            acc[`${key}_aiAcceptanceRate`] = c.aiAcceptance.acceptanceRate;
            acc[`${key}_aiModified`] = c.aiAcceptance.modified;
            acc[`${key}_aiDeleted`] = c.aiAcceptance.deleted;
            acc[`${key}_userAdded`] = c.aiAcceptance.addedByUser;
          }
          return acc;
        }, {}),
      },
    };

    // Store results so retry can re-use them without rebuilding
    finalResultsRef.current = finalResults;

    // Move to completion screen immediately (shows spinner) then upload.
    // beforeunload guard is attached below to warn the user not to close the tab.
    setUploadStatus("uploading");
    setPhase("complete");
    doUpload(finalResults);
  };

  // ── Upload function — called on first attempt and on retry ──
  const doUpload = useCallback(async (results) => {
    setUploadStatus("uploading");
    try {
      const { _tracker: _ft, ...uploadData } = results;
      await addDoc(collection(db, "study_results"), {
        submittedAt: new Date(),
        userName: session.userName,
        data: uploadData,
      });
      setUploadStatus("success");
    } catch (err) {
      console.error("Firebase upload failed:", err);
      setUploadStatus("error");
    }
  }, [session.userName]);

  // ── beforeunload guard: warn the user not to close the tab while uploading ──
  useEffect(() => {
    if (phase !== "complete" || uploadStatus === "success") return;
    const handler = (e) => {
      e.preventDefault();
      // Modern browsers require returnValue to be set to show the dialog
      e.returnValue = "Your results are still being saved. Are you sure you want to leave?";
      return e.returnValue;
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [phase, uploadStatus]);

  if (phase === "annotate") {
    return <AnnotationScreen datasets={session.datasets} vizMode={session.vizMode} userName={session.userName} prolificParams={{ prolificPid: session.prolificPid, studyId: session.studyId, sessionId: session.sessionId }} onStudyComplete={handleAnnotationDone} onQuit={(results) => handleQuit(results)} />;
  }
  if (phase === "nasa_tlx") {
    return <NasaTlxSurvey onComplete={handleNasaDone} onQuit={() => handleQuit()} />;
  }
  if (phase === "feedback") {
    return <FeedbackSurvey onComplete={handleFeedbackDone} onQuit={() => handleQuit()} />;
  }
  if (phase === "demographics") {
    return <DemographicsSurvey onComplete={handleDemographicsDone} onQuit={() => handleQuit()} />;
  }
  return (
    <CompletionScreen
      status={uploadStatus}
      onRetry={() => finalResultsRef.current && doUpload(finalResultsRef.current)}
    />
  );
}