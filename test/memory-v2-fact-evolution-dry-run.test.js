const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const {
  runFactEvolutionDryRun,
  writeReports,
} = require("../scripts/memory-v2-fact-evolution-dry-run");

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-fact-evolution-"));
  const dbPath = path.join(root, "memory-v2.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE memory_index (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      source_message_ids TEXT NOT NULL,
      source_file TEXT NOT NULL,
      source_timestamp TEXT NOT NULL,
      heat REAL NOT NULL,
      recall_count INTEGER NOT NULL,
      last_recalled_at TEXT,
      last_recalled TEXT,
      pinned INTEGER NOT NULL,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE memory_review_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL,
      action TEXT NOT NULL,
      previous_status TEXT NOT NULL,
      next_status TEXT NOT NULL,
      actor TEXT NOT NULL,
      note TEXT NOT NULL,
      memory_snapshot TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE memory_recall_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return { root, dbPath, db };
}

function insertMemory(db, row = {}) {
  const value = {
    id: "mem_1",
    status: "active",
    title: "Memory",
    content: "current account: A",
    source_message_ids: '["source_1"]',
    source_file: "/tmp/l0.jsonl",
    source_timestamp: "2026-01-01T00:00:00.000Z",
    heat: 0.1,
    recall_count: 0,
    last_recalled_at: null,
    last_recalled: null,
    pinned: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...row,
  };
  db.prepare(`
    INSERT INTO memory_index (
      id, status, title, content, source_message_ids, source_file,
      source_timestamp, heat, recall_count, last_recalled_at, last_recalled,
      pinned, created_at, updated_at
    ) VALUES (
      @id, @status, @title, @content, @source_message_ids, @source_file,
      @source_timestamp, @heat, @recall_count, @last_recalled_at, @last_recalled,
      @pinned, @created_at, @updated_at
    )
  `).run(value);
}

function insertAudit(db, memoryId = "mem_1") {
  db.prepare(`
    INSERT INTO memory_review_audit (
      memory_id, action, previous_status, next_status, actor, note, memory_snapshot, created_at
    ) VALUES (?, 'approve', 'pending', 'active', 'tester', 'verified', '{}', '2026-01-01T00:00:00.000Z')
  `).run(memoryId);
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function auditCount(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Number(db.prepare("SELECT COUNT(*) AS count FROM memory_review_audit").get().count);
  } finally {
    db.close();
  }
}

function sampleRows(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(`
      SELECT id, heat, recall_count, last_recalled_at, last_recalled
      FROM memory_index
      ORDER BY id
    `).all();
  } finally {
    db.close();
  }
}

test("same explicit fact domain with different values generates conflict candidate", () => {
  const fixture = createFixture();
  insertMemory(fixture.db, { id: "account-a", content: "current account: A", source_timestamp: "2026-01-01T00:00:00.000Z" });
  insertMemory(fixture.db, { id: "account-b", content: "current account: B", source_timestamp: "2026-06-01T00:00:00.000Z" });
  insertAudit(fixture.db, "account-a");
  insertAudit(fixture.db, "account-b");
  fixture.db.close();

  const report = runFactEvolutionDryRun({ dbPath: fixture.dbPath, now: "2026-06-30T00:00:00.000Z" });

  assert.equal(report.candidates.possiblyConflicting.length, 1);
  assert.equal(report.candidates.possiblyConflicting[0].candidateType, "possiblyConflicting");
  assert.equal(report.candidates.possiblyConflicting[0].factDomain, "account");
  assert.deepEqual(report.candidates.possiblyConflicting[0].involvedMemoryIds.sort(), ["account-a", "account-b"]);
});

