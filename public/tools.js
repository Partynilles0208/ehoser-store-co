/* ═══════════════════════════════════════════════════════════════
   tools.js — alle Tools + SFX + VFX
   ═══════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════
   SFX — Web-Audio-Engine (keine externen Dateien, reine Synthese)
   ═══════════════════════════════════════════════════════════════ */
const SFX = (() => {
  let ctx = null;
  function getCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function beep(freq, type, duration, vol = 0.3, delay = 0) {
    try {
      const c = getCtx(), t = c.currentTime + delay;
      const osc = c.createOscillator(), g = c.createGain();
      osc.connect(g); g.connect(c.destination);
      osc.type = type; osc.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + duration);
      osc.start(t); osc.stop(t + duration);
    } catch(e) {}
  }
  function noise(duration, vol = 0.2, delay = 0) {
    try {
      const c = getCtx(), t = c.currentTime + delay;
      const buf = c.createBuffer(1, Math.ceil(c.sampleRate * duration), c.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1);
      const src = c.createBufferSource(), g = c.createGain();
      src.buffer = buf; src.connect(g); g.connect(c.destination);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + duration);
      src.start(t); src.stop(t + duration);
    } catch(e) {}
  }
  return {
    click:    () => beep(900, 'sine', 0.04, 0.12),
    pop:      () => beep(620, 'sine', 0.07, 0.22),
    eat:      () => { beep(523, 'square', 0.06, 0.18); beep(659, 'square', 0.06, 0.18, 0.07); },
    correct:  () => { beep(523, 'sine', 0.09, 0.28); beep(659, 'sine', 0.09, 0.28, 0.10); beep(784, 'sine', 0.12, 0.28, 0.20); },
    wrong:    () => beep(200, 'sawtooth', 0.18, 0.28),
    win:      () => { [523, 659, 784, 1047].forEach((f, i) => beep(f, 'sine', 0.22, 0.32, i * 0.11)); },
    lose:     () => { [300, 250, 200, 150].forEach((f, i) => beep(f, 'sawtooth', 0.22, 0.28, i * 0.10)); },
    tick:     () => beep(880, 'sine', 0.04, 0.10),
    merge:    () => beep(480, 'sine', 0.07, 0.22),
    bounce:   () => beep(380, 'square', 0.05, 0.14),
    brickHit: () => { beep(280, 'square', 0.05, 0.18); beep(180, 'square', 0.05, 0.15, 0.04); },
    explosion:() => { noise(0.35, 0.4); beep(80, 'sawtooth', 0.3, 0.35, 0.02); },
    chime:    () => { [784, 1047, 1319, 1568].forEach((f, i) => beep(f, 'sine', 0.28, 0.28, i * 0.09)); },
    score:    () => beep(760, 'sine', 0.10, 0.25),
    flip:     () => beep(500, 'triangle', 0.05, 0.12),
    match2:   () => { beep(523, 'sine', 0.10, 0.28); beep(784, 'sine', 0.15, 0.28, 0.10); },
    roll:     () => { [0, 1, 2].forEach(i => noise(0.05, 0.15, i * 0.06)); },
    tooEarly: () => beep(160, 'sawtooth', 0.20, 0.35),
    draw:     () => { beep(400, 'sine', 0.12, 0.22); beep(380, 'sine', 0.12, 0.22, 0.12); },
  };
})();

/* ═══════════════════════════════════════════════════════════════
   VFX — Konfetti, Pop-Animation, Shake
   ═══════════════════════════════════════════════════════════════ */
