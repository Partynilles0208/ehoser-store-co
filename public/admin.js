const form = document.getElementById("gameForm");
const message = document.getElementById("adminMessage");
const list = document.getElementById("adminGames");

const fields = {
  id: document.getElementById("gameId"),
  title: document.getElementById("title"),
  description: document.getElementById("description"),
  releaseAt: document.getElementById("releaseAt"),
  iconUrl: document.getElementById("iconUrl"),
  trailerUrl: document.getElementById("trailerUrl"),
  imageUrls: document.getElementById("imageUrls"),
  downloadUrl: document.getElementById("downloadUrl"),
};

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setMessage(text, ok = true) {
  message.textContent = text;
  message.classList.toggle("error", !ok);
}

function localDateValue(value) {
  if (!value) return "";
  const date = new Date(value);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

async function uploadOne(input, type) {
  if (!input.files?.[0]) return "";
  const body = new FormData();
  body.append("type", type);
  body.append("file", input.files[0]);
  const response = await fetch("/api/admin/upload", { method: "POST", body });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Upload fehlgeschlagen");
  return data.url;
}

async function uploadMany(input, type) {
  const urls = [];
  for (const file of input.files || []) {
    const body = new FormData();
    body.append("type", type);
    body.append("file", file);
    const response = await fetch("/api/admin/upload", { method: "POST", body });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Upload fehlgeschlagen");
    urls.push(data.url);
  }
  return urls;
}

function fillForm(game) {
  fields.id.value = game.id || "";
  fields.title.value = game.title || "";
  fields.description.value = game.description || "";
  fields.releaseAt.value = localDateValue(game.release_at);
  fields.iconUrl.value = game.icon_url || "";
  fields.trailerUrl.value = game.trailer_url || "";
  fields.imageUrls.value = (game.image_urls || []).join("\n");
  fields.downloadUrl.value = game.download_url || "";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetForm() {
  form.reset();
  fields.id.value = "";
  setMessage("");
}

function renderAdminGames(games) {
  list.innerHTML = games
    .map(
      (game) => `
        <article class="admin-row">
          <img src="${game.icon_url || "/assets/placeholder-neon.svg"}" alt="" />
          <div>
            <h3>${escapeHtml(game.title)}</h3>
            <p>${escapeHtml(game.release_at ? new Date(game.release_at).toLocaleString("de-DE") : "Sofort sichtbar")} · ${game.download_url ? "EXE hinterlegt" : "Keine EXE"}</p>
          </div>
          <button data-edit="${game.id}" class="secondary">Bearbeiten</button>
          <button data-delete="${game.id}" class="danger">Loeschen</button>
        </article>
      `
    )
    .join("");

  document.querySelectorAll("[data-edit]").forEach((button) => {
    button.addEventListener("click", () => fillForm(games.find((game) => game.id === button.dataset.edit)));
  });

  document.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm("Spiel wirklich loeschen?")) return;
      await fetch(`/api/admin/games/${button.dataset.delete}`, { method: "DELETE" });
      await loadAdminGames();
    });
  });
}

async function loadAdminGames() {
  const response = await fetch("/api/admin/games");
  if (!response.ok) {
    window.location.href = "/admin";
    return;
  }
  renderAdminGames(await response.json());
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage("Uploads werden verarbeitet...");
  try {
    const icon = await uploadOne(document.getElementById("iconFile"), "icons");
    const trailer = await uploadOne(document.getElementById("trailerFile"), "trailers");
    const exe = await uploadOne(document.getElementById("exeFile"), "executables");
    const images = await uploadMany(document.getElementById("imageFiles"), "screenshots");

    const existingImages = fields.imageUrls.value.split("\n").map((url) => url.trim()).filter(Boolean);
    const payload = {
      id: fields.id.value || undefined,
      title: fields.title.value,
      description: fields.description.value,
      release_at: fields.releaseAt.value ? new Date(fields.releaseAt.value).toISOString() : null,
      icon_url: icon || fields.iconUrl.value,
      trailer_url: trailer || fields.trailerUrl.value,
      image_urls: [...existingImages, ...images],
      download_url: exe || fields.downloadUrl.value,
    };

    const response = await fetch("/api/admin/games", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Speichern fehlgeschlagen");
    fillForm(data);
    setMessage("Gespeichert.");
    await loadAdminGames();
  } catch (error) {
    setMessage(error.message, false);
  }
});

document.getElementById("resetForm").addEventListener("click", resetForm);
loadAdminGames();
