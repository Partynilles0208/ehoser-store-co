const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
const imgCanvas = document.createElement("canvas");
const imgCtx = imgCanvas.getContext("2d", { willReadFrequently: true });
const originalCanvas = document.createElement("canvas");
const originalCtx = originalCanvas.getContext("2d", { willReadFrequently: true });

const fileInput = document.getElementById("fileInput");
const resetBtn = document.getElementById("resetBtn");
const saveBtn = document.getElementById("saveBtn");
const strengthInput = document.getElementById("strength");
const sizeInput = document.getElementById("size");
const softnessInput = document.getElementById("softness");
const strengthValue = document.getElementById("strengthValue");
const sizeValue = document.getElementById("sizeValue");
const softnessValue = document.getElementById("softnessValue");
const placeholder = document.getElementById("placeholder");
const brush = document.getElementById("brush");
const canvasFrame = document.getElementById("canvasFrame");
const cameraBtn = document.getElementById("cameraBtn");
const captureBtn = document.getElementById("captureBtn");
const cameraVideo = document.getElementById("camera");
const cameraPreview = document.getElementById("cameraPreview");
const cameraHint = document.getElementById("cameraHint");
const modeButtons = document.querySelectorAll("[data-mode]");
const pixabayQuery = document.getElementById("pixabayQuery");
const pixabaySearchBtn = document.getElementById("pixabaySearchBtn");
const pixabayResults = document.getElementById("pixabayResults");
const pixabayUseBtn = document.getElementById("pixabayUseBtn");
const pixabayStatus = document.getElementById("pixabayStatus");
const undoBtn = document.getElementById("undoBtn");
const redoBtn = document.getElementById("redoBtn");
const exportFormatSelect = document.getElementById("exportFormat");
const exportQualityWrap = document.getElementById("exportQualityWrap");
const exportQualityInput = document.getElementById("exportQuality");
const exportQualityValue = document.getElementById("exportQualityValue");
const flipHBtn = document.getElementById("flipHBtn");
const flipVBtn = document.getElementById("flipVBtn");

let strength = parseFloat(strengthInput.value);
let radius = parseInt(sizeInput.value, 10);
let softness = parseFloat(softnessInput.value);
let hasImage = false;
let dragging = false;
let lastPos = null;
let mode = "push";
let cameraStream = null;
let selectedPixabay = null;
let selectedPixabayCard = null;
let originalImgData = null;
let historyStack = [];
let redoStack = [];

const PIXABAY_KEY = "50190970-65ec83f509b70f19f8665f4a1";
const PIXABAY_ENDPOINT = "https://pixabay.com/api/";
const FLY_REPEAT = 6;

function updateSliderValues() {
  strengthValue.textContent = strength.toFixed(2);
  sizeValue.textContent = `${radius} px`;
  softnessValue.textContent = softness.toFixed(1);
  updateBrushSize();
}

function setHasImage(value) {
  hasImage = value;
  placeholder.classList.toggle("is-hidden", value);
  canvasFrame.classList.toggle("has-image", value);
  resetBtn.disabled = !value;
  saveBtn.disabled = !value;
  if (flipHBtn) flipHBtn.disabled = !value;
  if (flipVBtn) flipVBtn.disabled = !value;
}

function saveHistory() {
  const snapshot = imgCtx.getImageData(0, 0, imgCanvas.width, imgCanvas.height);
  historyStack.push(snapshot);
  if (historyStack.length > 30) historyStack.shift();
  redoStack = [];
  syncHistoryButtons();
}

function undo() {
  if (!historyStack.length) return;
  const current = imgCtx.getImageData(0, 0, imgCanvas.width, imgCanvas.height);
  redoStack.push(current);
  const prev = historyStack.pop();
  imgCtx.putImageData(prev, 0, 0);
  drawToScreen();
  syncHistoryButtons();
}

function redo() {
  if (!redoStack.length) return;
  const current = imgCtx.getImageData(0, 0, imgCanvas.width, imgCanvas.height);
  historyStack.push(current);
  const next = redoStack.pop();
  imgCtx.putImageData(next, 0, 0);
  drawToScreen();
  syncHistoryButtons();
}

