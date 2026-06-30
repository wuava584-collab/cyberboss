#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DEFAULTS = { sampleLimit: 20, similarThreshold: 0.82, staleFactDays: 120, unrecalledActiveDays: 90, highHeatThreshold: 1.0 };

function runMemoryV2Patrol({ dbPath, now = new Date(), sampleLimit = DEFAULTS.sampleLimit, similarThreshold = DEFAULTS.similarThreshold, staleFactDays = DEFAULTS.staleFactDays, unrecalledActiveDays = DEFAULTS.unrecalledActiveDays, highHeatThreshold = DEFAULTS.highHeatThreshold } = {}) {
  const resolvedDbPath = requireDatabase(dbPath);
  const checkedAt = normalizeDate(now);
  const limit = normalizePositiveInteger(sampleLimit, "sampleLimit");
  const similarityThreshold = normalizeRatio(similarThreshold, "similarThreshold");
  const staleDays = normalizePositiveInteger(staleFactDays, "staleFactDays");
  const unrecalledDays = normalizePositiveInteger(unrecalledActiveDays, "unrecalledActiveDays");
  const heatThreshold = normalizeNonNegativeNumber(highHeatThreshold, "highHeatThreshold");
  const db = new DatabaseSync(resolvedDbPath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON");
    assertTable(db, "memory_index");
    const columns = getColumns(db, "memory_index");
    const auditSupported = getTableNames(db).has("memory_review_audit");
    const rows = db.prepare("SELECT * FROM memory_index ORDER BY id").all();
    const audit = auditSupported ? loadAuditSummary(db) : new Map();
    const duplicateAnalysis = findDuplicateOrSimilar(rows, { threshold: similarityThreshold, sampleLimit: limit });
    const stalePreferences = findStalePreferences(rows, { checkedAt, staleFactDays: staleDays, sampleLimit: limit });
    const lowEvidence = findLowEvidence(rows, audit, { sampleLimit: limit });
    const longUnrecalledActive = findLongUnrecalledActive(rows, { checkedAt, unrecalledActiveDays: unrecalledDays, sampleLimit: limit });
    const backlog = buildBacklog(rows, audit, { sampleLimit: limit });
    const highHeatWeakEvidence = findHighHeatWeakEvidence(rows, lowEvidence.byId, { highHeatThreshold: heatThreshold, sampleLimit: limit });
    const softening = findSofteningSuggestions(rows, {
      staleIds: new Set(stalePreferences.items.map((item) => item.id)),
      weakIds: lowEvidence.byId,
      longUnrecalledIds: new Set(longUnrecalledActive.items.map((item) => item.id)),
      sampleLimit: limit,
    });
    return {
      schemaVersion: 1,
      kind: "memory-v2-patrol",
      mode: "dry-run",
      checkedAt: checkedAt.toISOString(),
      database: resolvedDbPath,
      readOnly: true,
      policy: { sampleLimit: limit, similarThreshold: similarityThreshold, staleFactDays: staleDays, unrecalledActiveDays: unrecalledDays, highHeatThreshold: heatThreshold },
      counts: countRows(rows),
      schema: { memoryIndexColumns: Array.from(columns).sort(), reviewAuditSupported: auditSupported },
      checks: {
        duplicateOrSimilar: duplicateAnalysis.report,
        stalePreferencesOrFacts: stalePreferences.report,
        lowEvidence: lowEvidence.report,
        longUnrecalledActive: longUnrecalledActive.report,
        pendingReviewBacklog: backlog.report,
        highHeatWeakEvidence: highHeatWeakEvidence.report,
        softeningSuggestions: softening.report,
      },
      safety: { databaseWrites: 0, l0Writes: 0, recallAuditWrites: 0, heatUpdates: 0, statusChanges: 0, liveRecallChanges: 0, pm2Restarts: 0, requiresHumanReviewToApply: true },
    };
  } finally {
    db.close();
  }
}

