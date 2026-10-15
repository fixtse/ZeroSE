import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type {
  Job,
  MemoryFragment,
  StoredMemory,
  PendingMemoryMessage,
} from '../../domain/models.js';
import type { ConversationStore, AuditPort, MemoryRepository } from '../../application/ports.js';
export class Store implements ConversationStore, AuditPort, MemoryRepository {
  readonly db: DatabaseSync;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dir, 'assistant.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, session TEXT NOT NULL, dedupe TEXT UNIQUE,
        payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', output TEXT, error TEXT,
        created TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, thread TEXT, history_after INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY,session TEXT,role TEXT,text TEXT,
        consolidated INTEGER NOT NULL DEFAULT 0,created TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS memories(id INTEGER PRIMARY KEY,session TEXT,text TEXT,category TEXT,
        tags TEXT,embedding TEXT,source TEXT UNIQUE,created TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,job TEXT,tool TEXT,success INTEGER,duration INTEGER,created TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS schedules(key TEXT PRIMARY KEY,created TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session,id);`);
    // Never replay a job whose external effects may already have happened.
    this.db.exec(
      "UPDATE jobs SET status='failed',error='Service stopped during execution; inspect effects before retrying' WHERE status='running'",
    );
  }
  enqueue(session: string, payload: unknown, dedupe: string = randomUUID()): Job {
    const id = randomUUID();
    this.db
      .prepare('INSERT OR IGNORE INTO jobs(id,session,dedupe,payload) VALUES(?,?,?,?)')
      .run(id, session, dedupe, JSON.stringify(payload));
    return this.decode(this.db.prepare('SELECT * FROM jobs WHERE dedupe=?').get(dedupe));
  }
  private decode(row: any): Job {
    return { ...row, payload: JSON.parse(row.payload) };
  }
  job(id: string): Job | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    return row ? this.decode(row) : undefined;
  }
  claim(excluded: string[]): Job | undefined {
    const rows = this.db
      .prepare("SELECT * FROM jobs WHERE status='pending' ORDER BY rowid LIMIT 1000")
      .all();
    const row = rows.find((r) => !excluded.includes(String(r.session)));
    if (!row) return;
    this.db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(row.id);
    return this.decode(row);
  }
  finish(id: string, output: string) {
    this.db.prepare("UPDATE jobs SET status='done',output=? WHERE id=?").run(output, id);
  }
  fail(id: string, error: string) {
    this.db.prepare("UPDATE jobs SET status='failed',error=? WHERE id=?").run(error, id);
  }
  thread(session: string): string | undefined {
    return this.db.prepare('SELECT thread FROM sessions WHERE id=?').get(session)?.thread as
      | string
      | undefined;
  }
  setThread(session: string, thread: string) {
    this.db
      .prepare(
        'INSERT INTO sessions(id,thread) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET thread=excluded.thread',
      )
      .run(session, thread);
  }
  reset(session?: string) {
    if (session) {
      this.db
        .prepare(
          'INSERT INTO sessions(id,thread,history_after) VALUES(?,NULL,(SELECT COALESCE(MAX(id),0) FROM messages)) ON CONFLICT(id) DO UPDATE SET thread=NULL,history_after=excluded.history_after',
        )
        .run(session);
    } else
      this.db.exec(
        'UPDATE sessions SET thread=NULL,history_after=(SELECT COALESCE(MAX(id),0) FROM messages)',
      );
  }
  addMessage(session: string, role: string, text: string) {
    this.db
      .prepare('INSERT INTO messages(session,role,text) VALUES(?,?,?)')
      .run(session, role, text);
  }
  history(session: string) {
    return this.db
      .prepare(
        'SELECT role,text,created FROM messages WHERE session=? AND id>COALESCE((SELECT history_after FROM sessions WHERE id=?),0) ORDER BY id DESC LIMIT 40',
      )
      .all(session, session)
      .reverse();
  }
  audit(job: string, tool: string, success: boolean, duration: number) {
    this.db
      .prepare('INSERT INTO audit(job,tool,success,duration) VALUES(?,?,?,?)')
      .run(job, tool, +success, duration);
  }
  scheduled(key: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM schedules WHERE key=?').get(key);
  }
  markScheduled(key: string) {
    this.db.prepare('INSERT OR IGNORE INTO schedules(key) VALUES(?)').run(key);
  }
  sessions(): string[] {
    return this.db
      .prepare('SELECT id FROM sessions')
      .all()
      .map((row) => String(row.id));
  }
  insertMemory(
    session: string,
    value: MemoryFragment,
    embedding: number[] | null,
    source?: string,
  ) {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO memories(session,text,category,tags,embedding,source) VALUES(?,?,?,?,?,?)',
      )
      .run(
        session,
        value.text,
        value.category,
        JSON.stringify(value.tags),
        embedding ? JSON.stringify(embedding) : null,
        source || null,
      );
  }
  memories(session: string): StoredMemory[] {
    return this.db
      .prepare('SELECT * FROM memories WHERE session=?')
      .all(session)
      .map((row) => ({
        id: Number(row.id),
        text: String(row.text),
        category: String(row.category),
        tags: JSON.parse(String(row.tags)),
        embedding: row.embedding ? JSON.parse(String(row.embedding)) : null,
        created: String(row.created),
      }));
  }
  pendingMemoryMessages(session: string): PendingMemoryMessage[] {
    return this.db
      .prepare(
        "SELECT id,text,created FROM messages WHERE role='user' AND consolidated=0 AND session=? ORDER BY id LIMIT 200",
      )
      .all(session)
      .map((row) => ({ id: Number(row.id), text: String(row.text), created: String(row.created) }));
  }
  pendingMemorySessions(): string[] {
    return this.db
      .prepare("SELECT DISTINCT session FROM messages WHERE role='user' AND consolidated=0")
      .all()
      .map((row) => String(row.session));
  }
  markConsolidated(session: string, ids: number[]) {
    for (const id of ids)
      this.db
        .prepare('UPDATE messages SET consolidated=1 WHERE id=? AND session=?')
        .run(id, session);
  }
  close() {
    this.db.close();
  }
}
