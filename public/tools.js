/* ═══════════════════════════════════════════════════════════════
   tools.js — 15 neue Tools für ehoser.de
   ═══════════════════════════════════════════════════════════════ */

/* ─────────────────────────────────────────────────────────────
   1. SNAKE
───────────────────────────────────────────────────────────────*/
let snakeGame = null;
function snakeStart() {
  if (snakeGame) { snakeGame.stop(); snakeGame = null; }
  snakeGame = new SnakeGame();
  snakeGame.start();
}
class SnakeGame {
  constructor() {
    this.canvas = document.getElementById('snakeCanvas');
    this.ctx = this.canvas.getContext('2d');
    this.CELL = 20;
    this.COLS = this.canvas.width / this.CELL;
    this.ROWS = this.canvas.height / this.CELL;
    this.reset();
    this._keydown = (e) => {
      const map = { ArrowUp:'U', ArrowDown:'D', ArrowLeft:'L', ArrowRight:'R', w:'U', s:'D', a:'L', d:'R', W:'U', S:'D', A:'L', D:'R' };
      if (map[e.key]) { e.preventDefault(); this.queue.push(map[e.key]); }
    };
    this._touch = { x: null, y: null };
    this._touchstart = (e) => { this._touch.x = e.touches[0].clientX; this._touch.y = e.touches[0].clientY; };
    this._touchend = (e) => {
      if (!this._touch.x) return;
      const dx = e.changedTouches[0].clientX - this._touch.x;
      const dy = e.changedTouches[0].clientY - this._touch.y;
      if (Math.abs(dx) > Math.abs(dy)) this.queue.push(dx > 0 ? 'R' : 'L');
      else this.queue.push(dy > 0 ? 'D' : 'U');
      this._touch.x = null;
    };
    document.addEventListener('keydown', this._keydown);
    this.canvas.addEventListener('touchstart', this._touchstart, { passive: true });
    this.canvas.addEventListener('touchend', this._touchend);
  }
  reset() {
    this.snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
    this.dir = 'R';
    this.queue = [];
    this.score = 0;
    this.hi = parseInt(localStorage.getItem('snakeHi') || '0');
    this.alive = true;
    this.placeFood();
    document.getElementById('snakeHi').textContent = 'Highscore: ' + this.hi;
  }
  placeFood() {
    do {
      this.food = { x: Math.floor(Math.random() * this.COLS), y: Math.floor(Math.random() * this.ROWS) };
    } while (this.snake.some(s => s.x === this.food.x && s.y === this.food.y));
  }
  start() {
    this.interval = setInterval(() => this.tick(), 120);
    this.draw();
  }
  stop() {
    clearInterval(this.interval);
    document.removeEventListener('keydown', this._keydown);
    this.canvas.removeEventListener('touchstart', this._touchstart);
    this.canvas.removeEventListener('touchend', this._touchend);
  }
  tick() {
    if (!this.alive) return;
    const next = this.queue.shift();
    const opp = { U:'D', D:'U', L:'R', R:'L' };
    if (next && next !== opp[this.dir]) this.dir = next;
    const head = { ...this.snake[0] };
    if (this.dir === 'U') head.y--;
    if (this.dir === 'D') head.y++;
    if (this.dir === 'L') head.x--;
    if (this.dir === 'R') head.x++;
    if (head.x < 0 || head.x >= this.COLS || head.y < 0 || head.y >= this.ROWS || this.snake.some(s => s.x === head.x && s.y === head.y)) {
      this.alive = false;
      this.draw();
      if (this.score > this.hi) { this.hi = this.score; localStorage.setItem('snakeHi', this.hi); document.getElementById('snakeHi').textContent = 'Highscore: ' + this.hi; }
      return;
    }
    this.snake.unshift(head);
    if (head.x === this.food.x && head.y === this.food.y) {
      this.score++;
      document.getElementById('snakeScore').textContent = 'Punkte: ' + this.score;
      this.placeFood();
    } else {
      this.snake.pop();
    }
    this.draw();
  }
  draw() {
    const ctx = this.ctx;
    const C = this.CELL;
    ctx.fillStyle = '#0d1b2a';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    // Food
    ctx.fillStyle = '#f47c2a';
    ctx.beginPath();
    ctx.arc(this.food.x * C + C / 2, this.food.y * C + C / 2, C / 2 - 2, 0, Math.PI * 2);
    ctx.fill();
    // Snake
    this.snake.forEach((s, i) => {
      ctx.fillStyle = i === 0 ? '#0e8a9b' : `hsl(${180 - i * 3},70%,${50 - i * 0.5}%)`;
      ctx.beginPath();
      ctx.roundRect(s.x * C + 1, s.y * C + 1, C - 2, C - 2, 4);
      ctx.fill();
    });
    if (!this.alive) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 28px Space Grotesk, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Game Over!', this.canvas.width / 2, this.canvas.height / 2 - 20);
      ctx.font = '18px Space Grotesk, sans-serif';
      ctx.fillStyle = '#0e8a9b';
      ctx.fillText('Punkte: ' + this.score, this.canvas.width / 2, this.canvas.height / 2 + 16);
      ctx.fillStyle = '#aaa';
      ctx.font = '14px sans-serif';
      ctx.fillText('Klicke "Neu starten"', this.canvas.width / 2, this.canvas.height / 2 + 46);
    }
  }
}