test("old fact plus newer fact generates superseded candidate without writing", () => {
  const fixture = createFixture();
  insertMemory(fixture.db, { id: "city-old", content: "current city: Hefei", source_timestamp: "2026-01-01T00:00:00.000Z" });
  insertMemory(fixture.db, { id: "city-new", content: "current city: Dali", source_timestamp: "2026-06-20T00:00:00.000Z" });
  insertAudit(fixture.db, "city-old");
  insertAudit(fixture.db, "city-new");
  fixture.db.close();
  const before = sha256(fixture.dbPath);

  const report = runFactEvolutionDryRun({ dbPath: fixture.dbPath, now: "2026-06-30T00:00:00.000Z" });

  assert.equal(report.candidates.possiblySuperseded.length, 1);
  assert.equal(report.candidates.possiblySuperseded[0].suggestedHumanAction, "consider_supersede_later");
  assert.equal(sha256(fixture.dbPath), before);
});

test("old temporal fact generates stale candidate", () => {
  const fixture = createFixture();
  insertMemory(fixture.db, { id: "runtime-old", content: "current runtime: Claude Code", source_timestamp: "2026-01-01T00:00:00.000Z" });
  insertAudit(fixture.db, "runtime-old");
  fixture.db.close();

  const report = runFactEvolutionDryRun({
    dbPath: fixture.dbPath,
    now: "2026-06-30T00:00:00.000Z",
    staleDays: 60,
  });

  assert.equal(report.candidates.possiblyStale.length, 1);
  assert.equal(report.candidates.possiblyStale[0].confidence, "medium");
  assert.equal(report.candidates.possiblyStale[0].safetyNote, "dry-run only, no DB write");
});

test("ordinary preference differences are not high-confidence conflicts", () => {
  const fixture = createFixture();
  insertMemory(fixture.db, { id: "likes-tea", content: "User likes tea.", source_timestamp: "2026-06-01T00:00:00.000Z" });
  insertMemory(fixture.db, { id: "likes-coffee", content: "User likes coffee.", source_timestamp: "2026-06-02T00:00:00.000Z" });
  insertMemory(fixture.db, { id: "stable-pref", content: "stable preference: quiet mornings", source_timestamp: "2026-06-03T00:00:00.000Z" });
  insertAudit(fixture.db, "likes-tea");
  insertAudit(fixture.db, "likes-coffee");
  insertAudit(fixture.db, "stable-pref");
  fixture.db.close();

  const report = runFactEvolutionDryRun({ dbPath: fixture.dbPath, now: "2026-06-30T00:00:00.000Z" });

  assert.equal(report.candidates.possiblyConflicting.length, 0);
  assert.equal(report.counts.extractedFacts, 1);
});

test("database bytes, audit count, heat, recall_count, and recall timestamps remain unchanged and reports write", () => {
  const fixture = createFixture();
  insertMemory(fixture.db, {
    id: "path-old",
    content: "current path: /root/old",
    heat: 0.9,
    recall_count: 3,
    last_recalled_at: "2026-06-01T00:00:00.000Z",
    last_recalled: "2026-06-01T00:00:00.000Z",
  });
  insertAudit(fixture.db, "path-old");
  fixture.db.prepare("INSERT INTO memory_recall_audit (memory_id, created_at) VALUES (?, ?)").run(
    "path-old",
    "2026-06-01T00:00:00.000Z",
  );
  fixture.db.close();
  const beforeHash = sha256(fixture.dbPath);
  const beforeAuditCount = auditCount(fixture.dbPath);
  const beforeRows = sampleRows(fixture.dbPath);

  const report = runFactEvolutionDryRun({ dbPath: fixture.dbPath, now: "2026-06-30T00:00:00.000Z" });
  const paths = writeReports(report, { outputRoot: fixture.root });

  assert.equal(fs.existsSync(paths.jsonPath), true);
  assert.equal(fs.existsSync(paths.markdownPath), true);
  assert.equal(sha256(fixture.dbPath), beforeHash);
  assert.equal(auditCount(fixture.dbPath), beforeAuditCount);
  assert.deepEqual(sampleRows(fixture.dbPath), beforeRows);
  assert.deepEqual(report.safety, {
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
  });
});

test("requires explicit database path so production is not touched by default", () => {
  assert.throws(() => runFactEvolutionDryRun(), /--db FILE/);
});