function writeReports(report, { outputRoot, prefix = "patrol" } = {}) {
  const runId = `memory-v2-patrol-${formatTimestamp(report.checkedAt)}`;
  const outputDir = path.resolve(outputRoot || path.join(process.cwd(), "tmp", "memory-v2-patrol"), runId);
  fs.mkdirSync(outputDir, { recursive: true });
  const safePrefix = String(prefix || "patrol").replace(/[^a-zA-Z0-9._-]/g, "_");
  const jsonPath = path.join(outputDir, `${safePrefix}.json`);
  const markdownPath = path.join(outputDir, `${safePrefix}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(markdownPath, renderMarkdown(report), "utf8");
  return { outputDir, jsonPath, markdownPath };
}

function renderMarkdown(report) {
  const lines = ["# Memory V2 Patrol Report", "", `Mode: ${report.mode}`, `Checked: ${report.checkedAt}`, `Database: \`${report.database}\``, `Database opened read-only: ${report.readOnly ? "yes" : "no"}`, "", "## Counts", "", "| Metric | Count |", "| --- | ---: |"];
  for (const [name, count] of Object.entries(report.counts)) lines.push(`| ${name} | ${count} |`);
  lines.push("", "## Patrol Checks", "", "| Check | Findings |", "| --- | ---: |");
  for (const [name, check] of Object.entries(report.checks)) lines.push(`| ${name} | ${check.count} |`);
  lines.push("", "## Findings", "");
  for (const [name, check] of Object.entries(report.checks)) {
    lines.push(`### ${name}`, "", check.reason || "No findings.", "");
    const items = check.items || check.groups || [];
    if (items.length === 0) { lines.push("- none", ""); continue; }
    for (const item of items) lines.push(`- ${renderFinding(item)}`);
    lines.push("");
  }
  lines.push("## Safety", "", "- Database writes: 0", "- L0 writes: 0", "- Recall audit writes: 0", "- Heat updates: 0", "- Status changes: 0", "- Live recall changes: 0", "- PM2 restarts: 0", "- Applying any suggestion requires separate human review and a backup guard.", "");
  return lines.join("\n");
}

function findDuplicateOrSimilar(rows, { threshold, sampleLimit }) {
  const candidates = rows.filter((row) => row.status !== "invalid" && normalizeText(row.content || row.summary));
  const groups = [];
  const used = new Set();
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    const left = candidates[leftIndex];
    if (used.has(left.id)) continue;
    const members = [left];
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const right = candidates[rightIndex];
      if (used.has(right.id)) continue;
      const score = similarity(left.content || left.summary, right.content || right.summary);
      if (score >= threshold) { right.__similarity = score; members.push(right); }
    }
    if (members.length > 1) {
      for (const member of members) used.add(member.id);
      const ranked = members.slice().sort(compareEvidenceStrength);
      groups.push({ fingerprint: sha256(normalizeText(ranked[0].content || ranked[0].summary)), count: members.length, representativeId: ranked[0].id, memoryIds: ranked.map((row) => row.id), maxSimilarity: round(Math.max(...ranked.slice(1).map((row) => row.__similarity || 1))), proposedAction: "human_duplicate_review", reason: "Memories have identical or highly similar normalized wording.", preview: truncate(ranked[0].content || ranked[0].summary, 180) });
    }
  }
  groups.sort((left, right) => right.count - left.count || left.representativeId.localeCompare(right.representativeId));
  return { report: { count: groups.length, reason: "Duplicate or highly similar active/pending memories should be reviewed before any merge.", groups: sample(groups, sampleLimit) } };
}

