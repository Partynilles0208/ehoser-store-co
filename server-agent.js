/**
 * ehoser KI Browser Agent – server-agent.js
 * Deploye diesen Server auf Railway (nicht Vercel!):
 *   1. Neues Railway-Projekt → "Deploy from GitHub" → Repo auswählen
 *   2. Start Command: node server-agent.js
 *   3. Environment Variable: GROQ_API_KEY=...
 *   4. Die Railway-URL (wss://...) in der App eintragen
 */

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '20mb' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_VISION_MODEL = 'llama-3.2-11b-vision-preview';
const VIEWPORT = { width: 1280, height: 720 };
const MAX_STEPS = 20;

// Einmaliger Browser – wird lazy gestartet
let _browserPromise = null;

async function getSharedBrowser() {
  if (!_browserPromise) {
    const puppeteer = require('puppeteer');
    _browserPromise = puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        `--window-size=${VIEWPORT.width},${VIEWPORT.height}`
      ]
    }).catch(err => {
      _browserPromise = null;
      throw err;
    });
  }
  return _browserPromise;
}

// KI-Schritt: Screenshot → Groq Vision → Aktion
async function aiStep(screenshotBase64, task, history, groqKey) {
  const systemPrompt =
    `Du bist ein Web-Browser-Agent. Du siehst einen Screenshot und entscheidest die nächste Aktion.\n` +
    `Antworte AUSSCHLIESSLICH mit gültigem JSON – kein Markdown, keine Erklärungen:\n` +
    `{"thought":"Was du siehst und tust (1-2 Sätze Deutsch)","action":{"type":"navigate|click|type|key|scroll|done|wait","url":"https://...","x":640,"y":360,"text":"...","key":"Enter","direction":"down","amount":300}}\n` +
    `Koordinaten sind Pixel in einem ${VIEWPORT.width}x${VIEWPORT.height} Viewport. type=done wenn fertig.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-6), // Maximal 6 History-Einträge
    {
      role: 'user',
      content: [
        { type: 'text', text: `Aufgabe: ${task}\nNächster Schritt?` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshotBase64}` } }
      ]
    }
  ];

  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${groqKey}`
    },
    body: JSON.stringify({ model: GROQ_VISION_MODEL, messages, max_tokens: 350, temperature: 0.1 })
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Groq Fehler ${res.status}`);

  const content = data?.choices?.[0]?.message?.content || '';
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch {}
    }
    return { thought: content.slice(0, 200), action: { type: 'wait' } };
  }
}

