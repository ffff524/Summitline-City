'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { URL } = require('node:url');

// Simple .env loader: never serve this file to clients.
const BASE = __dirname;
const envPath = path.join(BASE, '.env');
if (fs.existsSync(envPath)) for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
}
const OWNER_EMAIL = (process.env.OWNER_EMAIL || '').trim().toLowerCase();
if (!OWNER_EMAIL || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(OWNER_EMAIL)) {
  console.error('FEHLER: OWNER_EMAIL in .env festlegen (.env.example kopieren).');
  process.exit(1);
}
const PORT = Number(process.env.PORT || 3000), HOST = process.env.HOST || '127.0.0.1';
const SECURE = process.env.SECURE_COOKIES === 'true';
const DATA_DIR = path.join(BASE, 'data'), UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'summitline.sqlite'));
db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'mitglied',
  is_owner INTEGER NOT NULL DEFAULT 0, is_admin INTEGER NOT NULL DEFAULT 0,
  permissions TEXT NOT NULL DEFAULT '[]', suspended INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT 'mitglied',
  email TEXT, created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL, used_by TEXT REFERENCES users(id), used_at TEXT
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#7c5cff', created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'nicht_zugeteilt', priority TEXT NOT NULL DEFAULT 'normal',
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  shift TEXT, due_at TEXT, created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id), filename TEXT NOT NULL,
  mime TEXT NOT NULL, bytes INTEGER NOT NULL, stored_as TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL, task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  is_read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL, description TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id,is_read);