/* ─────────────────────────────────────────────────────────────
   2. TIC TAC TOE
───────────────────────────────────────────────────────────────*/
let tttBoard = Array(9).fill(null);
let tttCurrent = 'X';
let tttVsAI = true;
let tttScoreX = 0, tttScoreO = 0, tttScoreDraw = 0;

function tttReset() {
  tttBoard = Array(9).fill(null);
  tttCurrent = 'X';
  tttRender();
  document.getElementById('tttStatus').textContent = 'Du bist X – fang an!';
}
function tttToggleMode() {
  tttVsAI = !tttVsAI;
  document.getElementById('tttModeLabel').textContent = tttVsAI ? 'KI' : '2 Spieler';
  tttReset();
}
function tttRender() {
  const board = document.getElementById('tttBoard');
  board.innerHTML = '';
  tttBoard.forEach((v, i) => {
    const btn = document.createElement('button');
    btn.className = 'ttt-cell';
    btn.textContent = v || '';
    btn.disabled = !!v;
    btn.style.color = v === 'X' ? 'var(--brand)' : '#f47c2a';
    btn.onclick = () => tttMove(i);
    board.appendChild(btn);
  });
}
function tttMove(i) {
  if (tttBoard[i] || tttCheckWin(tttBoard)) return;
  tttBoard[i] = tttCurrent;
  const winner = tttCheckWin(tttBoard);
  if (winner) {
    tttRender();
    if (winner === 'X') tttScoreX++; else tttScoreO++;
    document.getElementById('tttStatus').textContent = winner === 'X' ? '🎉 Du hast gewonnen!' : (tttVsAI ? '🤖 KI gewinnt!' : '🎉 ' + winner + ' gewinnt!');
    document.getElementById('tttScores').textContent = `X: ${tttScoreX} | O: ${tttScoreO} | Unentschieden: ${tttScoreDraw}`;
    return;
  }
  if (!tttBoard.includes(null)) {
    tttScoreDraw++;
    tttRender();
    document.getElementById('tttStatus').textContent = '🤝 Unentschieden!';
    document.getElementById('tttScores').textContent = `X: ${tttScoreX} | O: ${tttScoreO} | Unentschieden: ${tttScoreDraw}`;
    return;
  }
  tttCurrent = tttCurrent === 'X' ? 'O' : 'X';
  document.getElementById('tttStatus').textContent = tttVsAI ? '🤖 KI denkt…' : (tttCurrent + ' ist dran');
  tttRender();
  if (tttVsAI && tttCurrent === 'O') setTimeout(tttAIMove, 400);
}
function tttAIMove() {
  const best = tttMinimax(tttBoard, 'O');
  tttMove(best.idx);
}
function tttMinimax(board, player) {
  const win = tttCheckWin(board);
  if (win === 'O') return { score: 10 };
  if (win === 'X') return { score: -10 };
  if (!board.includes(null)) return { score: 0 };
  const moves = [];
  board.forEach((v, i) => {
    if (!v) {
      const b = [...board];
      b[i] = player;
      const res = tttMinimax(b, player === 'O' ? 'X' : 'O');
      moves.push({ idx: i, score: res.score });
    }
  });
  return moves.reduce((a, b) => player === 'O' ? (b.score > a.score ? b : a) : (b.score < a.score ? b : a));
}
function tttCheckWin(b) {
  const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (const [a,c,d] of lines) if (b[a] && b[a] === b[c] && b[a] === b[d]) return b[a];
  return null;
}

/* ─────────────────────────────────────────────────────────────
   3. MEMORY
───────────────────────────────────────────────────────────────*/
const MEM_EMOJIS = ['🐶','🐱','🦊','🐸','🦋','🌸','⭐','🍕'];
let memCards = [], memFlipped = [], memMatched = [], memMoves2 = 0, memLocked = false;

