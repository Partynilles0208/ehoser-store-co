require("dotenv").config();

const cookieParser = require("cookie-parser");
const express = require("express");
const fs = require("fs/promises");
const multer = require("multer");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 900 * 1024 * 1024 } });

const PORT = Number(process.env.PORT || 3000);
const SITE_ACCESS_CODE = process.env.SITE_ACCESS_CODE || "0208";
const ADMIN_ACCESS_CODE = process.env.ADMIN_ACCESS_CODE || "Nils2014!";
const PUBLIC_DIR = path.join(__dirname, "public");
const WRITABLE_ROOT = process.env.VERCEL ? os.tmpdir() : __dirname;
const DATA_FILE = path.join(WRITABLE_ROOT, "data", "games.json");
const UPLOAD_DIR = path.join(WRITABLE_ROOT, "uploads");
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "games";

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;

app.use(express.json({ limit: "4mb" }));
app.use(cookieParser());
app.use((req, res, next) => {
  if (!req.path.startsWith("/assets")) {
    res.set("Cache-Control", "no-store");
  }
  next();
});
app.use("/assets", express.static(PUBLIC_DIR, { maxAge: "1h" }));
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "1h" }));

app.get("/health", (req, res) => {
  res.json({ ok: true, storage: supabase ? "supabase" : "local" });
});

function hasStoreAccess(req) {
  return req.cookies.ehoser_access === "granted";
}

function createId(size = 10) {
  return crypto.randomUUID().replaceAll("-", "").slice(0, size);
}

function hasAdminAccess(req) {
  return req.cookies.ehoser_admin === "granted";
}

function requireStore(req, res, next) {
  if (!hasStoreAccess(req)) return res.status(401).json({ error: "locked" });
  next();
}

function requireAdmin(req, res, next) {
  if (!hasAdminAccess(req)) return res.status(401).json({ error: "admin_locked" });
  next();
}

function publicGame(game) {
  const releaseAt = game.release_at ? new Date(game.release_at) : null;
  const isReleased = !releaseAt || releaseAt <= new Date();
  return {
    ...game,
    download_url: isReleased ? game.download_url : "",
    is_released: isReleased,
    release_label: releaseAt ? releaseAt.toLocaleDateString("de-DE") : "Jetzt verfuegbar",
  };
}

async function ensureLocalStore() {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  try {
    await fs.access(DATA_FILE);
  } catch {
    const demo = [
      {
        id: createId(10),
        title: "Neon Drift",
        icon_url: "/assets/placeholder-neon.svg",
        trailer_url: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
        image_urls: ["/assets/hero-art.svg"],
        description: "Ein schneller Arcade-Racer mit futuristischen Strecken, klarer Steuerung und Zeitrennen.",
        release_at: new Date().toISOString(),
        download_url: "",
        created_at: new Date().toISOString(),
      },
      {
        id: createId(10),
        title: "Orbit Factory",
        icon_url: "/assets/placeholder-orbit.svg",
        trailer_url: "",
        image_urls: ["/assets/hero-art.svg"],
        description: "Baue Produktionslinien im Weltraum, optimiere Routen und schalte neue Module frei.",
        release_at: "2026-08-15T10:00:00.000Z",
        download_url: "",
        created_at: new Date().toISOString(),
      },
    ];
    await fs.writeFile(DATA_FILE, JSON.stringify(demo, null, 2));
  }
}

async function readLocalGames() {
  await ensureLocalStore();
  return JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
}

async function writeLocalGames(games) {
  await ensureLocalStore();
  await fs.writeFile(DATA_FILE, JSON.stringify(games, null, 2));
}

