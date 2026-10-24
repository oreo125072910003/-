import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import initSqlJs from 'sql.js';
import { TASK_STATUSES } from '../contracts/index.mjs';

const require = createRequire(import.meta.url);

function acquireOwnerLock(dataDir) {
  const filename=path.join(dataDir,'.assistant-owner.lock');
  const owner={pid:process.pid,token:randomUUID(),createdAt:new Date().toISOString()};
  for(let attempt=0;attempt<2;attempt++){
    try{fs.writeFileSync(filename,JSON.stringify(owner),{flag:'wx',mode:0o600});return()=>{try{const current=JSON.parse(fs.readFileSync(filename,'utf8'));if(current.token===owner.token)fs.unlinkSync(filename);}catch(error){if(error.code!=='ENOENT')throw error;}};}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      let existing,raw;
      try{raw=fs.readFileSync(filename,'utf8');existing=JSON.parse(raw);}catch{throw new Error('无法验证数据库锁，原文件已保留。请关闭所有小助手后检查数据目录。');}
      if(!Number.isSafeInteger(existing.pid)||existing.pid<=0)throw new Error('数据库锁的进程信息无效，原文件已保留。');
      let alive=true;try{process.kill(existing.pid,0);}catch(probe){if(probe.code==='ESRCH')alive=false;}
      if(alive)throw new Error('这个数据目录已由另一个小助手实例打开，请先退出该实例。');
      if(fs.readFileSync(filename,'utf8')!==raw)throw new Error('数据目录的使用状态发生变化，请重试。');
      fs.unlinkSync(filename);
    }
  }
  throw new Error('无法取得数据库写入锁，请重试。');
}

