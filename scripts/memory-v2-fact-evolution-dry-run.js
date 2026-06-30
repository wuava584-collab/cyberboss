#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DEFAULTS = {
  sampleLimit: 40,
  staleDays: 90,
};

const DOMAIN_RULES = [
  { domain: "account", pattern: /\b(account|账号)\b/i, value: valueAfter },
  { domain: "model", pattern: /\b(model|模型)\b/i, value: valueAfter },
  { domain: "city", pattern: /\b(city|城市)\b/i, value: valueAfter },
  { domain: "location", pattern: /\b(location|位置)\b/i, value: valueAfter },
  { domain: "address", pattern: /\b(address|地址)\b/i, value: valueAfter },
  { domain: "version", pattern: /\b(version|版本)\b/i, value: valueAfter },
  { domain: "runtime", pattern: /\b(runtime|运行时)\b/i, value: valueAfter },
  { domain: "default", pattern: /\b(default|默认设置|默认)\b/i, value: valueAfter },
  { domain: "path", pattern: /\b(path|路径)\b/i, value: valueAfter },
  { domain: "identity", pattern: /\b(identity|身份设定|身份)\b/i, value: valueAfter },
  {
    domain: "stable_preference",
    pattern: /\b(stable preference|explicit stable preference|明确稳定偏好)\b/i,
    value: valueStablePreference,
    confidenceCap: "medium",
  },
];

const TEMPORAL_PATTERN = /\b(current|now|currently|at present|目前|当前|现在)\b/i;

function runFactEvolutionDryRun({
  dbPath,
  now = new Date(),
  sampleLimit = DEFAULTS.sampleLimit,
  staleDays = DEFAULTS.staleDays,
} = {}) {
  const resolvedDbPath = requireDatabase(dbPath);
  const checkedAt = normalizeDate(now);
  const limit = normalizePositiveInteger(sampleLimit, "sampleLimit");
  const staleWindowDays = normalizePositiveInteger(staleDays, "staleDays");
  const db = new DatabaseSync(resolvedDbPath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON");
    assertTable(db, "memory_index");
    const columns = getColumns(db, "memory_index");
    const rows = db.prepare("SELECT * FROM memory_index ORDER BY id").all();
    const activeRows = rows.filter((row) => row.status === "active");
    const facts = activeRows.flatMap((row) => extractFacts(row, columns));
    const possiblyConflicting = findConflicts(facts, limit);
    const possiblySuperseded = findSuperseded(facts, limit);
    const possiblyStale = findStale(facts, checkedAt, staleWindowDays, limit);
    return {
      schemaVersion: 1,
      kind: "memory-v2-fact-evolution-dry-run",
      mode: "dry-run",
      checkedAt: checkedAt.toISOString(),
      database: resolvedDbPath,
      readOnly: true,
      policy: {
        sampleLimit: limit,
        staleDays: staleWindowDays,
        domains: DOMAIN_RULES.map((rule) => rule.domain),
        preferenceHandling: "stable_preference only; ordinary likes/dislikes are not high-confidence conflicts",
      },
      counts: {
        scannedRows: rows.length,
        activeRows: activeRows.length,
        extractedFacts: facts.length,
        possiblyStale: possiblyStale.length,
        possiblyConflicting: possiblyConflicting.length,
        possiblySuperseded: possiblySuperseded.length,
      },
      candidates: {
        possiblyStale,
        possiblyConflicting,
        possiblySuperseded,
      },
      safety: {
        databaseWrites: 0,
        l0Writes: 0,
        auditWrites: 0,
        supersedeWrites: 0,
        contradictionWrites: 0,
        statusChanges: 0,
        heatUpdates: 0,
        liveRecallChanges: 0,
        pm2Restarts: 0,
        requiresHumanReviewToApply: true,
      },
    };
  } finally {
    db.close();
  }
}

