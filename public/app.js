const gamesEl = document.getElementById("games");
const downloadsEl = document.getElementById("downloadGrid");

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function releaseText(game) {
  if (game.is_released && game.download_url) return "Download bereit";
  if (game.release_label) return `Erscheint am ${game.release_label}`;
  return "Noch kein Download";
}

function mediaFor(game) {
  if (game.trailer_url) {
    return `<video controls preload="metadata" poster="${game.image_urls?.[0] || game.icon_url || "/assets/hero-art.svg"}"><source src="${game.trailer_url}" /></video>`;
  }
    return `<img src="${game.image_urls?.[0] || game.icon_url || "/assets/hero-art.svg"}" alt="${escapeHtml(game.title)}" />`;
}

function renderGames(games) {
  gamesEl.innerHTML = games
    .map(
      (game) => `
        <article class="game-card">
          <div class="game-media">${mediaFor(game)}</div>
          <div class="game-content">
            <div class="game-title-row">
              <img class="game-icon" src="${game.icon_url || "/assets/placeholder-neon.svg"}" alt="" />
              <h3>${escapeHtml(game.title)}</h3>
            </div>
            <p>${escapeHtml(game.description || "Noch keine Beschreibung vorhanden.")}</p>
            <span class="status-pill">${escapeHtml(releaseText(game))}</span>
          </div>
        </article>
      `
    )
    .join("");

  downloadsEl.innerHTML = games
    .map((game) => {
      const canDownload = game.is_released && game.download_url;
      return `
        <article class="download-tile">
          <button class="download-icon" ${canDownload ? `data-url="${escapeHtml(game.download_url)}"` : "disabled"} title="${escapeHtml(game.title)}">
            <img src="${game.icon_url || "/assets/placeholder-orbit.svg"}" alt="${escapeHtml(game.title)}" />
          </button>
          <div>
            <h3>${escapeHtml(game.title)}</h3>
            <p>${escapeHtml(canDownload ? "Klicken zum Herunterladen" : releaseText(game))}</p>
          </div>
        </article>
      `;
    })
    .join("");

  document.querySelectorAll(".download-icon[data-url]").forEach((button) => {
    button.addEventListener("click", () => {
      window.location.href = button.dataset.url;
    });
  });
}

async function loadGames() {
  const response = await fetch("/api/games");
  if (response.status === 401) {
    window.location.href = "/";
    return;
  }
  if (!response.ok) {
    gamesEl.innerHTML = `
      <article class="game-card error-card">
        <div class="game-content">
          <h3>Spiele konnten nicht geladen werden</h3>
          <p>Bitte pruefe in Supabase, ob die Tabelle aus <code>supabase/schema.sql</code> angelegt ist.</p>
        </div>
      </article>
    `;
    downloadsEl.innerHTML = "";
    return;
  }
  renderGames(await response.json());
}

loadGames();
