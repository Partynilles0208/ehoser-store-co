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
const RELEASE_TIME_ZONE = "Europe/Berlin";
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;

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
    download_url: isReleased && game.download_url ? `/api/games/${encodeURIComponent(game.id)}/download` : "",
    download_count: Number(game.download_count || 0),
    is_released: isReleased,
    release_label: releaseAt ? releaseAt.toLocaleString("de-DE", { timeZone: RELEASE_TIME_ZONE, dateStyle: "short", timeStyle: "short" }) : "Jetzt verfuegbar",
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
        download_count: 0,
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
        download_count: 0,
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

async function getGame(id) {
  if (supabase) {
    const { data, error } = await supabase.from("games").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return data;
  }

  const games = await readLocalGames();
  return games.find((game) => game.id === id) || null;
}

async function saveGame(payload) {
  const now = new Date().toISOString();
  const existingGame = payload.id ? await getGame(payload.id) : null;
  if (!payload.download_url && !payload.release_at) {
    const error = new Error("Wenn keine EXE/ZIP hinterlegt ist, muss ein Veroeffentlichungsdatum gesetzt werden.");
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
  if (payload.download_count !== undefined) {
    game.download_count = Math.max(0, Number(payload.download_count) || 0);
  } else {
    game.download_count = Math.max(0, Number(existingGame?.download_count || 0));
  }

  if (supabase) {
    const { data, error } = await supabase.from("games").upsert(game).select().single();
    if (error) throw error;
    return data;
  }

  const games = await readLocalGames();
  const index = games.findIndex((item) => item.id === game.id);
  let savedGame = game;
  if (index >= 0) {
    games[index] = { ...games[index], ...game };
    savedGame = games[index];
  } else {
    games.unshift(game);
  }
  await writeLocalGames(games);
  return savedGame;
}

async function incrementDownloadCount(id) {
  if (supabase) {
    const game = await getGame(id);
    if (!game) return;
    const nextCount = Math.max(0, Number(game.download_count || 0)) + 1;
    const { error } = await supabase.from("games").update({ download_count: nextCount }).eq("id", id);
    if (error) throw error;
    return;
  }

  const games = await readLocalGames();
  const index = games.findIndex((game) => game.id === id);
  if (index < 0) return;
  games[index].download_count = Math.max(0, Number(games[index].download_count || 0)) + 1;
  await writeLocalGames(games);
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

function findZipEndOfCentralDirectory(buffer) {
  const minRecordSize = 22;
  const maxCommentSize = 0xffff;
  const start = Math.max(0, buffer.length - minRecordSize - maxCommentSize);

  for (let offset = buffer.length - minRecordSize; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) return offset;
  }

  return -1;
}

function zipContainsExecutable(buffer) {
  const eocdOffset = findZipEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) return false;

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  if (centralDirectoryOffset < 0 || centralDirectoryEnd > buffer.length) return false;

  let offset = centralDirectoryOffset;
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    if (offset + 46 > centralDirectoryEnd) return false;
    if (buffer.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) return false;

    const flags = buffer.readUInt16LE(offset + 8);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > centralDirectoryEnd) return false;

    const encoding = flags & 0x0800 ? "utf8" : "latin1";
    const entryName = buffer.toString(encoding, nameStart, nameEnd).replaceAll("\\", "/");
    const fileName = entryName.split("/").pop() || "";
    if (fileName.toLowerCase().endsWith(".exe")) return true;

    offset = nameEnd + extraLength + commentLength;
  }

  return false;
}

function validateExecutableUpload(file) {
  const extension = path.extname(file.originalname || "").toLowerCase();

  if (extension === ".exe") return "";
  if (extension === ".zip") {
    return zipContainsExecutable(file.buffer) ? "" : "ZIP-Dateien muessen mindestens eine EXE-Datei enthalten.";
  }

  return "Bitte lade eine .exe-Datei oder eine .zip-Datei mit enthaltener EXE hoch.";
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

app.get("/api/games/:id/download", requireStore, async (req, res, next) => {
  try {
    const game = await getGame(req.params.id);
    if (!game) return res.status(404).json({ error: "Spiel nicht gefunden." });

    const releaseAt = game.release_at ? new Date(game.release_at) : null;
    const isReleased = !releaseAt || releaseAt <= new Date();
    if (!isReleased || !game.download_url) {
      return res.status(403).json({ error: "Download ist noch nicht verfuegbar." });
    }

    await incrementDownloadCount(game.id);
    res.redirect(game.download_url);
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
    if (type === "executables") {
      const uploadError = validateExecutableUpload(req.file);
      if (uploadError) return res.status(400).json({ error: uploadError });
    }
    const url = await uploadFile(req.file, type);
    res.json({ url });
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  if (error.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      error: "Datei ist zu gross. Lade grosse EXE/ZIP-Dateien extern hoch und trage den Link bei EXE/ZIP Download URL ein.",
    });
  }
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