// WebSocket-Verbindung
wss.on('connection', async (ws) => {
  let page = null;
  let agentRunning = false;
  let agentHistory = [];

  const send = (obj) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  };

  const takeScreenshot = async () => {
    if (!page) return null;
    const buf = await page.screenshot({ type: 'jpeg', quality: 65 });
    return buf.toString('base64');
  };

  const sendScreenshot = async (extra = {}) => {
    const data = await takeScreenshot();
    if (!data) return;
    const url = page.url();
    const title = await page.title().catch(() => '');
    send({ type: 'screenshot', data, url, title, ...extra });
  };

  // Browser-Page erstellen
  try {
    const browser = await getSharedBrowser();
    page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await page.goto('about:blank');
    send({ type: 'ready' });
  } catch (err) {
    send({ type: 'error', message: 'Browser konnte nicht gestartet werden: ' + err.message });
    ws.close();
    return;
  }

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    try {
      switch (msg.type) {

        case 'screenshot':
          await sendScreenshot();
          break;

        case 'navigate': {
          let url = (msg.url || '').trim();
          if (!url) return;
          if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
          await sendScreenshot();
          break;
        }

        case 'click':
          await page.mouse.click(msg.x, msg.y);
          await new Promise(r => setTimeout(r, 600));
          await sendScreenshot();
          break;

        case 'type':
          await page.keyboard.type(msg.text || '', { delay: 40 });
          await sendScreenshot();
          break;

        case 'key':
          await page.keyboard.press(msg.key || 'Enter');
          await new Promise(r => setTimeout(r, 500));
          await sendScreenshot();
          break;

        case 'scroll':
          await page.mouse.wheel({ deltaY: msg.direction === 'up' ? -(msg.amount || 300) : (msg.amount || 300) });
          await new Promise(r => setTimeout(r, 400));
          await sendScreenshot();
          break;

        case 'agent_start': {
          if (agentRunning) return;
          const groqKey = process.env.GROQ_API_KEY;
          if (!groqKey) { send({ type: 'error', message: 'GROQ_API_KEY fehlt auf dem Server' }); return; }

          agentRunning = true;
          agentHistory = [];
          const task = msg.task || 'Erkunde das Web';
          send({ type: 'agent_thought', text: `🎯 Aufgabe erhalten: "${task}"`, kind: 'task' });

          for (let step = 0; step < MAX_STEPS && agentRunning; step++) {
            const ss = await takeScreenshot();
            const url = page.url();
            const title = await page.title().catch(() => '');
            send({ type: 'screenshot', data: ss, url, title, step: step + 1 });

            let result;
            try {
              result = await aiStep(ss, task, agentHistory, groqKey);
            } catch (err) {
              send({ type: 'agent_thought', text: `⚠️ KI-Fehler: ${err.message}`, kind: 'error' });
              break;
            }

            send({ type: 'agent_thought', text: result.thought || '...', kind: 'thought' });
            agentHistory.push({ role: 'assistant', content: JSON.stringify(result) });

            const action = result.action || {};

            if (action.type === 'done') {
              send({ type: 'agent_done', message: '✅ Aufgabe abgeschlossen!' });
              agentRunning = false;
              break;
            } else if (action.type === 'navigate' && action.url) {
              let navUrl = action.url;
              if (!/^https?:\/\//i.test(navUrl)) navUrl = 'https://' + navUrl;
              send({ type: 'agent_action', action: 'navigate', detail: navUrl });
              await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
              await new Promise(r => setTimeout(r, 1000));
            } else if (action.type === 'click') {
              const cx = Math.max(0, Math.min(VIEWPORT.width, Math.round(action.x || 640)));
              const cy = Math.max(0, Math.min(VIEWPORT.height, Math.round(action.y || 360)));
              send({ type: 'agent_action', action: 'click', x: cx, y: cy });
              await page.mouse.move(cx, cy);
              await new Promise(r => setTimeout(r, 250));
              await page.mouse.click(cx, cy);
              await new Promise(r => setTimeout(r, 900));
            } else if (action.type === 'type') {
              send({ type: 'agent_action', action: 'type', detail: action.text });
              await page.keyboard.type(action.text || '', { delay: 55 });
              await new Promise(r => setTimeout(r, 500));
            } else if (action.type === 'key') {
              await page.keyboard.press(action.key || 'Enter');
              await new Promise(r => setTimeout(r, 600));
            } else if (action.type === 'scroll') {
              send({ type: 'agent_action', action: 'scroll' });
              await page.mouse.wheel({ deltaY: action.direction === 'up' ? -(action.amount || 300) : (action.amount || 300) });
              await new Promise(r => setTimeout(r, 400));
            } else {
              // wait
              await new Promise(r => setTimeout(r, 1200));
            }
          }

          if (agentRunning) {
            send({ type: 'agent_done', message: `🏁 Max. ${MAX_STEPS} Schritte erreicht.` });
          }
          agentRunning = false;
          break;
        }

        case 'agent_stop':
          agentRunning = false;
          send({ type: 'agent_done', message: '⏹ Agent gestoppt.' });
          break;
      }
    } catch (err) {
      send({ type: 'error', message: err.message });
    }
  });

  ws.on('close', async () => {
    agentRunning = false;
    if (page) await page.close().catch(() => {});
    page = null;
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok', sessions: wss.clients.size }));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`[ehoser KI Browser Agent] Port ${PORT}`));