function memoryStart() {
  const emojis = [...MEM_EMOJIS, ...MEM_EMOJIS];
  emojis.sort(() => Math.random() - 0.5);
  memCards = emojis;
  memFlipped = [];
  memMatched = [];
  memMoves2 = 0;
  memLocked = false;
  document.getElementById('memMoves').textContent = 'Züge: 0';
  document.getElementById('memPairs').textContent = 'Paare: 0/8';
  memRender();
}
function memRender() {
  const board = document.getElementById('memoryBoard');
  board.innerHTML = '';
  memCards.forEach((e, i) => {
    const card = document.createElement('button');
    card.className = 'mem-card' + (memFlipped.includes(i) || memMatched.includes(i) ? ' flipped' : '');
    card.innerHTML = memFlipped.includes(i) || memMatched.includes(i) ? `<span>${e}</span>` : '<span>❓</span>';
    if (memMatched.includes(i)) card.style.opacity = '0.45';
    card.onclick = () => memFlip(i);
    board.appendChild(card);
  });
}
function memFlip(i) {
  if (memLocked || memFlipped.includes(i) || memMatched.includes(i)) return;
  if (memFlipped.length === 2) return;
  memFlipped.push(i);
  memRender();
  if (memFlipped.length === 2) {
    memMoves2++;
    document.getElementById('memMoves').textContent = 'Züge: ' + memMoves2;
    memLocked = true;
    setTimeout(() => {
      if (memCards[memFlipped[0]] === memCards[memFlipped[1]]) {
        memMatched.push(...memFlipped);
        document.getElementById('memPairs').textContent = `Paare: ${memMatched.length / 2}/8`;
        if (memMatched.length === 16) document.getElementById('memPairs').textContent = `🎉 Gewonnen in ${memMoves2} Zügen!`;
      }
      memFlipped = [];
      memLocked = false;
      memRender();
    }, 900);
  }
}

/* ─────────────────────────────────────────────────────────────
   4. BMI RECHNER
───────────────────────────────────────────────────────────────*/
function bmiCalc() {
  const h = parseFloat(document.getElementById('bmiHeight').value);
  const w = parseFloat(document.getElementById('bmiWeight').value);
  const a = parseFloat(document.getElementById('bmiAge').value) || 25;
  if (!h || !w || h < 50 || w < 10) { alert('Bitte gültige Werte eingeben.'); return; }
  const bmi = w / ((h / 100) ** 2);
  let label, color, pct, info;
  if (bmi < 18.5) { label = 'Untergewicht'; color = '#3b82f6'; pct = (bmi / 40) * 100; info = 'Du könntest mehr essen. Normalgewicht liegt zwischen 18,5 und 24,9.'; }
  else if (bmi < 25) { label = 'Normalgewicht'; color = '#22c55e'; pct = (bmi / 40) * 100; info = 'Super! Dein Gewicht ist im gesunden Bereich.'; }
  else if (bmi < 30) { label = 'Übergewicht'; color = '#f59e0b'; pct = (bmi / 40) * 100; info = 'Leicht erhöhtes Risiko. Sport und ausgewogene Ernährung helfen.'; }
  else { label = 'Starkes Übergewicht'; color = '#ef4444'; pct = Math.min((bmi / 40) * 100, 98); info = 'Spreche mit einem Arzt über Möglichkeiten zur Gewichtsreduktion.'; }
  const res = document.getElementById('bmiResult');
  res.style.display = 'block';
  document.getElementById('bmiValue').textContent = bmi.toFixed(1);
  document.getElementById('bmiValue').style.color = color;
  document.getElementById('bmiLabel').textContent = label;
  document.getElementById('bmiLabel').style.color = color;
  document.getElementById('bmiMarker').style.left = pct + '%';
  document.getElementById('bmiInfo').textContent = info;
}

/* ─────────────────────────────────────────────────────────────
   5. TRINKGELD RECHNER
───────────────────────────────────────────────────────────────*/
function tipCalc() {
  const bill = parseFloat(document.getElementById('tipBill').value) || 0;
  const pct = parseFloat(document.getElementById('tipPct').value) || 0;
  const persons = parseInt(document.getElementById('tipPersons').value) || 1;
  const tipAmt = bill * (pct / 100);
  const total = bill + tipAmt;
  const res = document.getElementById('tipResult');
  res.style.display = 'grid';
  document.getElementById('tipTotal').textContent = total.toFixed(2) + ' €';
  document.getElementById('tipPP').textContent = (total / persons).toFixed(2) + ' €';
  document.getElementById('tipTipOnly').textContent = tipAmt.toFixed(2) + ' €';
  document.getElementById('tipTipPP').textContent = (tipAmt / persons).toFixed(2) + ' €';
}