function findStalePreferences(rows, { checkedAt, staleFactDays, sampleLimit }) {
  const cutoff = checkedAt.getTime() - staleFactDays * 86400000;
  const items = rows.filter((row) => row.status === "active").filter((row) => hasPreferenceOrFactSignal(row.content || row.summary || row.title)).map((row) => ({ row, evidenceAt: newestValidDate(row.updated_at, row.source_timestamp, row.created_at) })).filter((item) => item.evidenceAt && item.evidenceAt.getTime() <= cutoff).map(({ row, evidenceAt }) => ({ id: row.id, status: row.status, heat: toNumber(row.heat), evidenceAt: evidenceAt.toISOString(), proposedAction: "staleness_review", reason: `Preference/fact-like memory has no newer evidence inside ${staleFactDays} days.`, preview: truncate(row.content || row.summary, 180) }));
  return { items, report: { count: items.length, reason: "Old preference/fact-like memories may need confirmation or softer wording.", items: sample(items, sampleLimit) } };
}

function findLowEvidence(rows, audit, { sampleLimit }) {
  const items = [];
  const byId = new Set();
  for (const row of rows) {
    if (row.status === "invalid") continue;
    const reasons = evidenceWeaknessReasons(row, audit.get(row.id));
    if (reasons.length === 0) continue;
    byId.add(row.id);
    items.push({ id: row.id, status: row.status, heat: toNumber(row.heat), reasons, proposedAction: "evidence_review", preview: truncate(row.content || row.summary, 180) });
  }
  items.sort((left, right) => right.reasons.length - left.reasons.length || left.id.localeCompare(right.id));
  return { byId, report: { count: items.length, reason: "Low-evidence memories lack enough source or review support for confident live use.", items: sample(items, sampleLimit) } };
}

function findLongUnrecalledActive(rows, { checkedAt, unrecalledActiveDays, sampleLimit }) {
  const cutoff = checkedAt.getTime() - unrecalledActiveDays * 86400000;
  const items = rows.filter((row) => row.status === "active" && !row.pinned).map((row) => ({ row, activityAt: newestValidDate(row.last_recalled_at, row.last_recalled, row.source_timestamp, row.created_at) })).filter((item) => item.activityAt && item.activityAt.getTime() <= cutoff).map(({ row, activityAt }) => ({ id: row.id, heat: toNumber(row.heat), activityAt: activityAt.toISOString(), proposedAction: "activity_review", reason: `Active unpinned memory has not been recalled or refreshed inside ${unrecalledActiveDays} days.`, preview: truncate(row.content || row.summary, 180) }));
  items.sort((left, right) => left.activityAt.localeCompare(right.activityAt) || left.id.localeCompare(right.id));
  return { items, report: { count: items.length, reason: "Long-unrecalled active memories may be stale, overly specific, or simply low priority.", items: sample(items, sampleLimit) } };
}

function buildBacklog(rows, audit, { sampleLimit }) {
  const pending = rows.filter((row) => row.status === "pending");
  const oldest = pending.slice().sort((left, right) => String(left.source_timestamp || left.created_at || "").localeCompare(String(right.source_timestamp || right.created_at || "")));
  const skipped = pending.filter((row) => audit.get(row.id)?.action === "skip");
  const items = oldest.map((row) => ({ id: row.id, sourceTimestamp: row.source_timestamp || row.created_at || null, latestReviewAction: audit.get(row.id)?.action || null, proposedAction: "review_queue_triage", preview: truncate(row.content || row.summary, 160) }));
  return { report: { count: pending.length, pending: pending.length, skippedPending: skipped.length, reason: "Pending/review backlog is reported for human queue planning only.", items: sample(items, sampleLimit) } };
}

function findHighHeatWeakEvidence(rows, weakIds, { highHeatThreshold, sampleLimit }) {
  const items = rows.filter((row) => row.status !== "invalid").filter((row) => toNumber(row.heat) >= highHeatThreshold && weakIds.has(row.id)).map((row) => ({ id: row.id, status: row.status, heat: toNumber(row.heat), proposedAction: "high_heat_evidence_review", reason: `Memory heat is at or above ${highHeatThreshold}, but evidence is weak.`, preview: truncate(row.content || row.summary, 180) }));
  items.sort((left, right) => right.heat - left.heat || left.id.localeCompare(right.id));
  return { report: { count: items.length, reason: "Hot memories with weak evidence should not be allowed to dominate recall without review.", items: sample(items, sampleLimit) } };
}