function syncHistoryButtons() {
  if (undoBtn) undoBtn.disabled = !historyStack.length;
  if (redoBtn) redoBtn.disabled = !redoStack.length;
}

function updateBrushSize() {
  if (!hasImage) return;
  const rect = canvas.getBoundingClientRect();
  const scale = rect.width / canvas.width;
  const cssRadius = radius * scale;
  brush.style.width = `${cssRadius * 2}px`;
  brush.style.height = `${cssRadius * 2}px`;
}

function updateBrushPosition(cssX, cssY, visible) {
  if (!hasImage) return;
  if (visible) {
    brush.style.opacity = "1";
  }
  brush.style.left = `${cssX}px`;
  brush.style.top = `${cssY}px`;
}

function hideBrush() {
  brush.style.opacity = "0";
}

function getPointerPos(event) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (event.clientX - rect.left) * scaleX;
  const y = (event.clientY - rect.top) * scaleY;
  return {
    x,
    y,
    cssX: event.clientX - rect.left,
    cssY: event.clientY - rect.top,
  };
}

function drawToScreen() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(imgCanvas, 0, 0);
}

function setCanvasSize(width, height) {
  canvas.width = width;
  canvas.height = height;
  imgCanvas.width = width;
  imgCanvas.height = height;
  originalCanvas.width = width;
  originalCanvas.height = height;
}

function drawLoadedImage(img) {
  const targetWidth = img.naturalWidth || img.width;
  const targetHeight = img.naturalHeight || img.height;
  setCanvasSize(targetWidth, targetHeight);
  originalCtx.clearRect(0, 0, targetWidth, targetHeight);
  imgCtx.clearRect(0, 0, targetWidth, targetHeight);
  originalCtx.drawImage(img, 0, 0, targetWidth, targetHeight);
  imgCtx.drawImage(img, 0, 0, targetWidth, targetHeight);
  originalImgData = originalCtx.getImageData(0, 0, targetWidth, targetHeight);
  historyStack = [];
  redoStack = [];
  syncHistoryButtons();
  drawToScreen();
  setHasImage(true);
  updateBrushSize();
}

function loadImageFromFile(file) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    drawLoadedImage(img);
    URL.revokeObjectURL(url);
    fileInput.value = "";
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

function loadImageFromUrl(url) {
  if (!url) return;
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    drawLoadedImage(img);
    setPixabayStatus("Bild geladen.");
  };
  img.onerror = () => {
    setPixabayStatus("Bild konnte nicht geladen werden.");
  };
  img.src = url;
}

function resetImage() {
  if (!hasImage) return;
  imgCtx.clearRect(0, 0, imgCanvas.width, imgCanvas.height);
  imgCtx.drawImage(originalCanvas, 0, 0);
  drawToScreen();
}

function exportImage() {
  if (!hasImage) return;
  const format = exportFormatSelect ? exportFormatSelect.value : "image/png";
  const quality = exportQualityInput ? parseFloat(exportQualityInput.value) : 0.92;
  const ext = format === "image/jpeg" ? "jpg" : "png";
  const link = document.createElement("a");
  link.download = `face-warp.${ext}`;
  link.href = imgCanvas.toDataURL(format, quality);
  link.click();
}

function flipImage(horizontal) {
  if (!hasImage) return;
  saveHistory();
  const width = imgCanvas.width;
  const height = imgCanvas.height;
  const tmp = document.createElement("canvas");
  tmp.width = width;
  tmp.height = height;
  const tmpCtx = tmp.getContext("2d");
  tmpCtx.save();
  if (horizontal) {
    tmpCtx.translate(width, 0);
    tmpCtx.scale(-1, 1);
  } else {
    tmpCtx.translate(0, height);
    tmpCtx.scale(1, -1);
  }
  tmpCtx.drawImage(imgCanvas, 0, 0);
  tmpCtx.restore();
  imgCtx.clearRect(0, 0, width, height);
  imgCtx.drawImage(tmp, 0, 0);
  drawToScreen();
}