/* ─────────────────────────────────────────────────────────────
   6. MORSE CODE
───────────────────────────────────────────────────────────────*/
const MORSE_MAP = {A:'.-',B:'-...',C:'-.-.',D:'-..',E:'.',F:'..-.',G:'--.',H:'....',I:'..',J:'.---',K:'-.-',L:'.-..',M:'--',N:'-.',O:'---',P:'.--.',Q:'--.-',R:'.-.',S:'...',T:'-',U:'..-',V:'...-',W:'.--',X:'-..-',Y:'-.--',Z:'--..',0:'-----',1:'.----',2:'..---',3:'...--',4:'....-',5:'.....',6:'-....',7:'--...',8:'---..',9:'----.',' ':'/'};
const MORSE_REV = Object.fromEntries(Object.entries(MORSE_MAP).map(([k,v])=>[v,k]));
let morseDirection = 1, morseAudioCtx = null, morseStopFlag = false;

function morseSetDir(d) {
  morseDirection = d;
  document.getElementById('morseDir1').style.fontWeight = d === 1 ? '700' : '400';
  document.getElementById('morseDir2').style.fontWeight = d === 2 ? '700' : '400';
  morseConvert();
}
function morseConvert() {
  const input = document.getElementById('morseInput').value;
  let out = '';
  if (morseDirection === 1) {
    out = input.toUpperCase().split('').map(c => MORSE_MAP[c] || '').join(' ');
  } else {
    out = input.trim().split(' / ').map(word => word.trim().split(' ').map(code => MORSE_REV[code] || '?').join('')).join(' ');
  }
  document.getElementById('morseOutput').textContent = out;
}
async function morsePlay() {
  morseStopFlag = false;
  const text = morseDirection === 1 ? document.getElementById('morseOutput').textContent : document.getElementById('morseInput').value.toUpperCase().split('').map(c => MORSE_MAP[c] || '').join(' ');
  morseAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const dot = 80, dash = 240, gap = 80, letterGap = 240, wordGap = 560;
  let t = morseAudioCtx.currentTime + 0.05;
  for (const ch of text) {
    if (morseStopFlag) break;
    if (ch === '.') { playTone(morseAudioCtx, t, dot / 1000); t += (dot + gap) / 1000; }
    else if (ch === '-') { playTone(morseAudioCtx, t, dash / 1000); t += (dash + gap) / 1000; }
    else if (ch === ' ') { t += letterGap / 1000; }
    else if (ch === '/') { t += wordGap / 1000; }
  }
}
function playTone(ctx, start, duration) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain); gain.connect(ctx.destination);
  osc.frequency.value = 600; osc.type = 'sine';
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(0.4, start + 0.005);
  gain.gain.setValueAtTime(0.4, start + duration - 0.005);
  gain.gain.linearRampToValueAtTime(0, start + duration);
  osc.start(start); osc.stop(start + duration);
}
function morseStop() { morseStopFlag = true; if (morseAudioCtx) { morseAudioCtx.close(); morseAudioCtx = null; } }
function morseCopy() { navigator.clipboard.writeText(document.getElementById('morseOutput').textContent); }

/* ─────────────────────────────────────────────────────────────
   7. CAESAR CHIFFRE
───────────────────────────────────────────────────────────────*/
let caesarMode = 'enc', caesarBruteVisible = false;

function caesarSetMode(m) {
  caesarMode = m;
  document.getElementById('caesarMode1').style.fontWeight = m === 'enc' ? '700' : '400';
  document.getElementById('caesarMode2').style.fontWeight = m === 'dec' ? '700' : '400';
  caesarConvert();
}
function caesarConvert() {
  const input = document.getElementById('caesarInput').value;
  const shift = parseInt(document.getElementById('caesarShift').value);
  document.getElementById('caesarOutput').textContent = caesarShift(input, caesarMode === 'enc' ? shift : 26 - shift);
  if (caesarBruteVisible) caesarShowBrute();
}
function caesarShift(text, n) {
  return text.split('').map(c => {
    if (/[a-z]/.test(c)) return String.fromCharCode(((c.charCodeAt(0) - 97 + n) % 26) + 97);
    if (/[A-Z]/.test(c)) return String.fromCharCode(((c.charCodeAt(0) - 65 + n) % 26) + 65);
    return c;
  }).join('');
}
function caesarCopy() { navigator.clipboard.writeText(document.getElementById('caesarOutput').textContent); }
function caesarToggleBrute() {
  caesarBruteVisible = !caesarBruteVisible;
  document.getElementById('caesarBrute').style.display = caesarBruteVisible ? 'block' : 'none';
  if (caesarBruteVisible) caesarShowBrute();
}
function caesarShowBrute() {
  const input = document.getElementById('caesarInput').value;
  const list = document.getElementById('caesarBruteList');
  list.innerHTML = Array.from({length:25},(_,i)=>`<div style="padding:2px 0;"><span style="color:var(--brand);min-width:32px;display:inline-block;">${i+1}:</span> ${caesarShift(input,i+1)}</div>`).join('');
}

