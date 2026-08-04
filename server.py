import hashlib, secrets, time, sqlite3, os, binascii, base64, json, re
from contextlib import contextmanager
from pathlib import Path
from fastapi import FastAPI, HTTPException, Request, UploadFile, File, Form
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import httpx

DATA_DIR = Path("/data")
DATA_DIR.mkdir(exist_ok=True)
DB_PATH = DATA_DIR / "waterfish.db"
UPLOAD_DIR = DATA_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

TEXT_EXT = {'.txt', '.md', '.json', '.csv', '.py', '.js', '.html', '.css', '.xml', '.yaml', '.yml', '.log', '.sh', '.bat', '.ps1', '.conf', '.cfg', '.ini', '.toml'}
IMG_EXT = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'}

import sys
print(f"[server] Starting, DB={DB_PATH}, pid={os.getpid()}", flush=True)

@contextmanager
def use_db():
    db = sqlite3.connect(str(DB_PATH))
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    try:
        yield db
        db.commit()
    finally:
        db.close()

def init_db():
    with use_db() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                value TEXT
            );
            CREATE TABLE IF NOT EXISTS providers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                base_url TEXT NOT NULL,
                api_key TEXT NOT NULL DEFAULT '',
                model TEXT NOT NULL DEFAULT '',
                created_at REAL DEFAULT (strftime('%s','now'))
            );
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
                title TEXT DEFAULT '新对话',
                created_at REAL DEFAULT (strftime('%s','now'))
            );
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at REAL DEFAULT (strftime('%s','now'))
            );
            CREATE INDEX IF NOT EXISTS idx_conv_provider ON conversations(provider_id);
            CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);

            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                is_admin INTEGER DEFAULT 0,
                created_at REAL DEFAULT (strftime('%s','now'))
            );
        """)

init_db()

def migrate():
    with use_db() as db:
        try:
            db.execute("ALTER TABLE conversations ADD COLUMN system_prompt TEXT DEFAULT ''")
        except:
            pass

migrate()

def cfg_get(key):
    with use_db() as db:
        row = db.execute("SELECT value FROM config WHERE key=?", (key,)).fetchone()
        return row["value"] if row else None

def cfg_set(key, value):
    with use_db() as db:
        db.execute("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", (key, value))

PBKDF2_ITERATIONS = 600000
SALT_BYTES = 16

def hash_pw(pw):
    salt = os.urandom(SALT_BYTES)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, PBKDF2_ITERATIONS)
    return binascii.hexlify(salt).decode() + ":" + binascii.hexlify(dk).decode()

def verify_pw(pw, stored):
    parts = stored.split(":", 1)
    if len(parts) != 2:
        return hashlib.sha256(pw.encode()).hexdigest() == stored
    salt = binascii.unhexlify(parts[0])
    dk = binascii.unhexlify(parts[1])
    return hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, PBKDF2_ITERATIONS) == dk

def make_token(): return secrets.token_hex(32)

def get_session_user_id(request: Request):
    token = request.cookies.get("session")
    if not token: return None
    val = cfg_get(f"session_{token}")
    if not val: return None
    try:
        if "|" in val:
            ts_str, uid = val.split("|", 1)
            if time.time() - float(ts_str) < 86400:
                return uid
        else:
            if time.time() - float(val) < 86400:
                return None  # legacy session, fallback below
    except (ValueError, TypeError):
        pass
    return None

def get_current_user(request: Request):
    uid = get_session_user_id(request)
    if uid:
        with use_db() as db:
            return db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    # legacy session: match first admin
    val = request.cookies.get("session")
    if val and cfg_get(f"session_{val}"):
        try:
            if time.time() - float(cfg_get(f"session_{val}")) < 86400:
                with use_db() as db:
                    return db.execute("SELECT * FROM users WHERE is_admin=1 ORDER BY created_at LIMIT 1").fetchone()
        except:
            pass
    return None

def check_session(request: Request):
    return get_current_user(request) is not None

def check_admin(request: Request):
    u = get_current_user(request)
    if not u or not u["is_admin"]:
        raise HTTPException(403, "Admin only")
    return u

def cleanup_sessions():
    now = time.time()
    with use_db() as db:
        rows = db.execute("SELECT key FROM config WHERE key LIKE 'session_%'").fetchall()
        for r in rows:
            val = cfg_get(r["key"])
            if not val: continue
            try:
                ts_str = val.split("|")[0] if "|" in val else val
                if now - float(ts_str) > 86400:
                    db.execute("DELETE FROM config WHERE key=?", (r["key"],))
            except:
                pass

LOGIN_ATTEMPTS = {}
LOGIN_RATE_LIMIT = 10
LOGIN_WINDOW = 60

def check_login_ratelimit(ip):
    now = time.time()
    LOGIN_ATTEMPTS[ip] = [t for t in LOGIN_ATTEMPTS.get(ip, []) if now - t < LOGIN_WINDOW]
    if len(LOGIN_ATTEMPTS[ip]) >= LOGIN_RATE_LIMIT:
        return False
    LOGIN_ATTEMPTS[ip].append(now)
    return True

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

@app.get("/api/status")
def status(request: Request):
    try:
        with use_db() as db:
            admin = db.execute("SELECT id FROM users WHERE is_admin=1 LIMIT 1").fetchone()
        initialized = admin is not None
    except:
        pw = cfg_get("admin_password_hash")
        initialized = pw is not None
    resp = {"initialized": initialized, "turnstile_site_key": cfg_get("turnstile_site_key") or ""}
    user = get_current_user(request)
    if user:
        resp["username"] = user["username"]
        resp["is_admin"] = bool(user["is_admin"])
    return resp

@app.post("/api/init")
async def init(request: Request):
    with use_db() as db:
        admin = db.execute("SELECT id FROM users WHERE is_admin=1 LIMIT 1").fetchone()
    if admin:
        raise HTTPException(400, "Already initialized")
    ip = request.client.host if request.client else "unknown"
    if not check_login_ratelimit(ip):
        raise HTTPException(429, "Too many attempts")
    body = await request.json()
    name = body.get("admin_name", "").strip() or "admin"
    pw = body.get("password", "").strip()
    if len(pw) < 4:
        raise HTTPException(400, "Password too short")
    with use_db() as db:
        uid = secrets.token_hex(8)
        db.execute("INSERT INTO users (id, username, password_hash, is_admin) VALUES (?,?,?,1)", (uid, name, hash_pw(pw)))
    cfg_set("turnstile_site_key", body.get("turnstile_site_key", ""))
    cfg_set("turnstile_secret", body.get("turnstile_secret", ""))
    token = make_token()
    cfg_set(f"session_{token}", f"{time.time()}|{uid}")
    cleanup_sessions()
    resp = JSONResponse({"ok": True, "admin_name": name})
    resp.set_cookie("session", token, httponly=True, max_age=86400, samesite="lax")
    return resp

@app.post("/api/login")
async def login(request: Request):
    try:
        with use_db() as db:
            _ = db.execute("SELECT id FROM users WHERE is_admin=1 LIMIT 1").fetchone()
    except:
        pass
    ip = request.client.host if request.client else "unknown"
    if not check_login_ratelimit(ip):
        raise HTTPException(429, "Too many attempts")
    body = await request.json()
    username = body.get("username", "").strip()
    pw = body.get("password", "")
    if not username:
        raise HTTPException(400, "用户名不能为空")

    # try new users table first
    user = None
    with use_db() as db:
        try:
            user = db.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        except:
            pass
    if user and verify_pw(pw, user["password_hash"]):
        pass
    elif not user:
        # fallback: old admin_password_hash (backward compat & auto-migrate)
        stored = cfg_get("admin_password_hash")
        if username == "admin" and stored and verify_pw(pw, stored):
            with use_db() as db:
                existing = db.execute("SELECT id FROM users WHERE username='admin'").fetchone()
                if existing:
                    uid = existing["id"]
                else:
                    uid = secrets.token_hex(8)
                    db.execute("INSERT INTO users (id, username, password_hash, is_admin) VALUES (?,?,?,1)", (uid, "admin", stored))
            user = {"id": uid, "username": "admin", "is_admin": 1}
        else:
            raise HTTPException(401, "用户名或密码错误")
    else:
        raise HTTPException(401, "用户名或密码错误")

    secret = cfg_get("turnstile_secret")
    sitekey = cfg_get("turnstile_site_key")
    if secret and sitekey:
        turnstile_token = body.get("turnstile_token", "")
        if not turnstile_token:
            raise HTTPException(400, "Turnstile token required")
        async with httpx.AsyncClient() as client:
            r = await client.post("https://challenges.cloudflare.com/turnstile/v0/siteverify", data={
                "secret": secret, "response": turnstile_token
            })
            if not r.json().get("success"):
                raise HTTPException(401, "Turnstile verification failed")

    token = make_token()
    cfg_set(f"session_{token}", f"{time.time()}|{user['id']}")
    cleanup_sessions()
    resp = JSONResponse({"ok": True, "username": user["username"], "is_admin": bool(user["is_admin"])})
    resp.set_cookie("session", token, httponly=True, max_age=86400, samesite="lax")
    return resp

@app.post("/api/logout")
def logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("session")
    return resp

@app.get("/api/users")
def list_users(request: Request):
    check_admin(request)
    with use_db() as db:
        rows = db.execute("SELECT id, username, is_admin, created_at FROM users ORDER BY created_at").fetchall()
    return {"users": [dict(r) for r in rows]}

@app.post("/api/users")
async def add_user(request: Request):
    check_admin(request)
    body = await request.json()
    name = body.get("username", "").strip()
    pw = body.get("password", "").strip()
    if not name or len(pw) < 4:
        raise HTTPException(400, "用户名不能为空，密码至少 4 位")
    with use_db() as db:
        exists = db.execute("SELECT id FROM users WHERE username=?", (name,)).fetchone()
        if exists:
            raise HTTPException(400, "用户名已存在")
        uid = secrets.token_hex(8)
        db.execute("INSERT INTO users (id, username, password_hash, is_admin) VALUES (?,?,?,0)", (uid, name, hash_pw(pw)))
    return {"ok": True, "id": uid, "username": name}

@app.delete("/api/users/{uid}")
def delete_user(uid: str, request: Request):
    me = check_admin(request)
    if me["id"] == uid:
        raise HTTPException(400, "不能删除自己")
    with use_db() as db:
        target = db.execute("SELECT id, is_admin FROM users WHERE id=?", (uid,)).fetchone()
        if not target:
            raise HTTPException(404, "用户不存在")
        if target["is_admin"]:
            admins = db.execute("SELECT id FROM users WHERE is_admin=1").fetchall()
            if len(admins) <= 1:
                raise HTTPException(400, "至少保留一个管理员")
        db.execute("DELETE FROM users WHERE id=?", (uid,))
    return {"ok": True}

@app.get("/api/providers")
def get_providers(request: Request):
    if not check_session(request): raise HTTPException(401)
    user = get_current_user(request)
    with use_db() as db:
        rows = db.execute("SELECT id, name, base_url, model, api_key FROM providers ORDER BY created_at").fetchall()
        providers = [{"id": r["id"], "name": r["name"], "base_url": r["base_url"], "model": r["model"], "has_key": bool(r["api_key"])} for r in rows]
    if user and not user["is_admin"]:
        allowed = [m.strip() for m in (cfg_get("user_models") or "").split(",") if m.strip()]
        if allowed:
            providers = [p for p in providers if p["model"] in allowed]
    return providers

@app.post("/api/providers")
async def add_provider(request: Request):
    if not check_session(request): raise HTTPException(401)
    body = await request.json()
    pid = secrets.token_hex(6)
    with use_db() as db:
        db.execute("INSERT INTO providers (id, name, base_url, api_key, model) VALUES (?,?,?,?,?)",
                   (pid, body["name"], body["base_url"], body.get("api_key",""), body["model"]))
    return {"id": pid, "ok": True}

@app.delete("/api/providers/{pid}")
def delete_provider(pid: str, request: Request):
    if not check_session(request): raise HTTPException(401)
    with use_db() as db:
        db.execute("DELETE FROM providers WHERE id=?", (pid,))
    return {"ok": True}

@app.put("/api/providers/{pid}")
async def update_provider(pid: str, request: Request):
    if not check_session(request): raise HTTPException(401)
    body = await request.json()
    with use_db() as db:
        existing = db.execute("SELECT * FROM providers WHERE id=?", (pid,)).fetchone()
        if not existing: raise HTTPException(404)
        db.execute("UPDATE providers SET name=?, base_url=?, model=? WHERE id=?",
                   (body.get("name", existing["name"]), body.get("base_url", existing["base_url"]),
                    body.get("model", existing["model"]), pid))
        if body.get("api_key"):
            db.execute("UPDATE providers SET api_key=? WHERE id=?", (body["api_key"], pid))
    return {"ok": True}

@app.get("/api/conversations")
def get_conversations(request: Request, provider_id: str = ""):
    if not check_session(request): raise HTTPException(401)
    with use_db() as db:
        rows = db.execute("SELECT id, title, system_prompt, created_at FROM conversations WHERE provider_id=? ORDER BY created_at DESC",
                          (provider_id,)).fetchall()
        return [{"id": r["id"], "title": r["title"], "system_prompt": r["system_prompt"] or "", "created_at": r["created_at"]} for r in rows]

@app.post("/api/conversations")
async def create_conversation(request: Request):
    if not check_session(request): raise HTTPException(401)
    body = await request.json()
    cid = secrets.token_hex(8)
    with use_db() as db:
        db.execute("INSERT INTO conversations (id, provider_id, title, system_prompt) VALUES (?,?,?,?)",
                   (cid, body["provider_id"], body.get("title", "新对话"), body.get("system_prompt", "")))
    return {"id": cid, "title": body.get("title", "新对话"), "system_prompt": body.get("system_prompt", ""), "ok": True}

@app.put("/api/conversations/{cid}")
async def update_conversation(cid: str, request: Request):
    if not check_session(request): raise HTTPException(401)
    body = await request.json()
    with use_db() as db:
        if "title" in body:
            db.execute("UPDATE conversations SET title=? WHERE id=?", (body["title"], cid))
        if "system_prompt" in body:
            db.execute("UPDATE conversations SET system_prompt=? WHERE id=?", (body["system_prompt"], cid))
    return {"ok": True}

@app.delete("/api/conversations/{cid}")
def delete_conversation(cid: str, request: Request):
    if not check_session(request): raise HTTPException(401)
    with use_db() as db:
        db.execute("DELETE FROM conversations WHERE id=?", (cid,))
    return {"ok": True}

@app.get("/api/conversations/{cid}/messages")
def get_messages(cid: str, request: Request):
    if not check_session(request): raise HTTPException(401)
    with use_db() as db:
        rows = db.execute("SELECT role, content FROM messages WHERE conversation_id=? ORDER BY created_at", (cid,)).fetchall()
        return [{"role": r["role"], "content": r["content"]} for r in rows]

@app.post("/api/upload")
async def upload_files(request: Request, files: list[UploadFile] = File(...)):
    if not check_session(request): raise HTTPException(401)
    file_ids = []
    for f in files:
        fid = secrets.token_hex(6)
        ext = Path(f.filename).suffix.lower() if f.filename else ""
        fname = f"{fid}{ext}" if ext else fid
        fpath = UPLOAD_DIR / fname
        content = await f.read()
        fpath.write_bytes(content)
        file_ids.append({"id": fid, "name": f.filename, "size": len(content), "ext": ext})
    return {"file_ids": file_ids, "ok": True}

async def do_web_search(engine, api_key, query):
    max_results = int(cfg_get("querit_max_results") or 10) if engine == "querit" else 5
    time_range = cfg_get("querit_time_range") or "none"

    async with httpx.AsyncClient(timeout=20) as client:
        if engine == "bing":
            if api_key:
                sr = await client.get(
                    "https://api.bing.microsoft.com/v7.0/search",
                    params={"q": query, "count": str(max_results), "mkt": "zh-CN"},
                    headers={"Ocp-Apim-Subscription-Key": api_key}
                )
                if sr.status_code == 200:
                    results = sr.json().get("webPages", {}).get("value", [])[:max_results]
                    items = [(r.get("name",""), r.get("url",""), r.get("snippet","")) for r in results]
                else:
                    items = []
            else:
                import urllib.parse
                qs = urllib.parse.quote(query)
                sr = await client.get(
                    f"https://www.bing.com/search?q={qs}&count={max_results}",
                    headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
                )
                if sr.status_code == 200:
                    from re import findall
                    html = sr.text
                    titles = findall(r'<h2[^>]*><a[^>]*>(.*?)</a></h2>', html, re.S)
                    links = findall(r'<h2[^>]*><a[^>]*href="([^"]+)"', html)
                    snippets = findall(r'<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>(.*?)</p>', html, re.S)
                    items = []
                    for i in range(min(len(titles), max_results)):
                        items.append((
                            re.sub(r'<[^>]+>', '', titles[i]).strip() if i < len(titles) else f"结果{i+1}",
                            links[i] if i < len(links) else "#",
                            re.sub(r'<[^>]+>', '', snippets[i]).strip() if i < len(snippets) else ""
                        ))
                else:
                    items = []

        elif engine == "tavily":
            sr = await client.post(
                "https://api.tavily.com/search",
                json={"api_key": api_key, "query": query, "max_results": max_results, "search_depth": "basic"}
            )
            if sr.status_code == 200:
                results = sr.json().get("results", [])[:max_results]
                items = [(r.get("title",""), r.get("url",""), r.get("content","")) for r in results]

        elif engine == "bocha":
            sr = await client.post(
                "https://api.bochaai.com/v1/ai/search",
                json={"query": query, "count": max_results},
                headers={"Authorization": f"Bearer {api_key}"}
            )
            if sr.status_code == 200:
                data = sr.json()
                results = (data.get("data", {}) if isinstance(data.get("data"), dict) else {}).get("webPages", {}).get("value", data.get("results", []))[:max_results]
                items = [(r.get("name", r.get("title","")), r.get("url",""), r.get("snippet", r.get("summary",""))) for r in results]

        elif engine == "querit":
            body = {"query": query, "max_results": max_results}
            if time_range and time_range != "none":
                body["time_range"] = time_range
            sr = await client.post(
                "https://api.querit.ai/v1/search",
                json=body,
                headers={"Authorization": f"Bearer {api_key}"}
            )
            if sr.status_code == 200:
                data = sr.json()
                results = data.get("results", [])[:max_results]
                items = [(r.get("title",""), r.get("url",""), r.get("snippet", r.get("content",""))) for r in results]
        else:
            return None

        if items:
            return "联网搜索结果:\n" + "\n".join(
                f"- [{title or '链接'}]({url}): {(snippet or '')[:200]}"
                for title, url, snippet in items
            )
    return None

@app.post("/api/conversations/{cid}/chat")
async def chat_in_conversation(cid: str, request: Request):
    if not check_session(request): raise HTTPException(401)
    body = await request.json()
    content = body.get("content", "").strip()
    web_search = body.get("web_search", False)
    file_ids = body.get("file_ids", [])

    if not content and not file_ids:
        raise HTTPException(400, "Empty message")

    user_content = content
    user_content_for_db = content
    multimodal_content = None

    if file_ids:
        file_texts = []
        image_parts = []
        for fi in file_ids:
            fid = fi.get("id") if isinstance(fi, dict) else fi
            ext = Path(fi.get("ext", "")) if isinstance(fi, dict) else ""
            fname = fi.get("name", "") if isinstance(fi, dict) else fid
            if not ext:
                for f in UPLOAD_DIR.iterdir():
                    if f.stem == fid:
                        ext = f.suffix.lower()
                        break
            fpath = None
            for f in UPLOAD_DIR.iterdir():
                if f.stem == fid:
                    fpath = f
                    break
            if not fpath or not fpath.exists():
                continue
            file_bytes = fpath.read_bytes()
            if ext in IMG_EXT:
                b64 = base64.b64encode(file_bytes).decode()
                mime = f"image/{ext[1:]}" if ext[1:] != "jpg" else "image/jpeg"
                if ext == ".svg":
                    mime = "image/svg+xml"
                image_parts.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}})
            elif ext in TEXT_EXT:
                try:
                    t = file_bytes.decode("utf-8")
                    if len(t) > 8000:
                        t = t[:8000] + "\n...(truncated)"
                    file_texts.append(f"[文件: {fname}]\n{t}")
                except:
                    file_texts.append(f"[文件: {fname} (binary)]")
            else:
                file_texts.append(f"[文件: {fname}]")

        if image_parts:
            parts = [{"type": "text", "text": content or "分析这张图片"}] + image_parts
            multimodal_content = parts
            user_content_for_db = content + " [包含图片]"
        elif file_texts:
            fc = "\n\n".join(file_texts)
            user_content = fc + ("\n\n" + content if content else "")
            user_content_for_db = user_content

    if web_search:
        engine = cfg_get("web_search_engine") or "bing"
        search_key = cfg_get("web_search_api_key") or ""
        if search_key or engine == "bing":
            try:
                query = content or " "
                sc = await do_web_search(engine, search_key, query)
                if sc:
                    user_content = sc + "\n\n用户问题: " + user_content
            except:
                pass

    with use_db() as db:
        conv = db.execute("SELECT * FROM conversations WHERE id=?", (cid,)).fetchone()
        if not conv: raise HTTPException(404, "Conversation not found")

        provider = db.execute("SELECT * FROM providers WHERE id=?", (conv["provider_id"],)).fetchone()
        if not provider: raise HTTPException(400, "Provider not found")

        if conv["title"] == "新对话":
            title = content[:40] + ("..." if len(content) > 40 else "")
            db.execute("UPDATE conversations SET title=? WHERE id=?", (title, cid))

        db.execute("INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)", (cid, "user", user_content_for_db))

        history = db.execute("SELECT role, content FROM messages WHERE conversation_id=? ORDER BY created_at", (cid,)).fetchall()

    messages = [{"role": r["role"], "content": r["content"]} for r in history]

    if file_ids and multimodal_content:
        messages[-1] = {"role": "user", "content": multimodal_content}
    elif user_content != content:
        messages[-1] = {"role": "user", "content": user_content}

    if conv["system_prompt"]:
        messages.insert(0, {"role": "system", "content": conv["system_prompt"]})

    try:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{provider['base_url']}/chat/completions",
                headers={"Authorization": f"Bearer {provider['api_key']}", "Content-Type": "application/json"},
                json={"model": provider["model"], "messages": messages}
            )

        if resp.status_code != 200:
            err_text = await resp.atext()
            with use_db() as db:
                db.execute("INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)",
                           (cid, "assistant", f"API 错误 {resp.status_code}: {err_text[:500]}"))
                rows = db.execute("SELECT role, content FROM messages WHERE conversation_id=? ORDER BY created_at", (cid,)).fetchall()
                return {"messages": [{"role": r["role"], "content": r["content"], "error": r["role"]=="assistant"} for r in rows]}

        result = resp.json()
        reply = result.get("choices", [{}])[0].get("message", {}).get("content", "(空回复)")

        with use_db() as db:
            db.execute("INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)", (cid, "assistant", reply))
            rows = db.execute("SELECT role, content FROM messages WHERE conversation_id=? ORDER BY created_at", (cid,)).fetchall()
            return {"messages": [{"role": r["role"], "content": r["content"]} for r in rows]}

    except Exception as e:
        with use_db() as db:
            db.execute("INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)",
                       (cid, "assistant", f"请求失败: {str(e)}"))
            rows = db.execute("SELECT role, content FROM messages WHERE conversation_id=? ORDER BY created_at", (cid,)).fetchall()
            return {"messages": [{"role": r["role"], "content": r["content"], "error": r["role"]=="assistant"} for r in rows]}

@app.get("/api/settings")
def get_settings(request: Request):
    if not check_session(request): raise HTTPException(401)
    return {
        "turnstile_site_key": cfg_get("turnstile_site_key") or "",
        "turnstile_secret": cfg_get("turnstile_secret") or "",
        "idle_timeout": int(cfg_get("idle_timeout") or 15),
        "use_container_network": cfg_get("use_container_network") == "true",
        "web_search_engine": cfg_get("web_search_engine") or "bing",
        "web_search_api_key": cfg_get("web_search_api_key") or "",
        "querit_max_results": int(cfg_get("querit_max_results") or 10),
        "querit_time_range": cfg_get("querit_time_range") or "none",
        "user_models": cfg_get("user_models") or ""
    }

@app.post("/api/settings")
async def save_settings(request: Request):
    check_admin(request)
    body = await request.json()
    if "turnstile_site_key" in body: cfg_set("turnstile_site_key", body["turnstile_site_key"])
    if "turnstile_secret" in body: cfg_set("turnstile_secret", body["turnstile_secret"])
    if "use_container_network" in body: cfg_set("use_container_network", "true" if body["use_container_network"] else "false")
    if "web_search_engine" in body: cfg_set("web_search_engine", body["web_search_engine"])
    if "web_search_api_key" in body: cfg_set("web_search_api_key", body["web_search_api_key"])
    if "querit_max_results" in body: cfg_set("querit_max_results", str(body["querit_max_results"]))
    if "querit_time_range" in body: cfg_set("querit_time_range", body["querit_time_range"])
    if "idle_timeout" in body:
        t = max(1, min(120, int(body["idle_timeout"])))
        cfg_set("idle_timeout", str(t))
        Path("/tmp/idle_timeout_min").write_text(str(t))
    if "user_models" in body: cfg_set("user_models", body["user_models"])
    return {"ok": True}

@app.post("/api/fetch-models")
async def fetch_models_from_url(request: Request):
    if not check_session(request): raise HTTPException(401)
    body = await request.json()
    base = body.get("base_url", "").rstrip("/")
    key = body.get("api_key", "")
    if not base:
        raise HTTPException(400, "base_url required")
    models_url = f"{base}/models"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            headers = {"Authorization": f"Bearer {key}"} if key else {}
            resp = await client.get(models_url, headers=headers)
        if resp.status_code != 200:
            raise HTTPException(502, f"API returned {resp.status_code}: {await resp.atext()}"[:500])
        data = resp.json()
        model_list = []
        if isinstance(data, dict):
            items = data.get("data", data.get("models", []))
        elif isinstance(data, list):
            items = data
        else:
            items = []
        for m in items:
            if isinstance(m, dict):
                mid = m.get("id", m.get("model", ""))
                if mid:
                    model_list.append({"id": mid, "owned_by": m.get("owned_by", ""), "created": m.get("created", 0)})
            elif isinstance(m, str):
                model_list.append({"id": m})
        return {"models": model_list, "ok": True}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, str(e))

@app.post("/api/providers/{pid}/fetch-models")
async def fetch_models(pid: str, request: Request):
    if not check_session(request): raise HTTPException(401)
    with use_db() as db:
        provider = db.execute("SELECT * FROM providers WHERE id=?", (pid,)).fetchone()
    if not provider: raise HTTPException(404)
    base = provider["base_url"].rstrip("/")
    key = provider["api_key"]
    models_url = f"{base}/models"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            headers = {"Authorization": f"Bearer {key}"} if key else {}
            resp = await client.get(models_url, headers=headers)
        if resp.status_code != 200:
            raise HTTPException(502, f"API returned {resp.status_code}: {await resp.atext()}"[:500])
        data = resp.json()
        model_list = []
        if isinstance(data, dict):
            items = data.get("data", data.get("models", []))
        elif isinstance(data, list):
            items = data
        else:
            items = []
        for m in items:
            if isinstance(m, dict):
                mid = m.get("id", m.get("model", ""))
                if mid:
                    model_list.append({"id": mid, "owned_by": m.get("owned_by", ""), "created": m.get("created", 0)})
            elif isinstance(m, str):
                model_list.append({"id": m})
        return {"models": model_list, "ok": True}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=9000)