function setPixabayStatus(text) {
  if (!pixabayStatus) return;
  pixabayStatus.textContent = text;
}

function getPixabayKey() {
  if (PIXABAY_KEY && PIXABAY_KEY !== "PASTE_YOUR_PIXABAY_KEY") {
    return PIXABAY_KEY;
  }
  return "";
}

function renderPixabayResults(hits) {
  pixabayResults.innerHTML = "";
  selectedPixabay = null;
  selectedPixabayCard = null;
  pixabayUseBtn.disabled = true;

  if (!hits.length) {
    setPixabayStatus("Keine Treffer.");
    return;
  }

  setPixabayStatus(`${hits.length} Treffer`);

  hits.forEach((hit) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "result-card";

    const img = document.createElement("img");
    img.alt = hit.tags || "Pixabay Bild";
    img.loading = "lazy";
    img.src = hit.webformatURL || hit.previewURL;

    button.appendChild(img);
    button.addEventListener("click", () => {
      if (selectedPixabayCard) {
        selectedPixabayCard.classList.remove("selected");
      }
      button.classList.add("selected");
      selectedPixabayCard = button;
      selectedPixabay = hit;
      pixabayUseBtn.disabled = false;
      setPixabayStatus(`Ausgewaehlt: ${hit.tags || "Bild"}`);
    });

    pixabayResults.appendChild(button);
  });
}