/* ─────────────────────────────────────────────────────────────
   8. UUID GENERATOR
───────────────────────────────────────────────────────────────*/
function uuidV4() {
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));
}
function uuidGenerate() {
  const n = Math.min(parseInt(document.getElementById('uuidCount').value) || 1, 100);
  const list = document.getElementById('uuidList');
  list.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const id = uuidV4();
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.05);';
    row.innerHTML = `<span style="flex:1;">${id}</span><button onclick="navigator.clipboard.writeText('${id}')" style="background:none;border:1px solid var(--brand);color:var(--brand);border-radius:6px;padding:2px 8px;cursor:pointer;font-size:0.75rem;">Kopieren</button>`;
    list.appendChild(row);
  }
}
function uuidCopyAll() {
  const ids = [...document.getElementById('uuidList').querySelectorAll('span')].map(s => s.textContent).join('\n');
  navigator.clipboard.writeText(ids);
}

/* ─────────────────────────────────────────────────────────────
   9. BOX-SHADOW GENERATOR
───────────────────────────────────────────────────────────────*/
function bsUpdate() {
  const x = document.getElementById('bsX').value;
  const y = document.getElementById('bsY').value;
  const blur = document.getElementById('bsBlur').value;
  const spread = document.getElementById('bsSpread').value;
  const color = document.getElementById('bsColor').value;
  const opac = (parseInt(document.getElementById('bsOpac').value) / 100).toFixed(2);
  const inset = document.getElementById('bsInset').checked ? 'inset ' : '';
  document.getElementById('bsXLabel').textContent = x;
  document.getElementById('bsYLabel').textContent = y;
  document.getElementById('bsBlurLabel').textContent = blur;
  document.getElementById('bsSpreadLabel').textContent = spread;
  document.getElementById('bsOpacLabel').textContent = opac;
  const r = parseInt(color.slice(1,3),16), g = parseInt(color.slice(3,5),16), b = parseInt(color.slice(5,7),16);
  const css = `${inset}${x}px ${y}px ${blur}px ${spread}px rgba(${r},${g},${b},${opac})`;
  document.getElementById('bsPreview').style.boxShadow = css;
  document.getElementById('bsCode').textContent = `box-shadow: ${css};`;
}
function bsCopy() { navigator.clipboard.writeText(document.getElementById('bsCode').textContent); }

/* ─────────────────────────────────────────────────────────────
   10. HTTP STATUS CODES
───────────────────────────────────────────────────────────────*/
const HTTP_CODES = [
  [100,'Continue','Der Server hat den Anfrageanfang erhalten.'],
  [101,'Switching Protocols','Protokollwechsel wurde akzeptiert.'],
  [200,'OK','Anfrage erfolgreich.'],
  [201,'Created','Ressource erfolgreich erstellt.'],
  [204,'No Content','Erfolg, aber kein Inhalt zurückgegeben.'],
  [301,'Moved Permanently','Ressource dauerhaft verschoben.'],
  [302,'Found','Ressource vorübergehend unter anderer URL.'],
  [304,'Not Modified','Ressource hat sich nicht verändert (Cache).'],
  [400,'Bad Request','Fehlerhafte Anfrage vom Client.'],
  [401,'Unauthorized','Authentifizierung erforderlich.'],
  [403,'Forbidden','Zugriff verweigert.'],
  [404,'Not Found','Ressource nicht gefunden.'],
  [405,'Method Not Allowed','HTTP-Methode nicht erlaubt.'],
  [408,'Request Timeout','Zeitüberschreitung der Anfrage.'],
  [409,'Conflict','Konflikt mit aktuellem Ressourcenstatus.'],
  [410,'Gone','Ressource dauerhaft entfernt.'],
  [422,'Unprocessable Entity','Validierungsfehler.'],
  [429,'Too Many Requests','Zu viele Anfragen (Rate Limiting).'],
  [500,'Internal Server Error','Interner Serverfehler.'],
  [501,'Not Implemented','Methode nicht implementiert.'],
  [502,'Bad Gateway','Ungültige Antwort vom Upstream-Server.'],
  [503,'Service Unavailable','Dienst vorübergehend nicht verfügbar.'],
  [504,'Gateway Timeout','Zeitüberschreitung des Gateways.'],
];
const HTTP_COLORS = { 1:'#3b82f6', 2:'#22c55e', 3:'#a855f7', 4:'#f59e0b', 5:'#ef4444' };

function httpRender(codes) {
  const list = document.getElementById('httpList');
  list.innerHTML = codes.map(([code, name, desc]) => {
    const color = HTTP_COLORS[String(code)[0]] || '#888';
    return `<div style="display:flex;gap:12px;align-items:flex-start;padding:10px 12px;background:var(--bg-soft);border-radius:10px;border-left:4px solid ${color};">
      <span style="font-weight:800;font-size:1.15rem;color:${color};min-width:44px;">${code}</span>
      <div><div style="font-weight:600;font-size:0.95rem;">${name}</div><div style="font-size:0.82rem;color:var(--text-soft);margin-top:2px;">${desc}</div></div>
    </div>`;
  }).join('');
}
function httpFilter() {
  const q = document.getElementById('httpSearch').value.toLowerCase();
  httpRender(HTTP_CODES.filter(([c,n,d]) => String(c).includes(q) || n.toLowerCase().includes(q) || d.toLowerCase().includes(q)));
}