function vfxConfetti(count = 50) {
  for (let i = 0; i < count; i++) {
    const d = document.createElement('div');
    d.className = 'confetti-p';
    d.style.cssText = `left:${5 + Math.random() * 90}%;` +
      `background:hsl(${Math.random() * 360},90%,60%);` +
      `width:${5 + Math.random() * 7}px;height:${5 + Math.random() * 7}px;` +
      `animation-delay:${Math.random() * 0.6}s;` +
      `animation-duration:${0.8 + Math.random() * 0.9}s;`;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 2200);
  }
}
function vfxPop(el) {
  if (!el) return;
  el.classList.remove('vfx-pop'); void el.offsetWidth; el.classList.add('vfx-pop');
  setTimeout(() => el.classList.remove('vfx-pop'), 400);
}
function vfxShake(el) {
  if (!el) return;
  el.classList.remove('vfx-shake'); void el.offsetWidth; el.classList.add('vfx-shake');
  setTimeout(() => el.classList.remove('vfx-shake'), 500);
}
function vfxFloat(text, x, y, color = '#0ef0d0') {
  const d = document.createElement('div');
  d.className = 'vfx-float';
  d.textContent = text;
  d.style.cssText = `left:${x}px;top:${y}px;color:${color};`;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 900);
}

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
      SFX.lose();
      vfxShake(this.canvas);
      if (this.score > this.hi) { this.hi = this.score; localStorage.setItem('snakeHi', this.hi); document.getElementById('snakeHi').textContent = 'Highscore: ' + this.hi; SFX.chime(); }
      return;
    }
    this.snake.unshift(head);
    if (head.x === this.food.x && head.y === this.food.y) {
      this.score++;
      SFX.eat();
      const scoreEl = document.getElementById('snakeScore');
      scoreEl.textContent = 'Punkte: ' + this.score;
      vfxPop(scoreEl);
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
  SFX.click();
  tttBoard[i] = tttCurrent;
  const winner = tttCheckWin(tttBoard);
  if (winner) {
    tttRender();
    if (winner === 'X') { tttScoreX++; SFX.win(); setTimeout(vfxConfetti, 100); }
    else { tttScoreO++; if (tttVsAI) SFX.lose(); else SFX.win(); }
    document.getElementById('tttStatus').textContent = winner === 'X' ? '🎉 Du hast gewonnen!' : (tttVsAI ? '🤖 KI gewinnt!' : '🎉 ' + winner + ' gewinnt!');
    document.getElementById('tttScores').textContent = `X: ${tttScoreX} | O: ${tttScoreO} | Unentschieden: ${tttScoreDraw}`;
    return;
  }
  if (!tttBoard.includes(null)) {
    tttScoreDraw++;
    SFX.draw();
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
  SFX.flip();
  memFlipped.push(i);
  memRender();
  if (memFlipped.length === 2) {
    memMoves2++;
    document.getElementById('memMoves').textContent = 'Züge: ' + memMoves2;
    memLocked = true;
    setTimeout(() => {
      if (memCards[memFlipped[0]] === memCards[memFlipped[1]]) {
        memMatched.push(...memFlipped);
        SFX.match2();
        document.getElementById('memPairs').textContent = `Paare: ${memMatched.length / 2}/8`;
        if (memMatched.length === 16) {
          document.getElementById('memPairs').textContent = `🎉 Gewonnen in ${memMoves2} Zügen!`;
          SFX.win(); setTimeout(vfxConfetti, 100);
        }
      } else {
        SFX.wrong();
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

/* ═══════════════════════════════════════════════════════════════
   SUDOKU
   ═══════════════════════════════════════════════════════════════ */
let _sudokuPuzzle = [], _sudokuSolution = [], _sudokuCells = [];
const SUDOKU_EASY = [
  '530070000600195000098000060800060003400803001700020006060000280000419005000080079',
  '003020600900305001001806400008102900700000008006708200002609500800203009005010300'
];
const SUDOKU_MEDIUM = [
  '000000000302540000050301070000000004409006005023054790000010502700060830500080000',
  '000075400000000008080190000300001060970000200050700190000024005600000000003850000'
];
const SUDOKU_HARD = [
  '000000000000003085001020000000507000004000100090000000500000073002010000000040009',
  '800000000003600000070090200060005030004806090030001060068090500070030040900000001'
];
function sudokuNew(diff) {
  const sets = diff==='easy'?SUDOKU_EASY : diff==='medium'?SUDOKU_MEDIUM : SUDOKU_HARD;
  const str = sets[Math.floor(Math.random()*sets.length)];
  _sudokuPuzzle = str.split('').map(Number);
  _sudokuSolution = sudokuSolveArr([..._sudokuPuzzle]);
  _sudokuRender();
  document.getElementById('sudokuMsg').textContent = '';
}
function sudokuSolveArr(board) {
  const empty = board.indexOf(0);
  if (empty === -1) return board;
  const row = Math.floor(empty/9), col = empty%9;
  for (let n = 1; n <= 9; n++) {
    if (sudokuValid(board, row, col, n)) {
      board[empty] = n;
      const res = sudokuSolveArr(board);
      if (res) return res;
      board[empty] = 0;
    }
  }
  return null;
}
function sudokuValid(b, r, c, n) {
  for (let i = 0; i < 9; i++) {
    if (b[r*9+i]===n || b[i*9+c]===n) return false;
  }
  const br = Math.floor(r/3)*3, bc = Math.floor(c/3)*3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (b[(br+i)*9+(bc+j)]===n) return false;
  return true;
}
function _sudokuRender() {
  const grid = document.getElementById('sudokuGrid');
  if (!grid) return;
  grid.innerHTML = '';
  _sudokuCells = [];
  for (let i = 0; i < 81; i++) {
    const v = _sudokuPuzzle[i];
    const cell = document.createElement('input');
    cell.type = 'text'; cell.maxLength = 1;
    cell.value = v ? v : '';
    cell.readOnly = !!v;
    const row = Math.floor(i/9), col = i%9;
    const borderR = (row%3===2 && row<8) ? '2px solid #4d9fff' : '1px solid #2a3a4a';
    const borderB = (col%3===2 && col<8) ? '2px solid #4d9fff' : '1px solid #2a3a4a';
    cell.style.cssText = `width:100%;aspect-ratio:1;text-align:center;font-size:clamp(10px,2.5vw,18px);font-weight:700;border:0;border-right:${borderR};border-bottom:${borderB};background:${v?'rgba(77,159,255,0.08)':'rgba(255,255,255,0.03)'};color:${v?'#8ab4c9':'#fff'};outline:none;cursor:${v?'default':'text'};`;
    cell.dataset.idx = i;
    cell.addEventListener('input', () => { cell.value = cell.value.replace(/[^1-9]/g,'').slice(-1); sudokuCheck(); });
    grid.appendChild(cell);
    _sudokuCells.push(cell);
  }
}
function sudokuCheck() {
  let complete = true;
  for (let i = 0; i < 81; i++) {
    const c = _sudokuCells[i]; if (!c) continue;
    const v = parseInt(c.value)||0;
    if (!c.readOnly) {
      if (!v) { complete = false; c.style.color='#fff'; } else if (v===(_sudokuSolution?.[i]||0)) { c.style.color='#4caf50'; } else { c.style.color='#ff5252'; complete = false; }
    }
  }
  if (complete) {
    document.getElementById('sudokuMsg').textContent = '🎉 Gelöst!';
    SFX.chime(); setTimeout(vfxConfetti, 100);
  }
}
function sudokuHint() {
  if (!_sudokuSolution) return;
  for (let i = 0; i < 81; i++) {
    const c = _sudokuCells[i];
    if (c && !c.readOnly && (!c.value || c.value != _sudokuSolution[i])) {
      c.value = _sudokuSolution[i]; c.style.color='#4d9fff'; sudokuCheck(); return;
    }
  }
}
function sudokuSolve() {
  if (!_sudokuSolution) return;
  _sudokuCells.forEach((c,i) => { if (!c.readOnly) { c.value=_sudokuSolution[i]; c.style.color='#4d9fff'; } });
  document.getElementById('sudokuMsg').textContent = '✅ Gelöst!';
}
function initSudoku() { sudokuNew('easy'); }

/* ═══════════════════════════════════════════════════════════════
   HANGMAN
   ═══════════════════════════════════════════════════════════════ */
const HANGMAN_WORDS = ['SCHULE','FREUND','SOMMER','COMPUTER','MUSIK','BUCH','REISE','KÜCHE','WINTER','SPORT','GARTEN','FILM','BRÜCKE','FENSTER','KAFFEE','BLUME','STRAND','VOGEL','HUND','KATZE','HAUS','BAUM','AUTO','TISCH','LAMPE'];
let _hangmanWord = '', _hangmanGuessed = new Set(), _hangmanWrong = 0;
function hangmanNew() {
  _hangmanWord = HANGMAN_WORDS[Math.floor(Math.random()*HANGMAN_WORDS.length)];
  _hangmanGuessed = new Set();
  _hangmanWrong = 0;
  _hangmanRenderWord();
  _hangmanRenderLetters();
  _hangmanDraw(0);
  document.getElementById('hangmanMsg').textContent = '';
}
function _hangmanRenderWord() {
  const el = document.getElementById('hangmanWord');
  if (!el) return;
  el.textContent = _hangmanWord.split('').map(l => _hangmanGuessed.has(l)?l:'_').join(' ');
}
function _hangmanRenderLetters() {
  const el = document.getElementById('hangmanLetters');
  if (!el) return;
  el.innerHTML = '';
  'ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÜ'.split('').forEach(l => {
    const b = document.createElement('button');
    b.textContent = l;
    b.disabled = _hangmanGuessed.has(l) || _hangmanWrong>=6;
    b.style.cssText = `width:36px;height:36px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:${_hangmanGuessed.has(l)?(_hangmanWord.includes(l)?'rgba(76,175,80,0.3)':'rgba(255,82,82,0.3)'):'rgba(255,255,255,0.05)'};color:#fff;cursor:pointer;font-size:0.85rem;font-weight:700;`;
    b.onclick = () => {
      _hangmanGuessed.add(l);
      if (!_hangmanWord.includes(l)) {
        _hangmanWrong++;
        SFX.wrong();
      } else {
        SFX.correct();
      }
      _hangmanRenderWord(); _hangmanRenderLetters(); _hangmanDraw(_hangmanWrong); _hangmanCheckEnd();
    };
    el.appendChild(b);
  });
}
function _hangmanCheckEnd() {
  const msg = document.getElementById('hangmanMsg'); if (!msg) return;
  if (_hangmanWrong >= 6) {
    msg.textContent = `💀 Verloren! Das Wort war: ${_hangmanWord}`; msg.style.color='#ff5252';
    SFX.lose(); vfxShake(document.getElementById('hangmanCanvas'));
    return;
  }
  if (_hangmanWord.split('').every(l => _hangmanGuessed.has(l))) {
    msg.textContent = '🎉 Gewonnen!'; msg.style.color='#4caf50';
    SFX.win(); setTimeout(vfxConfetti, 100);
  }
}
function _hangmanDraw(n) {
  const c = document.getElementById('hangmanCanvas'); if (!c) return;
  const ctx = c.getContext('2d');
  ctx.clearRect(0,0,200,200);
  ctx.strokeStyle='#4d9fff'; ctx.lineWidth=3; ctx.lineCap='round';
  // Gallows
  ctx.beginPath(); ctx.moveTo(20,180); ctx.lineTo(180,180); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(60,180); ctx.lineTo(60,20); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(60,20); ctx.lineTo(130,20); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(130,20); ctx.lineTo(130,40); ctx.stroke();
  if (n>=1) { ctx.beginPath(); ctx.arc(130,55,15,0,Math.PI*2); ctx.stroke(); }
  if (n>=2) { ctx.beginPath(); ctx.moveTo(130,70); ctx.lineTo(130,110); ctx.stroke(); }
  if (n>=3) { ctx.beginPath(); ctx.moveTo(130,80); ctx.lineTo(110,100); ctx.stroke(); }
  if (n>=4) { ctx.beginPath(); ctx.moveTo(130,80); ctx.lineTo(150,100); ctx.stroke(); }
  if (n>=5) { ctx.beginPath(); ctx.moveTo(130,110); ctx.lineTo(110,135); ctx.stroke(); }
  if (n>=6) { ctx.beginPath(); ctx.moveTo(130,110); ctx.lineTo(150,135); ctx.stroke(); }
}
function initHangman() { hangmanNew(); }

/* ═══════════════════════════════════════════════════════════════
   2048
   ═══════════════════════════════════════════════════════════════ */
let _grid2048 = [], _score2048 = 0, _best2048 = 0, _over2048 = false;
const TILE_COLORS = {0:'#1a2a3a',2:'#eee4da',4:'#ede0c8',8:'#f2b179',16:'#f59563',32:'#f67c5f',64:'#f65e3b',128:'#edcf72',256:'#edcc61',512:'#edc850',1024:'#edc53f',2048:'#edc22e'};
function init2048() {
  _grid2048 = Array(16).fill(0); _score2048 = 0; _over2048 = false;
  _best2048 = parseInt(localStorage.getItem('best2048'))||0;
  _add2048(); _add2048(); _render2048();
  document.getElementById('msg2048').textContent = '';
}
function _add2048() {
  const empty = _grid2048.map((v,i)=>v===0?i:-1).filter(i=>i>=0);
  if (!empty.length) return;
  const i = empty[Math.floor(Math.random()*empty.length)];
  _grid2048[i] = Math.random()<0.9 ? 2 : 4;
}
function _render2048() {
  const g = document.getElementById('grid2048'); if (!g) return;
  g.innerHTML = '';
  _grid2048.forEach(v => {
    const d = document.createElement('div');
    const textColor = v <= 4 ? '#776e65' : '#fff';
    d.style.cssText = `aspect-ratio:1;border-radius:8px;background:${TILE_COLORS[v]||'#3c2a1e'};display:flex;align-items:center;justify-content:center;font-weight:900;font-size:${v>=1000?'1rem':v>=100?'1.2rem':'1.5rem'};color:${textColor};`;
    d.textContent = v||'';
    g.appendChild(d);
  });
  document.getElementById('score2048').textContent = _score2048;
  if (_score2048 > _best2048) { _best2048 = _score2048; localStorage.setItem('best2048', _best2048); }
  document.getElementById('best2048').textContent = _best2048;
}
function _slide2048(row) {
  let r = row.filter(v=>v); let changed = false;
  for (let i = 0; i < r.length-1; i++) {
    if (r[i]===r[i+1]) { r[i]*=2; _score2048+=r[i]; r.splice(i+1,1); changed=true; SFX.merge(); }
  }
  while (r.length<4) r.push(0);
  return { row: r, changed: changed || r.some((v,i)=>v!==row[i]) };
}
function _move2048(dir) {
  if (_over2048) return;
  let changed = false;
  if (dir==='left') {
    for (let r = 0; r < 4; r++) { const {row,changed:c} = _slide2048(_grid2048.slice(r*4,r*4+4)); if(c){for(let i=0;i<4;i++)_grid2048[r*4+i]=row[i]; changed=true;} }
  } else if (dir==='right') {
    for (let r = 0; r < 4; r++) { const {row,changed:c} = _slide2048(_grid2048.slice(r*4,r*4+4).reverse()); if(c){for(let i=0;i<4;i++)_grid2048[r*4+(3-i)]=row[i]; changed=true;} }
  } else if (dir==='up') {
    for (let c = 0; c < 4; c++) { const col=[_grid2048[c],_grid2048[4+c],_grid2048[8+c],_grid2048[12+c]]; const {row,changed:ch}=_slide2048(col); if(ch){for(let i=0;i<4;i++)_grid2048[i*4+c]=row[i]; changed=true;} }
  } else {
    for (let c = 0; c < 4; c++) { const col=[_grid2048[12+c],_grid2048[8+c],_grid2048[4+c],_grid2048[c]]; const {row,changed:ch}=_slide2048(col); if(ch){for(let i=0;i<4;i++)_grid2048[(3-i)*4+c]=row[i]; changed=true;} }
  }
  if (changed) { _add2048(); _render2048(); }
  if (_grid2048.includes(2048)) {
    document.getElementById('msg2048').textContent = '🎉 2048 erreicht!';
    SFX.win(); setTimeout(vfxConfetti, 100);
  } else if (!_grid2048.includes(0) && !_canMove2048()) {
    _over2048=true;
    document.getElementById('msg2048').textContent = 'Game Over!';
    SFX.lose(); vfxShake(document.getElementById('grid2048'));
  } else if (changed) {
    SFX.click();
  }
}
function _canMove2048() {
  for (let i = 0; i < 16; i++) {
    if (i%4!==3 && _grid2048[i]===_grid2048[i+1]) return true;
    if (i<12 && _grid2048[i]===_grid2048[i+4]) return true;
  }
  return false;
}
(function(){
  let _t2Start = null;
  document.addEventListener('keydown', e => {
    const m = {ArrowLeft:'left',ArrowRight:'right',ArrowUp:'up',ArrowDown:'down'};
    if (m[e.key] && document.getElementById('2048')?.classList.contains('active')) { e.preventDefault(); _move2048(m[e.key]); }
  });
  document.addEventListener('touchstart', e => { if (document.getElementById('2048')?.classList.contains('active')) _t2Start = e.touches[0]; }, {passive:true});
  document.addEventListener('touchend', e => {
    if (!_t2Start || !document.getElementById('2048')?.classList.contains('active')) return;
    const dx = e.changedTouches[0].clientX - _t2Start.clientX;
    const dy = e.changedTouches[0].clientY - _t2Start.clientY;
    if (Math.abs(dx)>Math.abs(dy)) _move2048(dx>0?'right':'left'); else _move2048(dy>0?'down':'up');
    _t2Start = null;
  }, {passive:true});
})();

/* ═══════════════════════════════════════════════════════════════
   REAKTIONSTEST
   ═══════════════════════════════════════════════════════════════ */
let _rxState = 'idle', _rxStart = 0, _rxTimeout = null, _rxHistory = [];
function initReaction() { _rxState='idle'; _rxHistory=[]; _rxRender(); }
function _rxRender() {
  const box = document.getElementById('reactionBox'); if (!box) return;
  if (_rxState==='idle') { box.style.background='#1a2a3a'; box.textContent='Klicke zum Starten'; }
  else if (_rxState==='wait') { box.style.background='#b71c1c'; box.textContent='Warte…'; }
  else if (_rxState==='go') { box.style.background='#1b5e20'; box.textContent='JETZT KLICKEN!'; }
  const h = document.getElementById('reactionHistory');
  if (h && _rxHistory.length) {
    const avg = Math.round(_rxHistory.reduce((a,b)=>a+b,0)/_rxHistory.length);
    h.textContent = `Letzte: ${_rxHistory.slice(-5).join(', ')} ms | Ø ${avg} ms`;
  }
}
function reactionClick() {
  if (_rxState==='idle'||_rxState==='result') {
    _rxState='wait';
    _rxRender();
    clearTimeout(_rxTimeout);
    _rxTimeout = setTimeout(() => { _rxState='go'; _rxStart=Date.now(); _rxRender(); SFX.correct(); }, 1000+Math.random()*3000);
  } else if (_rxState==='wait') {
    clearTimeout(_rxTimeout); _rxState='idle';
    document.getElementById('reactionResult').textContent='⚠️ Zu früh!';
    SFX.tooEarly();
    setTimeout(() => { _rxState='idle'; _rxRender(); }, 1200);
  } else if (_rxState==='go') {
    const ms = Date.now()-_rxStart;
    _rxHistory.push(ms);
    document.getElementById('reactionResult').textContent = `⚡ ${ms} ms`;
    _rxState='result';
    SFX.pop();
    _rxRender();
    setTimeout(() => { _rxState='idle'; _rxRender(); }, 1500);
  }
}

/* ═══════════════════════════════════════════════════════════════
   ZINSEN-RECHNER
   ═══════════════════════════════════════════════════════════════ */
let _intMode = 'simple';
function initInterest() { interestSetMode('simple'); }
function interestSetMode(m) {
  _intMode = m;
  document.getElementById('intBtnSimple').style.opacity = m==='simple'?'1':'0.5';
  document.getElementById('intBtnCompound').style.opacity = m==='compound'?'1':'0.5';
  interestCalc();
}
function interestCalc() {
  const P = parseFloat(document.getElementById('intCapital')?.value)||0;
  const r = parseFloat(document.getElementById('intRate')?.value)||0;
  const t = parseFloat(document.getElementById('intYears')?.value)||0;
  const el = document.getElementById('intResult'); if (!el) return;
  if (!P||!r||!t) { el.innerHTML='Bitte alle Felder ausfüllen.'; return; }
  const rate = r/100;
  let endValue, zinsen;
  if (_intMode==='simple') {
    zinsen = P*rate*t; endValue = P+zinsen;
    el.innerHTML = `<div style="display:flex;flex-direction:column;gap:8px;"><div>📥 Startkapital: <strong style="color:#fff">€${P.toFixed(2)}</strong></div><div>💰 Zinsen: <strong style="color:#4caf50">€${zinsen.toFixed(2)}</strong></div><div>🏦 Endkapital: <strong style="color:var(--brand)">€${endValue.toFixed(2)}</strong></div></div>`;
  } else {
    endValue = P*Math.pow(1+rate,t); zinsen = endValue-P;
    el.innerHTML = `<div style="display:flex;flex-direction:column;gap:8px;"><div>📥 Startkapital: <strong style="color:#fff">€${P.toFixed(2)}</strong></div><div>💰 Zinseszinsen: <strong style="color:#4caf50">€${zinsen.toFixed(2)}</strong></div><div>🏦 Endkapital: <strong style="color:var(--brand)">€${endValue.toFixed(2)}</strong></div></div>`;
  }
}

/* ═══════════════════════════════════════════════════════════════
   ZITAT-GENERATOR
   ═══════════════════════════════════════════════════════════════ */
const QUOTES = [
  {text:'Der Weg ist das Ziel.',author:'Konfuzius'},
  {text:'Phantasie ist wichtiger als Wissen.',author:'Albert Einstein'},
  {text:'Das Leben ist das, was passiert, während du andere Pläne machst.',author:'John Lennon'},
  {text:'Wer kämpft, kann verlieren. Wer nicht kämpft, hat schon verloren.',author:'Bertolt Brecht'},
  {text:'In der Ruhe liegt die Kraft.',author:'Deutsches Sprichwort'},
  {text:'Erfolg ist die Summe kleiner Anstrengungen.',author:'Robert Collier'},
  {text:'Träume nicht dein Leben, lebe deinen Traum.',author:'Mark Twain'},
  {text:'Man muss das Unmögliche versuchen, um das Mögliche zu erreichen.',author:'Hermann Hesse'},
  {text:'Irren ist menschlich.',author:'Cicero'},
  {text:'Die Grenzen meiner Sprache bedeuten die Grenzen meiner Welt.',author:'Ludwig Wittgenstein'},
  {text:'Handle nur nach derjenigen Maxime, durch die du zugleich wollen kannst, dass sie ein allgemeines Gesetz werde.',author:'Immanuel Kant'},
  {text:'Wissen ist Macht.',author:'Francis Bacon'},
  {text:'Das Glück begünstigt den vorbereiteten Geist.',author:'Louis Pasteur'},
  {text:'Nicht die Verhältnisse machen den Menschen, sondern der Mensch macht die Verhältnisse.',author:'Karl Marx'},
  {text:'Jeder ist seines Glückes Schmied.',author:'Appius Claudius'},
  {text:'Dein heutiges Ich ist das Ergebnis deiner gestrigen Gedanken.',author:'Budda'},
  {text:'Fange nie an aufzuhören, höre nie auf anzufangen.',author:'Cicero'},
  {text:'Es ist besser, ein einziges kleines Licht anzuzünden, als die Dunkelheit zu verfluchen.',author:'Konfuzius'},
  {text:'Mut ist nicht die Abwesenheit von Angst, sondern das Urteil, dass etwas anderes wichtiger ist.',author:'Ambrose Redmoon'},
  {text:'Der beste Zeitpunkt einen Baum zu pflanzen war vor 20 Jahren. Der zweitbeste Zeitpunkt ist jetzt.',author:'Chinesisches Sprichwort'},
];
let _quoteIdx = 0, _quoteFavs = [];
function initQuote() { _quoteIdx = Math.floor(Math.random()*QUOTES.length); _quoteFavs = JSON.parse(localStorage.getItem('quoteFavs')||'[]'); quoteRender(); quoteFavsRender(); }
function quoteRender() {
  const q = QUOTES[_quoteIdx];
  document.getElementById('quoteText').textContent = `„${q.text}"`;
  document.getElementById('quoteAuthor').textContent = `— ${q.author}`;
}
function quoteNext() { _quoteIdx = (_quoteIdx+1)%QUOTES.length; quoteRender(); }
function quoteCopy() { navigator.clipboard?.writeText(`„${QUOTES[_quoteIdx].text}" — ${QUOTES[_quoteIdx].author}`).catch(()=>{}); }
function quoteFav() {
  const q = QUOTES[_quoteIdx];
  if (!_quoteFavs.some(f=>f.text===q.text)) { _quoteFavs.unshift(q); if (_quoteFavs.length>10) _quoteFavs.pop(); localStorage.setItem('quoteFavs',JSON.stringify(_quoteFavs)); quoteFavsRender(); }
}
function quoteFavsRender() {
  const el = document.getElementById('quoteFavs'); if (!el) return;
  el.innerHTML = _quoteFavs.length ? `<div style="font-size:0.8rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--brand);margin-bottom:6px;">❤️ Favoriten</div>` + _quoteFavs.map(f=>`<div style="font-size:0.85rem;color:var(--text-soft);margin-bottom:4px;">„${f.text}" — ${f.author}</div>`).join('') : '';
}

/* ═══════════════════════════════════════════════════════════════
   WÜRFELSIMULATOR
   ═══════════════════════════════════════════════════════════════ */
let _diceType = 6, _diceRollHistory = [];
function initDice() { diceSetType(6); }
function diceSetType(n) { _diceType = n; document.getElementById('diceResults').innerHTML = ''; document.getElementById('diceSum').textContent = `W${n} ausgewählt`; }
function diceRoll() {
  const count = Math.min(10, Math.max(1, parseInt(document.getElementById('diceCount')?.value)||1));
  const results = Array.from({length:count}, () => 1+Math.floor(Math.random()*_diceType));
  const sum = results.reduce((a,b)=>a+b,0);
  const el = document.getElementById('diceResults'); if (!el) return;
  SFX.roll();
  el.innerHTML = results.map(r => `<div style="width:56px;height:56px;border-radius:12px;background:linear-gradient(135deg,#1a2a3a,#0d1f2d);border:2px solid var(--brand);display:flex;align-items:center;justify-content:center;font-size:1.5rem;font-weight:800;color:#fff;">${r}</div>`).join('');
  document.getElementById('diceSum').textContent = count>1 ? `Summe: ${sum}` : `Ergebnis: ${results[0]}`;
  _diceRollHistory.unshift(`W${_diceType}×${count}: ${results.join(',')} = ${sum}`);
  if (_diceRollHistory.length>8) _diceRollHistory.pop();
  document.getElementById('diceHistory').textContent = _diceRollHistory.join(' | ');
}

/* ═══════════════════════════════════════════════════════════════
   STIMMUNGSTAGEBUCH
   ═══════════════════════════════════════════════════════════════ */
let _moodSelected = null;
function initMood() { _moodSelected = null; moodRenderList(); }
function moodSelect(emoji, label) {
  _moodSelected = {emoji, label};
  document.querySelectorAll('#moodEmojis button').forEach(b => b.style.transform = b.title===label ? 'scale(1.4)' : 'scale(1)');
}
function moodSave() {
  if (!_moodSelected) { alert('Bitte erst eine Stimmung wählen.'); return; }
  const note = document.getElementById('moodNote')?.value.trim()||'';
  const entries = JSON.parse(localStorage.getItem('moodDiary')||'[]');
  entries.unshift({ date: new Date().toLocaleDateString('de-DE'), emoji: _moodSelected.emoji, label: _moodSelected.label, note });
  if (entries.length > 90) entries.pop();
  localStorage.setItem('moodDiary', JSON.stringify(entries));
  document.getElementById('moodNote').value = '';
  _moodSelected = null;
  document.querySelectorAll('#moodEmojis button').forEach(b => b.style.transform='scale(1)');
  moodRenderList();
}
function moodRenderList() {
  const el = document.getElementById('moodList'); if (!el) return;
  const entries = JSON.parse(localStorage.getItem('moodDiary')||'[]');
  el.innerHTML = entries.length ? entries.map(e => `<div style="display:flex;gap:12px;align-items:flex-start;background:rgba(255,255,255,0.04);border-radius:10px;padding:10px 14px;"><div style="font-size:1.5rem;line-height:1;">${e.emoji}</div><div><div style="font-size:0.8rem;color:var(--text-soft);">${e.date} — ${e.label}</div>${e.note?`<div style="font-size:0.9rem;color:#fff;margin-top:2px;">${e.note}</div>`:''}</div></div>`).join('') : '<div style="color:var(--text-soft);font-size:0.9rem;">Noch keine Einträge.</div>';
}

/* ═══════════════════════════════════════════════════════════════
   NOTENRECHNER
   ═══════════════════════════════════════════════════════════════ */
let _gradesRows = [];
function initGrades() { _gradesRows = []; document.getElementById('gradesList').innerHTML = ''; gradesAddRow(); gradesAddRow(); gradesCalc(); }
function gradesAddRow() {
  const id = Date.now()+Math.random();
  _gradesRows.push(id);
  const row = document.createElement('div');
  row.id = `gradeRow_${id}`;
  row.style.cssText = 'display:flex;gap:8px;align-items:center;';
  row.innerHTML = `<input type="text" placeholder="Fach" class="tool-input" style="flex:2;" oninput="gradesCalc()"><input type="number" placeholder="Note (1-6)" min="1" max="6" step="0.1" class="tool-input" style="flex:1;" oninput="gradesCalc()"><input type="number" placeholder="Gewicht" min="1" value="1" class="tool-input" style="width:70px;" oninput="gradesCalc()"><button onclick="gradesRemoveRow('${id}')" style="background:none;border:none;color:#ff5252;cursor:pointer;font-size:1.1rem;flex-shrink:0;">✕</button>`;
  document.getElementById('gradesList').appendChild(row);
}
function gradesRemoveRow(id) {
  _gradesRows = _gradesRows.filter(r=>r!==id);
  document.getElementById(`gradeRow_${id}`)?.remove();
  gradesCalc();
}
function gradesClear() { _gradesRows=[]; document.getElementById('gradesList').innerHTML=''; document.getElementById('gradesResult').innerHTML=''; }
function gradesCalc() {
  let total = 0, weight = 0;
  document.querySelectorAll('#gradesList > div').forEach(row => {
    const inputs = row.querySelectorAll('input');
    const g = parseFloat(inputs[1]?.value), w = parseFloat(inputs[2]?.value)||1;
    if (g>=1&&g<=6) { total += g*w; weight += w; }
  });
  const el = document.getElementById('gradesResult'); if (!el) return;
  if (!weight) { el.textContent = 'Noch keine gültigen Noten.'; return; }
  const avg = total/weight;
  const color = avg<=2?'#4caf50':avg<=3?'#8bc34a':avg<=4?'#ff9800':avg<=5?'#ff5722':'#f44336';
  el.innerHTML = `Ø <span style="color:${color};font-size:1.8rem;">${avg.toFixed(2)}</span>`;
}

/* ═══════════════════════════════════════════════════════════════
   WELTZEIT-UHR
   ═══════════════════════════════════════════════════════════════ */
const WORLD_CLOCKS = [
  {city:'Berlin',tz:'Europe/Berlin',flag:'🇩🇪'},
  {city:'London',tz:'Europe/London',flag:'🇬🇧'},
  {city:'New York',tz:'America/New_York',flag:'🇺🇸'},
  {city:'Los Angeles',tz:'America/Los_Angeles',flag:'🇺🇸'},
  {city:'Tokio',tz:'Asia/Tokyo',flag:'🇯🇵'},
  {city:'Dubai',tz:'Asia/Dubai',flag:'🇦🇪'},
  {city:'Sydney',tz:'Australia/Sydney',flag:'🇦🇺'},
  {city:'São Paulo',tz:'America/Sao_Paulo',flag:'🇧🇷'},
  {city:'Moskau',tz:'Europe/Moscow',flag:'🇷🇺'},
  {city:'Singapur',tz:'Asia/Singapore',flag:'🇸🇬'},
  {city:'Kairo',tz:'Africa/Cairo',flag:'🇪🇬'},
  {city:'Mumbai',tz:'Asia/Kolkata',flag:'🇮🇳'},
];
let _wclockInterval = null;
function initWorldclock() {
  const el = document.getElementById('worldclockGrid'); if (!el) return;
  el.innerHTML = WORLD_CLOCKS.map(c=>`<div id="wc_${c.city.replace(/\s/g,'')}" style="background:rgba(255,255,255,0.04);border-radius:12px;padding:14px;text-align:center;"><div style="font-size:1.4rem;">${c.flag}</div><div style="font-size:0.85rem;color:var(--text-soft);margin:4px 0;">${c.city}</div><div id="wcTime_${c.city.replace(/\s/g,'')}" style="font-size:1.2rem;font-weight:700;color:#fff;font-family:monospace;"></div></div>`).join('');
  clearInterval(_wclockInterval);
  const tick = () => { const now = new Date(); WORLD_CLOCKS.forEach(c=>{ const el2=document.getElementById(`wcTime_${c.city.replace(/\s/g,'')}`); if(el2) el2.textContent=now.toLocaleTimeString('de-DE',{timeZone:c.tz,hour:'2-digit',minute:'2-digit',second:'2-digit'}); }); };
  tick(); _wclockInterval = setInterval(tick, 1000);
}

/* ═══════════════════════════════════════════════════════════════
   PONG
   ═══════════════════════════════════════════════════════════════ */
let _pongRAF = null, _pongRunning = false;
let _pong = { bx:240, by:160, bdx:3.5, bdy:2.5, py:120, ey:120, ps:0, es:0, pSpeed:5 };
function initPong() { pongReset(); }
function pongReset() { cancelAnimationFrame(_pongRAF); _pongRunning=false; _pong={bx:240,by:160,bdx:3.5,bdy:2.5,py:120,ey:120,ps:0,es:0,pSpeed:5}; pongDraw(); document.getElementById('pongStartBtn').textContent='▶ Start'; document.getElementById('pongScore').textContent=''; }
function pongStart() {
  if (_pongRunning) return;
  _pongRunning = true;
  document.getElementById('pongStartBtn').textContent='⏸ Läuft';
  const keys = {};
  const kd = e => { keys[e.key]=true; }; const ku = e => { delete keys[e.key]; };
  window.addEventListener('keydown',kd); window.addEventListener('keyup',ku);
  function loop() {
    const p = _pong;
    if (keys['w']||keys['W']||keys['ArrowUp']) p.py = Math.max(0, p.py-p.pSpeed);
    if (keys['s']||keys['S']||keys['ArrowDown']) p.py = Math.min(260, p.py+p.pSpeed);
    // AI
    if (p.ey+30 < p.by) p.ey = Math.min(260, p.ey+3.2); else p.ey = Math.max(0, p.ey-3.2);
    p.bx+=p.bdx; p.by+=p.bdy;
    if (p.by<=0||p.by>=320) { p.bdy*=-1; SFX.bounce(); }
    // player paddle
    if (p.bx<=24 && p.by>=p.py && p.by<=p.py+60) { p.bdx=Math.abs(p.bdx)+0.1; p.bx=24; SFX.bounce(); }
    // enemy paddle
    if (p.bx>=456 && p.by>=p.ey && p.by<=p.ey+60) { p.bdx=-(Math.abs(p.bdx)+0.1); p.bx=456; SFX.bounce(); }
    if (p.bx<=0) { p.es++; p.bx=240; p.by=160; p.bdx=3.5; p.bdy=2.5*Math.sign(p.bdy||1); SFX.score(); }
    if (p.bx>=480) { p.ps++; p.bx=240; p.by=160; p.bdx=-3.5; p.bdy=2.5*Math.sign(p.bdy||1); SFX.score(); }
    pongDraw();
    document.getElementById('pongScore').textContent = `Du ${p.ps} : ${p.es} Computer`;
    if (p.ps>=7||p.es>=7) {
      _pongRunning=false;
      window.removeEventListener('keydown',kd);
      window.removeEventListener('keyup',ku);
      if (p.ps > p.es) {
        document.getElementById('pongScore').textContent+=` — 🎉 Gewonnen!`;
        SFX.win(); setTimeout(vfxConfetti, 100);
      } else {
        document.getElementById('pongScore').textContent+=` — 💀 Verloren!`;
        SFX.lose();
      }
      return;
    }
    _pongRAF = requestAnimationFrame(loop);
  }
  _pongRAF = requestAnimationFrame(loop);
}
function pongDraw() {
  const c = document.getElementById('pongCanvas'); if (!c) return;
  const ctx = c.getContext('2d'), p = _pong;
  ctx.fillStyle='#0d1f2d'; ctx.fillRect(0,0,480,320);
  ctx.setLineDash([10,10]); ctx.strokeStyle='rgba(255,255,255,0.1)'; ctx.beginPath(); ctx.moveTo(240,0); ctx.lineTo(240,320); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle='#4d9fff'; ctx.fillRect(12,p.py,10,60); ctx.fillRect(458,p.ey,10,60);
  ctx.fillStyle='#fff'; ctx.beginPath(); ctx.arc(p.bx,p.by,8,0,Math.PI*2); ctx.fill();
}

/* ═══════════════════════════════════════════════════════════════
   PASSWORT-STÄRKE
   ═══════════════════════════════════════════════════════════════ */
function initPwdcheck() { document.getElementById('pwdCheckInput').value=''; pwdCheckAnalyze(); }
function pwdCheckToggle() {
  const inp = document.getElementById('pwdCheckInput'); if (!inp) return;
  inp.type = inp.type==='password' ? 'text' : 'password';
}
function pwdCheckAnalyze() {
  const pw = document.getElementById('pwdCheckInput')?.value||'';
  const bar = document.getElementById('pwdCheckBar');
  const label = document.getElementById('pwdCheckLabel');
  const tips = document.getElementById('pwdCheckTips');
  if (!bar) return;
  const checks = [pw.length>=8, pw.length>=12, /[A-Z]/.test(pw), /[a-z]/.test(pw), /[0-9]/.test(pw), /[^A-Za-z0-9]/.test(pw)];
  const score = checks.filter(Boolean).length;
  const colors = ['#ff1744','#ff5722','#ff9800','#ffc107','#8bc34a','#4caf50'];
  const labels = ['Sehr schwach','Schwach','Mittelmäßig','Gut','Stark','Sehr stark'];
  bar.style.width = `${Math.round(score/6*100)}%`; bar.style.background = colors[score-1]||'#333';
  label.textContent = pw ? labels[score-1]||'' : '';
  label.style.color = colors[score-1]||'#fff';
  const hints = [];
  if (!checks[0]) hints.push('Mindestens 8 Zeichen verwenden');
  if (!checks[1]) hints.push('12+ Zeichen für maximale Sicherheit');
  if (!checks[2]) hints.push('Großbuchstaben hinzufügen (A-Z)');
  if (!checks[3]) hints.push('Kleinbuchstaben hinzufügen (a-z)');
  if (!checks[4]) hints.push('Zahlen einbauen (0-9)');
  if (!checks[5]) hints.push('Sonderzeichen verwenden (!@#$…)');
  tips.innerHTML = hints.map(h=>`<li>${h}</li>`).join('');
}

/* ═══════════════════════════════════════════════════════════════
   ALTER-RECHNER
   ═══════════════════════════════════════════════════════════════ */
function initAgecalc() {
  const today = new Date();
  document.getElementById('agecalcInput').max = today.toISOString().split('T')[0];
}
function agecalcCalc() {
  const val = document.getElementById('agecalcInput')?.value;
  const el = document.getElementById('agecalcResult'); if (!el) return;
  if (!val) { el.innerHTML = ''; return; }
  const born = new Date(val), now = new Date();
  if (born > now) { el.innerHTML = 'Datum liegt in der Zukunft.'; return; }
  let years = now.getFullYear()-born.getFullYear(), months = now.getMonth()-born.getMonth(), days = now.getDate()-born.getDate();
  if (days < 0) { months--; days += new Date(now.getFullYear(), now.getMonth(), 0).getDate(); }
  if (months < 0) { years--; months += 12; }
  const totalDays = Math.floor((now-born)/86400000);
  const nextBd = new Date(now.getFullYear(), born.getMonth(), born.getDate());
  if (nextBd <= now) nextBd.setFullYear(now.getFullYear()+1);
  const daysUntil = Math.floor((nextBd-now)/86400000);
  el.innerHTML = `<div>🎂 <strong style="color:var(--brand);font-size:1.4rem;">${years} Jahre</strong> ${months} Monate ${days} Tage</div><div style="margin-top:8px;font-size:0.9rem;color:var(--text-soft);">= ${totalDays.toLocaleString('de-DE')} Tage gelebt</div><div style="margin-top:6px;font-size:0.9rem;color:var(--text-soft);">🎈 Nächster Geburtstag in <strong style="color:#fff">${daysUntil}</strong> Tagen</div>`;
}

/* ═══════════════════════════════════════════════════════════════
   KALENDER
   ═══════════════════════════════════════════════════════════════ */
let _calYear = new Date().getFullYear(), _calMonth = new Date().getMonth();
const DE_MONTHS = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
const DE_DAYS = ['Mo','Di','Mi','Do','Fr','Sa','So'];
const DE_HOLIDAYS = {
  '01-01':'Neujahr','05-01':'Tag der Arbeit','10-03':'Tag der Deutschen Einheit','12-25':'1. Weihnachtstag','12-26':'2. Weihnachtstag','12-31':'Silvester'
};
function initCalendar() { _calYear=new Date().getFullYear(); _calMonth=new Date().getMonth(); calendarRender(); }
function calendarNav(d) { _calMonth+=d; if(_calMonth>11){_calMonth=0;_calYear++;} if(_calMonth<0){_calMonth=11;_calYear--;} calendarRender(); }
function calendarRender() {
  document.getElementById('calendarTitle').textContent = `${DE_MONTHS[_calMonth]} ${_calYear}`;
  const g = document.getElementById('calendarGrid'); if (!g) return;
  const today = new Date(); const tY=today.getFullYear(),tM=today.getMonth(),tD=today.getDate();
  const first = new Date(_calYear,_calMonth,1).getDay(); const days = new Date(_calYear,_calMonth+1,0).getDate();
  const startOffset = (first+6)%7;
  let html = DE_DAYS.map(d=>`<div style="font-size:0.75rem;font-weight:700;color:var(--text-soft);padding:4px 0;">${d}</div>`).join('');
  for (let i = 0; i < startOffset; i++) html += '<div></div>';
  for (let d = 1; d <= days; d++) {
    const mm = String(_calMonth+1).padStart(2,'0'), dd = String(d).padStart(2,'0');
    const holiday = DE_HOLIDAYS[`${mm}-${dd}`];
    const isToday = _calYear===tY && _calMonth===tM && d===tD;
    const isSun = (new Date(_calYear,_calMonth,d).getDay()===0);
    const bg = isToday?'linear-gradient(135deg,#0e8a9b,#4d9fff)':'rgba(255,255,255,0.04)';
    const col = holiday?'#ff9800':isSun?'#ff5252':'#fff';
    html += `<div title="${holiday||''}" style="padding:5px 2px;border-radius:8px;background:${bg};color:${col};font-size:0.85rem;cursor:default;font-weight:${isToday?'800':'400'};">${d}${holiday?'*':''}</div>`;
  }
  g.innerHTML = html;
  const holidaysThisMonth = Object.entries(DE_HOLIDAYS).filter(([k])=>k.startsWith(String(_calMonth+1).padStart(2,'0'))).map(([,v])=>v);
  document.getElementById('calendarNote').textContent = holidaysThisMonth.length ? `* ${holidaysThisMonth.join(', ')}` : '';
}

/* ═══════════════════════════════════════════════════════════════
   WORDLE (5-Buchstaben-Wörter, Deutsch)
   ═══════════════════════════════════════════════════════════════ */
const WORDLE_WORDS = ['STEIN','STERN','RUFEN','BUCHE','TIGER','FLUSS','HUNDE','KATZE','MAUER','BRAUT','BRIEF','DUNST','EIMER','FLECK','GARDE','HAFER','JOKER','KARTE','LAMPE','MAGMA','NACHT','OPFER','PFEIL','QUARZ','RAHMEN','SCHUH','TINTE','ULMEN','VATER','WELLE','XENOS','YACHT','ZANGE','AMBER','BLANK','CREPE','DOLCH','EBENE','FALKE','GABEL','HOLME','INSEL','JACKE','KNALL','LAUBE','MILCH','NAPEL','OCKER','PRINZ','QUELL'];
let _wordleWord='', _wordleGuesses=[], _wordleCurrent='', _wordleOver=false;
function initWordle() { wordleNew(); }
function wordleNew() {
  _wordleWord = WORDLE_WORDS[Math.floor(Math.random()*WORDLE_WORDS.length)];
  _wordleGuesses = []; _wordleCurrent = ''; _wordleOver = false;
  wordleRenderGrid(); wordleRenderKeyboard();
  document.getElementById('wordleMsg').textContent = '';
}
function wordleRenderGrid() {
  const el = document.getElementById('wordleGrid'); if (!el) return;
  el.innerHTML = '';
  for (let r = 0; r < 6; r++) {
    const guess = _wordleGuesses[r];
    for (let c = 0; c < 5; c++) {
      const d = document.createElement('div');
      const letter = guess ? guess[c]||'' : (r===_wordleGuesses.length&&_wordleCurrent[c]||'');
      let bg = 'rgba(255,255,255,0.06)'; let col = '#fff'; let border = '2px solid rgba(255,255,255,0.15)';
      if (guess) {
        const result = wordleScore(guess);
        if (result[c]==='correct') { bg='#538d4e'; border='2px solid #538d4e'; }
        else if (result[c]==='present') { bg='#b59f3b'; border='2px solid #b59f3b'; }
        else { bg='#3a3a3c'; border='2px solid #3a3a3c'; }
      } else if (r===_wordleGuesses.length&&_wordleCurrent[c]) border='2px solid rgba(255,255,255,0.4)';
      d.style.cssText = `width:48px;height:48px;border-radius:6px;background:${bg};border:${border};display:flex;align-items:center;justify-content:center;font-size:1.3rem;font-weight:700;color:${col};`;
      d.textContent = letter;
      el.appendChild(d);
    }
  }
}
function wordleScore(guess) {
  const res = Array(5).fill('absent'), word = _wordleWord.split(''), remaining = [...word];
  for (let i = 0; i < 5; i++) { if (guess[i]===word[i]) { res[i]='correct'; remaining[i]=null; } }
  for (let i = 0; i < 5; i++) { if (res[i]==='correct') continue; const ri=remaining.indexOf(guess[i]); if(ri>=0){res[i]='present';remaining[ri]=null;} }
  return res;
}
function wordleRenderKeyboard() {
  const rows = ['QWERTZUIOP','ASDFGHJKL','YXCVBNM'];
  const el = document.getElementById('wordleKeyboard'); if (!el) return;
  el.innerHTML = rows.map(row =>
    `<div style="display:flex;gap:4px;justify-content:center;">${row.split('').concat(row===rows[2]?['⌫','↵']:[]).map(k=>`<button onclick="wordleKey('${k}')" style="min-width:${['⌫','↵'].includes(k)?'44px':'32px'};height:44px;border-radius:6px;border:none;background:rgba(255,255,255,0.12);color:#fff;font-size:0.85rem;font-weight:700;cursor:pointer;">${k}</button>`).join('')}</div>`
  ).join('');
}
function wordleKey(k) {
  if (_wordleOver) return;
  SFX.click();
  if (k==='⌫') { _wordleCurrent=_wordleCurrent.slice(0,-1); }
  else if (k==='↵') { wordleSubmit(); return; }
  else if (_wordleCurrent.length<5) _wordleCurrent+=k;
  wordleRenderGrid();
}
function wordleSubmit() {
  if (_wordleCurrent.length<5) return;
  _wordleGuesses.push(_wordleCurrent); _wordleCurrent='';
  wordleRenderGrid();
  const last = _wordleGuesses[_wordleGuesses.length-1];
  const msg = document.getElementById('wordleMsg');
  if (last===_wordleWord) {
    msg.textContent='🎉 Gewonnen!';
    _wordleOver=true;
    SFX.win(); setTimeout(vfxConfetti, 100);
    return;
  }
  if (last !== _wordleWord) SFX.wrong();
  if (_wordleGuesses.length>=6) {
    msg.textContent=`💀 Verloren! Das Wort war: ${_wordleWord}`;
    _wordleOver=true;
    SFX.lose();
  }
}
(function(){
  document.addEventListener('keydown', e => {
    if (!document.getElementById('wordle')?.classList.contains('active')) return;
    if (e.key==='Backspace') wordleKey('⌫');
    else if (e.key==='Enter') wordleKey('↵');
    else if (/^[A-Za-zÄÖÜäöü]$/.test(e.key)) wordleKey(e.key.toUpperCase());
  });
})();

/* ═══════════════════════════════════════════════════════════════
   BREAKOUT
   ═══════════════════════════════════════════════════════════════ */
let _boRAF = null, _boRunning = false;
let _bo = {};
function initBreakout() { breakoutReset(); }
function breakoutReset() {
  cancelAnimationFrame(_boRAF); _boRunning=false;
  _bo = { bx:240, by:280, bdx:3, bdy:-3, px:200, pw:80, score:0, lives:3, bricks:[] };
  for (let r = 0; r < 5; r++) for (let c = 0; c < 10; c++) _bo.bricks.push({x:c*46+8,y:r*22+30,alive:true,color:`hsl(${r*40+160},80%,55%)`});
  breakoutDraw();
  document.getElementById('breakoutStartBtn').textContent='▶ Start';
  _boUpdateHUD();
}
function _boUpdateHUD() { document.getElementById('breakoutHUD').textContent = `Punkte: ${_bo.score} | Leben: ${'❤️'.repeat(Math.max(0,_bo.lives))}`; }
function breakoutStart() {
  if (_boRunning) return;
  _boRunning=true;
  document.getElementById('breakoutStartBtn').textContent='⏸ Läuft';
  const keys={};
  const kd=e=>{keys[e.key]=true;}; const ku=e=>{delete keys[e.key];};
  window.addEventListener('keydown',kd); window.addEventListener('keyup',ku);
  const canvas = document.getElementById('breakoutCanvas');
  canvas.onmousemove = e => { const r=canvas.getBoundingClientRect(); _bo.px=Math.min(480-_bo.pw,Math.max(0,(e.clientX-r.left)*(480/r.width)-_bo.pw/2)); };
  canvas.ontouchmove = e => { e.preventDefault(); const r=canvas.getBoundingClientRect(); _bo.px=Math.min(480-_bo.pw,Math.max(0,(e.touches[0].clientX-r.left)*(480/r.width)-_bo.pw/2)); };
  function loop() {
    if (keys['ArrowLeft']) _bo.px=Math.max(0,_bo.px-6);
    if (keys['ArrowRight']) _bo.px=Math.min(480-_bo.pw,_bo.px+6);
    _bo.bx+=_bo.bdx; _bo.by+=_bo.bdy;
    if (_bo.bx<=8||_bo.bx>=472) { _bo.bdx*=-1; SFX.bounce(); }
    if (_bo.by<=10) { _bo.bdy*=-1; SFX.bounce(); }
    if (_bo.by>=310 && _bo.bx>=_bo.px && _bo.bx<=_bo.px+_bo.pw) {
      _bo.bdy=-Math.abs(_bo.bdy);
      const rel=(_bo.bx-_bo.px)/_bo.pw-.5;
      _bo.bdx=rel*6;
      SFX.bounce();
    }
    if (_bo.by>320) {
      _bo.lives--;
      SFX.wrong();
      _boUpdateHUD();
      _bo.bx=240; _bo.by=280; _bo.bdx=3*Math.sign(_bo.bdx||1); _bo.bdy=-3;
      if(_bo.lives<=0){
        _boRunning=false;
        window.removeEventListener('keydown',kd);
        window.removeEventListener('keyup',ku);
        document.getElementById('breakoutHUD').textContent+=' — Game Over!';
        SFX.lose();
        breakoutDraw();
        return;
      }
    }
    for (const brick of _bo.bricks) {
      if (!brick.alive) continue;
      if (_bo.bx>=brick.x&&_bo.bx<=brick.x+42&&_bo.by>=brick.y&&_bo.by<=brick.y+16) {
        brick.alive=false;
        _bo.bdy*=-1;
        _bo.score+=10;
        SFX.brickHit();
        _boUpdateHUD();
        break;
      }
    }
    if (_bo.bricks.every(b=>!b.alive)) {
      _boRunning=false;
      window.removeEventListener('keydown',kd);
      window.removeEventListener('keyup',ku);
      document.getElementById('breakoutHUD').textContent+=' — 🎉 Gewonnen!';
      SFX.win(); setTimeout(vfxConfetti, 100);
      breakoutDraw();
      return;
    }
    breakoutDraw();
    _boRAF=requestAnimationFrame(loop);
  }
  _boRAF=requestAnimationFrame(loop);
}
function breakoutDraw() {
  const c=document.getElementById('breakoutCanvas'); if(!c) return;
  const ctx=c.getContext('2d');
  ctx.fillStyle='#0d1f2d'; ctx.fillRect(0,0,480,320);
  _bo.bricks.forEach(b=>{if(!b.alive)return; ctx.fillStyle=b.color; ctx.beginPath(); ctx.roundRect(b.x,b.y,42,16,4); ctx.fill();});
  ctx.fillStyle='#4d9fff'; ctx.beginPath(); ctx.roundRect(_bo.px,300,_bo.pw,10,4); ctx.fill();
  ctx.fillStyle='#fff'; ctx.beginPath(); ctx.arc(_bo.bx,_bo.by,7,0,Math.PI*2); ctx.fill();
}

/* ═══════════════════════════════════════════════════════════════
   FARB-QUIZ
   ═══════════════════════════════════════════════════════════════ */
let _cqAnswer='', _cqScore=0, _cqStreak=0;
function initColorquiz() { _cqScore=0; _cqStreak=0; colorquizNext(); }
function colorquizNext() {
  const r=()=>Math.floor(Math.random()*256);
  _cqAnswer = `#${r().toString(16).padStart(2,'0')}${r().toString(16).padStart(2,'0')}${r().toString(16).padStart(2,'0')}`;
  document.getElementById('colorquizSwatch').style.background = _cqAnswer;
  document.getElementById('colorquizHex').textContent = '?';
  document.getElementById('colorquizPts').textContent = _cqScore;
  document.getElementById('colorquizStreak').textContent = _cqStreak;
  const wrong = Array.from({length:3},()=>`#${r().toString(16).padStart(2,'0')}${r().toString(16).padStart(2,'0')}${r().toString(16).padStart(2,'0')}`);
  const opts = [...wrong, _cqAnswer].sort(()=>Math.random()-.5);
  document.getElementById('colorquizBtns').innerHTML = opts.map(o=>`<button onclick="colorquizGuess('${o}')" style="padding:8px 16px;border-radius:10px;border:2px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.06);color:#fff;font-family:monospace;font-size:1rem;cursor:pointer;">${o.toUpperCase()}</button>`).join('');
}
function colorquizGuess(val) {
  const correct = val===_cqAnswer;
  document.getElementById('colorquizHex').textContent = _cqAnswer.toUpperCase();
  document.querySelectorAll('#colorquizBtns button').forEach(b=>{
    if (b.textContent===_cqAnswer.toUpperCase()) b.style.background='rgba(76,175,80,0.4)';
    else if (b.textContent===val.toUpperCase()&&!correct) b.style.background='rgba(255,82,82,0.4)';
    b.disabled=true;
  });
  if (correct) { _cqScore+=10+_cqStreak*2; _cqStreak++; } else _cqStreak=0;
  setTimeout(colorquizNext, 1200);
}

/* ═══════════════════════════════════════════════════════════════
   ZAHL RATEN
   ═══════════════════════════════════════════════════════════════ */
let _ngRange=100, _ngSecret=0, _ngAttempts=0;
function initNumguess() { numguessSetRange(100); }
function numguessSetRange(n) { _ngRange=n; numguessNew(); }
function numguessNew() { _ngSecret=1+Math.floor(Math.random()*_ngRange); _ngAttempts=0; document.getElementById('numguessInput').value=''; document.getElementById('numguessMsg').textContent=''; document.getElementById('numguessHistory').textContent=''; document.getElementById('numguessInfo').textContent=`Ich denke an eine Zahl zwischen 1 und ${_ngRange}. Rate!`; }
function numguessGuess() {
  const val = parseInt(document.getElementById('numguessInput')?.value);
  if (!val||val<1||val>_ngRange) return;
  _ngAttempts++;
  const msg = document.getElementById('numguessMsg');
  if (val===_ngSecret) { msg.textContent=`🎉 Richtig in ${_ngAttempts} Versuchen!`; msg.style.color='#4caf50'; }
  else { msg.textContent=val<_ngSecret?'⬆️ Höher!':'⬇️ Niedriger!'; msg.style.color='var(--brand)'; }
  document.getElementById('numguessHistory').textContent=`Versuch ${_ngAttempts}`;
  document.getElementById('numguessInput').value='';
}

/* ═══════════════════════════════════════════════════════════════
   GEBURTSTAGS-TRACKER
   ═══════════════════════════════════════════════════════════════ */
function initBirthday() { birthdayRender(); }
function birthdayAdd() {
  const name = document.getElementById('birthdayName')?.value.trim();
  const date = document.getElementById('birthdayDate')?.value;
  if (!name||!date) return;
  const list = JSON.parse(localStorage.getItem('birthdays')||'[]');
  list.push({name,date});
  list.sort((a,b)=>birthdayDaysUntil(a.date)-birthdayDaysUntil(b.date));
  localStorage.setItem('birthdays',JSON.stringify(list));
  document.getElementById('birthdayName').value='';
  document.getElementById('birthdayDate').value='';
  birthdayRender();
}
function birthdayDaysUntil(dateStr) {
  const now=new Date(), bd=new Date(dateStr), next=new Date(now.getFullYear(),bd.getMonth(),bd.getDate());
  if (next<now) next.setFullYear(now.getFullYear()+1);
  return Math.floor((next-now)/86400000);
}
function birthdayRender() {
  const el=document.getElementById('birthdayList'); if(!el) return;
  const list=JSON.parse(localStorage.getItem('birthdays')||'[]');
  el.innerHTML=list.length?list.map((b,i)=>{
    const d=birthdayDaysUntil(b.date);
    const bd=new Date(b.date);
    const age=new Date().getFullYear()-bd.getFullYear();
    return `<div style="display:flex;justify-content:space-between;align-items:center;background:rgba(255,255,255,0.04);border-radius:10px;padding:10px 14px;"><div><div style="font-weight:700;color:#fff;">${b.name}</div><div style="font-size:0.82rem;color:var(--text-soft);">${bd.toLocaleDateString('de-DE')} · ${age} Jahre</div></div><div style="text-align:right;"><div style="font-size:1.1rem;font-weight:700;color:${d===0?'#4caf50':'var(--brand)'};">${d===0?'🎂 Heute!':d===1?'Morgen 🎈':`in ${d} Tagen`}</div><button onclick="birthdayRemove(${i})" style="background:none;border:none;color:#ff5252;cursor:pointer;font-size:0.8rem;">✕</button></div></div>`;
  }).join(''):'<div style="color:var(--text-soft);font-size:0.9rem;">Noch keine Geburtstage gespeichert.</div>';
}
function birthdayRemove(i) {
  const list=JSON.parse(localStorage.getItem('birthdays')||'[]');
  list.splice(i,1); localStorage.setItem('birthdays',JSON.stringify(list)); birthdayRender();
}

/* ═══════════════════════════════════════════════════════════════
   MINESWEEPER
   ═══════════════════════════════════════════════════════════════ */
let _ms = { cols:9, rows:9, mines:10, board:[], revealed:[], flagged:[], started:false, over:false, timer:null, seconds:0 };
function initMinesweeper() { minesweeperNew(9,9,10); }
function minesweeperNew(rows,cols,mines) {
  clearInterval(_ms.timer);
  _ms = { rows, cols, mines, board:Array(rows*cols).fill(0), revealed:Array(rows*cols).fill(false), flagged:Array(rows*cols).fill(false), started:false, over:false, timer:null, seconds:0 };
  document.getElementById('mineCount').textContent=mines;
  document.getElementById('mineTimer').textContent='0';
  document.getElementById('minesweeperMsg').textContent='';
  _msRender();
}
function _msPlace(firstIdx) {
  const forbidden = new Set([firstIdx, ..._msNeighbors(firstIdx, _ms.cols, _ms.rows)]);
  let placed=0;
  while(placed<_ms.mines) { const i=Math.floor(Math.random()*_ms.rows*_ms.cols); if(!forbidden.has(i)&&_ms.board[i]===0){_ms.board[i]=-1;placed++;} }
  for(let i=0;i<_ms.board.length;i++) { if(_ms.board[i]===-1) continue; _ms.board[i]=_msNeighbors(i,_ms.cols,_ms.rows).filter(n=>_ms.board[n]===-1).length; }
}
function _msNeighbors(i, cols, rows) {
  const r=Math.floor(i/cols), c=i%cols, ns=[];
  for(let dr=-1;dr<=1;dr++) for(let dc=-1;dc<=1;dc++) { if(!dr&&!dc) continue; const nr=r+dr,nc=c+dc; if(nr>=0&&nr<rows&&nc>=0&&nc<cols) ns.push(nr*cols+nc); }
  return ns;
}
function _msReveal(i) {
  if(_ms.revealed[i]||_ms.flagged[i]) return;
  _ms.revealed[i]=true;
  if(_ms.board[i]===0) _msNeighbors(i,_ms.cols,_ms.rows).forEach(n=>{ if(!_ms.revealed[n]&&!_ms.flagged[n]) _msReveal(n); });
}
function _msRender() {
  const el=document.getElementById('minesweeperGrid'); if(!el) return;
  el.style.gridTemplateColumns=`repeat(${_ms.cols},1fr)`;
  el.innerHTML='';
  _ms.board.forEach((_,i)=>{
    const d=document.createElement('div');
    const r=_ms.revealed[i], f=_ms.flagged[i];
    const val=_ms.board[i];
    const numColors=['','#1565c0','#2e7d32','#c62828','#4a148c','#b71c1c','#006064','#000','#616161'];
    let content='', bg='rgba(255,255,255,0.1)', col='#fff';
    if(f){content='🚩';}
    else if(!r){bg='rgba(255,255,255,0.1)';}
    else if(val===-1){content='💣';bg='rgba(255,82,82,0.4)';}
    else{bg='rgba(0,0,0,0.2)';content=val||'';col=numColors[val]||'#fff';}
    d.style.cssText=`width:28px;height:28px;display:flex;align-items:center;justify-content:center;border-radius:4px;background:${bg};color:${col};font-size:${val===-1||f?'1rem':'0.85rem'};font-weight:700;cursor:pointer;user-select:none;`;
    d.textContent=content;
    d.onclick=()=>{ if(_ms.over||f) return; if(!_ms.started){_ms.started=true;_msPlace(i);_ms.timer=setInterval(()=>{_ms.seconds++;document.getElementById('mineTimer').textContent=_ms.seconds;},1000);} _msReveal(i); if(_ms.board[i]===-1){_ms.over=true;clearInterval(_ms.timer);_ms.revealed.fill(true);_msRender();document.getElementById('minesweeperMsg').textContent='💥 Mine getroffen! Game Over.';SFX.explosion();return;} const won=_ms.revealed.filter(Boolean).length===_ms.board.length-_ms.mines; if(won){_ms.over=true;clearInterval(_ms.timer);document.getElementById('minesweeperMsg').textContent='🎉 Gewonnen!';SFX.chime(); setTimeout(vfxConfetti, 100);} else SFX.tick(); _msRender(); };
    d.oncontextmenu=e=>{e.preventDefault();if(_ms.over||_ms.revealed[i])return;_ms.flagged[i]=!_ms.flagged[i];const f2=_ms.flagged.filter(Boolean).length;document.getElementById('mineCount').textContent=_ms.mines-f2;_msRender();};
    el.appendChild(d);
  });
}

/* ═══════════════════════════════════════════════════════════════
   INIT-HOOKS für die 20 neuen Tools
   ═══════════════════════════════════════════════════════════════ */
function initReaction()    { _rxState='idle'; _rxHistory=[]; _rxRender(); }
function initInterest()    { interestSetMode('simple'); }
function initQuote()       { _quoteIdx=Math.floor(Math.random()*QUOTES.length); _quoteFavs=JSON.parse(localStorage.getItem('quoteFavs')||'[]'); quoteRender(); quoteFavsRender(); }
function initDice()        { diceSetType(6); }
function initMood()        { _moodSelected=null; moodRenderList(); }
function initGrades()      { _gradesRows=[]; document.getElementById('gradesList').innerHTML=''; document.getElementById('gradesResult').innerHTML=''; gradesAddRow(); gradesAddRow(); gradesCalc(); }
function initWorldclock()  { }
function initPong()        { pongReset(); }
function initPwdcheck()    { document.getElementById('pwdCheckInput').value=''; pwdCheckAnalyze(); }
function initAgecalc()     { const t=new Date(); document.getElementById('agecalcInput').max=t.toISOString().split('T')[0]; }
function initCalendar()    { _calYear=new Date().getFullYear(); _calMonth=new Date().getMonth(); calendarRender(); }
function initWordle()      { wordleNew(); }
function initBreakout()    { breakoutReset(); }
function initColorquiz()   { _cqScore=0; _cqStreak=0; colorquizNext(); }
function initNumguess()    { numguessSetRange(100); }
function initBirthday()    { birthdayRender(); }
function initMinesweeper() { minesweeperNew(9,9,10); }
