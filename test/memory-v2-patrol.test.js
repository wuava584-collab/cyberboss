const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const { runMemoryV2Patrol, writeReports } = require("../scripts/memory-v2-patrol");

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-v2-patrol-"));
  const dbPath = path.join(root, "memory-v2.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE memory_index (id TEXT PRIMARY KEY,status TEXT NOT NULL,title TEXT NOT NULL,content TEXT NOT NULL,source_message_ids TEXT NOT NULL,source_file TEXT NOT NULL,source_timestamp TEXT NOT NULL,heat REAL NOT NULL,last_recalled TEXT,pinned INTEGER NOT NULL,created_at TEXT,updated_at TEXT); CREATE TABLE memory_review_audit (id INTEGER PRIMARY KEY AUTOINCREMENT,memory_id TEXT NOT NULL,action TEXT NOT NULL,previous_status TEXT NOT NULL,next_status TEXT NOT NULL,actor TEXT NOT NULL,note TEXT NOT NULL,memory_snapshot TEXT NOT NULL,created_at TEXT NOT NULL);`);
  return { root, dbPath, db };
}

function insertMemory(db, row = {}) {
  const value = { id: "mem_1", status: "active", title: "Memory", content: "The user likes quiet mornings.", source_message_ids: '["source_1"]', source_file: "/root/.cyberboss/conversations/2026-01-01.jsonl", source_timestamp: "2026-01-01T00:00:00.000Z", heat: 0.1, last_recalled: null, pinned: 0, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", ...row };
  db.prepare(`INSERT INTO memory_index (id,status,title,content,source_message_ids,source_file,source_timestamp,heat,last_recalled,pinned,created_at,updated_at) VALUES (@id,@status,@title,@content,@source_message_ids,@source_file,@source_timestamp,@heat,@last_recalled,@pinned,@created_at,@updated_at)`).run(value);
}

function insertAudit(db, row = {}) {
  db.prepare(`INSERT INTO memory_review_audit (memory_id,action,previous_status,next_status,actor,note,memory_snapshot,created_at) VALUES (@memory_id,@action,@previous_status,@next_status,@actor,@note,@memory_snapshot,@created_at)`).run({ memory_id: "mem_1", action: "approve", previous_status: "pending", next_status: "active", actor: "tester", note: "verified source", memory_snapshot: "{}", created_at: "2026-01-01T00:00:00.000Z", ...row });
}

function sha256(filePath) { return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"); }

test("patrol detects duplicate, stale, backlog, weak evidence, hot weak memories, and softening suggestions", () => {
  const fixture = createFixture();
  insertMemory(fixture.db, { id: "dup-a", heat: 0.2 });
  insertMemory(fixture.db, { id: "dup-b", content: "  the user likes QUIET mornings. ", source_message_ids: '["source_2"]', heat: 0.8 });
  insertMemory(fixture.db, { id: "stale-pref", content: "User now prefers quiet mornings.", source_timestamp: "2026-01-05T00:00:00.000Z", heat: 0.4 });
  insertMemory(fixture.db, { id: "weak-hot", content: "User default account is A.", source_message_ids: "[]", source_file: "", source_timestamp: "2026-06-01T00:00:00.000Z", heat: 1.4 });
  insertMemory(fixture.db, { id: "pending-old", status: "pending", content: "Pending item needs review.", source_timestamp: "2026-02-01T00:00:00.000Z" });
  insertAudit(fixture.db, { memory_id: "dup-a" });
  insertAudit(fixture.db, { memory_id: "dup-b" });
  insertAudit(fixture.db, { memory_id: "stale-pref" });
  insertAudit(fixture.db, { memory_id: "weak-hot", note: "" });
  fixture.db.close();
  const before = sha256(fixture.dbPath);
  const report = runMemoryV2Patrol({ dbPath: fixture.dbPath, now: "2026-06-30T00:00:00.000Z", sampleLimit: 10, highHeatThreshold: 1 });
  assert.equal(report.mode, "dry-run");
  assert.equal(report.readOnly, true);
  assert.equal(report.checks.duplicateOrSimilar.count, 1);
  assert.equal(report.checks.stalePreferencesOrFacts.count >= 1, true);
  assert.equal(report.checks.lowEvidence.count >= 1, true);
  assert.equal(report.checks.longUnrecalledActive.count >= 1, true);
  assert.equal(report.checks.pendingReviewBacklog.count, 1);
  assert.equal(report.checks.highHeatWeakEvidence.count, 1);
  assert.equal(report.checks.softeningSuggestions.count >= 1, true);
  assert.deepEqual(report.safety, { databaseWrites: 0, l0Writes: 0, recallAuditWrites: 0, heatUpdates: 0, statusChanges: 0, liveRecallChanges: 0, pm2Restarts: 0, requiresHumanReviewToApply: true });
  assert.equal(sha256(fixture.dbPath), before);
});

test("patrol writes report files only and leaves fixture database unchanged", () => {
  const fixture = createFixture();
  insertMemory(fixture.db);
  insertAudit(fixture.db);
  fixture.db.close();
  const before = sha256(fixture.dbPath);
  const report = runMemoryV2Patrol({ dbPath: fixture.dbPath, now: "2026-06-30T00:00:00.000Z" });
  const paths = writeReports(report, { outputRoot: fixture.root });
  assert.equal(fs.existsSync(paths.jsonPath), true);
  assert.equal(fs.existsSync(paths.markdownPath), true);
  assert.match(fs.readFileSync(paths.markdownPath, "utf8"), /Memory V2 Patrol Report/);
  assert.equal(sha256(fixture.dbPath), before);
});

test("patrol requires an explicit database path so production is not touched by default", () => {
  assert.throws(() => runMemoryV2Patrol(), /--db FILE/);
});