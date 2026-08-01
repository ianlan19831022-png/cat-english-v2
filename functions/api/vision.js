const MODEL = '@cf/moondream/moondream3.1-9B-A2B';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_SENTENCES = 40;
const MAX_SENTENCE_LENGTH = 300;
const MAX_BODY_CHARS = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 2048;
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 6;
const requestWindows = new Map();

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Cat-English-Vision': '3',
    },
  });
}

function isRateLimited(request) {
  const now = Date.now();
  const key = request.headers.get('CF-Connecting-IP') || 'unknown';
  const current = requestWindows.get(key);
  if (!current || now - current.startedAt >= WINDOW_MS) {
    requestWindows.set(key, { startedAt: now, count: 1 });
    return false;
  }
  current.count += 1;
  if (requestWindows.size > 500) {
    for (const [storedKey, value] of requestWindows) {
      if (now - value.startedAt >= WINDOW_MS) requestWindows.delete(storedKey);
    }
  }
  return current.count > MAX_REQUESTS_PER_WINDOW;
}

function validateSameOrigin(request) {
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && !['same-origin', 'none'].includes(site)) return false;
  const origin = request.headers.get('Origin');
  return !origin || origin === new URL(request.url).origin;
}

function parseImage(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return null;
  const encoded = match[2];
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const bytes = Math.floor((encoded.length * 3) / 4) - padding;
  if (bytes <= 0 || bytes > MAX_IMAGE_BYTES) return { tooLarge: bytes > MAX_IMAGE_BYTES };
  return { dataUrl: value, bytes };
}

function extractJson(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

function saysNoEnglish(text) {
  const answer = String(text || '').replace(/\s+/g, ' ').trim();
  return /^NO_ENGLISH$/i.test(answer)
    || /\bno (?:readable |visible )?(?:english )?text\b/i.test(answer)
    || /\bno (?:readable |visible )?english\b/i.test(answer)
    || /\bdoes(?: not|n't) contain (?:any )?(?:readable |visible )?english\b/i.test(answer);
}

function parseTranscription(text) {
  const answer = String(text || '').trim();
  if (!answer) return null;
  const parsed = extractJson(answer);
  if (parsed) return validateSentences(parsed.sentences);
  if (saysNoEnglish(answer)) return [];

  const cleaned = answer.replace(/^```(?:text)?\s*/i, '').replace(/\s*```$/, '').trim();
  const lines = cleaned.split(/\r?\n/).map(line => line
    .replace(/^\s*(?:[-*•]+|\d+[.)])\s*/, '')
    .replace(/^(?:the (?:visible )?(?:english )?text (?:reads|is)|transcription|english text)\s*:\s*/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim())
    .filter(line => line && !/^(?:here (?:is|are)|transcription|english text)\s*:?$/i.test(line));
  const entries = lines.flatMap(line => {
    const parts = (line.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || []).map(part => part.trim()).filter(Boolean);
    return parts.length > 1 ? parts : [line];
  });
  return validateSentences(entries);
}

function modelText(response) {
  if (typeof response === 'string') return response;
  const direct = [response?.answer, response?.response, response?.text, response?.description];
  const nested = [response?.result?.answer, response?.result?.response, response?.result?.text, response?.result?.description];
  return [...direct, ...nested].find(value => typeof value === 'string') || '';
}

function validateSentences(value) {
  if (!Array.isArray(value)) return null;
  const output = [];
  const seen = new Set();
  for (const item of value.slice(0, MAX_SENTENCES)) {
    if (typeof item !== 'string') continue;
    const sentence = item.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!sentence || sentence.length > MAX_SENTENCE_LENGTH || !/[A-Za-z]/.test(sentence)) continue;
    const key = sentence.toLowerCase().replace(/’/g, "'").replace(/[.!?]+$/, '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);output.push(sentence);
  }
  return output;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return json({ code: 'METHOD_NOT_ALLOWED' }, 405);
  if (!validateSameOrigin(request)) return json({ code: 'FORBIDDEN' }, 403);
  if (isRateLimited(request)) return json({ code: 'RATE_LIMITED' }, 429);
  if (!env.AI) return json({ code: 'AI_NOT_CONFIGURED' }, 503);
  if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) {
    return json({ code: 'INVALID_IMAGE' }, 415);
  }

  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  if (declaredLength > MAX_BODY_CHARS) return json({ code: 'IMAGE_TOO_LARGE' }, 413);
  let body;
  try {
    const rawBody = await request.text();
    if (rawBody.length > MAX_BODY_CHARS) return json({ code: 'IMAGE_TOO_LARGE' }, 413);
    body = JSON.parse(rawBody);
  } catch { return json({ code: 'INVALID_IMAGE' }, 400); }
  const image = parseImage(body?.image);
  if (!image) return json({ code: 'INVALID_IMAGE' }, 400);
  if (image.tooLarge) return json({ code: 'IMAGE_TOO_LARGE' }, 413);

  const question = `Transcribe only the English text that is visibly present in this image.
Do not describe the image, translate, correct, complete, infer, or invent text.
Preserve punctuation and reading order. Put each sentence, menu item, or useful English heading on its own line.
Return transcription lines only: no JSON, bullets, numbering, headings, explanations, or translations.
If no readable English is visible, return exactly NO_ENGLISH. Return at most ${MAX_SENTENCES} lines.`;

  let modelResponse;
  try {
    modelResponse = await env.AI.run(MODEL, {
      task: 'query', image: image.dataUrl, question,
      reasoning: false, temperature: 0, max_tokens: 1800, stream: false,
    });
  } catch (error) {
    const message = String(error?.message || '');
    const quota = /quota|limit|neurons|capacity/i.test(message);
    return json({ code: quota ? 'AI_QUOTA' : 'AI_FAILED' }, quota ? 429 : 502);
  }

  const sentences = parseTranscription(modelText(modelResponse));
  if (!sentences) return json({ code: 'MODEL_FORMAT' }, 502);
  if (!sentences.length) return json({ code: 'NO_ENGLISH' }, 422);
  return json({ sentences, model: MODEL });
}