async function searchPixabay(query) {
  const key = getPixabayKey();
  if (!key) {
    setPixabayStatus("Pixabay API-Key fehlt. Bitte in app.js setzen.");
    return;
  }
  if (!query) {
    setPixabayStatus("Bitte Suchwort eingeben.");
    return;
  }

  setPixabayStatus("Suche...");
  pixabayResults.innerHTML = "";
  selectedPixabay = null;
  pixabayUseBtn.disabled = true;

  try {
    const params = new URLSearchParams({
      key,
      q: query,
      image_type: "photo",
      safesearch: "true",
      per_page: "18",
    });
    const response = await fetch(`${PIXABAY_ENDPOINT}?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    renderPixabayResults(Array.isArray(data.hits) ? data.hits : []);
  } catch (error) {
    setPixabayStatus("Fehler bei der Suche.");
  }
}

function applyStroke(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(dist / (radius * 0.35)));
  const stepX = dx / steps;
  const stepY = dy / steps;

  for (let i = 1; i <= steps; i += 1) {
    const x = from.x + stepX * i;
    const y = from.y + stepY * i;
    warpAt(x, y, stepX, stepY);
  }
}

function warpAt(centerX, centerY, deltaX, deltaY) {
  const width = imgCanvas.width;
  const height = imgCanvas.height;
  if (width === 0 || height === 0) return;

  const left = Math.max(0, Math.floor(centerX - radius));
  const top = Math.max(0, Math.floor(centerY - radius));
  const right = Math.min(width, Math.ceil(centerX + radius));
  const bottom = Math.min(height, Math.ceil(centerY + radius));
  const boxWidth = right - left;
  const boxHeight = bottom - top;
  if (boxWidth <= 0 || boxHeight <= 0) return;

  const src = imgCtx.getImageData(0, 0, width, height);
  const srcData = src.data;
  const out = imgCtx.createImageData(boxWidth, boxHeight);
  const outData = out.data;

  const radiusSquared = radius * radius;

  const origData = originalImgData ? originalImgData.data : srcData;

  for (let y = 0; y < boxHeight; y += 1) {
    const gy = top + y;
    for (let x = 0; x < boxWidth; x += 1) {
      const gx = left + x;
      const dx = gx - centerX;
      const dy = gy - centerY;
      const distSquared = dx * dx + dy * dy;
      const outIndex = (y * boxWidth + x) * 4;
      const srcIdx = (gy * width + gx) * 4;

      // smooth and reconstruct modes bypass the sample-position approach
      if (distSquared < radiusSquared && (mode === "smooth" || mode === "reconstruct")) {
        const dist = Math.sqrt(distSquared);
        const falloff = 1 - dist / radius;
        const influence = Math.pow(falloff, softness);
        const t = Math.min(1, strength * influence);

        if (mode === "smooth") {
          const kr = Math.max(1, Math.round(3 * influence));
          let rs = 0, gs = 0, bs = 0, as_ = 0, cnt = 0;
          for (let ky = -kr; ky <= kr; ky += 1) {
            for (let kx = -kr; kx <= kr; kx += 1) {
              const nx = Math.max(0, Math.min(width - 1, gx + kx));
              const ny = Math.max(0, Math.min(height - 1, gy + ky));
              const ni = (ny * width + nx) * 4;
              rs += srcData[ni]; gs += srcData[ni + 1]; bs += srcData[ni + 2]; as_ += srcData[ni + 3];
              cnt += 1;
            }
          }
          outData[outIndex]     = srcData[srcIdx]     * (1 - t) + (rs / cnt) * t;
          outData[outIndex + 1] = srcData[srcIdx + 1] * (1 - t) + (gs / cnt) * t;
          outData[outIndex + 2] = srcData[srcIdx + 2] * (1 - t) + (bs / cnt) * t;
          outData[outIndex + 3] = srcData[srcIdx + 3] * (1 - t) + (as_ / cnt) * t;
        } else {
          outData[outIndex]     = srcData[srcIdx]     * (1 - t) + origData[srcIdx]     * t;
          outData[outIndex + 1] = srcData[srcIdx + 1] * (1 - t) + origData[srcIdx + 1] * t;
          outData[outIndex + 2] = srcData[srcIdx + 2] * (1 - t) + origData[srcIdx + 2] * t;
          outData[outIndex + 3] = srcData[srcIdx + 3] * (1 - t) + origData[srcIdx + 3] * t;
        }
        continue;
      }

      let sampleX = gx;
      let sampleY = gy;

      if (distSquared < radiusSquared) {
        const dist = Math.sqrt(distSquared);
        const falloff = 1 - dist / radius;
        const influence = Math.pow(falloff, softness);

        if (mode === "push") {
          sampleX = gx - deltaX * strength * influence;
          sampleY = gy - deltaY * strength * influence;
        } else if (mode === "bulge") {
          const factor = Math.max(0.2, 1 - strength * influence);
          sampleX = centerX + dx * factor;
          sampleY = centerY + dy * factor;
        } else if (mode === "pinch") {
          const factor = 1 + strength * influence;
          sampleX = centerX + dx * factor;
          sampleY = centerY + dy * factor;
        } else if (mode === "twirl") {
          const spin = deltaX + deltaY;
          const direction = spin === 0 ? 1 : Math.sign(spin);
          const angle = direction * strength * influence * 1.2;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          sampleX = centerX + dx * cos - dy * sin;
          sampleY = centerY + dx * sin + dy * cos;
        }

        if (sampleX < 0) sampleX = 0;
        if (sampleY < 0) sampleY = 0;
        if (sampleX > width - 1) sampleX = width - 1;
        if (sampleY > height - 1) sampleY = height - 1;
      }

      const x0 = Math.floor(sampleX);
      const y0 = Math.floor(sampleY);
      const x1 = Math.min(x0 + 1, width - 1);
      const y1 = Math.min(y0 + 1, height - 1);
      const tx = sampleX - x0;
      const ty = sampleY - y0;

      const idx00 = (y0 * width + x0) * 4;
      const idx10 = (y0 * width + x1) * 4;
      const idx01 = (y1 * width + x0) * 4;
      const idx11 = (y1 * width + x1) * 4;

      for (let c = 0; c < 4; c += 1) {
        const v0 = srcData[idx00 + c] * (1 - tx) + srcData[idx10 + c] * tx;
        const v1 = srcData[idx01 + c] * (1 - tx) + srcData[idx11 + c] * tx;
        outData[outIndex + c] = v0 * (1 - ty) + v1 * ty;
      }
    }
  }

  imgCtx.putImageData(out, left, top);
  drawToScreen();
}

strengthInput.addEventListener("input", () => {
  strength = parseFloat(strengthInput.value);
  updateSliderValues();
});

sizeInput.addEventListener("input", () => {
  radius = parseInt(sizeInput.value, 10);
  updateSliderValues();
});

softnessInput.addEventListener("input", () => {
  softness = parseFloat(softnessInput.value);
  updateSliderValues();
});

fileInput.addEventListener("change", (event) => {
  const file = event.target.files && event.target.files[0];
  loadImageFromFile(file);
});

resetBtn.addEventListener("click", resetImage);
saveBtn.addEventListener("click", exportImage);

pixabaySearchBtn.addEventListener("click", () => {
  const query = pixabayQuery.value.trim();
  searchPixabay(query);
});

pixabayQuery.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    const query = pixabayQuery.value.trim();
    searchPixabay(query);
  }
});

pixabayUseBtn.addEventListener("click", () => {
  if (!selectedPixabay) return;
  const url = selectedPixabay.largeImageURL || selectedPixabay.webformatURL;
  setPixabayStatus("Bild wird geladen...");
  loadImageFromUrl(url);
});

canvas.addEventListener("pointerdown", (event) => {
  if (!hasImage) return;
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  saveHistory();
  dragging = true;
  lastPos = getPointerPos(event);
  updateBrushPosition(lastPos.cssX, lastPos.cssY, true);
  if (mode !== "push") {
    warpAt(lastPos.x, lastPos.y, 0, 0);
  }
});

canvas.addEventListener("pointermove", (event) => {
  if (!hasImage) return;
  const pos = getPointerPos(event);
  updateBrushPosition(pos.cssX, pos.cssY, true);
  if (!dragging) return;
  if (!lastPos) {
    lastPos = pos;
    return;
  }
  applyStroke(lastPos, pos);
  lastPos = pos;
});

canvas.addEventListener("pointerup", (event) => {
  if (!hasImage) return;
  dragging = false;
  lastPos = null;
  canvas.releasePointerCapture(event.pointerId);
});

canvas.addEventListener("pointerleave", () => {
  if (!hasImage) return;
  hideBrush();
});

canvas.addEventListener("pointerenter", (event) => {
  if (!hasImage) return;
  updateBrushSize();
  const pos = getPointerPos(event);
  updateBrushPosition(pos.cssX, pos.cssY, true);
});

canvas.addEventListener("pointercancel", () => {
  dragging = false;
  lastPos = null;
  hideBrush();
});

canvasFrame.addEventListener("dragover", (event) => {
  event.preventDefault();
  canvasFrame.classList.add("drag");
});

canvasFrame.addEventListener("dragleave", () => {
  canvasFrame.classList.remove("drag");
});

canvasFrame.addEventListener("drop", (event) => {
  event.preventDefault();
  canvasFrame.classList.remove("drag");
  const file = event.dataTransfer.files && event.dataTransfer.files[0];
  loadImageFromFile(file);
});

window.addEventListener("resize", updateBrushSize);

modeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    modeButtons.forEach((btn) => btn.classList.remove("active"));
    button.classList.add("active");
    mode = button.dataset.mode || "push";
  });
});

cameraBtn.addEventListener("click", async () => {
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    cameraVideo.srcObject = null;
    cameraPreview.classList.remove("active");
    cameraHint.textContent = "Kamera aus";
    cameraBtn.textContent = "Kamera starten";
    captureBtn.disabled = true;
    return;
  }

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user" },
      audio: false,
    });
    cameraVideo.srcObject = cameraStream;
    await cameraVideo.play();
    cameraPreview.classList.add("active");
    cameraHint.textContent = "Live";
    cameraBtn.textContent = "Kamera stoppen";
    captureBtn.disabled = false;
  } catch (error) {
    cameraHint.textContent = "Keine Kamera";
  }
});

captureBtn.addEventListener("click", () => {
  if (!cameraStream) return;
  const width = cameraVideo.videoWidth;
  const height = cameraVideo.videoHeight;
  if (!width || !height) return;
  setCanvasSize(width, height);
  originalCtx.clearRect(0, 0, width, height);
  imgCtx.clearRect(0, 0, width, height);
  originalCtx.drawImage(cameraVideo, 0, 0, width, height);
  imgCtx.drawImage(cameraVideo, 0, 0, width, height);
  originalImgData = originalCtx.getImageData(0, 0, width, height);
  historyStack = [];
  redoStack = [];
  syncHistoryButtons();
  drawToScreen();
  setHasImage(true);
  updateBrushSize();
});

function initFlyText() {
  const tracks = document.querySelectorAll(".fly-track");
  tracks.forEach((track) => {
    const text = track.dataset.text || "WARP 2.0";
    let html = "";
    for (let r = 0; r < FLY_REPEAT; r += 1) {
      for (const char of text) {
        if (char === " ") {
          html += '<span class="fly-gap"></span>';
        } else {
          html += `<span>${char}</span>`;
        }
      }
      html += '<span class="fly-gap"></span>';
    }
    track.innerHTML = html;
  });
}

// Mouse wheel: resize brush
canvas.addEventListener("wheel", (event) => {
  if (!hasImage) return;
  event.preventDefault();
  const delta = event.deltaY < 0 ? 5 : -5;
  const min = parseInt(sizeInput.min, 10);
  const max = parseInt(sizeInput.max, 10);
  radius = Math.max(min, Math.min(max, radius + delta));
  sizeInput.value = radius;
  updateSliderValues();
}, { passive: false });

// Keyboard shortcuts
document.addEventListener("keydown", (event) => {
  // Undo / Redo
  if (event.ctrlKey && event.key === "z" && !event.shiftKey) { event.preventDefault(); undo(); return; }
  if (event.ctrlKey && (event.key === "Z" || (event.shiftKey && event.key === "z"))) { event.preventDefault(); redo(); return; }
  if (event.ctrlKey && event.key === "y") { event.preventDefault(); redo(); return; }

  // Paste image from clipboard
  if (event.ctrlKey && event.key === "v") return; // handled by paste event

  // Mode shortcuts (only when not in an input)
  if (document.activeElement && (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "TEXTAREA")) return;

  const modeMap = { "1": "push", "2": "bulge", "3": "pinch", "4": "twirl", "5": "smooth", "6": "reconstruct" };
  if (modeMap[event.key]) {
    event.preventDefault();
    const target = document.querySelector(`[data-mode="${modeMap[event.key]}"]`);
    if (target) target.click();
    return;
  }

  // Brush size with [ and ]
  if (event.key === "[") {
    event.preventDefault();
    const min = parseInt(sizeInput.min, 10);
    radius = Math.max(min, radius - 10);
    sizeInput.value = radius;
    updateSliderValues();
  }
  if (event.key === "]") {
    event.preventDefault();
    const max = parseInt(sizeInput.max, 10);
    radius = Math.min(max, radius + 10);
    sizeInput.value = radius;
    updateSliderValues();
  }
});

// Paste image from clipboard
document.addEventListener("paste", (event) => {
  const items = event.clipboardData && event.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) { loadImageFromFile(file); break; }
    }
  }
});

if (undoBtn) undoBtn.addEventListener("click", undo);
if (redoBtn) redoBtn.addEventListener("click", redo);
if (flipHBtn) flipHBtn.addEventListener("click", () => flipImage(true));
if (flipVBtn) flipVBtn.addEventListener("click", () => flipImage(false));

if (exportFormatSelect) {
  exportFormatSelect.addEventListener("change", () => {
    if (exportQualityWrap) {
      exportQualityWrap.hidden = exportFormatSelect.value !== "image/jpeg";
    }
  });
}

if (exportQualityInput) {
  exportQualityInput.addEventListener("input", () => {
    if (exportQualityValue) {
      exportQualityValue.textContent = `${Math.round(parseFloat(exportQualityInput.value) * 100)}%`;
    }
  });
}

if (exportFormatSelect && exportQualityWrap) {
  exportQualityWrap.hidden = exportFormatSelect.value !== "image/jpeg";
}

if (exportQualityInput && exportQualityValue) {
  exportQualityValue.textContent = `${Math.round(parseFloat(exportQualityInput.value) * 100)}%`;
}

initFlyText();
syncHistoryButtons();
updateSliderValues();