CREATE INDEX IF NOT EXISTS idx_activity_task ON activity(task_id);
`);
const ROLES = [
  {key:'projektinhaber',name:'Projektinhaber',group:'SERVERLEITUNG'},
  {key:'stv_projektinhaber',name:'STV-Projektinhaber',group:'SERVERLEITUNG'},
  {key:'projektleitung',name:'Projektleitung',group:'SERVERLEITUNG'},
  {key:'stv_projektleitung',name:'STV-Projektleitung',group:'SERVERLEITUNG'},
  {key:'management',name:'Management',group:'HIGH TEAM'},
  {key:'stv_management',name:'STV-Management',group:'HIGH TEAM'},
  {key:'teamleitung',name:'Teamleitung',group:'HIGH TEAM'},
  {key:'stv_teamleitung',name:'STV-Teamleitung',group:'HIGH TEAM'},
  {key:'head_admin',name:'Head-Admin',group:'ADMINISTRATION'},
  {key:'admin',name:'Admin',group:'ADMINISTRATION'},
  {key:'test_admin',name:'Test Admin',group:'ADMINISTRATION'},
  {key:'mitglied',name:'Mitglied',group:'MITGLIEDER'}
];
const ROLE_KEYS = new Set(ROLES.map(x=>x.key));
const STATUSES = ['nicht_zugeteilt','zu_erledigen','in_bearbeitung','im_test','erledigt'];
const SHIFTS = ['frueh','spaet','nacht'];
const PERMISSIONS = [
  {key:'tasks.create',label:'Aufgaben erstellen'},
  {key:'tasks.edit_all',label:'Alle Aufgaben bearbeiten'},
  {key:'tasks.delete',label:'Aufgaben löschen'},
  {key:'projects.manage',label:'Projekte verwalten'},
  {key:'invites.manage',label:'Einladungen verwalten'},
  {key:'members.manage',label:'Mitglieder verwalten'},
  {key:'admins.manage',label:'Administratoren ernennen'},
  {key:'admin.access',label:'Administrationsbereich öffnen'}
];
const PERM_KEYS = new Set(PERMISSIONS.map(x=>x.key));
const uuid = () => crypto.randomUUID();
const s256 = s => crypto.createHash('sha256').update(s).digest('hex');
const now = () => new Date().toISOString();
const isEmail = s => typeof s==='string' && s.length<=200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const short = (v,max=200) => typeof v === 'string' ? v.trim().slice(0,max) : '';
const rawUser = id => db.prepare('SELECT * FROM users WHERE id=?').get(id);
const cleanUser = u => u ? ({id:u.id,name:u.name,email:u.email,role:u.role,is_owner:!!u.is_owner,is_admin:!!u.is_admin,permissions:JSON.parse(u.permissions||'[]'),suspended:!!u.suspended,created_at:u.created_at}) : null;
const publicUser = u => ({id:u.id,name:u.name,role:u.role,is_admin:!!u.is_admin});
const has = (u,key) => u && (u.is_owner || (u.is_admin && key==='admin.access') || JSON.parse(u.permissions||'[]').includes(key));
const argon = password => {
  const salt=crypto.randomBytes(16).toString('hex');
  const hash=crypto.scryptSync(password,salt,64,{N:16384,r:8,p:1}).toString('hex');
  return `scrypt$${salt}$${hash}`;
};
const verifyPwd = (password,stored) => {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [,salt,hash] = stored.split('$');
  const actual=crypto.scryptSync(password,salt,64,{N:16384,r:8,p:1});
  return crypto.timingSafeEqual(actual,Buffer.from(hash,'hex'));
};
const goodPwd = s => typeof s==='string' && s.length >= 12 && s.length <= 128;
let setupToken = process.env.OWNER_SETUP_TOKEN || crypto.randomBytes(18).toString('base64url');
if (setupToken.length < 24) { console.error('OWNER_SETUP_TOKEN muss mindestens 24 Zeichen lang sein.'); process.exit(1); }
const ownerExists=()=>!!db.prepare('SELECT 1 FROM users WHERE is_owner=1').get();
const attempts=new Map();
function limited(ip,kind,limit=10) {
  const key = `${kind}:${ip}`, entry=attempts.get(key), t=Date.now();
  if (!entry || t-entry.time>15*60*1000) { attempts.set(key,{count:1,time:t}); return false; }
  entry.count++;
  return entry.count>limit;
}
function setSession(res,userId) {
  const token=crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(s256(token),userId,new Date(Date.now()+14*86400000).toISOString());
  res.setHeader('Set-Cookie',`scr_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=1209600${SECURE?'; Secure':''}`);
}
function clearSession(res) {res.setHeader('Set-Cookie',`scr_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${SECURE?'; Secure':''}`);}
function getAuth(req) {
  const cookie=(req.headers.cookie||'').match(/(?:^|;\s*)scr_session=([^;]+)/);
  if (!cookie) return null;
  const u = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=? AND s.expires_at>?`).get(s256(cookie[1]),now());
  return u && !u.suspended?u:null;
}
function json(res,status,obj,headers={}) {
  const data=Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Content-Length':data.length,'Cache-Control':'no-store',...headers});
  res.end(data);
}
function fail(res,code,message) {json(res,code,{fehler:message});}
async function body(req) {
  let total=0; const parts=[];
  for await (const part of req) {total+=part.length; if(total>8*1024*1024) throw Object.assign(new Error('Anfrage zu groß (maximal 8 MB).'),{status:413}); parts.push(part);}
  try{return JSON.parse(Buffer.concat(parts).toString('utf8')||'{}');}catch{throw Object.assign(new Error('Ungültige JSON-Daten.'),{status:400});}
}
function getTask(id) {
  return db.prepare(`SELECT t.*,u.name AS assignee_name,p.title AS project_name,author.name AS creator_name
    FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id JOIN projects p ON p.id=t.project_id
    JOIN users author ON author.id=t.created_by WHERE t.id=?`).get(id);
}
function note(userId,message,taskId=null) {
  if(userId)db.prepare('INSERT INTO notifications (id,user_id,message,task_id) VALUES(?,?,?,?)').run(uuid(),userId,message.slice(0,300),taskId);
}
function activity(userId,desc,taskId=null) {db.prepare('INSERT INTO activity(id,user_id,description,task_id) VALUES(?,?,?,?)').run(uuid(),userId,desc,taskId);}
function route(pathname) {return pathname.split('/').filter(Boolean);}
function validateStatus(input,assignee,shift) {
  if(!assignee || !shift)return 'nicht_zugeteilt';
  return STATUSES.includes(input)?(input==='nicht_zugeteilt'?'zu_erledigen':input):'zu_erledigen';
}
function validShift(s) {return s===null || s==='' || SHIFTS.includes(s);}
const EXT_MIME={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',pdf:'application/pdf',txt:'text/plain',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',zip:'application/zip'};
function safeMagic(buf,ext) {
  if(ext==='png')return buf.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'));
  if(ext==='jpg'||ext==='jpeg')return buf.subarray(0,3).equals(Buffer.from('ffd8ff','hex'));
  if(ext==='webp')return buf.toString('ascii',0,4)==='RIFF'&&buf.toString('ascii',8,12)==='WEBP';
  if(ext==='pdf')return buf.toString('ascii',0,5)==='%PDF-';
  if(['zip','docx','xlsx'].includes(ext))return buf.toString('ascii',0,2)==='PK';
  if(ext==='txt')return !buf.includes(0);
  return false;
}
const staticMime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon'};
function staticFile(pathname,res) {
  const relative = pathname==='/'?'index.html':pathname.slice(1);
  if(!['index.html','app.css','app.js','logo.svg','favicon.svg'].includes(relative))return fail(res,404,'Datei nicht gefunden.');
  const file=path.join(BASE,'public',relative);
  if(!fs.existsSync(file))return fail(res,404,'Datei nicht gefunden.');
  res.writeHead(200,{'Content-Type':staticMime[path.extname(file)],'Cache-Control':'no-cache'});
  fs.createReadStream(file).pipe(res);
}
const securityHeaders={
  'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',
  'Referrer-Policy':'no-referrer',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
};
function isSafeOrigin(req) {
  // Disallow cross-origin requests even if cookies would be sent.
  const origin=req.headers.origin;
  if(!origin)return true; // allows CLI + native clients without Origin; SameSite=Strict mitigates browser CSRF
  try {return new URL(origin).host===req.headers.host;} catch{return false;}
}
async function api(req,res,parts,searchParams) {
  const method=req.method, pathx=parts.slice(1).join('/');
  const u=getAuth(req);
  const ip=(req.socket.remoteAddress||'').slice(0,80);
  if(method==='GET'&&pathx==='session')return json(res,200,{user:cleanUser(u),needs_setup:!ownerExists(),roles:ROLES,permissions:PERMISSIONS});
  if(method==='POST'&&pathx==='setup') {
    if(ownerExists())return fail(res,403,'Die Ersteinrichtung ist bereits abgeschlossen.');
    if(limited(ip,'setup',8))return fail(res,429,'Zu viele Versuche. Bitte später erneut versuchen.');
    const b=await body(req);
    const email=short(b.email,200).toLowerCase(), name=short(b.name,80);
    if(email!==OWNER_EMAIL||b.setupToken!==setupToken)return fail(res,403,'E-Mail-Adresse oder Startcode ist falsch.');
    if(!name||!goodPwd(b.password))return fail(res,400,'Name fehlt oder Passwort ist kürzer als 12 Zeichen.');
    const uid=uuid();
    db.exec('BEGIN IMMEDIATE');
    try {
      if(ownerExists())throw new Error('Bereits eingerichtet.');
      db.prepare('INSERT INTO users(id,name,email,password_hash,role,is_owner,is_admin) VALUES(?,?,?,?,?,1,1)').run(uid,name,email,argon(b.password),'projektinhaber');
      db.prepare('INSERT INTO projects(id,title,description,created_by) VALUES(?,?,?,?)').run(uuid(),'Summitline City Roleplay','Gemeinsame Aufgaben für das gesamte Serverteam',uid);
      activity(uid,'hat die Projektverwaltung eingerichtet.');
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    setSession(res,uid);
    console.log('Der Hauptadministrator wurde eingerichtet. Der Startcode ist ab jetzt ungültig.');
    return json(res,201,{user:cleanUser(rawUser(uid))});
  }
  if(method==='POST'&&pathx==='register') {
    if(!ownerExists())return fail(res,403,'Zuerst muss der Hauptadministrator eingerichtet werden.');
    if(limited(ip,'register',12))return fail(res,429,'Zu viele Anfragen.');
    const b=await body(req), name=short(b.name,80), email=short(b.email,200).toLowerCase(), code=short(b.inviteCode,80).replace(/\s/g,'').toUpperCase();
    if(!name||!isEmail(email)||!goodPwd(b.password)||!code)return fail(res,400,'Name, gültige E-Mail, Einladungscode und Passwort mit mindestens 12 Zeichen erforderlich.');
    const invite=db.prepare('SELECT * FROM invites WHERE code_hash=? AND used_by IS NULL AND expires_at>?').get(s256(code),now());
    if(!invite || (invite.email && invite.email!==email))return fail(res,403,'Einladungscode ist ungültig, abgelaufen oder für eine andere E-Mail bestimmt.');
    if(db.prepare('SELECT 1 FROM users WHERE email=?').get(email))return fail(res,409,'Diese E-Mail-Adresse ist bereits registriert.');
    const id=uuid();
    db.exec('BEGIN IMMEDIATE');
    try {
      // Die FK-Verknüpfung auf invites.used_by setzt voraus, dass der User zuerst existiert.
      // Alles bleibt in derselben Transaktion: scheitert das Einlösen, wird auch der User zurückgerollt.
      db.prepare('INSERT INTO users(id,name,email,password_hash,role) VALUES(?,?,?,?,?)').run(id,name,email,argon(b.password),invite.role);
      const result=db.prepare('UPDATE invites SET used_by=?,used_at=? WHERE id=? AND used_by IS NULL AND expires_at>?').run(id,now(),invite.id,now());
      if(result.changes!==1)throw new Error('Der Code wurde bereits benutzt.');
      activity(id,`${name} hat sich dem Team angeschlossen.`);
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK'); throw e;}
    setSession(res,id);
    return json(res,201,{user:cleanUser(rawUser(id))});
  }
  if(method==='POST'&&pathx==='login') {
    if(limited(ip,'login',30))return fail(res,429,'Zu viele Anmeldungen. Bitte später erneut versuchen.');
    const b=await body(req), email=short(b.email,200).toLowerCase();
    const user=db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if(!user||!verifyPwd(b.password||'',user.password_hash)||user.suspended)return fail(res,401,'E-Mail-Adresse oder Passwort falsch, oder Account gesperrt.');
    setSession(res,user.id);
    return json(res,200,{user:cleanUser(user)});
  }
  if(method==='POST'&&pathx==='logout') {
    const cookie=(req.headers.cookie||'').match(/(?:^|;\s*)scr_session=([^;]+)/);
    if(cookie)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(s256(cookie[1]));
    clearSession(res); return json(res,200,{ok:true});
  }
  if(!u)return fail(res,401,'Bitte zuerst anmelden.');
  if(method==='GET'&&pathx==='bootstrap') {
    const members=db.prepare('SELECT id,name,role,is_admin FROM users WHERE suspended=0 ORDER BY name').all().map(publicUser);
    const projects=db.prepare('SELECT p.*,u.name AS creator_name FROM projects p LEFT JOIN users u ON u.id=p.created_by ORDER BY p.created_at').all();
    const tasks=db.prepare(`SELECT t.*,u.name AS assignee_name,p.title AS project_name,author.name AS creator_name
       FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id JOIN projects p ON p.id=t.project_id
       JOIN users author ON author.id=t.created_by ORDER BY t.created_at DESC`).all();
    const notifications=db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 60').all(u.id);
    return json(res,200,{me:cleanUser(u),members,projects,tasks,notifications,roles:ROLES,permissions:PERMISSIONS});
  }
  if(method==='GET'&&pathx==='activity') {
    return json(res,200,{activity:db.prepare(`SELECT a.*,u.name AS user_name FROM activity a JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 80`).all()});
  }
  if(method==='POST'&&pathx==='notifications/read-all') {
    db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=?').run(u.id);return json(res,200,{ok:true});
  }
  if(method==='POST'&&pathx==='projects') {
    if(!has(u,'projects.manage'))return fail(res,403,'Keine Berechtigung für Projekte.');
    const b=await body(req),title=short(b.title,100),description=short(b.description,2000),color=/^#[0-9a-fA-F]{6}$/.test(b.color)?b.color:'#7c5cff';
    if(!title)return fail(res,400,'Bitte Projektnamen eingeben.');
    const id=uuid();db.prepare('INSERT INTO projects(id,title,description,color,created_by) VALUES(?,?,?,?,?)').run(id,title,description,color,u.id);
    activity(u.id,`hat das Projekt „${title}“ erstellt.`);return json(res,201,{id});
  }
  if(parts[1]==='projects'&&parts[2]&&method==='PATCH'&&parts.length===3) {
    if(!has(u,'projects.manage'))return fail(res,403,'Keine Berechtigung.');
    const p=db.prepare('SELECT * FROM projects WHERE id=?').get(parts[2]);if(!p)return fail(res,404,'Projekt nicht gefunden.');
    const b=await body(req),title=b.title!==undefined?short(b.title,100):p.title,description=b.description!==undefined?short(b.description,2000):p.description,color=/^#[0-9a-fA-F]{6}$/.test(b.color)?b.color:p.color;
    if(!title)return fail(res,400,'Projektname fehlt.');
    db.prepare('UPDATE projects SET title=?,description=?,color=? WHERE id=?').run(title,description,color,p.id);
    return json(res,200,{ok:true});
  }
  if(parts[1]==='projects'&&parts[2]&&method==='DELETE'&&parts.length===3){
    if(!has(u,'projects.manage'))return fail(res,403,'Keine Berechtigung.');
    const total=db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
    if(total<=1)return fail(res,400,'Mindestens ein Projekt muss erhalten bleiben.');
    const p=db.prepare('SELECT * FROM projects WHERE id=?').get(parts[2]);if(!p)return fail(res,404,'Projekt nicht gefunden.');
    const taskIds=db.prepare('SELECT id FROM tasks WHERE project_id=?').all(p.id).map(x=>x.id);
    for(const id of taskIds){const stored=db.prepare('SELECT stored_as FROM files WHERE task_id=?').all(id);for(const f of stored)try{fs.unlinkSync(path.join(UPLOAD_DIR,f.stored_as));}catch{}}
    db.prepare('DELETE FROM projects WHERE id=?').run(p.id);
    activity(u.id,`hat das Projekt „${p.title}“ gelöscht.`);
    return json(res,200,{ok:true});
  }
  if(method==='POST'&&pathx==='tasks') {
    if(!has(u,'tasks.create'))return fail(res,403,'Du darfst keine Aufgaben erstellen.');
    const b=await body(req),title=short(b.title,160),desc=short(b.description,12000);
    if(!title)return fail(res,400,'Aufgabenname fehlt.');
    if(!db.prepare('SELECT id FROM projects WHERE id=?').get(b.project_id))return fail(res,400,'Projekt nicht gefunden.');
    const assignee=b.assignee_id&&db.prepare('SELECT id FROM users WHERE id=? AND suspended=0').get(b.assignee_id)?b.assignee_id:null;
    const shift=validShift(b.shift)?(b.shift||null):null;
    const status=validateStatus(b.status,assignee,shift);
    const pr=['niedrig','normal','hoch','kritisch'].includes(b.priority)?b.priority:'normal';
    const due=b.due_at&&/^\d{4}-\d\d-\d\d$/.test(b.due_at)?b.due_at:null;
    const id=uuid();
    db.prepare(`INSERT INTO tasks(id,project_id,title,description,status,priority,assignee_id,shift,due_at,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,b.project_id,title,desc,status,pr,assignee,shift,due,u.id);
    activity(u.id,`hat „${title}“ erstellt.`,id);
    if(assignee&&assignee!==u.id)note(assignee,`Neue Aufgabe zugewiesen: ${title}`,id);
    return json(res,201,{task:getTask(id)});
  }
  if(parts[1]==='tasks'&&parts[2]&&method==='PATCH'&&parts.length===3) {
    const existing=getTask(parts[2]);if(!existing)return fail(res,404,'Aufgabe nicht gefunden.');
    if(!(has(u,'tasks.edit_all')||existing.created_by===u.id||existing.assignee_id===u.id))return fail(res,403,'Du darfst diese Aufgabe nicht bearbeiten.');
    const b=await body(req);
    const title=b.title!==undefined?short(b.title,160):existing.title;
    if(!title)return fail(res,400,'Aufgabentitel fehlt.');
    const desc=b.description!==undefined?short(b.description,12000):existing.description;
    const project=b.project_id!==undefined?b.project_id:existing.project_id;
    if(!db.prepare('SELECT id FROM projects WHERE id=?').get(project))return fail(res,400,'Projekt nicht gefunden.');
    let assignee=b.assignee_id!==undefined?(b.assignee_id||null):existing.assignee_id;
    if(assignee&&!db.prepare('SELECT id FROM users WHERE id=? AND suspended=0').get(assignee))return fail(res,400,'Unbekannter Mitarbeiter.');
    let shift=b.shift!==undefined?(b.shift||null):existing.shift;
    if(!validShift(shift))return fail(res,400,'Unbekannte Schicht.');
    const status=validateStatus(b.status!==undefined?b.status:existing.status,assignee,shift);
    const pr=b.priority!==undefined?b.priority:existing.priority;
    if(!['niedrig','normal','hoch','kritisch'].includes(pr))return fail(res,400,'Ungültige Priorität.');
    const due=b.due_at!==undefined?(b.due_at||null):existing.due_at;
    if(due&&!/^\d{4}-\d\d-\d\d$/.test(due))return fail(res,400,'Ungültiges Datum.');
    db.prepare(`UPDATE tasks SET project_id=?,title=?,description=?,status=?,priority=?,assignee_id=?,shift=?,due_at=?,updated_at=? WHERE id=?`)
      .run(project,title,desc,status,pr,assignee,shift,due,now(),existing.id);
    if(assignee&&assignee!==existing.assignee_id&&assignee!==u.id)note(assignee,`Dir wurde die Aufgabe „${title}“ zugewiesen.`,existing.id);
    if(status!==existing.status && assignee && assignee!==u.id)note(assignee,`Status von „${title}“: ${status.replaceAll('_',' ')}.`,existing.id);
    activity(u.id,`hat „${title}“ aktualisiert (${status.replaceAll('_',' ')}).`,existing.id);
    return json(res,200,{task:getTask(existing.id)});
  }
  if(parts[1]==='tasks'&&parts[2]&&method==='DELETE'&&parts.length===3) {
    if(!has(u,'tasks.delete'))return fail(res,403,'Keine Berechtigung zum Löschen.');
    const t=getTask(parts[2]);if(!t)return fail(res,404,'Aufgabe nicht gefunden.');
    const attachments=db.prepare('SELECT stored_as FROM files WHERE task_id=?').all(t.id);
    db.prepare('DELETE FROM tasks WHERE id=?').run(t.id);
    for(const a of attachments)try{fs.unlinkSync(path.join(UPLOAD_DIR,a.stored_as));}catch{}
    activity(u.id,`hat die Aufgabe „${t.title}“ gelöscht.`);return json(res,200,{ok:true});
  }
  if(parts[1]==='tasks'&&parts[2]&&parts[3]==='details'&&method==='GET') {
    if(!getTask(parts[2]))return fail(res,404,'Aufgabe nicht gefunden.');
    const comments=db.prepare(`SELECT c.*,u.name AS user_name FROM comments c JOIN users u ON u.id=c.user_id WHERE c.task_id=? ORDER BY c.created_at`).all(parts[2]);
    const files=db.prepare(`SELECT f.id,f.task_id,f.filename,f.mime,f.bytes,f.created_at,u.name AS user_name
      FROM files f JOIN users u ON u.id=f.user_id WHERE f.task_id=? ORDER BY f.created_at DESC`).all(parts[2]);
    const activities=db.prepare(`SELECT a.*,u.name AS user_name FROM activity a JOIN users u ON u.id=a.user_id WHERE a.task_id=? ORDER BY a.created_at DESC LIMIT 40`).all(parts[2]);
    return json(res,200,{comments,files,activities});
  }
  if(parts[1]==='tasks'&&parts[2]&&parts[3]==='comments'&&method==='POST') {
    const t=getTask(parts[2]);if(!t)return fail(res,404,'Aufgabe nicht gefunden.');
    const b=await body(req),comment=short(b.body,3000);if(!comment)return fail(res,400,'Bitte Kommentar eingeben.');
    db.prepare('INSERT INTO comments(id,task_id,user_id,body) VALUES(?,?,?,?)').run(uuid(),t.id,u.id,comment);
    activity(u.id,`hat „${t.title}“ kommentiert.`,t.id);
    if(t.assignee_id&&t.assignee_id!==u.id)note(t.assignee_id,`Neuer Kommentar zu „${t.title}“.`,t.id);
    return json(res,201,{ok:true});
  }
  if(parts[1]==='tasks'&&parts[2]&&parts[3]==='files'&&method==='POST') {
    const t=getTask(parts[2]);if(!t)return fail(res,404,'Aufgabe nicht gefunden.');
    const b=await body(req),filename=short(b.filename,180).replace(/[\\/\0\x00-\x1f]/g,'_');
    const ext=filename.split('.').pop().toLowerCase(), mime=EXT_MIME[ext];
    if(!mime||!b.base64||typeof b.base64!=='string')return fail(res,400,'Dateityp nicht unterstützt.');
    if(b.base64.length>7_000_000)return fail(res,413,'Datei zu groß. Maximal 5 MB.');
    const buf=Buffer.from(b.base64,'base64');
    if(!buf.length||buf.length>5*1024*1024||!safeMagic(buf,ext))return fail(res,400,'Datei ist zu groß oder der Inhalt entspricht nicht dem Dateityp.');
    const id=uuid(),stored=`${id}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR,stored),buf,{flag:'wx',mode:0o600});
    db.prepare('INSERT INTO files(id,task_id,user_id,filename,mime,bytes,stored_as) VALUES(?,?,?,?,?,?,?)').run(id,t.id,u.id,filename,mime,buf.length,stored);
    activity(u.id,`hat „${filename}“ an „${t.title}“ angehängt.`,t.id);
    return json(res,201,{ok:true});
  }
  if(parts[1]==='files'&&parts[2]&&method==='GET'&&parts.length===3) {
    const f=db.prepare('SELECT * FROM files WHERE id=?').get(parts[2]);if(!f)return fail(res,404,'Datei nicht gefunden.');
    const target=path.join(UPLOAD_DIR,f.stored_as);if(!fs.existsSync(target))return fail(res,404,'Datei fehlt.');
    const encoded=encodeURIComponent(f.filename).replace(/[()']/g,escape);
    res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename*=UTF-8''${encoded}`,'Content-Length':f.bytes,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    return fs.createReadStream(target).pipe(res);
  }
  if(pathx==='invites'&&method==='GET') {
    if(!has(u,'invites.manage'))return fail(res,403,'Keine Berechtigung für Einladungen.');
    return json(res,200,{invites:db.prepare(`SELECT i.id,i.role,i.email,i.created_at,i.expires_at,i.used_at,i.used_by,
      u.name AS creator_name,v.name AS used_name FROM invites i LEFT JOIN users u ON u.id=i.created_by
      LEFT JOIN users v ON v.id=i.used_by ORDER BY i.created_at DESC LIMIT 150`).all()});
  }
  if(pathx==='invites'&&method==='POST') {
    if(!has(u,'invites.manage'))return fail(res,403,'Keine Berechtigung für Einladungen.');
    if(limited(`${u.id}`, 'invites',50))return fail(res,429,'Zu viele Einladungen.');
    const b=await body(req),email=short(b.email,200).toLowerCase()||null;
    const role=ROLE_KEYS.has(b.role)?b.role:'mitglied';
    if(email&&!isEmail(email))return fail(res,400,'E-Mail-Adresse ungültig.');
    const days=Math.min(30,Math.max(1,Number(b.days)||7));
    const code=`SCR-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const id=uuid(),expires=new Date(Date.now()+days*86400000).toISOString();
    db.prepare('INSERT INTO invites(id,code_hash,role,email,created_by,expires_at) VALUES(?,?,?,?,?,?)').run(id,s256(code),role,email,u.id,expires);
    activity(u.id,`hat einen Einladungscode für ${email||'ein neues Mitglied'} erstellt.`);
    return json(res,201,{invite:{id,code,email,role,expires_at:expires}});
  }
  if(parts[1]==='invites'&&parts[2]&&method==='DELETE') {
    if(!has(u,'invites.manage'))return fail(res,403,'Keine Berechtigung.');
    db.prepare('DELETE FROM invites WHERE id=? AND used_by IS NULL').run(parts[2]);return json(res,200,{ok:true});
  }
  if(pathx==='admin/members'&&method==='GET') {
    if(!has(u,'admin.access')&&!has(u,'members.manage'))return fail(res,403,'Kein Administratorzugang.');
    return json(res,200,{members:db.prepare('SELECT * FROM users ORDER BY created_at ASC').all().map(cleanUser)});
  }
  if(parts[1]==='admin'&&parts[2]==='members'&&parts[3]&&method==='PATCH') {
    if(!has(u,'members.manage')&&!has(u,'admins.manage'))return fail(res,403,'Keine Berechtigung.');
    const target=rawUser(parts[3]);if(!target)return fail(res,404,'Mitglied nicht gefunden.');
    if(target.is_owner)return fail(res,403,'Der Hauptadministrator kann nicht verändert werden.');
    const b=await body(req), name=b.name!==undefined?short(b.name,80):target.name;
    const role=b.role!==undefined?b.role:target.role;
    if(!name||!ROLE_KEYS.has(role))return fail(res,400,'Ungültiger Name oder Rang.');
    const email=b.email!==undefined?short(b.email,200).toLowerCase():target.email;
    if(!isEmail(email))return fail(res,400,'Ungültige E-Mail-Adresse.');
    const changesPrivilege=(b.is_admin!==undefined&&Boolean(b.is_admin)!==Boolean(target.is_admin)) ||
      (b.permissions!==undefined&&JSON.stringify([...new Set(b.permissions)].sort())!==JSON.stringify([...JSON.parse(target.permissions)].sort()));
    if(changesPrivilege&&!has(u,'admins.manage'))return fail(res,403,'Nur Berechtigte dürfen Administratorrechte ändern.');
    const perms=b.permissions!==undefined?b.permissions:JSON.parse(target.permissions);
    if(!Array.isArray(perms)||perms.some(p=>!PERM_KEYS.has(p)))return fail(res,400,'Unbekannte Berechtigung.');
    const isAdmin=b.is_admin!==undefined?!!b.is_admin:!!target.is_admin;
    const suspended=b.suspended!==undefined?!!b.suspended:!!target.suspended;
    db.prepare('UPDATE users SET name=?,email=?,role=?,is_admin=?,permissions=?,suspended=? WHERE id=?')
      .run(name,email,role,isAdmin?1:0,JSON.stringify([...new Set(perms)]),suspended?1:0,target.id);
    if(suspended)db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
    activity(u.id,`hat die Mitgliedsdaten von ${name} geändert.`);
    note(target.id,'Dein Teamprofil oder deine Berechtigungen wurden geändert.');
    return json(res,200,{user:cleanUser(rawUser(target.id))});
  }
  if(parts[1]==='admin'&&parts[2]==='members'&&parts[3]&&method==='DELETE') {
    if(!has(u,'members.manage'))return fail(res,403,'Keine Berechtigung.');
    const target=rawUser(parts[3]);if(!target)return fail(res,404,'Mitglied nicht gefunden.');
    if(target.is_owner||target.id===u.id)return fail(res,403,'Diesen Account kannst du nicht löschen.');
    // Preserve existing task/comments audit history; block deletion of users with history.
    const refs=db.prepare(`SELECT (SELECT COUNT(*) FROM tasks WHERE created_by=?) +
       (SELECT COUNT(*) FROM comments WHERE user_id=?) +
       (SELECT COUNT(*) FROM activity WHERE user_id=?) AS n`).get(target.id,target.id,target.id).n;
    if(refs>0)return fail(res,409,'Der Account hat einen Bearbeitungsverlauf. Bitte stattdessen sperren, damit die Historie erhalten bleibt.');
    db.prepare('DELETE FROM users WHERE id=?').run(target.id);
    activity(u.id,`hat den Account ${target.name} gelöscht.`);
    return json(res,200,{ok:true});
  }
  if(pathx==='profile/password'&&method==='POST') {
    if(limited(`${u.id}`,'password',12))return fail(res,429,'Zu viele Versuche.');
    const b=await body(req);
    if(!verifyPwd(b.oldPassword||'',u.password_hash))return fail(res,403,'Bisheriges Passwort falsch.');
    if(!goodPwd(b.newPassword))return fail(res,400,'Das neue Passwort muss mindestens 12 Zeichen enthalten.');
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(argon(b.newPassword),u.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
    clearSession(res);return json(res,200,{ok:true});
  }
  return fail(res,404,'API-Endpunkt nicht gefunden.');
}
const server=http.createServer(async(req,res)=>{
  for(const [key,value] of Object.entries(securityHeaders))res.setHeader(key,value);
  try {
    const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);
    if(['POST','PATCH','DELETE','PUT'].includes(req.method) && !isSafeOrigin(req))return fail(res,403,'Unerlaubte Herkunft.');
    if(url.pathname.startsWith('/api/'))return await api(req,res,route(url.pathname),url.searchParams);
    if(req.method!=='GET')return fail(res,405,'Methode nicht erlaubt.');
    return staticFile(url.pathname,res);
  }catch(err){
    if(err.code==='SQLITE_CONSTRAINT_UNIQUE')return fail(res,409,'Dieser Wert ist bereits vergeben.');
    console.error('API-Fehler:',err);
    if(!res.headersSent)return fail(res,err.status||500,err.status?err.message:'Interner Serverfehler.');
    if(!res.writableEnded)res.end();
  }
});
if(require.main===module){
  server.listen(PORT,HOST,()=>{
    console.log(`\nSUMMITLINE CITY ROLEPLAY – TEAMVERWALTUNG\nWebseite: http://localhost:${PORT}`);
    if(!ownerExists())console.log(`\nERSTEINRICHTUNG:\nHauptadministrator-E-Mail: ${OWNER_EMAIL}\nGEHEIMER STARTCODE: ${setupToken}\nDiesen Code NICHT weitergeben!\n`);
    else console.log('Hauptadministrator bereits vorhanden; normales Login aktiviert.');
    if(!SECURE)console.log('ACHTUNG: Für öffentliche Nutzung HTTPS aktivieren und SECURE_COOKIES=true setzen.');
  });
}
module.exports={server,db,ROLES,STATUSES,validateStatus};
