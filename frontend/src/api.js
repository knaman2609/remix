const BASE = '';

export async function uploadSong(file) {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${BASE}/api/upload`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function pollStatus(jobId) {
  const res = await fetch(`${BASE}/api/status/${jobId}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function swapStem(jobId, stem, stylePrompt, durationSeconds) {
  const res = await fetch(`${BASE}/api/swap-stem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      job_id: jobId,
      stem,
      style_prompt: stylePrompt,
      duration_seconds: durationSeconds,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function analyzeSong(jobId) {
  const res = await fetch(`${BASE}/api/analyze?job_id=${jobId}`, { method: 'POST' });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function exportMix(jobId, stemChoices) {
  const res = await fetch(`${BASE}/api/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: jobId, stem_choices: stemChoices }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function youtubeDownload(url) {
  const res = await fetch(`${BASE}/api/youtube`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function trimAndProcess(jobId, startSeconds, endSeconds) {
  const body = { job_id: jobId };
  if (startSeconds != null) body.start_seconds = startSeconds;
  if (endSeconds != null) body.end_seconds = endSeconds;
  const res = await fetch(`${BASE}/api/trim-and-process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchSwapHistory() {
  const res = await fetch(`${BASE}/api/swap-history`);
  return res.json();
}

export async function fetchLibrary() {
  const res = await fetch(`${BASE}/api/library`);
  return res.json();
}

export async function suggestMatch(jobId, keywords = '') {
  const res = await fetch(`${BASE}/api/suggest-match`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: jobId, keywords }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function healthCheck() {
  const res = await fetch(`${BASE}/api/health`);
  return res.json();
}