export async function createStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const filename = path.join(dataDir, 'assistant.sqlite');
  const releaseOwner=acquireOwnerLock(dataDir);
  let SQL;
  let db;
  try {
    SQL = await initSqlJs({ locateFile: name => path.join(path.dirname(require.resolve('sql.js/dist/sql-wasm.js')), name) });
    db = new SQL.Database(fs.existsSync(filename) ? fs.readFileSync(filename) : undefined);
    const result = db.exec('PRAGMA integrity_check');
    if (result[0]?.values?.[0]?.[0] !== 'ok') throw new Error('SQLite 完整性检查失败');
    if(db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'").length){
      const version=db.exec("SELECT value FROM metadata WHERE key='schema_version'")[0]?.values?.[0]?.[0];
      if(version&&version!=='1')throw new Error('数据版本高于当前程序，请使用匹配版本打开。');
    }
  } catch (error) {
    db?.close();releaseOwner();
    throw new Error(`无法读取小助手记录。原文件已保留，请恢复备份或检查数据目录。${error.message}`);
  }
  let closed = false;
  function snapshot() {
    const bytes = db.export();
    db.run('PRAGMA foreign_keys=ON');
    return bytes;
  }
  function flush() {
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, Buffer.from(snapshot()));
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, filename);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  function query(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally { stmt.free(); }
  }
  function transaction(fn) {
    if (closed) throw new Error('数据存储已关闭。');
    const previous = snapshot();
    db.run('BEGIN IMMEDIATE');
    try {
      const result = fn(); db.run('COMMIT'); flush(); return result;
    } catch (error) {
      try { db.run('ROLLBACK'); } catch {}
      db.close(); db = new SQL.Database(previous); db.run('PRAGMA foreign_keys=ON');
      throw error;
    }
  }
  try {transaction(() => db.run(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL,
      kind TEXT NOT NULL, status TEXT NOT NULL, progress TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, workspace TEXT NOT NULL,
      attachments TEXT NOT NULL DEFAULT '[]', session_id TEXT);
    CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
      type TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS events_task ON events(task_id,created_at);
    CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
      name TEXT NOT NULL, path TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL);
    INSERT OR IGNORE INTO metadata(key,value) VALUES('schema_version','1');
  `));}catch(error){db.close();releaseOwner();throw error;}
  const schema = query("SELECT value FROM metadata WHERE key='schema_version'")[0]?.value;
  if (schema !== '1') { db.close();releaseOwner();throw new Error('数据版本高于当前程序，请使用匹配版本打开。'); }
  function mapTask(row) {
    if (!row) return null;
    return { id: row.id, title: row.title, prompt: row.prompt, kind: row.kind, status: row.status,
      progress: row.progress, summary: row.summary, error: row.error, createdAt: row.created_at,
      updatedAt: row.updated_at, workspace: row.workspace, attachments: JSON.parse(row.attachments),
      attachmentNames: JSON.parse(row.attachments).map(a => a.name), sessionId: row.session_id };
  }
  const api = {
    filename,
    getSettings() { return Object.fromEntries(query('SELECT key,value FROM settings').map(r => [r.key, JSON.parse(r.value)])); },
    saveSettings(patch) { return transaction(() => { for (const [key, value] of Object.entries(patch)) db.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, JSON.stringify(value)]); }); },
    createTask(task) {
      transaction(() => db.run('INSERT INTO tasks(id,title,prompt,kind,status,created_at,updated_at,workspace,attachments) VALUES(?,?,?,?,?,?,?,?,?)',
        [task.id,task.title,task.prompt,task.kind,task.status,task.createdAt,task.createdAt,task.workspace,JSON.stringify(task.attachments)]));
      return api.getTask(task.id);
    },
    getTask(id) { return mapTask(query('SELECT * FROM tasks WHERE id=?', [id])[0]); },
    listTasks() { return query('SELECT * FROM tasks ORDER BY created_at DESC,id DESC LIMIT 500').map(mapTask); },
    updateTask(id, patch) {
      const fields = { status:'status', progress:'progress', summary:'summary', error:'error', sessionId:'session_id' };
      if (patch.status && !TASK_STATUSES.has(patch.status)) throw new Error('任务状态无效。');
      const entries = Object.entries(patch).filter(([key]) => fields[key]);
      transaction(() => {
        db.run(`UPDATE tasks SET ${[...entries.map(([key]) => `${fields[key]}=?`),'updated_at=?'].join(',')} WHERE id=?`, [...entries.map(([,v])=>v), new Date().toISOString(), id]);
      });
      return api.getTask(id);
    },
    addEvent(taskId, type, message) {
      const event = { id:'event_'+randomUUID(), taskId, type, message, createdAt:new Date().toISOString() };
      transaction(() => db.run('INSERT INTO events(id,task_id,type,message,created_at) VALUES(?,?,?,?,?)',[event.id,taskId,type,message,event.createdAt]));
      return event;
    },
    getEvents(taskId) { return query('SELECT id,type,message,created_at AS createdAt FROM events WHERE task_id=? ORDER BY rowid ASC LIMIT 1000',[taskId]); },
    addArtifact(artifact) {
      transaction(() => db.run('INSERT INTO artifacts(id,task_id,name,path,type,size,sha256,created_at) VALUES(?,?,?,?,?,?,?,?)',
        [artifact.id,artifact.taskId,artifact.name,artifact.path,artifact.type,artifact.size,artifact.sha256,artifact.createdAt]));
      return artifact;
    },
    getArtifact(id) { return query('SELECT id,task_id AS taskId,name,path,type,size,sha256,created_at AS createdAt FROM artifacts WHERE id=?',[id])[0] ?? null; },
    getArtifacts(taskId) { return query('SELECT id,task_id AS taskId,name,path,type,size,sha256,created_at AS createdAt FROM artifacts WHERE task_id=? ORDER BY rowid ASC',[taskId]); },
    counts() { return {taskCount:query('SELECT COUNT(*) AS n FROM tasks')[0].n,artifactCount:query('SELECT COUNT(*) AS n FROM artifacts')[0].n}; },
    recover() {
      const unfinished = query("SELECT id FROM tasks WHERE status IN ('queued','running','validating')");
      for (const item of unfinished) {
        api.updateTask(item.id,{status:'interrupted',progress:'上次运行被中断',error:'程序在任务完成前退出。已有资料和记录已保留，请检查后重新提交；本版本不会自动重放任务。'});
        api.addEvent(item.id,'recovery','检测到上次未完成的任务，已标记中断，未自动重放。');
      }
      return unfinished.length;
    },
    close() { if (!closed) { flush(); db.close(); closed=true;releaseOwner(); } }
  };
  return api;
}