function writeReports(report, { outputRoot, prefix = "fact-evolution" } = {}) {
  const runId = `memory-v2-fact-evolution-${formatTimestamp(report.checkedAt)}`;
  const outputDir = path.resolve(outputRoot || path.join(process.cwd(), "tmp", "memory-v2-fact-evolution"), runId);
  fs.mkdirSync(outputDir, { recursive: true });
  const safePrefix = String(prefix || "fact-evolution").replace(/[^a-zA-Z0-9._-]/g, "_");
  const jsonPath = path.join(outputDir, `${safePrefix}.json`);
  const markdownPath = path.join(outputDir, `${safePrefix}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(markdownPath, renderMarkdown(report), "utf8");
  return { outputDir, jsonPath, markdownPath };
}

function renderMarkdown(report) {
  const lines = [
    "# Memory V2 Fact Evolution Dry-Run",
    "",
    `Mode: ${report.mode}`,
    `Checked: ${report.checkedAt}`,
    `Database: \`${report.database}\``,
    `Database opened read-only: ${report.readOnly ? "yes" : "no"}`,
    "",
    "## Counts",
    "",
    "| Metric | Count |",
    "| --- | ---: |",
  ];
  for (const [name, count] of Object.entries(report.counts)) {
    lines.push(`| ${name} | ${count} |`);
  }
  lines.push("", "## Candidates", "");
  for (const [name, items] of Object.entries(report.candidates)) {
    lines.push(`### ${name}`, "");
    if (items.length === 0) {
      lines.push("- none", "");
      continue;
    }
    for (const item of items) {
      lines.push(`- ${item.candidateType} ${item.factDomain}/${item.factKey} (${item.confidence}): ${item.reason}`);
      lines.push(`  - memories: ${item.involvedMemoryIds.join(", ")}`);
      lines.push(`  - action: ${item.suggestedHumanAction}`);
      lines.push(`  - safety: ${item.safetyNote}`);
    }
    lines.push("");
  }
  lines.push(
    "## Safety",
    "",
    "- Database writes: 0",
    "- L0 writes: 0",
    "- Audit writes: 0",
    "- Supersede writes: 0",
    "- Contradiction writes: 0",
    "- Status changes: 0",
    "- Heat updates: 0",
    "- Live recall changes: 0",
    "",
  );
  return lines.join("\n");
}

function extractFacts(row, columns) {
  const content = String(row.content || row.summary || "").trim();
  if (!content) {
    return [];
  }
  const facts = [];
  for (const rule of DOMAIN_RULES) {
    if (!rule.pattern.test(content)) {
      continue;
    }
    const value = rule.value(content, rule.domain);
    if (!value) {
      continue;
    }
    const temporal = TEMPORAL_PATTERN.test(content) || rule.domain === "default";
    facts.push({
      memoryId: row.id,
      domain: rule.domain,
      key: guessFactKey(rule.domain, content),
      value,
      normalizedValue: normalizeValue(value),
      confidence: rule.confidenceCap || (temporal ? "high" : "medium"),
      temporal,
      sourceTimestamp: firstExisting(row, columns, ["source_timestamp", "created_at", "updated_at"]),
      evidenceSnippet: truncate(content, 220),
    });
  }
  return facts;
}

function findConflicts(facts, sampleLimit) {
  const byKey = groupBy(facts, (fact) => `${fact.domain}:${fact.key}`);
  const candidates = [];
  for (const [factKey, group] of byKey.entries()) {
    const values = new Map();
    for (const fact of group) {
      const bucket = values.get(fact.normalizedValue) || [];
      bucket.push(fact);
      values.set(fact.normalizedValue, bucket);
    }
    if (values.size < 2) {
      continue;
    }
    const involved = group.sort(compareFactTime);
    const confidence = group.some((fact) => fact.domain === "stable_preference") ? "low" : "medium";
    candidates.push(candidate({
      candidateType: "possiblyConflicting",
      confidence,
      factDomain: involved[0].domain,
      factKey,
      involvedFacts: involved,
      reason: "Same conservative fact domain/key has multiple normalized values. This is a review candidate, not an automatic contradiction.",
      suggestedHumanAction: confidence === "low" ? "review" : "consider_supersede_later",
    }));
  }
  return candidates.slice(0, sampleLimit);
}

function findSuperseded(facts, sampleLimit) {
  const byKey = groupBy(facts, (fact) => `${fact.domain}:${fact.key}`);
  const candidates = [];
  for (const [factKey, group] of byKey.entries()) {
    const ordered = group.filter((fact) => validDate(fact.sourceTimestamp)).sort(compareFactTime);
    if (ordered.length < 2) {
      continue;
    }
    const oldest = ordered[0];
    const newest = ordered[ordered.length - 1];
    if (oldest.normalizedValue === newest.normalizedValue) {
      continue;
    }
    candidates.push(candidate({
      candidateType: "possiblySuperseded",
      confidence: oldest.domain === "stable_preference" ? "low" : "medium",
      factDomain: newest.domain,
      factKey,
      involvedFacts: [oldest, newest],
      reason: "A newer fact in the same conservative domain/key has a different value. Human review can decide whether the older memory should be softened or later superseded.",
      suggestedHumanAction: "consider_supersede_later",
    }));
  }
  return candidates.slice(0, sampleLimit);
}

