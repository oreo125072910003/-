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
      if(version&&!['1','2','3'].includes(version))throw new Error('数据版本高于当前程序，请使用匹配版本打开。');
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
  try {transaction(() => { db.run(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL,
      kind TEXT NOT NULL, status TEXT NOT NULL, progress TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, workspace TEXT NOT NULL,
      attachments TEXT NOT NULL DEFAULT '[]', session_id TEXT, skill_ids TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
      type TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS events_task ON events(task_id,created_at);
    CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
      name TEXT NOT NULL, path TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS wechat_messages(id TEXT PRIMARY KEY, inbound_key TEXT NOT NULL UNIQUE,
      account_id TEXT NOT NULL, kind TEXT NOT NULL, conversation_id TEXT NOT NULL, conversation_name TEXT NOT NULL,
      sender_id TEXT NOT NULL, sender_name TEXT NOT NULL, text TEXT NOT NULL, external_id TEXT NOT NULL,
      received_at TEXT NOT NULL, task_id TEXT REFERENCES tasks(id));
    CREATE INDEX IF NOT EXISTS wechat_conversation ON wechat_messages(account_id,kind,conversation_id,received_at);
    CREATE TABLE IF NOT EXISTS wechat_outbox(id TEXT PRIMARY KEY, message_id TEXT REFERENCES wechat_messages(id),
      account_id TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, text TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE, delivery_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
      error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mail_accounts(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mail_messages(id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES mail_accounts(id),payload TEXT NOT NULL,task_id TEXT REFERENCES tasks(id));
    CREATE TABLE IF NOT EXISTS mail_drafts(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES mail_accounts(id),payload TEXT NOT NULL,status TEXT NOT NULL,error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
  `);
    // A manually selected conversation can receive an outbound message before
    // any inbound record exists. Rebuild v2 outbox atomically to make its source
    // message optional, retaining every old delivery and foreign-key reference.
    if(query('PRAGMA table_info(wechat_outbox)').find(column=>column.name==='message_id')?.notnull===1){
      db.run(`ALTER TABLE wechat_outbox RENAME TO wechat_outbox_v2;
        CREATE TABLE wechat_outbox(id TEXT PRIMARY KEY,message_id TEXT REFERENCES wechat_messages(id),
          account_id TEXT NOT NULL,kind TEXT NOT NULL,target TEXT NOT NULL,text TEXT NOT NULL,
          dedupe_key TEXT NOT NULL UNIQUE,delivery_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,
          error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        INSERT INTO wechat_outbox SELECT * FROM wechat_outbox_v2;
        DROP TABLE wechat_outbox_v2;`);
    }
    for(const table of ['wechat_messages','wechat_outbox'])if(!query(`PRAGMA table_info(${table})`).some(column=>column.name==='payload'))db.run(`ALTER TABLE ${table} ADD COLUMN payload TEXT NOT NULL DEFAULT '{}'`);
    db.run("INSERT INTO metadata(key,value) VALUES('schema_version','3') ON CONFLICT(key) DO UPDATE SET value='3'");
  });}catch(error){db.close();releaseOwner();throw error;}
  const schema = query("SELECT value FROM metadata WHERE key='schema_version'")[0]?.value;
  if (schema !== '3') { db.close();releaseOwner();throw new Error('数据版本高于当前程序，请使用匹配版本打开。'); }
  try{if(!query('PRAGMA table_info(tasks)').some(column=>column.name==='skill_ids'))transaction(()=>db.run("ALTER TABLE tasks ADD COLUMN skill_ids TEXT NOT NULL DEFAULT '[]'"));}
  catch(error){db.close();releaseOwner();throw error;}
  try{for(const [name,definition]of [['workflow_id',"TEXT NOT NULL DEFAULT 'single'"],['worker_result',"TEXT NOT NULL DEFAULT 'null'"]])if(!query('PRAGMA table_info(tasks)').some(column=>column.name===name))transaction(()=>db.run(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`));}
  catch(error){db.close();releaseOwner();throw error;}
  function mapTask(row) {
    if (!row) return null;
    return { id: row.id, title: row.title, prompt: row.prompt, kind: row.kind, status: row.status,
      progress: row.progress, summary: row.summary, error: row.error, createdAt: row.created_at,
      updatedAt: row.updated_at, workspace: row.workspace, attachments: JSON.parse(row.attachments),
      attachmentNames: JSON.parse(row.attachments).map(a => a.name), sessionId: row.session_id, skillIds:JSON.parse(row.skill_ids||'[]'),workflowId:row.workflow_id||'single',workerResult:JSON.parse(row.worker_result||'null') };
  }
  const wechatMessageSelect='SELECT id,account_id AS accountId,kind,conversation_id AS conversationId,conversation_name AS conversationName,sender_id AS senderId,sender_name AS senderName,text,external_id AS externalId,received_at AS receivedAt,task_id AS taskId,payload FROM wechat_messages';
  const wechatDeliverySelect='SELECT id,message_id AS messageId,account_id AS accountId,kind,target,text,delivery_id AS deliveryId,status,error,created_at AS createdAt,updated_at AS updatedAt,payload FROM wechat_outbox';
  const mapWechat=row=>{if(!row)return null;const {payload,...fields}=row;return {outgoing:false,source:'live',messageType:'text',images:[],...JSON.parse(payload||'{}'),...fields};};
  const mapWechatDelivery=row=>{if(!row)return null;const {payload,...fields}=row;return {mediaType:'text',stickerId:'',requestId:'',...JSON.parse(payload||'{}'),...fields};};
  function insertWechatMessage(message){
    const existing=query('SELECT id FROM wechat_messages WHERE inbound_key=?',[message.inboundKey])[0];
    if(existing)return {inserted:false,message:api.getWechatMessage(existing.id)};
    const payload={outgoing:message.outgoing===true,source:message.source??'live',messageType:message.messageType??'text',images:message.images??[],time:message.time??null,serverId:message.serverId??''};
    db.run('INSERT INTO wechat_messages(id,inbound_key,account_id,kind,conversation_id,conversation_name,sender_id,sender_name,text,external_id,received_at,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      [message.id,message.inboundKey,message.accountId,message.kind,message.conversationId,message.conversationName,message.senderId,message.senderName,message.text,message.externalId,message.receivedAt,JSON.stringify(payload)]);
    return {inserted:true,message:api.getWechatMessage(message.id)};
  }
  const api = {
    filename,
    getSettings() { return Object.fromEntries(query('SELECT key,value FROM settings').map(r => [r.key, JSON.parse(r.value)])); },
    saveSettings(patch) { return transaction(() => { for (const [key, value] of Object.entries(patch)) db.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, JSON.stringify(value)]); }); },
    createTask(task) {
      transaction(() => db.run('INSERT INTO tasks(id,title,prompt,kind,status,created_at,updated_at,workspace,attachments,skill_ids,workflow_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        [task.id,task.title,task.prompt,task.kind,task.status,task.createdAt,task.createdAt,task.workspace,JSON.stringify(task.attachments),JSON.stringify(task.skillIds??[]),task.workflowId??'single']));
      return api.getTask(task.id);
    },
    getTask(id) { return mapTask(query('SELECT * FROM tasks WHERE id=?', [id])[0]); },
    listTasks() { return query('SELECT * FROM tasks ORDER BY created_at DESC,id DESC LIMIT 500').map(mapTask); },
    updateTask(id, patch) {
      const fields = { status:'status', progress:'progress', summary:'summary', error:'error', sessionId:'session_id',workerResult:'worker_result' };
      if (patch.status && !TASK_STATUSES.has(patch.status)) throw new Error('任务状态无效。');
      const entries = Object.entries(patch).filter(([key]) => fields[key]);
      transaction(() => {
        db.run(`UPDATE tasks SET ${[...entries.map(([key]) => `${fields[key]}=?`),'updated_at=?'].join(',')} WHERE id=?`, [...entries.map(([key,v])=>key==='workerResult'?JSON.stringify(v):v), new Date().toISOString(), id]);
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
    addWechatMessage(message) {
      return transaction(() => insertWechatMessage(message));
    },
    addWechatMessages(messages){return transaction(()=>messages.map(insertWechatMessage));},
    getWechatMessage(id) {return mapWechat(query(wechatMessageSelect+' WHERE id=?',[id])[0]);},
    listWechatMessages() {return query(wechatMessageSelect+' ORDER BY rowid DESC LIMIT 500').map(mapWechat);},
    linkWechatTask(messageId,taskId) {return transaction(()=>{db.run('UPDATE wechat_messages SET task_id=? WHERE id=?',[taskId,messageId]);return api.getWechatMessage(messageId);});},
    createWechatDelivery(delivery) {
      return transaction(()=>{
        const existing=query('SELECT id FROM wechat_outbox WHERE dedupe_key=?',[delivery.dedupeKey])[0];
        if(existing)return {inserted:false,delivery:api.getWechatDelivery(existing.id)};
        db.run('INSERT INTO wechat_outbox(id,message_id,account_id,kind,target,text,dedupe_key,delivery_id,status,created_at,updated_at,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
          [delivery.id,delivery.messageId??null,delivery.accountId,delivery.kind,delivery.target,delivery.text,delivery.dedupeKey,delivery.deliveryId,'sending',delivery.createdAt,delivery.createdAt,JSON.stringify({mediaType:delivery.mediaType??'text',stickerId:delivery.stickerId??'',requestId:delivery.requestId??''})]);
        return {inserted:true,delivery:api.getWechatDelivery(delivery.id)};
      });
    },
    getWechatDelivery(id) {return mapWechatDelivery(query(wechatDeliverySelect+' WHERE id=?',[id])[0]);},
    listWechatOutbox() {return query(wechatDeliverySelect+' ORDER BY rowid DESC LIMIT 500').map(mapWechatDelivery);},
    updateWechatDelivery(id,{status,error='',receipt}) {
      if(!['sending','delivered','unconfirmed','failed'].includes(status))throw Error('微信投递状态无效。');
      return transaction(()=>{db.run('UPDATE wechat_outbox SET status=?,error=?,updated_at=? WHERE id=?',[status,error,new Date().toISOString(),id]);if(receipt){const payload=JSON.parse(query('SELECT payload FROM wechat_outbox WHERE id=?',[id])[0]?.payload||'{}');db.run('UPDATE wechat_outbox SET payload=? WHERE id=?',[JSON.stringify({...payload,receipt}),id]);}return api.getWechatDelivery(id);});
    },
    listMailAccounts(){return query('SELECT payload FROM mail_accounts ORDER BY rowid').map(row=>JSON.parse(row.payload));},
    getMailAccount(id){const row=query('SELECT payload FROM mail_accounts WHERE id=?',[id])[0];return row?JSON.parse(row.payload):null;},
    saveMailAccount(account){return transaction(()=>{db.run('INSERT INTO mail_accounts(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',[account.id,JSON.stringify(account)]);return api.getMailAccount(account.id);});},
    saveMailAccounts(accounts){return transaction(()=>{for(const account of accounts)db.run('INSERT INTO mail_accounts(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',[account.id,JSON.stringify(account)]);return accounts.map(account=>api.getMailAccount(account.id));});},
    commitMailSync(account,messages){return transaction(()=>{for(const message of messages)db.run('INSERT INTO mail_messages(id,account_id,payload) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',[message.id,account.id,JSON.stringify(message)]);db.run('UPDATE mail_accounts SET payload=? WHERE id=?',[JSON.stringify(account),account.id]);});},
    listMailMessages(accountId){return query('SELECT payload,task_id FROM mail_messages'+(accountId?' WHERE account_id=?':'')+' ORDER BY rowid DESC LIMIT 500',accountId?[accountId]:[]).map(row=>({...JSON.parse(row.payload),taskId:row.task_id}));},
    getMailMessage(id){const row=query('SELECT payload,task_id FROM mail_messages WHERE id=?',[id])[0];return row?{...JSON.parse(row.payload),taskId:row.task_id}:null;},
    linkMailTask(id,taskId){return transaction(()=>db.run('UPDATE mail_messages SET task_id=? WHERE id=?',[taskId,id]));},
    saveMailDraft(draft){return transaction(()=>{db.run('INSERT INTO mail_drafts(id,account_id,payload,status,created_at,updated_at) VALUES(?,?,?,?,?,?)',[draft.id,draft.accountId,JSON.stringify(draft),draft.status??'draft',draft.createdAt,draft.createdAt]);return api.getMailDraft(draft.id);});},
    getMailDraft(id){const row=query('SELECT payload,status,error,updated_at FROM mail_drafts WHERE id=?',[id])[0];return row?{...JSON.parse(row.payload),status:row.status,error:row.error,updatedAt:row.updated_at}:null;},
    listMailDrafts(accountId){return query('SELECT id FROM mail_drafts'+(accountId?' WHERE account_id=?':'')+' ORDER BY rowid DESC LIMIT 500',accountId?[accountId]:[]).map(row=>api.getMailDraft(row.id));},
    updateMailDraft(id,{status,error='',receipt}){if(!['draft','sending','smtp-accepted','unconfirmed','failed'].includes(status))throw Error('邮件发送状态无效。');return transaction(()=>{const current=api.getMailDraft(id);if(!current)throw Error('邮件草稿不存在。');const payload={...current,...(receipt?{receipt}:{})};db.run('UPDATE mail_drafts SET payload=?,status=?,error=?,updated_at=? WHERE id=?',[JSON.stringify(payload),status,error,new Date().toISOString(),id]);return api.getMailDraft(id);});},
    recover() {
      const unfinished = query("SELECT id FROM tasks WHERE status IN ('queued','running','validating')");
      for (const item of unfinished) {
        api.updateTask(item.id,{status:'interrupted',progress:'上次运行被中断',error:'程序在任务完成前退出。已有资料和记录已保留，请检查后重新提交；本版本不会自动重放任务。'});
        api.addEvent(item.id,'recovery','检测到上次未完成的任务，已标记中断，未自动重放。');
      }
      transaction(()=>db.run("UPDATE wechat_outbox SET status='unconfirmed',error='上次发送过程被中断，无法确认是否送达；未自动重发。',updated_at=? WHERE status='sending'",[new Date().toISOString()]));
      transaction(()=>db.run("UPDATE mail_drafts SET status='unconfirmed',error='上次发送被中断，无法确认 SMTP 是否接收；未自动重发。',updated_at=? WHERE status='sending'",[new Date().toISOString()]));
      return unfinished.length;
    },
    close() { if (!closed) { flush(); db.close(); closed=true;releaseOwner(); } }
  };
  return api;
}
