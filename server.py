import hashlib, secrets, time, sqlite3, os
from pathlib import Path
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import httpx

DATA_DIR = Path("/data")
DATA_DIR.mkdir(exist_ok=True)
DB_PATH = DATA_DIR / "waterfish.db"

def get_db():
    db = sqlite3.connect(str(DB_PATH))
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    return db

def init_db():
    db = get_db()
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
    """)
    db.commit()
    db.close()

init_db()

def cfg_get(key):
    db = get_db()
    row = db.execute("SELECT value FROM config WHERE key=?", (key,)).fetchone()
    db.close()
    return row["value"] if row else None

def cfg_set(key, value):
    db = get_db()
    db.execute("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", (key, value))
    db.commit()
    db.close()

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

def hash_pw(pw): return hashlib.sha256(pw.encode()).hexdigest()
def make_token(): return secrets.token_hex(32)

def check_session(request: Request):
    token = request.cookies.get("session")
    if token:
        val = cfg_get(f"session_{token}")
        if val and time.time() - float(val) < 86400:
            return True
    return False

@app.get("/api/status")
def status():
    pw = cfg_get("admin_password_hash")
    return {"initialized": pw is not None, "turnstile_site_key": cfg_get("turnstile_site_key") or ""}

@app.post("/api/init")
async def init(request: Request):
    if cfg_get("admin_password_hash"):
        raise HTTPException(400, "Already initialized")
    body = await request.json()
    pw = body.get("password", "").strip()
    if len(pw) < 4:
        raise HTTPException(400, "Password too short")
    cfg_set("admin_password_hash", hash_pw(pw))
    cfg_set("turnstile_site_key", body.get("turnstile_site_key", ""))
    cfg_set("turnstile_secret", body.get("turnstile_secret", ""))
    token = make_token()
    cfg_set(f"session_{token}", str(time.time()))
    resp = JSONResponse({"ok": True})
    resp.set_cookie("session", token, httponly=True, max_age=86400, samesite="lax")
    return resp

@app.post("/api/login")
async def login(request: Request):
    stored = cfg_get("admin_password_hash")
    if not stored:
        raise HTTPException(400, "Not initialized")
    body = await request.json()
    if hash_pw(body.get("password", "")) != stored:
        raise HTTPException(401, "Wrong password")

    secret = cfg_get("turnstile_secret")
    if secret:
        token = body.get("turnstile_token", "")
        if not token:
            raise HTTPException(400, "Turnstile token required")
        async with httpx.AsyncClient() as client:
            r = await client.post("https://challenges.cloudflare.com/turnstile/v0/siteverify", data={
                "secret": secret, "response": token
            })
            if not r.json().get("success"):
                raise HTTPException(401, "Turnstile verification failed")

    token = make_token()
    cfg_set(f"session_{token}", str(time.time()))
    resp = JSONResponse({"ok": True})
    resp.set_cookie("session", token, httponly=True, max_age=86400, samesite="lax")
    return resp

@app.post("/api/logout")
def logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("session")
    return resp

@app.get("/api/providers")
def get_providers(request: Request):
    if not check_session(request): raise HTTPException(401)
    db = get_db()
    rows = db.execute("SELECT id, name, base_url, model, api_key FROM providers ORDER BY created_at").fetchall()
    db.close()
    return [{"id": r["id"], "name": r["name"], "base_url": r["base_url"], "model": r["model"], "has_key": bool(r["api_key"])} for r in rows]

@app.post("/api/providers")
async def add_provider(request: Request):
    if not check_session(request): raise HTTPException(401)
    body = await request.json()
    pid = secrets.token_hex(6)
    db = get_db()
    db.execute("INSERT INTO providers (id, name, base_url, api_key, model) VALUES (?,?,?,?,?)",
               (pid, body["name"], body["base_url"], body.get("api_key",""), body["model"]))
    db.commit(); db.close()
    return {"id": pid, "ok": True}

@app.delete("/api/providers/{pid}")
def delete_provider(pid: str, request: Request):
    if not check_session(request): raise HTTPException(401)
    db = get_db()
    db.execute("DELETE FROM providers WHERE id=?", (pid,))
    db.commit(); db.close()
    return {"ok": True}

@app.put("/api/providers/{pid}")
async def update_provider(pid: str, request: Request):
    if not check_session(request): raise HTTPException(401)
    body = await request.json()
    db = get_db()
    existing = db.execute("SELECT * FROM providers WHERE id=?", (pid,)).fetchone()
    if not existing: db.close(); raise HTTPException(404)
    db.execute("UPDATE providers SET name=?, base_url=?, model=? WHERE id=?",
               (body.get("name", existing["name"]), body.get("base_url", existing["base_url"]),
                body.get("model", existing["model"]), pid))
    if body.get("api_key"):
        db.execute("UPDATE providers SET api_key=? WHERE id=?", (body["api_key"], pid))
    db.commit(); db.close()
    return {"ok": True}

@app.get("/api/conversations")
def get_conversations(request: Request, provider_id: str = ""):
    if not check_session(request): raise HTTPException(401)
    db = get_db()
    rows = db.execute("SELECT id, title, created_at FROM conversations WHERE provider_id=? ORDER BY created_at DESC",
                      (provider_id,)).fetchall()
    db.close()
    return [{"id": r["id"], "title": r["title"], "created_at": r["created_at"]} for r in rows]

@app.post("/api/conversations")
async def create_conversation(request: Request):
    if not check_session(request): raise HTTPException(401)
    body = await request.json()
    cid = secrets.token_hex(8)
    db = get_db()
    db.execute("INSERT INTO conversations (id, provider_id, title) VALUES (?,?,?)",
               (cid, body["provider_id"], body.get("title", "新对话")))
    db.commit(); db.close()
    return {"id": cid, "title": body.get("title", "新对话"), "ok": True}

@app.delete("/api/conversations/{cid}")
def delete_conversation(cid: str, request: Request):
    if not check_session(request): raise HTTPException(401)
    db = get_db()
    db.execute("DELETE FROM conversations WHERE id=?", (cid,))
    db.commit(); db.close()
    return {"ok": True}

@app.get("/api/conversations/{cid}/messages")
def get_messages(cid: str, request: Request):
    if not check_session(request): raise HTTPException(401)
    db = get_db()
    rows = db.execute("SELECT role, content FROM messages WHERE conversation_id=? ORDER BY created_at", (cid,)).fetchall()
    db.close()
    return [{"role": r["role"], "content": r["content"]} for r in rows]

@app.post("/api/conversations/{cid}/chat")
async def chat_in_conversation(cid: str, request: Request):
    if not check_session(request): raise HTTPException(401)
    body = await request.json()
    content = body.get("content", "").strip()
    if not content:
        raise HTTPException(400, "Empty message")

    db = get_db()
    conv = db.execute("SELECT * FROM conversations WHERE id=?", (cid,)).fetchone()
    if not conv: db.close(); raise HTTPException(404, "Conversation not found")

    provider = db.execute("SELECT * FROM providers WHERE id=?", (conv["provider_id"],)).fetchone()
    if not provider: db.close(); raise HTTPException(400, "Provider not found")

    if conv["title"] == "新对话":
        title = content[:40] + ("..." if len(content) > 40 else "")
        db.execute("UPDATE conversations SET title=? WHERE id=?", (title, cid))

    db.execute("INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)", (cid, "user", content))
    db.commit()

    history = db.execute("SELECT role, content FROM messages WHERE conversation_id=? ORDER BY created_at", (cid,)).fetchall()
    db.close()

    messages = [{"role": r["role"], "content": r["content"]} for r in history]

    try:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{provider['base_url']}/chat/completions",
                headers={"Authorization": f"Bearer {provider['api_key']}", "Content-Type": "application/json"},
                json={"model": provider["model"], "messages": messages}
            )

        if resp.status_code != 200:
            err_text = await resp.atext()
            db = get_db()
            db.execute("INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)",
                       (cid, "assistant", f"API 错误 {resp.status_code}: {err_text[:500]}"))
            db.commit()
            rows = db.execute("SELECT role, content FROM messages WHERE conversation_id=? ORDER BY created_at", (cid,)).fetchall()
            db.close()
            return {"messages": [{"role": r["role"], "content": r["content"], "error": r["role"]=="assistant"} for r in rows]}

        result = resp.json()
        reply = result.get("choices", [{}])[0].get("message", {}).get("content", "(空回复)")

        db = get_db()
        db.execute("INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)", (cid, "assistant", reply))
        db.commit()
        rows = db.execute("SELECT role, content FROM messages WHERE conversation_id=? ORDER BY created_at", (cid,)).fetchall()
        db.close()
        return {"messages": [{"role": r["role"], "content": r["content"]} for r in rows]}

    except Exception as e:
        db = get_db()
        db.execute("INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)",
                   (cid, "assistant", f"请求失败: {str(e)}"))
        db.commit()
        rows = db.execute("SELECT role, content FROM messages WHERE conversation_id=? ORDER BY created_at", (cid,)).fetchall()
        db.close()
        return {"messages": [{"role": r["role"], "content": r["content"], "error": r["role"]=="assistant"} for r in rows]}

@app.get("/api/settings")
def get_settings(request: Request):
    if not check_session(request): raise HTTPException(401)
    return {
        "turnstile_site_key": cfg_get("turnstile_site_key") or "",
        "turnstile_secret": cfg_get("turnstile_secret") or "",
        "idle_timeout": int(cfg_get("idle_timeout") or 15)
    }

@app.post("/api/settings")
async def save_settings(request: Request):
    if not check_session(request): raise HTTPException(401)
    body = await request.json()
    if "turnstile_site_key" in body: cfg_set("turnstile_site_key", body["turnstile_site_key"])
    if "turnstile_secret" in body: cfg_set("turnstile_secret", body["turnstile_secret"])
    if "idle_timeout" in body:
        t = max(1, min(120, int(body["idle_timeout"])))
        cfg_set("idle_timeout", str(t))
        Path("/tmp/idle_timeout_min").write_text(str(t))
    return {"ok": True}