async function listGames() {
  if (!supabase) return readLocalGames();
  const { data, error } = await supabase.from("games").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

async function saveGame(payload) {
  const now = new Date().toISOString();
  if (!payload.download_url && !payload.release_at) {
    const error = new Error("Wenn keine EXE hinterlegt ist, muss ein Veroeffentlichungsdatum gesetzt werden.");
    error.status = 400;
    throw error;
  }
  const game = {
    id: payload.id || createId(10),
    title: payload.title?.trim() || "Unbenanntes Spiel",
    icon_url: payload.icon_url || "",
    trailer_url: payload.trailer_url || "",
    image_urls: Array.isArray(payload.image_urls) ? payload.image_urls.filter(Boolean) : [],
    description: payload.description || "",
    release_at: payload.release_at || null,
    download_url: payload.download_url || "",
    created_at: payload.created_at || now,
    updated_at: now,
  };

  if (supabase) {
    const { data, error } = await supabase.from("games").upsert(game).select().single();
    if (error) throw error;
    return data;
  }

  const games = await readLocalGames();
  const index = games.findIndex((item) => item.id === game.id);
  if (index >= 0) games[index] = { ...games[index], ...game };
  else games.unshift(game);
  await writeLocalGames(games);
  return game;
}

async function deleteGame(id) {
  if (supabase) {
    const { error } = await supabase.from("games").delete().eq("id", id);
    if (error) throw error;
    return;
  }
  const games = await readLocalGames();
  await writeLocalGames(games.filter((game) => game.id !== id));
}

async function uploadFile(file, folder) {
  const safeName = file.originalname.replace(/[^\w.\-]+/g, "_");
  const objectName = `${folder}/${Date.now()}-${createId(8)}-${safeName}`;
  if (supabase) {
    const { error } = await supabase.storage.from(BUCKET).upload(objectName, file.buffer, {
      contentType: file.mimetype,
      upsert: false,
    });
    if (error) throw error;
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(objectName);
    return data.publicUrl;
  }

  const target = path.join(UPLOAD_DIR, objectName);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, file.buffer);
  return `/uploads/${objectName.replaceAll("\\", "/")}`;
}

app.get("/", (req, res) => {
  if (hasStoreAccess(req)) return res.redirect("/store");
  res.sendFile(path.join(PUBLIC_DIR, "login.html"));
});

app.get("/store", (req, res) => {
  if (!hasStoreAccess(req)) return res.redirect("/");
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/admin", (req, res) => {
  if (!hasAdminAccess(req)) return res.sendFile(path.join(PUBLIC_DIR, "admin-login.html"));
  res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
});

app.post("/api/access", (req, res) => {
  if (req.body.code !== SITE_ACCESS_CODE) return res.status(403).json({ error: "Falscher Zugangscode." });
  res.cookie("ehoser_access", "granted", { httpOnly: true, sameSite: "lax", maxAge: 1000 * 60 * 60 * 24 * 14 });
  res.json({ ok: true });
});

app.post("/api/admin/access", (req, res) => {
  if (req.body.code !== ADMIN_ACCESS_CODE) return res.status(403).json({ error: "Falscher Admin-Code." });
  res.cookie("ehoser_admin", "granted", { httpOnly: true, sameSite: "lax", maxAge: 1000 * 60 * 60 * 12 });
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("ehoser_access");
  res.clearCookie("ehoser_admin");
  res.json({ ok: true });
});

app.get("/api/games", requireStore, async (req, res, next) => {
  try {
    const games = await listGames();
    res.json(games.map(publicGame));
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/games", requireAdmin, async (req, res, next) => {
  try {
    res.json(await listGames());
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/games", requireAdmin, async (req, res, next) => {
  try {
    const payload = {
      ...req.body,
      image_urls: typeof req.body.image_urls === "string" ? req.body.image_urls.split("\n") : req.body.image_urls,
    };
    res.json(await saveGame(payload));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/admin/games/:id", requireAdmin, async (req, res, next) => {
  try {
    await deleteGame(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/upload", requireAdmin, upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Keine Datei erhalten." });
    const type = req.body.type || "misc";
    const url = await uploadFile(req.file, type);
    res.json({ url });
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.message || "Serverfehler" });
});

async function startLocalServer() {
  await ensureLocalStore();
  app.listen(PORT, () => {
    console.log(`Ehoser server running on http://localhost:${PORT}`);
    console.log(supabase ? "Supabase mode enabled." : "Local fallback mode enabled.");
  });
}

if (require.main === module) {
  startLocalServer();
}

module.exports = app;