function findStale(facts, checkedAt, staleDays, sampleLimit) {
  const cutoff = checkedAt.getTime() - staleDays * 86400000;
  return facts
    .filter((fact) => fact.temporal)
    .filter((fact) => {
      const date = validDate(fact.sourceTimestamp);
      return date && date.getTime() <= cutoff;
    })
    .sort(compareFactTime)
    .slice(0, sampleLimit)
    .map((fact) => candidate({
      candidateType: "possiblyStale",
      confidence: fact.domain === "stable_preference" ? "low" : "medium",
      factDomain: fact.domain,
      factKey: `${fact.domain}:${fact.key}`,
      involvedFacts: [fact],
      reason: `Temporal fact is older than ${staleDays} days and may need confirmation or softer wording.`,
      suggestedHumanAction: "soften",
    }));
}

function candidate({
  candidateType,
  confidence,
  factDomain,
  factKey,
  involvedFacts,
  reason,
  suggestedHumanAction,
}) {
  return {
    candidateType,
    confidence,
    factDomain,
    factKey,
    involvedMemoryIds: Array.from(new Set(involvedFacts.map((fact) => fact.memoryId))),
    evidenceSnippets: involvedFacts.map((fact) => ({
      memoryId: fact.memoryId,
      value: fact.value,
      sourceTimestamp: fact.sourceTimestamp || null,
      snippet: fact.evidenceSnippet,
    })),
    reason,
    suggestedHumanAction,
    safetyNote: "dry-run only, no DB write",
  };
}

function valueAfter(content, domain) {
  const escaped = domain.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const regexes = [
    new RegExp(`${escaped}\\s*(?:is|=|:|：)\\s*([^.;,，。\\n]+)`, "i"),
    /\b(?:current|now|default|目前|当前|现在|默认)\b[^:：=]*[:：=]\\s*([^.;,，。\n]+)/i,
  ];
  for (const regex of regexes) {
    const match = content.match(regex);
    if (match?.[1]) {
      return truncate(match[1], 80);
    }
  }
  return "";
}

function valueStablePreference(content) {
  const match = content.match(/\b(?:stable preference|explicit stable preference)\s*(?:is|=|:|：)\s*([^.;,，。\n]+)/i);
  return match?.[1] ? truncate(match[1], 80) : "";
}

function guessFactKey(domain, content) {
  const lower = content.toLowerCase();
  for (const qualifier of ["claude", "account", "model", "city", "runtime", "path", "default"]) {
    if (lower.includes(qualifier)) {
      return `${domain}.${qualifier}`;
    }
  }
  return domain;
}

function firstExisting(row, columns, names) {
  for (const name of names) {
    if (columns.has(name) && row[name]) {
      return row[name];
    }
  }
  return null;
}

function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    const list = groups.get(key) || [];
    list.push(item);
    groups.set(key, list);
  }
  return groups;
}

function compareFactTime(left, right) {
  const leftTime = validDate(left.sourceTimestamp)?.getTime() || 0;
  const rightTime = validDate(right.sourceTimestamp)?.getTime() || 0;
  return leftTime - rightTime || left.memoryId.localeCompare(right.memoryId);
}

function normalizeValue(value) {
  return String(value || "").toLowerCase().replace(/[`*_~#>[\](){}，。！？、；：,.!?;:"'\s-]+/g, " ").trim().replace(/\s+/g, " ");
}

function truncate(value, maxLength = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function validDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return date;
}

function normalizePositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return number;
}

function getTableNames(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
}

function getColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((row) => row.name));
}

function assertTable(db, table) {
  if (!getTableNames(db).has(table)) {
    throw new Error(`${table} table is missing`);
  }
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function requireDatabase(dbPath) {
  if (!dbPath) {
    throw new Error("Usage: node scripts/memory-v2-fact-evolution-dry-run.js --db FILE [--output-root DIR]");
  }
  const resolved = path.resolve(String(dbPath));
  if (!fs.existsSync(resolved)) {
    throw new Error(`Memory V2 database does not exist: ${resolved}`);
  }
  return resolved;
}

function formatTimestamp(value) {
  return normalizeDate(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function parseArgs(argv) {
  const options = {};
  const mapping = {
    "--db": "dbPath",
    "--output-root": "outputRoot",
    "--now": "now",
    "--sample-limit": "sampleLimit",
    "--stale-days": "staleDays",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = mapping[argv[index]];
    const value = argv[index + 1];
    if (!key || value === undefined) {
      throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
    }
    options[key] = value;
    index += 1;
  }
  return options;
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = runFactEvolutionDryRun(options);
    const paths = writeReports(report, { outputRoot: options.outputRoot });
    process.stdout.write(`${JSON.stringify({
      mode: report.mode,
      readOnly: report.readOnly,
      jsonPath: paths.jsonPath,
      markdownPath: paths.markdownPath,
      safety: report.safety,
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`[memory-v2-fact-evolution] ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  runFactEvolutionDryRun,
  writeReports,
  renderMarkdown,
  parseArgs,
};
