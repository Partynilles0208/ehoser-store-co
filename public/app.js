const gamesEl = document.getElementById("games");
const downloadsEl = document.getElementById("downloadGrid");
const RELEASE_TIME_ZONE = "Europe/Berlin";
let countdownTimer = null;
let nextReleaseRefreshAt = 0;
let releaseRefreshTimer = null;

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function releaseText(game) {
  const releaseAt = releaseDate(game);
  if (game.is_released && game.download_url) return "Download bereit";
  if (game.is_released) return "Noch kein Download";
  if (releaseAt) return `Erscheint am ${formatReleaseDate(releaseAt)}`;
  if (game.release_label) return `Erscheint am ${game.release_label}`;
  return "Noch kein Download";
}

function releaseDate(game) {
  if (!game.release_at) return null;
  const date = new Date(game.release_at);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatReleaseDate(date) {
  return `${date.toLocaleString("de-DE", {
    timeZone: RELEASE_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })} Uhr`;
}

function formatCountdown(diffMs) {
  const totalSeconds = Math.max(0, Math.floor(diffMs / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const clock = [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
  return days > 0 ? `${days} ${days === 1 ? "Tag" : "Tage"} ${clock}` : clock;
}

function countdownText(date) {
  const diff = date.getTime() - Date.now();
  if (diff <= 0) return "";
  return formatCountdown(diff);
}

function releaseInfo(game, compact = false) {
  const date = releaseDate(game);
  if (!game.is_released && date && date.getTime() <= Date.now()) return "";

  const countdown = !game.is_released && date
    ? `<span class="countdown-pill" data-release-at="${escapeHtml(date.toISOString())}">Countdown: ${escapeHtml(countdownText(date))}</span>`
    : "";

  return `
    <div class="release-meta${compact ? " compact" : ""}">
      <span class="status-pill">${escapeHtml(releaseText(game))}</span>
      ${countdown}
    </div>
  `;
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
            ${releaseInfo(game)}
          </div>
        </article>
      `
    )
    .join("");

  downloadsEl.innerHTML = games
    .map((game) => {
      const canDownload = game.is_released && game.download_url;
      return `
        <article class="download-tile ${canDownload ? "is-ready" : "is-locked"}" ${canDownload ? `data-url="${escapeHtml(game.download_url)}" role="button" tabindex="0" aria-label="${escapeHtml(game.title)} herunterladen"` : ""}>
          <span class="download-icon" title="${escapeHtml(game.title)}">
            <img src="${game.icon_url || "/assets/placeholder-orbit.svg"}" alt="${escapeHtml(game.title)}" />
          </span>
          <div>
            <h3>${escapeHtml(game.title)}</h3>
            ${canDownload ? "<p>Klicken zum Herunterladen</p>" : releaseInfo(game, true)}
          </div>
        </article>
      `;
    })
    .join("");

  document.querySelectorAll(".download-tile[data-url]").forEach((tile) => {
    tile.addEventListener("click", () => {
      window.location.href = tile.dataset.url;
    });
    tile.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      window.location.href = tile.dataset.url;
    });
  });

  if (games.some((game) => !game.is_released && releaseDate(game)?.getTime() <= Date.now())) {
    scheduleReleaseRefresh(800);
  }

  startCountdowns();
}

function scheduleReleaseRefresh(delay = 0) {
  if (releaseRefreshTimer) return;
  const waitMs = Math.max(delay, nextReleaseRefreshAt - Date.now(), 0);
  releaseRefreshTimer = setTimeout(() => {
    releaseRefreshTimer = null;
    nextReleaseRefreshAt = Date.now() + 2000;
    loadGames();
  }, waitMs);
}

function updateCountdowns() {
  const nodes = document.querySelectorAll("[data-release-at]");
  let hasActiveCountdown = false;
  let hasExpiredCountdown = false;

  nodes.forEach((node) => {
    const date = new Date(node.dataset.releaseAt);
    if (Number.isNaN(date.getTime())) return;

    const diff = date.getTime() - Date.now();
    hasActiveCountdown = hasActiveCountdown || diff > 0;
    hasExpiredCountdown = hasExpiredCountdown || diff <= 0;
    if (diff <= 0) {
      node.closest(".release-meta")?.remove();
      return;
    }
    node.textContent = `Countdown: ${formatCountdown(diff)}`;
  });

  if (hasExpiredCountdown) scheduleReleaseRefresh();

  if (!hasActiveCountdown && countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function startCountdowns() {
  if (countdownTimer) clearInterval(countdownTimer);
  updateCountdowns();

  if (document.querySelector("[data-release-at]")) {
    countdownTimer = setInterval(updateCountdowns, 1000);
  }
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
  const text = await response.text();
  let data = [];
  try {
    data = JSON.parse(text);
  } catch {
    gamesEl.innerHTML = `
      <article class="game-card error-card">
        <div class="game-content">
          <h3>Spiele konnten nicht geladen werden</h3>
          <p>${escapeHtml(text || "Ungueltige Serverantwort.")}</p>
        </div>
      </article>
    `;
    downloadsEl.innerHTML = "";
    return;
  }
  renderGames(data);
}

loadGames();