/* ─────────────────────────────────────────────────────────────
   11. POMODORO TIMER
───────────────────────────────────────────────────────────────*/
const POMO_MODES = { focus: { label:'Fokus-Session', mins:25 }, short: { label:'Kurze Pause', mins:5 }, long: { label:'Lange Pause', mins:15 } };
let pomoMode = 'focus', pomoRemain = 25 * 60, pomoTotal = 25 * 60, pomoRunning = false, pomoInterval = null, pomoDone = 0;

function pomoSet(m) {
  clearInterval(pomoInterval); pomoRunning = false;
  pomoMode = m;
  pomoRemain = pomoTotal = POMO_MODES[m].mins * 60;
  document.getElementById('pomoLabel').textContent = POMO_MODES[m].label;
  document.getElementById('pomoPlayBtn').textContent = '▶ Start';
  pomoRender();
}
function pomoToggle() {
  if (pomoRunning) {
    clearInterval(pomoInterval); pomoRunning = false;
    document.getElementById('pomoPlayBtn').textContent = '▶ Weiter';
  } else {
    pomoRunning = true;
    document.getElementById('pomoPlayBtn').textContent = '⏸ Pause';
    pomoInterval = setInterval(() => {
      pomoRemain--;
      if (pomoRemain <= 0) {
        clearInterval(pomoInterval); pomoRunning = false;
        if (pomoMode === 'focus') pomoDone++;
        document.getElementById('pomoDoneCount').textContent = pomoDone;
        document.getElementById('pomoPlayBtn').textContent = '▶ Start';
        pomoRender();
        try { new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAA...').play(); } catch(e){}
        return;
      }
      pomoRender();
    }, 1000);
  }
}
function pomoReset() {
  clearInterval(pomoInterval); pomoRunning = false;
  pomoRemain = pomoTotal;
  document.getElementById('pomoPlayBtn').textContent = '▶ Start';
  pomoRender();
}
function pomoRender() {
  const m = String(Math.floor(pomoRemain / 60)).padStart(2,'0');
  const s = String(pomoRemain % 60).padStart(2,'0');
  document.getElementById('pomoTime').textContent = `${m}:${s}`;
  const pct = pomoRemain / pomoTotal;
  const circ = 2 * Math.PI * 88;
  document.getElementById('pomoRing').style.strokeDashoffset = circ * (1 - pct);
  document.getElementById('pomoRing').style.stroke = pomoMode === 'focus' ? 'var(--brand)' : (pomoMode === 'short' ? '#22c55e' : '#a855f7');
}

/* ─────────────────────────────────────────────────────────────
   12. KANBAN BOARD
───────────────────────────────────────────────────────────────*/
let kanbanData = { todo: [], progress: [], done: [] };
let kanbanDragId = null;

function kanbanLoad() {
  try { kanbanData = JSON.parse(localStorage.getItem('ehoser_kanban')) || { todo:[], progress:[], done:[] }; } catch(e) { kanbanData = { todo:[], progress:[], done:[] }; }
  kanbanRender();
}
function kanbanSave() { localStorage.setItem('ehoser_kanban', JSON.stringify(kanbanData)); }
function kanbanAdd() {
  const val = document.getElementById('kanbanInput').value.trim();
  if (!val) return;
  kanbanData.todo.push({ id: Date.now(), text: val });
  document.getElementById('kanbanInput').value = '';
  kanbanSave(); kanbanRender();
}
function kanbanClear() { if (confirm('Wirklich alles löschen?')) { kanbanData = { todo:[], progress:[], done:[] }; kanbanSave(); kanbanRender(); } }
function kanbanDelete(col, id) {
  kanbanData[col] = kanbanData[col].filter(c => c.id !== id);
  kanbanSave(); kanbanRender();
}
function kanbanDrop(e, col) {
  e.preventDefault();
  if (!kanbanDragId) return;
  for (const c of ['todo','progress','done']) {
    const idx = kanbanData[c].findIndex(x => x.id === kanbanDragId);
    if (idx !== -1) { const [item] = kanbanData[c].splice(idx,1); kanbanData[col].push(item); break; }
  }
  kanbanDragId = null; kanbanSave(); kanbanRender();
}
function kanbanRender() {
  ['todo','progress','done'].forEach(col => {
    document.getElementById('kanban'+col.charAt(0).toUpperCase()+col.slice(1)+'List').innerHTML = kanbanData[col].map(item =>
      `<div class="kanban-item" draggable="true" ondragstart="kanbanDragId=${item.id}" style="display:flex;justify-content:space-between;align-items:center;">
        <span style="word-break:break-word;flex:1;">${item.text}</span>
        <button onclick="kanbanDelete('${col}',${item.id})" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:1rem;padding:2px 6px;">×</button>
      </div>`
    ).join('');
  });
}

/* ─────────────────────────────────────────────────────────────
   13. MAGIC 8-BALL
───────────────────────────────────────────────────────────────*/
const EIGHT_BALL_ANSWERS = [
  'Es ist so','Auf jeden Fall','Ohne jeden Zweifel','Ja, sicher','Du kannst darauf zählen',
  'Wie ich es sehe, ja','Aller Wahrscheinlichkeit nach','Aussichten sind gut','Ja',
  'Anzeichen weisen auf Ja','Antworte später nochmal','Frag später nochmal',
  'Besser, ich sage jetzt nichts','Im Moment nicht vorhersehbar','Konzentrier dich und frag nochmal',
  'Schau nicht so gut aus','Meine Antwort ist Nein','Meine Quellen sagen Nein',
  'Aussichten nicht so gut','Sehr zweifelhaft'
];
let eightballShaking = false;
function eightballShake() {
  if (eightballShaking) return;
  eightballShaking = true;
  const ball = document.getElementById('eightballBall');
  const ans = document.getElementById('eightballAnswer');
  ans.textContent = '…';
  ball.style.transform = 'scale(0.95) rotate(-5deg)';
  setTimeout(() => { ball.style.transform = 'scale(1.05) rotate(5deg)'; }, 100);
  setTimeout(() => { ball.style.transform = 'scale(1) rotate(0)'; }, 200);
  setTimeout(() => {
    ans.textContent = EIGHT_BALL_ANSWERS[Math.floor(Math.random() * EIGHT_BALL_ANSWERS.length)];
    eightballShaking = false;
  }, 600);
}

/* ─────────────────────────────────────────────────────────────
   14. WITZ GENERATOR
───────────────────────────────────────────────────────────────*/
const JOKES = {
  flach: [
    { s:'Warum können Geister so schlecht lügen?', p:'Weil man durch sie hindurchsieht.' },
    { s:'Was macht ein Clown im Büro?', p:'Er hebt die Stimmung.' },
    { s:'Was sagt ein Bauer, wenn er sein Traktor verliert?', p:'Wo ist mein Traktor?' },
    { s:'Wie nennt man einen schlafenden Dinosaurier?', p:'Einen Dino-Schnauser.' },
    { s:'Was ist orange und klingt wie ein Papagei?', p:'Eine Karotte.' },
    { s:'Warum hat der Fahrradreifen keine Pause?', p:'Weil er unter Luftdruck steht.' },
    { s:'Was hat vier Räder und fliegt?', p:'Ein Müllauto.' },
    { s:'Was ist braun und klebrig?', p:'Ein Stab.' },
  ],
  dark: [
    { s:'Mein Arzt sagt, ich habe noch 6 Monate zu leben.', p:'Ich hab ihn erschossen. Jetzt sitzen wir im Gefängnis und alles ist gut.' },
    { s:'Was ist schlimmer als auf einem Stuhl mit einem Nagel zu sitzen?', p:'Auf einem Nagel mit zehn Stühlen sitzen.' },
    { s:'Ich habe meinen Job als Postbote verloren.', p:'Es war ein Brief von meinem Chef.' },
    { s:'Meine Frau sagte ich soll Dinge mehr wertschätzen.', p:'Also habe ich das Messer aufgehoben.' },
  ]
};
let jokeCat = 'all', jokeCurrentJoke = null;
function jokeSetCat(c) {
  jokeCat = c;
  ['1','2','3'].forEach(n => document.getElementById('jokeBtn'+n).style.fontWeight = '400');
  const map = { all:'1', flach:'2', dark:'3' };
  if (map[c]) document.getElementById('jokeBtn'+map[c]).style.fontWeight = '700';
  jokeNext();
}
function jokeNext() {
  const pool = jokeCat === 'all' ? [...JOKES.flach,...JOKES.dark] : JOKES[jokeCat] || [...JOKES.flach,...JOKES.dark];
  jokeCurrentJoke = pool[Math.floor(Math.random() * pool.length)];
  document.getElementById('jokeSetup').textContent = jokeCurrentJoke.s;
  document.getElementById('jokePunchline').style.display = 'none';
  document.getElementById('jokePunchline').textContent = jokeCurrentJoke.p;
  document.getElementById('jokePunchBtn').style.display = 'inline-flex';
}
function jokeReveal() {
  document.getElementById('jokePunchline').style.display = 'block';
  document.getElementById('jokePunchBtn').style.display = 'none';
}
function jokeCopy() {
  if (jokeCurrentJoke) navigator.clipboard.writeText(`${jokeCurrentJoke.s}\n${jokeCurrentJoke.p}`);
}

/* ─────────────────────────────────────────────────────────────
   15. ATEMÜBUNGEN
───────────────────────────────────────────────────────────────*/
const BREATHE_PATTERNS = {
  box: { name:'Box Breathing', phases:[{n:'Einatmen',d:4},{n:'Halten',d:4},{n:'Ausatmen',d:4},{n:'Halten',d:4}], desc:'Militärische Entspannungstechnik: 4-4-4-4 Sekunden.' },
  '478': { name:'4-7-8 Methode', phases:[{n:'Einatmen',d:4},{n:'Halten',d:7},{n:'Ausatmen',d:8}], desc:'Beruhigt das Nervensystem. Ideal vor dem Schlafen.' },
  calm: { name:'Beruhigungsatmung', phases:[{n:'Einatmen',d:4},{n:'Ausatmen',d:6}], desc:'Längeres Ausatmen aktiviert den Parasympathikus.' }
};
let breathePattern = 'box', breatheRunning = false, breathePhaseIdx = 0, breatheSecLeft = 0, breatheTimer = null, breatheCycles2 = 0;

function breatheSet(p) {
  breatheStop();
  breathePattern = p;
  breathePhaseIdx = 0;
  breatheCycles2 = 0;
  document.getElementById('breatheCycleCount').textContent = '0';
  const pat = BREATHE_PATTERNS[p];
  document.getElementById('breatheDesc').textContent = pat.desc;
  document.getElementById('breathePhase').textContent = pat.name;
  document.getElementById('breatheCount').textContent = '';
  const c = document.getElementById('breatheCircle');
  c.style.transform = 'scale(1)';
  c.textContent = 'Bereit';
}
function breatheToggle() {
  if (breatheRunning) breatheStop();
  else breatheBegin();
}
function breatheBegin() {
  breatheRunning = true;
  document.getElementById('breatheBtn').textContent = '⏸ Pause';
  breathePhaseIdx = 0;
  breatheNextPhase();
}
function breatheNextPhase() {
  if (!breatheRunning) return;
  const pat = BREATHE_PATTERNS[breathePattern];
  const phase = pat.phases[breathePhaseIdx];
  breatheSecLeft = phase.d;
  document.getElementById('breathePhase').textContent = phase.n;
  const c = document.getElementById('breatheCircle');
  c.textContent = phase.n;
  if (phase.n === 'Einatmen') { c.style.transition = `transform ${phase.d}s ease-in`; c.style.transform = 'scale(1.35)'; }
  else if (phase.n === 'Ausatmen') { c.style.transition = `transform ${phase.d}s ease-out`; c.style.transform = 'scale(1)'; }
  else { c.style.transition = 'none'; }
  breatheTimer = setInterval(() => {
    document.getElementById('breatheCount').textContent = breatheSecLeft;
    breatheSecLeft--;
    if (breatheSecLeft < 0) {
      clearInterval(breatheTimer);
      breathePhaseIdx++;
      if (breathePhaseIdx >= pat.phases.length) {
        breathePhaseIdx = 0;
        breatheCycles2++;
        document.getElementById('breatheCycleCount').textContent = breatheCycles2;
      }
      breatheNextPhase();
    }
  }, 1000);
}
function breatheStop() {
  clearInterval(breatheTimer);
  breatheRunning = false;
  document.getElementById('breatheBtn').textContent = '▶ Start';
  document.getElementById('breatheCount').textContent = '';
  const c = document.getElementById('breatheCircle');
  c.style.transition = 'transform 0.5s';
  c.style.transform = 'scale(1)';
  c.textContent = 'Bereit';
}

/* ═══════════════════════════════════════════════════════════════
   INIT-Hooks — werden von selectMode in app.js aufgerufen
   ═══════════════════════════════════════════════════════════════ */
function initSnake()      { setTimeout(snakeStart, 50); }
function initTictactoe()  { tttReset(); }
function initMemory2()    { memoryStart(); }
function initBmi()        { /* nothing */ }
function initTip()        { /* nothing */ }
function initMorse()      { morseSetDir(1); }
function initCaesar()     { caesarSetMode('enc'); }
function initUuid()       { uuidGenerate(); }
function initBoxshadow()  { bsUpdate(); }
function initHttpstatus() { httpRender(HTTP_CODES); }
function initPomodoro()   { pomoSet('focus'); }
function initKanban()     { kanbanLoad(); }
function initEightball()  { /* nothing */ }
function initJokegen()    { jokeSetCat('all'); }
function initBreathe()    { breatheSet('box'); }