function findSofteningSuggestions(rows, { staleIds, weakIds, longUnrecalledIds, sampleLimit }) {
  const items = [];
  for (const row of rows) {
    if (row.status !== "active" || row.pinned) continue;
    const reasons = [];
    if (staleIds.has(row.id)) reasons.push("stale preference/fact signal");
    if (weakIds.has(row.id)) reasons.push("weak evidence");
    if (longUnrecalledIds.has(row.id)) reasons.push("long unrecalled active memory");
    if (reasons.length === 0) continue;
    items.push({ id: row.id, heat: toNumber(row.heat), reasons, proposedAction: "softening_review_only", reason: "Consider softer wording, lower priority, or confirmation; do not auto-apply.", preview: truncate(row.content || row.summary, 180) });
  }
  items.sort((left, right) => right.reasons.length - left.reasons.length || left.id.localeCompare(right.id));
  return { report: { count: items.length, reason: "Softening suggestions are review-only and intentionally not DB writes.", items: sample(items, sampleLimit) } };
}

function evidenceWeaknessReasons(row, auditSummary) {
  const reasons = [];
  if (!String(row.source_file || "").trim()) reasons.push("missing source_file");
  const sourceIds = readSourceIds(row);
  if (sourceIds.length === 0) reasons.push("missing source_message_ids");
  if (!String(row.source_timestamp || row.created_at || "").trim()) reasons.push("missing source timestamp");
  if (row.status === "active" && (!auditSummary || auditSummary.action !== "approve")) reasons.push("active memory lacks latest approve audit");
  if (auditSummary && auditSummary.action && !String(auditSummary.note || "").trim()) reasons.push("latest review audit note is empty");
  return reasons;
}

function loadAuditSummary(db) {
  const columns = getColumns(db, "memory_review_audit");
  if (!columns.has("memory_id")) return new Map();
  const rows = db.prepare("SELECT * FROM memory_review_audit ORDER BY memory_id, created_at DESC, id DESC").all();
  const latest = new Map();
  for (const row of rows) if (!latest.has(row.memory_id)) latest.set(row.memory_id, row);
  return latest;
}

function countRows(rows) {
  const counts = { total: rows.length, active: 0, pending: 0, invalid: 0, pinned: 0 };
  for (const row of rows) {
    if (row.status === "active") counts.active += 1;
    if (row.status === "pending") counts.pending += 1;
    if (row.status === "invalid") counts.invalid += 1;
    if (row.pinned) counts.pinned += 1;
  }
  return counts;
}

function readSourceIds(row) {
  const raw = row.source_message_ids ?? row.source_ids ?? "";
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  try { const parsed = JSON.parse(String(raw || "")); if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean); } catch {}
  return String(raw || "").split(/[ ,;]+/).map((item) => item.trim()).filter(Boolean);
}

function compareEvidenceStrength(left, right) {
  return Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || toNumber(right.heat) - toNumber(left.heat) || readSourceIds(right).length - readSourceIds(left).length || String(right.source_timestamp || "").localeCompare(String(left.source_timestamp || "")) || String(left.id).localeCompare(String(right.id));
}

function similarity(left, right) {
  const leftNorm = normalizeText(left);
  const rightNorm = normalizeText(right);
  if (!leftNorm || !rightNorm) return 0;
  if (leftNorm === rightNorm) return 1;
  const leftTokens = tokenSet(leftNorm);
  const rightTokens = tokenSet(rightNorm);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
  return intersection / (leftTokens.size + rightTokens.size - intersection);
}

function tokenSet(value) {
  const text = normalizeText(value);
  const words = text.match(/[a-z0-9]+|[\u4e00-\u9fff]/g) || [];
  if (words.length <= 1 && text.length > 2) {
    const grams = [];
    for (let index = 0; index < text.length - 1; index += 1) grams.push(text.slice(index, index + 2));
    return new Set(grams);
  }
  return new Set(words);
}

function hasPreferenceOrFactSignal(value) {
  const text = normalizeText(value);
  return /prefer|preference|likes?|dislikes?|current|now|default|account|address|city|job|relationship|habit|want|need|use|using|profile|location/.test(text);
}

function normalizeText(value) { return String(value || "").toLowerCase().replace(/[`*_~#>\[\](){}???????,.!?;:"'\s-]+/g, " ").trim().replace(/\s+/g, " "); }
function newestValidDate(...values) { const dates = values.map(validDate).filter(Boolean).sort((left, right) => right.getTime() - left.getTime()); return dates[0] || null; }
function validDate(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date : null; }
function normalizeDate(value) { const date = value instanceof Date ? value : new Date(value); if (!Number.isFinite(date.getTime())) throw new Error(`Invalid date: ${value}`); return date; }
function normalizePositiveInteger(value, name) { const number = Number(value); if (!Number.isInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`); return number; }
function normalizeNonNegativeNumber(value, name) { const number = Number(value); if (!Number.isFinite(number) || number < 0) throw new Error(`${name} must be a non-negative number`); return number; }
function normalizeRatio(value, name) { const number = Number(value); if (!Number.isFinite(number) || number <= 0 || number > 1) throw new Error(`${name} must be > 0 and <= 1`); return number; }
function toNumber(value) { const number = Number(value); return Number.isFinite(number) ? number : 0; }
function round(value) { return Math.round(Number(value) * 1000) / 1000; }
function sample(items, limit) { return items.slice(0, limit); }
function truncate(value, maxLength = 160) { const text = String(value || "").replace(/\s+/g, " ").trim(); return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text; }
function renderFinding(item) { if (item.memoryIds) return `ids=${item.memoryIds.join(", ")} action=${item.proposedAction}; ${item.reason} Preview: ${item.preview}`; return `id=${item.id} action=${item.proposedAction}; ${item.reason || (item.reasons || []).join(", ")} Preview: ${item.preview || ""}`; }
function sha256(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function formatTimestamp(value) { return normalizeDate(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); }
function getTableNames(db) { return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name)); }
function getColumns(db, table) { return new Set(db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((row) => row.name)); }
function assertTable(db, table) { if (!getTableNames(db).has(table)) throw new Error(`${table} table is missing`); }
function quoteIdentifier(value) { return `"${String(value).replace(/"/g, '""')}"`; }
function requireDatabase(dbPath) { if (!dbPath) throw new Error("Usage: node scripts/memory-v2-patrol.js --db FILE [--output-root DIR]"); const resolved = path.resolve(String(dbPath)); if (!fs.existsSync(resolved)) throw new Error(`Memory V2 database does not exist: ${resolved}`); return resolved; }

function parseArgs(argv) {
  const options = {};
  const mapping = { "--db": "dbPath", "--output-root": "outputRoot", "--now": "now", "--sample-limit": "sampleLimit", "--similar-threshold": "similarThreshold", "--stale-fact-days": "staleFactDays", "--unrecalled-active-days": "unrecalledActiveDays", "--high-heat-threshold": "highHeatThreshold" };
  for (let index = 0; index < argv.length; index += 1) {
    const key = mapping[argv[index]];
    const value = argv[index + 1];
    if (!key || value === undefined) throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = runMemoryV2Patrol(options);
    const paths = writeReports(report, { outputRoot: options.outputRoot });
    process.stdout.write(`${JSON.stringify({ mode: report.mode, readOnly: report.readOnly, jsonPath: paths.jsonPath, markdownPath: paths.markdownPath, safety: report.safety }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`[memory-v2-patrol] ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { runMemoryV2Patrol, writeReports, renderMarkdown, parseArgs };