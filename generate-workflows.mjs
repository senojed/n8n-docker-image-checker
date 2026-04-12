import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const configPath = path.join(__dirname, 'service-map.json');
const config = JSON.parse(await fs.readFile(configPath, 'utf8'));

const { meta, services } = config;

const serviceMapByService = Object.fromEntries(services.map((service) => [service.service, service]));

function imageAliases(image) {
  const aliases = new Set([image]);
  const trimmed = image.trim();
  aliases.add(trimmed);

  if (!trimmed.startsWith('docker.io/') && !trimmed.startsWith('index.docker.io/')) {
    aliases.add(`docker.io/${trimmed}`);
    aliases.add(`index.docker.io/${trimmed}`);
  }

  if (!trimmed.includes('/')) {
    aliases.add(`library/${trimmed}`);
    aliases.add(`docker.io/library/${trimmed}`);
    aliases.add(`index.docker.io/library/${trimmed}`);
  }

  return [...aliases];
}

const serviceMapByImage = Object.fromEntries(
  services.flatMap((service) => imageAliases(service.image).map((image) => [image, service])),
);

const runtimeConfig = {
  meta,
  services,
  serviceMapByService,
  serviceMapByImage,
};

const sharedRuntime = `
const RUNTIME = ${JSON.stringify(runtimeConfig)};
const META = RUNTIME.meta;
const SERVICE_MAP_BY_IMAGE = RUNTIME.serviceMapByImage;
const SERVICE_MAP_BY_SERVICE = RUNTIME.serviceMapByService;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeImageRef(value) {
  let image = String(value ?? '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .trim();

  image = image.replace(/^docker\\.io\\//, '');
  image = image.replace(/^index\\.docker\\.io\\//, '');
  image = image.replace(/^library\\//, '');

  return image;
}

function floatingTag(image) {
  const match = String(image ?? '').match(/:([^:@]+)$/);
  if (!match) return false;
  return new Set(['latest', 'release', 'stable', 'main', 'master', 'nightly', 'edge']).has(match[1].toLowerCase());
}

function tagVersionFallback(image) {
  const match = String(image ?? '').match(/:([^:@]+)$/);
  if (!match) return null;
  const tag = match[1];
  return floatingTag(image) ? null : tag;
}

function shortDigest(value) {
  if (!value) return null;
  return String(value).replace(/^sha256:/, '').slice(0, 12);
}

function comparableVersion(value) {
  const raw = String(value || '').trim();
  if (/^v\d/i.test(raw)) {
    return raw.slice(1);
  }
  return raw;
}

function buildVersionInspectCommand(updates) {
  const payload = encodeURIComponent(JSON.stringify((updates || []).map((update) => ({
    service: update.service,
    label: update.label,
    image: update.image,
    releaseUrl: update.releaseUrl,
  }))));

  return 'python3 ' + META.sshInspectScriptPath + ' url:' + payload;
}

function readVersionPayload(stdout, stderr) {
  const combined = [stdout || '', stderr || ''].filter(Boolean).join('\\n').trim();
  if (!combined) {
    return { items: [] };
  }

  try {
    return JSON.parse(combined);
  } catch {
    const lines = combined.split(/\\r?\\n/).reverse();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        return JSON.parse(trimmed);
      } catch {
        // ignore parse attempts for non-JSON lines
      }
    }
  }

  return {
    items: [],
    error: 'Nepodarilo se zpracovat metadata verzi z hostu.',
  };
}

function selectVersionText(version, image) {
  return version || tagVersionFallback(image) || 'nezjisteno';
}

function buildVersionDetails(update, metadata) {
  const currentVersion = metadata?.currentVersion || null;
  const targetVersion = metadata?.targetVersion || null;
  const currentDigest = metadata?.currentDigest || null;
  const targetDigest = metadata?.targetDigest || null;
  const currentDigestShort = metadata?.currentDigestShort || shortDigest(currentDigest);
  const targetDigestShort = metadata?.targetDigestShort || shortDigest(targetDigest);

  const currentText = selectVersionText(currentVersion, metadata?.currentImageRef || update.image);
  const targetText = selectVersionText(targetVersion, update.image);

  const note =
    metadata?.note ||
    metadata?.error ||
    (!targetVersion && floatingTag(update.image)
      ? 'Image pouziva floating tag, presna cilova verze nemusi byt v metadata dostupna.'
      : null);

  let hasPendingUpdate = false;
  const comparableCurrentVersion = comparableVersion(currentVersion);
  const comparableTargetVersion = comparableVersion(targetVersion);
  if (!metadata?.error) {
    if (currentDigest && targetDigest) {
      hasPendingUpdate = currentDigest !== targetDigest;
    } else if (comparableCurrentVersion && comparableTargetVersion) {
      hasPendingUpdate = comparableCurrentVersion !== comparableTargetVersion;
    } else if (currentText !== 'nezjisteno' && targetText !== 'nezjisteno') {
      hasPendingUpdate = currentText !== targetText;
    }
  }

  return {
    currentVersion,
    targetVersion,
    currentDigest,
    targetDigest,
    currentDigestShort,
    targetDigestShort,
    currentVersionSource: metadata?.currentVersionSource || null,
    targetVersionSource: metadata?.targetVersionSource || null,
    currentText,
    targetText,
    note,
    metadataError: metadata?.error || null,
    isAlreadyCurrent: Boolean(metadata?.isAlreadyCurrent),
    hasPendingUpdate,
  };
}

function enrichUpdatesWithVersionInfo(prepared, versionPayload) {
  const versionMap = new Map((versionPayload?.items || []).map((item) => [item.service, item]));

  const enrichedUpdates = (prepared.updates || []).map((update) => {
    const metadata = versionMap.get(update.service) || {};
    const version = buildVersionDetails(update, metadata);

    return {
      ...update,
      ...version,
    };
  });

  const inspectionIssues = enrichedUpdates
    .filter((update) => update.metadataError)
    .map((update) => ({
      service: update.service,
      label: update.label,
      image: update.image,
      reason: update.metadataError,
    }));

  const updates = enrichedUpdates.filter((update) => update.hasPendingUpdate);

  const aiContext = updates.map((update) => ({
    service: update.service,
    label: update.label,
    image: update.image,
    releaseUrl: update.releaseUrl,
    riskClass: update.riskClass,
    defaultVerdict: update.defaultVerdict,
    defaultSelected: update.defaultSelected,
    stateful: update.stateful,
    hasDatabase: update.hasDatabase,
    notes: update.notes,
    autoInclude: update.autoInclude,
    currentVersion: update.currentVersion,
    targetVersion: update.targetVersion,
    currentDigestShort: update.currentDigestShort,
    targetDigestShort: update.targetDigestShort,
    isAlreadyCurrent: update.isAlreadyCurrent,
    versionNote: update.note,
  }));

  return {
    ...prepared,
    updates,
    allUpdates: enrichedUpdates,
    aiContext,
    inspectionIssues,
    mappedCount: updates.length,
    notifyCount: updates.length + inspectionIssues.length,
    versionLookupError: versionPayload?.error || null,
  };
}

function buildPreparedCatalog() {
  const updates = Object.values(SERVICE_MAP_BY_SERVICE).map((meta) => ({
    service: meta.service,
    label: meta.label,
    image: normalizeImageRef(meta.image),
    releaseUrl: meta.releaseUrl,
    riskClass: meta.riskClass,
    defaultVerdict: meta.defaultVerdict,
    defaultSelected: Boolean(meta.defaultSelected),
    stateful: Boolean(meta.stateful),
    hasDatabase: Boolean(meta.hasDatabase),
    notes: Array.isArray(meta.notes) ? meta.notes : [],
    autoInclude: Array.isArray(meta.autoInclude) ? meta.autoInclude : [],
  }));

  const baselineReviews = updates.map((update) => {
    const headlineMap = {
      safe: 'Bezpecnejsi kandidat',
      caution: 'Pozor',
      manual_review: 'Rucni kontrola',
    };

    const reason = update.notes.length
      ? update.notes.join(' ')
      : 'Chybi detailni metadata, proto doporucuji opatrnost.';

    return {
      service: update.service,
      verdict: update.defaultVerdict,
      headline: headlineMap[update.defaultVerdict] || 'Pozor',
      reason,
      defaultSelected: Boolean(update.defaultSelected),
    };
  });

  const aiContext = updates.map((update) => ({
    service: update.service,
    label: update.label,
    image: update.image,
    releaseUrl: update.releaseUrl,
    riskClass: update.riskClass,
    defaultVerdict: update.defaultVerdict,
    defaultSelected: update.defaultSelected,
    stateful: update.stateful,
    hasDatabase: update.hasDatabase,
    notes: update.notes,
    autoInclude: update.autoInclude,
  }));

  return {
    baseUrl: META.baseUrl,
    uiUrl: META.baseUrl + '/webhook/' + META.uiPath,
    runUrl: META.baseUrl + '/webhook/' + META.runPath,
    updates,
    unknownUpdates: [],
    inspectionIssues: [],
    baselineReviews,
    aiContext,
    mappedCount: updates.length,
    unknownCount: 0,
    notifyCount: updates.length,
    mailTo: META.mailTo,
    tailscaleNote: META.tailscaleNote,
  };
}

function mergeReviews(base, aiPayload) {
  const reviewMap = new Map((base.baselineReviews || []).map((review) => [review.service, review]));
  const validVerdicts = new Set(['safe', 'caution', 'manual_review']);

  if (aiPayload && Array.isArray(aiPayload.reviews)) {
    for (const review of aiPayload.reviews) {
      if (!review || !review.service || !reviewMap.has(review.service)) continue;
      const previous = reviewMap.get(review.service);
      const verdict = validVerdicts.has(review.verdict) ? review.verdict : previous.verdict;

      reviewMap.set(review.service, {
        service: review.service,
        verdict,
        headline: review.headline || previous.headline,
        reason: review.reason || previous.reason,
        defaultSelected: typeof review.defaultSelected === 'boolean' ? review.defaultSelected : previous.defaultSelected,
      });
    }
  }

  return base.updates.map((update) => ({
    ...update,
    review: reviewMap.get(update.service),
  }));
}

function verdictUi(verdict) {
  if (verdict === 'safe') {
    return { label: 'Bezpecne', className: 'safe' };
  }
  if (verdict === 'manual_review') {
    return { label: 'Rucni kontrola', className: 'manual' };
  }
  return { label: 'Pozor', className: 'caution' };
}
`.trim();

const checkerPrepareCode = `
${sharedRuntime}
const prepared = buildPreparedCatalog();
return [{ json: prepared }];
`.trim();

const versionQueryCode = `
${sharedRuntime}
const prepared = $input.first().json;
return [{
  json: {
    ...prepared,
    inspectSshCommand: buildVersionInspectCommand(prepared.updates || []),
  },
}];
`.trim();

const versionMergeCode = `
${sharedRuntime}
const prepared = $('Build Version Query').first().json;
const versionPayload = readVersionPayload($input.first().json.stdout || '', $input.first().json.stderr || '');
const enriched = enrichUpdatesWithVersionInfo(prepared, versionPayload);
return [{ json: enriched }];
`.trim();

const aiPrompt = [
  'You are a cautious self-hosted Docker update reviewer for a home server.',
  'Return strict JSON only.',
  'Schema: {"reviews":[{"service":"string","verdict":"safe|caution|manual_review","headline":"string","reason":"string","defaultSelected":true|false}]}',
  'Rules:',
  '- Be conservative for auth, storage, workflow automation, and database-backed services.',
  '- If the tracked image tag is floating like latest or release, mention that exact version delta is not fully verified.',
  '- Use currentVersion, targetVersion, digest delta, and versionNote when they are available.',
  '- Prefer manual_review for high-risk stateful apps unless the evidence is clearly low risk.',
  '- Keep reason concise, in Czech, one or two sentences max.',
  '- Output one review per provided service only.',
  '',
  'Context:',
  '{{ JSON.stringify($json.aiContext) }}',
].join('\\n');

const aiMergeCode = `
${sharedRuntime}
const prepared = $('Enrich Updates').first().json;

let parsed = null;
const content = $json?.message?.content ?? $json?.content ?? $json?.output ?? '';
if (typeof content === 'string' && content.trim()) {
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = null;
  }
} else if (content && typeof content === 'object') {
  parsed = content;
}

const updates = mergeReviews(prepared, parsed);
return [{
  json: {
    ...prepared,
    updates,
  },
}];
`.trim();

const checkerBuildCode = `
${sharedRuntime}
const data = $input.first().json;

function renderUpdateRow(update) {
  const verdict = verdictUi(update.review?.verdict);
  const autoIncludeText = update.autoInclude?.length
    ? '<div style="color:#94a3b8;font-size:12px;margin-top:4px">Pri updatu se automaticky doplni: ' + escapeHtml(update.autoInclude.join(', ')) + '</div>'
    : '';
  const digestText = update.currentDigestShort || update.targetDigestShort
    ? '<div style="margin-top:4px">Digest: ' + escapeHtml(update.currentDigestShort || '-') + ' -> ' + escapeHtml(update.targetDigestShort || '-') + '</div>'
    : '';
  const noteText = update.note
    ? '<div style="margin-top:4px;color:#fbbf24">' + escapeHtml(update.note) + '</div>'
    : '';

  return '<tr>' +
    '<td style="padding:12px;border-bottom:1px solid #2d3148;color:#e2e8f0;font-weight:600">' + escapeHtml(update.label) + '</td>' +
    '<td style="padding:12px;border-bottom:1px solid #2d3148;color:#cbd5e1">' +
      '<div style="margin-bottom:6px"><span style="display:inline-block;padding:4px 8px;border-radius:999px;font-size:12px;background:' +
      (verdict.className === 'safe' ? '#14532d;color:#86efac' : verdict.className === 'manual' ? '#7f1d1d;color:#fecaca' : '#78350f;color:#fde68a') +
      '">' + escapeHtml(verdict.label) + '</span></div>' +
      '<div style="font-size:13px">' + escapeHtml(update.review?.reason || '') + '</div>' +
      autoIncludeText +
    '</td>' +
    '<td style="padding:12px;border-bottom:1px solid #2d3148;color:#94a3b8;font-size:12px">' +
      '<div>' + escapeHtml(update.image) + '</div>' +
      '<div style="margin-top:6px">Aktualne: ' + escapeHtml(update.currentText || 'nezjisteno') + '</div>' +
      '<div style="margin-top:4px">Cil: ' + escapeHtml(update.targetText || 'nezjisteno') + '</div>' +
      digestText +
      noteText +
      '<div style="margin-top:6px"><a href="' + escapeHtml(update.releaseUrl) + '" style="color:#93c5fd">release notes</a></div>' +
    '</td>' +
  '</tr>';
}

const mappedRows = data.updates.map(renderUpdateRow).join('');
const unknownRows = (data.unknownUpdates || []).map((item) =>
  '<li style="margin:0 0 8px 18px;color:#fca5a5"><code>' + escapeHtml(item.image) + '</code> - ' + escapeHtml(item.reason) + '</li>'
).join('');
const issueRows = (data.inspectionIssues || []).map((item) =>
  '<li style="margin:0 0 8px 18px;color:#fde68a"><strong>' + escapeHtml(item.label || item.service || item.image) + '</strong> - ' + escapeHtml(item.reason) + '</li>'
).join('');

const html = '<div style="font-family:Segoe UI,Arial,sans-serif;max-width:760px;margin:0 auto;color:#e2e8f0;background:#0f172a;padding:24px;border-radius:16px">' +
  '<h2 style="margin:0 0 8px;color:#f8fafc">Docker updates - Codex</h2>' +
  '<p style="margin:0 0 16px;color:#94a3b8">Nalezeno ' + data.notifyCount + ' polozek. ' + escapeHtml(data.tailscaleNote) + '</p>' +
  (data.versionLookupError ? '<div style="margin:0 0 16px;padding:12px 14px;background:#422006;border:1px solid #92400e;border-radius:12px;color:#fde68a">Version metadata se nepodarilo nacist kompletne: ' + escapeHtml(data.versionLookupError) + '</div>' : '') +
  (data.updates.length
    ? '<table style="width:100%;border-collapse:collapse;background:#111827;border-radius:12px;overflow:hidden">' +
        '<tr style="background:#1f2937"><th style="padding:12px;text-align:left;color:#cbd5e1">Sluzba</th><th style="padding:12px;text-align:left;color:#cbd5e1">AI review</th><th style="padding:12px;text-align:left;color:#cbd5e1">Image</th></tr>' +
        mappedRows +
      '</table>'
    : '<p style="color:#cbd5e1">Nenalezena zadna mapovana sluzba s povolenym update flow.</p>') +
  (unknownRows
    ? '<div style="margin-top:20px;padding:16px;background:#3f1d1d;border:1px solid #7f1d1d;border-radius:12px"><h3 style="margin:0 0 8px;color:#fecaca">Neznamy update - vyzaduje doplneni mapy</h3><ul style="padding:0;margin:0">' + unknownRows + '</ul></div>'
    : '') +
  '<div style="margin-top:24px"><a href="' + escapeHtml(data.uiUrl) + '" style="display:inline-block;background:#2563eb;color:#ffffff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">Otevrit update UI</a></div>' +
  '</div>';

return [{
  json: {
    ...data,
    subject: 'Docker updates - ' + data.notifyCount + ' polozek',
    html,
  },
}];
`.trim();

const uiBuildCode = `
${sharedRuntime}
const data = $input.first().json;

function renderCard(update) {
  const verdict = verdictUi(update.review?.verdict);
  const checked = update.review?.defaultSelected ? 'checked' : '';
  const autoIncludeText = update.autoInclude?.length
    ? '<div class="extra">Pri updatu se automaticky doplni: ' + escapeHtml(update.autoInclude.join(', ')) + '</div>'
    : '';
  const digestText = update.currentDigestShort || update.targetDigestShort
    ? '<div class="meta">Digest: ' + escapeHtml(update.currentDigestShort || '-') + ' -> ' + escapeHtml(update.targetDigestShort || '-') + '</div>'
    : '';
  const noteText = update.note
    ? '<div class="meta note">' + escapeHtml(update.note) + '</div>'
    : '';

  return '<label class="card">' +
    '<div class="check"><input type="checkbox" name="services" value="' + escapeHtml(update.service) + '" ' + checked + '></div>' +
    '<div class="body">' +
      '<div class="topline"><span class="title">' + escapeHtml(update.label) + '</span><span class="badge ' + verdict.className + '">' + escapeHtml(verdict.label) + '</span></div>' +
      '<div class="reason">' + escapeHtml(update.review?.reason || '') + '</div>' +
      autoIncludeText +
      '<div class="meta"><strong>Aktualne:</strong> ' + escapeHtml(update.currentText || 'nezjisteno') + ' | <strong>Cil:</strong> ' + escapeHtml(update.targetText || 'nezjisteno') + '</div>' +
      digestText +
      noteText +
      '<div class="meta"><code>' + escapeHtml(update.service) + '</code> | <code>' + escapeHtml(update.image) + '</code></div>' +
      '<div class="meta"><a href="' + escapeHtml(update.releaseUrl) + '" target="_blank" rel="noreferrer">release notes</a></div>' +
    '</div>' +
  '</label>';
}

const cards = data.updates.map(renderCard).join('');
const unknownCards = (data.unknownUpdates || []).map((item) =>
  '<div class="unknown"><code>' + escapeHtml(item.image) + '</code><div>' + escapeHtml(item.reason) + '</div></div>'
).join('');
const issueCards = (data.inspectionIssues || []).map((item) =>
  '<div class="unknown"><strong>' + escapeHtml(item.label || item.service || item.image) + '</strong><div>' + escapeHtml(item.reason) + '</div></div>'
).join('');

const html = '<!DOCTYPE html><html lang="cs"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>' + escapeHtml(META.uiTitle) + '</title>' +
  '<style>' +
  'body{margin:0;font-family:Segoe UI,Arial,sans-serif;background:#0b1220;color:#e5e7eb;padding:24px}' +
  '.wrap{max-width:960px;margin:0 auto}.hero{margin-bottom:24px}.hero h1{margin:0 0 8px;font-size:30px}.hero p{margin:0;color:#94a3b8}' +
  '.card{display:flex;gap:16px;background:#111827;border:1px solid #1f2937;border-radius:16px;padding:16px;margin-bottom:12px;cursor:pointer}.card:hover{border-color:#374151}' +
  '.check{padding-top:4px}.body{flex:1}.topline{display:flex;gap:12px;align-items:center;justify-content:space-between}.title{font-size:18px;font-weight:700}' +
  '.badge{display:inline-block;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:700}.badge.safe{background:#14532d;color:#86efac}.badge.caution{background:#78350f;color:#fde68a}.badge.manual{background:#7f1d1d;color:#fecaca}' +
  '.reason{margin:10px 0;color:#cbd5e1;line-height:1.45}.meta{font-size:12px;color:#94a3b8;margin-top:8px}.meta a{color:#93c5fd}.meta strong{color:#cbd5e1}.meta.note{color:#fbbf24}.extra{font-size:12px;color:#c4b5fd;margin-top:8px}' +
  '.toolbar{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:24px 0}.toolbar button{background:#2563eb;color:#fff;border:none;border-radius:12px;padding:12px 18px;font-weight:700;cursor:pointer}.toolbar button.secondary{background:#1d4ed8;color:#dbeafe}.toolbar button.ghost{background:#1f2937;color:#e5e7eb}.toolbar button:disabled{opacity:.6;cursor:not-allowed}' +
  '#status{display:none;margin-top:16px;padding:14px 16px;border-radius:12px}.status-ok{background:#14532d;color:#dcfce7}.status-err{background:#7f1d1d;color:#fee2e2}.status-loading{background:#1f2937;color:#cbd5e1}' +
  '.empty,.unknowns,.warning{background:#111827;border:1px solid #1f2937;border-radius:16px;padding:16px;margin-top:16px}.unknown{padding:12px;background:#3f1d1d;border-radius:12px;margin-top:8px;color:#fecaca}.warning{background:#422006;border-color:#92400e;color:#fde68a}' +
  '</style></head><body><div class="wrap">' +
  '<div class="hero"><h1>Docker Updates - UI (Codex)</h1><p>' + escapeHtml(META.uiSubtitle) + ' · ' + escapeHtml(data.tailscaleNote) + '</p></div>' +
  (data.updates.length
    ? '<form id="update-form">' + cards +
        '<div class="toolbar"><button type="submit" id="submit-btn">Spustit update vybranych</button><button type="submit" class="secondary" id="dry-run-btn" data-mode="dry-run">Dry-run bez zmen</button><button type="button" class="ghost" id="toggle-btn">Prepnout vse</button></div>' +
      '</form>'
    : '<div class="empty">Zadne mapovane updaty k bezpecnemu spusteni. Pokud je niz neco v sekci unknown, je potreba nejdriv doplnit service map.</div>') +
  (unknownCards ? '<div class="unknowns"><h2>Unknown updates</h2>' + unknownCards + '</div>' : '') +
  '<div id="status"></div></div>' +
  '<script>' +
    'const form=document.getElementById("update-form");const status=document.getElementById("status");const submitButtons=[...document.querySelectorAll(\\'button[type="submit"]\\')];' +
    'document.getElementById("toggle-btn")?.addEventListener("click",()=>{document.querySelectorAll(\\'input[name="services"]\\').forEach((box)=>{box.checked=!box.checked;});});' +
    'form?.addEventListener("submit",async(event)=>{event.preventDefault();const services=[...document.querySelectorAll(\\'input[name="services"]:checked\\')].map((input)=>input.value);const dryRun=event.submitter?.dataset.mode==="dry-run";if(!services.length){window.alert("Vyber aspon jednu sluzbu.");return;}submitButtons.forEach((button)=>{button.disabled=true;});status.style.display="block";status.className="status-loading";status.textContent=dryRun?"Spoustim dry-run bez zmen...":"Spoustim update...";try{const response=await fetch("' + escapeHtml(data.runUrl) + '",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({services,dryRun})});const payload=await response.json();status.className=payload.ok?"status-ok":"status-err";status.textContent=payload.message || (payload.ok?(dryRun?"Dry-run dokoncen.":"Update dokoncen."):(dryRun?"Dry-run selhal.":"Update selhal."));}catch(error){status.className="status-err";status.textContent="Chyba spojeni: "+error.message;}finally{submitButtons.forEach((button)=>{button.disabled=false;});}});' +
  '</script></body></html>';

return [{ json: { html } }];
`.trim();

const runValidateCode = `
${sharedRuntime}
const body = $input.first().json.body || {};
const requested = Array.isArray(body.services) ? body.services : [];
const dryRun = Boolean(body.dryRun);

if (!requested.length) {
  throw new Error('Neni vybrana zadna sluzba.');
}

const invalid = requested.filter((service) => !SERVICE_MAP_BY_SERVICE[service]);
if (invalid.length) {
  throw new Error('Nepovolene sluzby: ' + invalid.join(', '));
}

const expanded = [];
const seen = new Set();
for (const service of requested) {
  const meta = SERVICE_MAP_BY_SERVICE[service];
  if (!seen.has(service)) {
    seen.add(service);
    expanded.push(service);
  }
  for (const extra of meta.autoInclude || []) {
    if (!seen.has(extra)) {
      seen.add(extra);
      expanded.push(extra);
    }
  }
}

const labels = expanded.map((service) => SERVICE_MAP_BY_SERVICE[service]?.label || service);
const sshCommand = 'bash ' + META.sshScriptPath + (dryRun ? ' --dry-run ' : ' ') + expanded.join(' ');

return [{
  json: {
    requestedServices: requested,
    expandedServices: expanded,
    labels,
    dryRun,
    sshCommand,
    mailTo: META.mailTo,
  },
}];
`.trim();

const runResultCode = `
${sharedRuntime}
const requestData = $('Validate Selection').first().json;
const stdout = $input.first().json.stdout || '';
const stderr = $input.first().json.stderr || '';
const combined = [stdout, stderr].filter(Boolean).join('\\n').trim();
const ok = combined.includes('__RESULT__:OK');
const errorMatch = combined.match(/__RESULT__:ERROR:(.*)/);
const compactOutput = combined.length > 4000 ? combined.slice(0, 4000) + '\\n...[truncated]' : combined;

const message = ok
  ? 'Update dokoncen pro: ' + requestData.labels.join(', ')
  : 'Update selhal pro: ' + requestData.labels.join(', ') + (errorMatch ? ' - ' + errorMatch[1].trim() : '');

const mailHtml = '<div style="font-family:Segoe UI,Arial,sans-serif;max-width:760px;margin:0 auto"><h2>' + escapeHtml(ok ? 'Docker update uspel' : 'Docker update selhal') + '</h2><p>' + escapeHtml(message) + '</p><pre style="white-space:pre-wrap;background:#111827;color:#e5e7eb;padding:16px;border-radius:12px">' + escapeHtml(compactOutput || 'Bez vystupu') + '</pre></div>';

return [{
  json: {
    ok,
    message,
    services: requestData.expandedServices,
    labels: requestData.labels,
    compactOutput,
    mailHtml,
  },
}];
`.trim();

const smallHelpers = `
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function verdictUi(verdict) {
  if (verdict === 'safe') return { label: 'Bezpecne', className: 'safe' };
  if (verdict === 'manual_review') return { label: 'Rucni kontrola', className: 'manual' };
  return { label: 'Pozor', className: 'caution' };
}

function readAiPayload(nodeJson) {
  const content = nodeJson?.message?.content ?? nodeJson?.content ?? nodeJson?.output ?? '';
  if (typeof content === 'string' && content.trim()) {
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
  if (content && typeof content === 'object') {
    return content;
  }
  return null;
}

function mergeReviews(prepared, aiPayload) {
  const reviewMap = new Map((prepared.baselineReviews || []).map((review) => [review.service, review]));
  const validVerdicts = new Set(['safe', 'caution', 'manual_review']);

  if (aiPayload && Array.isArray(aiPayload.reviews)) {
    for (const review of aiPayload.reviews) {
      if (!review || !review.service || !reviewMap.has(review.service)) continue;
      const previous = reviewMap.get(review.service);
      reviewMap.set(review.service, {
        service: review.service,
        verdict: validVerdicts.has(review.verdict) ? review.verdict : previous.verdict,
        headline: review.headline || previous.headline,
        reason: review.reason || previous.reason,
        defaultSelected: typeof review.defaultSelected === 'boolean' ? review.defaultSelected : previous.defaultSelected,
      });
    }
  }

  return prepared.updates.map((update) => ({
    ...update,
    review: reviewMap.get(update.service),
  }));
}
`.trim();

const checkerRenderCode = `
${smallHelpers}
const prepared = $('Enrich Updates').first().json;
const aiPayload = readAiPayload($input.first().json);
const data = { ...prepared, updates: mergeReviews(prepared, aiPayload) };

function renderUpdateRow(update) {
  const verdict = verdictUi(update.review?.verdict);
  const digestText = update.currentDigestShort || update.targetDigestShort
    ? '<div style="color:#94a3b8;font-size:12px;margin-top:4px">Digest: ' + escapeHtml(update.currentDigestShort || '-') + ' -> ' + escapeHtml(update.targetDigestShort || '-') + '</div>'
    : '';
  const noteText = update.note
    ? '<div style="color:#fbbf24;font-size:12px;margin-top:4px">' + escapeHtml(update.note) + '</div>'
    : '';

  return '<tr>' +
    '<td style="padding:12px;border-bottom:1px solid #2d3148;color:#e2e8f0;font-weight:600">' + escapeHtml(update.label) + '</td>' +
    '<td style="padding:12px;border-bottom:1px solid #2d3148;color:#cbd5e1">' +
      '<div style="margin-bottom:6px"><span style="display:inline-block;padding:4px 8px;border-radius:999px;font-size:12px;background:' +
      (verdict.className === 'safe' ? '#14532d;color:#86efac' : verdict.className === 'manual' ? '#7f1d1d;color:#fecaca' : '#78350f;color:#fde68a') +
      '">' + escapeHtml(verdict.label) + '</span></div>' +
    '</td>' +
    '<td style="padding:12px;border-bottom:1px solid #2d3148;color:#cbd5e1;font-size:13px">' +
      '<div><strong>' + escapeHtml(update.currentText || 'nezjisteno') + '</strong> -> <strong>' + escapeHtml(update.targetText || 'nezjisteno') + '</strong></div>' +
      digestText +
      noteText +
      '<div style="margin-top:6px"><a href="' + escapeHtml(update.releaseUrl) + '" style="color:#93c5fd">release notes</a></div>' +
    '</td>' +
  '</tr>';
}

const mappedRows = data.updates.map(renderUpdateRow).join('');
const unknownRows = (data.unknownUpdates || []).map((item) =>
  '<li style="margin:0 0 8px 18px;color:#fca5a5"><code>' + escapeHtml(item.image) + '</code> - ' + escapeHtml(item.reason) + '</li>'
).join('');
const issueRows = (data.inspectionIssues || []).map((item) =>
  '<li style="margin:0 0 8px 18px;color:#fde68a"><strong>' + escapeHtml(item.label || item.service || item.image) + '</strong> - ' + escapeHtml(item.reason) + '</li>'
).join('');

const html = '<div style="font-family:Segoe UI,Arial,sans-serif;max-width:760px;margin:0 auto;color:#e2e8f0;background:#0f172a;padding:24px;border-radius:16px">' +
  '<h2 style="margin:0 0 8px;color:#f8fafc">Docker updates - Codex</h2>' +
  '<p style="margin:0 0 16px;color:#94a3b8">Nalezeno ' + data.notifyCount + ' polozek. ' + escapeHtml(data.tailscaleNote) + '</p>' +
  (data.updates.length
    ? '<table style="width:100%;border-collapse:collapse;background:#111827;border-radius:12px;overflow:hidden">' +
        '<tr style="background:#1f2937"><th style="padding:12px;text-align:left;color:#cbd5e1">Sluzba</th><th style="padding:12px;text-align:left;color:#cbd5e1">Verdikt</th><th style="padding:12px;text-align:left;color:#cbd5e1">Verze</th></tr>' +
        mappedRows +
      '</table>'
    : '<p style="color:#cbd5e1">Nenalezena zadna zastarala mapovana sluzba.</p>') +
  (issueRows
    ? '<div style="margin-top:20px;padding:16px;background:#422006;border:1px solid #92400e;border-radius:12px"><h3 style="margin:0 0 8px;color:#fde68a">Kontrolni chyby</h3><ul style="padding:0;margin:0">' + issueRows + '</ul></div>'
    : '') +
  (unknownRows
    ? '<div style="margin-top:20px;padding:16px;background:#3f1d1d;border:1px solid #7f1d1d;border-radius:12px"><h3 style="margin:0 0 8px;color:#fecaca">Neznamy update - vyzaduje doplneni mapy</h3><ul style="padding:0;margin:0">' + unknownRows + '</ul></div>'
    : '') +
  '<div style="margin-top:24px"><a href="' + escapeHtml(data.uiUrl) + '" style="display:inline-block;background:#2563eb;color:#ffffff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">Otevrit update UI</a></div>' +
  '</div>';

return [{ json: { ...data, subject: 'Docker updates - ' + data.notifyCount + ' polozek', html } }];
`.trim();

const uiRenderCode = `
${smallHelpers}
const prepared = $('Enrich Updates').first().json;
const aiPayload = readAiPayload($input.first().json);
const data = { ...prepared, updates: mergeReviews(prepared, aiPayload) };

function renderCard(update) {
  const verdict = verdictUi(update.review?.verdict);
  const checked = update.review?.defaultSelected ? 'checked' : '';
  const autoIncludeText = update.autoInclude?.length
    ? '<div class="extra">Pri updatu se automaticky doplni: ' + escapeHtml(update.autoInclude.join(', ')) + '</div>'
    : '';
  const digestText = update.currentDigestShort || update.targetDigestShort
    ? '<div class="meta">Digest: ' + escapeHtml(update.currentDigestShort || '-') + ' -> ' + escapeHtml(update.targetDigestShort || '-') + '</div>'
    : '';
  const noteText = update.note
    ? '<div class="meta note">' + escapeHtml(update.note) + '</div>'
    : '';

  return '<label class="card">' +
    '<div class="check"><input type="checkbox" name="services" value="' + escapeHtml(update.service) + '" ' + checked + '></div>' +
    '<div class="body">' +
      '<div class="topline"><span class="title">' + escapeHtml(update.label) + '</span><span class="badge ' + verdict.className + '">' + escapeHtml(verdict.label) + '</span></div>' +
      '<div class="reason">' + escapeHtml(update.review?.reason || '') + '</div>' +
      autoIncludeText +
      '<div class="meta"><strong>Aktualne:</strong> ' + escapeHtml(update.currentText || 'nezjisteno') + ' | <strong>Cil:</strong> ' + escapeHtml(update.targetText || 'nezjisteno') + '</div>' +
      digestText +
      noteText +
      '<div class="meta"><code>' + escapeHtml(update.service) + '</code> | <code>' + escapeHtml(update.image) + '</code></div>' +
      '<div class="meta"><a href="' + escapeHtml(update.releaseUrl) + '" target="_blank" rel="noreferrer">release notes</a></div>' +
    '</div>' +
  '</label>';
}

const cards = data.updates.map(renderCard).join('');
const unknownCards = (data.unknownUpdates || []).map((item) =>
  '<div class="unknown"><code>' + escapeHtml(item.image) + '</code><div>' + escapeHtml(item.reason) + '</div></div>'
).join('');
const issueCards = (data.inspectionIssues || []).map((item) =>
  '<div class="unknown"><strong>' + escapeHtml(item.label || item.service || item.image) + '</strong><div>' + escapeHtml(item.reason) + '</div></div>'
).join('');

const html = '<!DOCTYPE html><html lang="cs"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>Docker Updates</title>' +
  '<style>' +
  'body{margin:0;font-family:Segoe UI,Arial,sans-serif;background:#0b1220;color:#e5e7eb;padding:24px}' +
  '.wrap{max-width:960px;margin:0 auto}.hero{margin-bottom:24px}.hero h1{margin:0 0 8px;font-size:30px}.hero p{margin:0;color:#94a3b8}' +
  '.card{display:flex;gap:16px;background:#111827;border:1px solid #1f2937;border-radius:16px;padding:16px;margin-bottom:12px;cursor:pointer}.card:hover{border-color:#374151}' +
  '.check{padding-top:4px}.body{flex:1}.topline{display:flex;gap:12px;align-items:center;justify-content:space-between}.title{font-size:18px;font-weight:700}' +
  '.badge{display:inline-block;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:700}.badge.safe{background:#14532d;color:#86efac}.badge.caution{background:#78350f;color:#fde68a}.badge.manual{background:#7f1d1d;color:#fecaca}' +
  '.reason{margin:10px 0;color:#cbd5e1;line-height:1.45}.meta{font-size:12px;color:#94a3b8;margin-top:8px}.meta a{color:#93c5fd}.meta strong{color:#cbd5e1}.meta.note{color:#fbbf24}.extra{font-size:12px;color:#c4b5fd;margin-top:8px}' +
  '.toolbar{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:24px 0}.toolbar button{background:#2563eb;color:#fff;border:none;border-radius:12px;padding:12px 18px;font-weight:700;cursor:pointer}.toolbar button.secondary{background:#1d4ed8;color:#dbeafe}.toolbar button.ghost{background:#1f2937;color:#e5e7eb}.toolbar button:disabled{opacity:.6;cursor:not-allowed}' +
  '#status{display:none;margin-top:16px;padding:14px 16px;border-radius:12px}.status-ok{background:#14532d;color:#dcfce7}.status-err{background:#7f1d1d;color:#fee2e2}.status-loading{background:#1f2937;color:#cbd5e1}' +
  '.empty,.unknowns,.warning,.issues{background:#111827;border:1px solid #1f2937;border-radius:16px;padding:16px;margin-top:16px}.unknown{padding:12px;background:#3f1d1d;border-radius:12px;margin-top:8px;color:#fecaca}.warning{background:#422006;border-color:#92400e;color:#fde68a}.issues{background:#422006;border-color:#92400e;color:#fde68a}' +
  '</style></head><body><div class="wrap">' +
  '<div class="hero"><h1>Docker Updates - UI (Codex)</h1><p>' + escapeHtml(data.tailscaleNote) + '</p></div>' +
  (data.versionLookupError ? '<div class="warning">Version metadata se nepodarilo nacist kompletne: ' + escapeHtml(data.versionLookupError) + '</div>' : '') +
  (data.updates.length
    ? '<form id="update-form">' + cards +
        '<div class="toolbar"><button type="submit" id="submit-btn">Spustit update vybranych</button><button type="submit" class="secondary" id="dry-run-btn" data-mode="dry-run">Dry-run bez zmen</button><button type="button" class="ghost" id="toggle-btn">Prepnout vse</button></div>' +
      '</form>'
    : '<div class="empty">Zadne zastarale mapovane sluzby k bezpecnemu spusteni.</div>') +
  (issueCards ? '<div class="issues"><h2>Kontrolni chyby</h2>' + issueCards + '</div>' : '') +
  (unknownCards ? '<div class="unknowns"><h2>Unknown updates</h2>' + unknownCards + '</div>' : '') +
  '<div id="status"></div></div>' +
  '<script>' +
    'const form=document.getElementById("update-form");const status=document.getElementById("status");const submitButtons=[...document.querySelectorAll(\\'button[type="submit"]\\')];' +
    'document.getElementById("toggle-btn")?.addEventListener("click",()=>{document.querySelectorAll(\\'input[name="services"]\\').forEach((box)=>{box.checked=!box.checked;});});' +
    'form?.addEventListener("submit",async(event)=>{event.preventDefault();const services=[...document.querySelectorAll(\\'input[name="services"]:checked\\')].map((input)=>input.value);const dryRun=event.submitter?.dataset.mode==="dry-run";if(!services.length){window.alert("Vyber aspon jednu sluzbu.");return;}submitButtons.forEach((button)=>{button.disabled=true;});status.style.display="block";status.className="status-loading";status.textContent=dryRun?"Spoustim dry-run bez zmen...":"Spoustim update...";try{const response=await fetch("' + escapeHtml(data.runUrl) + '",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({services,dryRun})});const payload=await response.json();status.className=payload.ok?"status-ok":"status-err";status.textContent=payload.message || (payload.ok?(dryRun?"Dry-run dokoncen.":"Update dokoncen."):(dryRun?"Dry-run selhal.":"Update selhal."));}catch(error){status.className="status-err";status.textContent="Chyba spojeni: "+error.message;}finally{submitButtons.forEach((button)=>{button.disabled=false;});}});' +
  '</script></body></html>';

return [{ json: { html } }];
`.trim();

const runResultRenderCode = `
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const requestData = $('Validate Selection').first().json;
const stdout = $input.first().json.stdout || '';
const stderr = $input.first().json.stderr || '';
const combined = [stdout, stderr].filter(Boolean).join('\\n').trim();
const ok = combined.includes('__RESULT__:OK');
const dryRun = Boolean(requestData.dryRun) || combined.includes('__RESULT__:OK:DRY_RUN');
const errorMatch = combined.match(/__RESULT__:ERROR:(.*)/);
const compactOutput = combined.length > 4000 ? combined.slice(0, 4000) + '\\n...[truncated]' : combined;
const actionLabel = dryRun ? 'Dry-run' : 'Update';

const message = ok
  ? actionLabel + ' dokoncen pro: ' + requestData.labels.join(', ')
  : actionLabel + ' selhal pro: ' + requestData.labels.join(', ') + (errorMatch ? ' - ' + errorMatch[1].trim() : '');

const mailHtml = '<div style="font-family:Segoe UI,Arial,sans-serif;max-width:760px;margin:0 auto"><h2>' + escapeHtml(ok ? 'Docker ' + actionLabel.toLowerCase() + ' uspel' : 'Docker ' + actionLabel.toLowerCase() + ' selhal') + '</h2><p>' + escapeHtml(message) + '</p><pre style="white-space:pre-wrap;background:#111827;color:#e5e7eb;padding:16px;border-radius:12px">' + escapeHtml(compactOutput || 'Bez vystupu') + '</pre></div>';

return [{ json: { ok, dryRun, message, services: requestData.expandedServices, labels: requestData.labels, compactOutput, mailHtml } }];
`.trim();

function openAiNode(name, id, position) {
  return {
    id,
    name,
    type: '@n8n/n8n-nodes-langchain.openAi',
    typeVersion: 1.8,
    position,
    onError: 'continueRegularOutput',
    parameters: {
      modelId: {
        __rl: true,
        mode: 'list',
        value: meta.aiModel,
        cachedResultName: meta.aiModel.toUpperCase(),
      },
      messages: {
        values: [
          {
            content: `=${aiPrompt}`,
          },
        ],
      },
      jsonOutput: true,
      options: {
        temperature: 0.2,
      },
    },
  };
}

function sshNode(name, id, position, command) {
  return {
    id,
    name,
    type: 'n8n-nodes-base.ssh',
    typeVersion: 1,
    position,
    parameters: {
      authentication: 'privateKey',
      command,
    },
  };
}

const checkerWorkflow = {
  name: 'Docker Updates - Checker (Codex)',
  nodes: [
    {
      id: 'schedule-1',
      name: 'Denni check 06:30',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [240, 300],
      parameters: {
        rule: {
          interval: [
            {
              field: 'cronExpression',
              expression: '30 6 * * *',
            },
          ],
        },
      },
    },
    {
      id: 'code-1',
      name: 'Prepare Services',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [460, 300],
      parameters: {
        jsCode: checkerPrepareCode,
      },
    },
    {
      id: 'code-version-1',
      name: 'Build Version Query',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [680, 300],
      parameters: {
        jsCode: versionQueryCode,
      },
    },
    sshNode('SSH Inspect Versions', 'ssh-version-1', [900, 300], '={{ $json.inspectSshCommand }}'),
    {
      id: 'code-version-2',
      name: 'Enrich Updates',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [1120, 300],
      parameters: {
        jsCode: versionMergeCode,
      },
    },
    openAiNode('OpenAI AI Review', 'openai-1', [1340, 300]),
    {
      id: 'code-2',
      name: 'Build Mail',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [1560, 300],
      parameters: {
        jsCode: checkerRenderCode,
      },
    },
    {
      id: 'if-1',
      name: 'Anything to Notify?',
      type: 'n8n-nodes-base.if',
      typeVersion: 1,
      position: [1780, 300],
      parameters: {
        conditions: {
          number: [
            {
              value1: '={{ $json.notifyCount }}',
              operation: 'larger',
              value2: 0,
            },
          ],
        },
      },
    },
    {
      id: 'gmail-1',
      name: 'Send Mail',
      type: 'n8n-nodes-base.gmail',
      typeVersion: 2.1,
      position: [2000, 220],
      parameters: {
        sendTo: meta.mailTo,
        subject: '={{ $json.subject }}',
        emailType: 'html',
        message: '={{ $json.html }}',
        options: {},
      },
    },
  ],
  connections: {
    'Denni check 08:30': {
      main: [[{ node: 'Prepare Services', type: 'main', index: 0 }]],
    },
    'Prepare Services': {
      main: [[{ node: 'Build Version Query', type: 'main', index: 0 }]],
    },
    'Build Version Query': {
      main: [[{ node: 'SSH Inspect Versions', type: 'main', index: 0 }]],
    },
    'SSH Inspect Versions': {
      main: [[{ node: 'Enrich Updates', type: 'main', index: 0 }]],
    },
    'Enrich Updates': {
      main: [[{ node: 'OpenAI AI Review', type: 'main', index: 0 }]],
    },
    'OpenAI AI Review': {
      main: [[{ node: 'Build Mail', type: 'main', index: 0 }]],
    },
    'Build Mail': {
      main: [[{ node: 'Anything to Notify?', type: 'main', index: 0 }]],
    },
    'Anything to Notify?': {
      main: [[{ node: 'Send Mail', type: 'main', index: 0 }], []],
    },
  },
  settings: { executionOrder: 'v1' },
};

const uiWorkflow = {
  name: 'Docker Updates - UI (Codex)',
  nodes: [
    {
      id: 'webhook-ui',
      name: 'Webhook UI',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [240, 300],
      webhookId: meta.uiPath,
      parameters: {
        httpMethod: 'GET',
        path: meta.uiPath,
        responseMode: 'responseNode',
        options: {},
      },
    },
    {
      id: 'code-ui-1',
      name: 'Prepare Services',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [460, 300],
      parameters: {
        jsCode: checkerPrepareCode,
      },
    },
    {
      id: 'code-ui-version-1',
      name: 'Build Version Query',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [680, 300],
      parameters: {
        jsCode: versionQueryCode,
      },
    },
    sshNode('SSH Inspect Versions', 'ssh-ui-version', [900, 300], '={{ $json.inspectSshCommand }}'),
    {
      id: 'code-ui-version-2',
      name: 'Enrich Updates',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [1120, 300],
      parameters: {
        jsCode: versionMergeCode,
      },
    },
    openAiNode('OpenAI AI Review', 'openai-ui', [1340, 300]),
    {
      id: 'code-ui-2',
      name: 'Build HTML',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [1560, 300],
      parameters: {
        jsCode: uiRenderCode,
      },
    },
    {
      id: 'respond-ui',
      name: 'Respond HTML',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1.4,
      position: [1780, 300],
      parameters: {
        respondWith: 'text',
        responseBody: '={{ $json.html }}',
        options: {
          responseHeaders: {
            entries: [
              {
                name: 'Content-Type',
                value: 'text/html; charset=utf-8',
              },
            ],
          },
        },
      },
    },
  ],
  connections: {
    'Webhook UI': {
      main: [[{ node: 'Prepare Services', type: 'main', index: 0 }]],
    },
    'Prepare Services': {
      main: [[{ node: 'Build Version Query', type: 'main', index: 0 }]],
    },
    'Build Version Query': {
      main: [[{ node: 'SSH Inspect Versions', type: 'main', index: 0 }]],
    },
    'SSH Inspect Versions': {
      main: [[{ node: 'Enrich Updates', type: 'main', index: 0 }]],
    },
    'Enrich Updates': {
      main: [[{ node: 'OpenAI AI Review', type: 'main', index: 0 }]],
    },
    'OpenAI AI Review': {
      main: [[{ node: 'Build HTML', type: 'main', index: 0 }]],
    },
    'Build HTML': {
      main: [[{ node: 'Respond HTML', type: 'main', index: 0 }]],
    },
  },
  settings: { executionOrder: 'v1' },
};

const runWorkflow = {
  name: 'Docker Updates - Run (Codex)',
  nodes: [
    {
      id: 'webhook-run',
      name: 'Webhook Run',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [240, 300],
      webhookId: meta.runPath,
      parameters: {
        httpMethod: 'POST',
        path: meta.runPath,
        responseMode: 'responseNode',
        options: {},
      },
    },
    {
      id: 'code-run-1',
      name: 'Validate Selection',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [460, 300],
      parameters: {
        jsCode: runValidateCode,
      },
    },
    sshNode('SSH Apply Update', 'ssh-run', [680, 300], '={{ $json.sshCommand }}'),
    {
      id: 'code-run-2',
      name: 'Build Result',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [900, 300],
      parameters: {
        jsCode: runResultRenderCode,
      },
    },
    {
      id: 'respond-run',
      name: 'Respond JSON',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1.4,
      position: [1120, 220],
      parameters: {
        respondWith: 'json',
        responseBody: '={{ JSON.stringify({ ok: $json.ok, dryRun: $json.dryRun, message: $json.message, services: $json.services, output: $json.compactOutput }) }}',
        options: {},
      },
    },
    {
      id: 'if-run-mail',
      name: 'Send Mail?',
      type: 'n8n-nodes-base.if',
      typeVersion: 1,
      position: [1120, 400],
      parameters: {
        conditions: {
          boolean: [
            {
              value1: '={{ $json.dryRun }}',
              operation: 'isFalse',
            },
          ],
        },
      },
    },
    {
      id: 'gmail-run',
      name: 'Send Result Mail',
      type: 'n8n-nodes-base.gmail',
      typeVersion: 2.1,
      position: [1340, 340],
      parameters: {
        sendTo: meta.mailTo,
        subject: '={{ `${$json.dryRun ? ($json.ok ? "DRY-RUN OK" : "DRY-RUN FAIL") : ($json.ok ? "OK" : "FAIL")} Docker update: ${$json.labels.join(", ")}` }}',
        emailType: 'html',
        message: '={{ $json.mailHtml }}',
        options: {},
      },
    },
  ],
  connections: {
    'Webhook Run': {
      main: [[{ node: 'Validate Selection', type: 'main', index: 0 }]],
    },
    'Validate Selection': {
      main: [[{ node: 'SSH Apply Update', type: 'main', index: 0 }]],
    },
    'SSH Apply Update': {
      main: [[{ node: 'Build Result', type: 'main', index: 0 }]],
    },
    'Build Result': {
      main: [[
        { node: 'Respond JSON', type: 'main', index: 0 },
        { node: 'Send Mail?', type: 'main', index: 0 },
      ]],
    },
    'Send Mail?': {
      main: [[{ node: 'Send Result Mail', type: 'main', index: 0 }], []],
    },
  },
  settings: { executionOrder: 'v1' },
};

const artifacts = {
  'allowed-services.txt': services.map((service) => service.service).join('\n') + '\n',
  'workflow-A-checker.json': JSON.stringify(checkerWorkflow, null, 2) + '\n',
  'workflow-B-ui.json': JSON.stringify(uiWorkflow, null, 2) + '\n',
  'workflow-C-run.json': JSON.stringify(runWorkflow, null, 2) + '\n',
};

const printOnly = process.argv[2];
if (printOnly) {
  if (!artifacts[printOnly]) {
    console.error(`Unknown artifact: ${printOnly}`);
    process.exit(1);
  }
  process.stdout.write(artifacts[printOnly]);
  process.exit(0);
}

for (const [filename, content] of Object.entries(artifacts)) {
  await fs.writeFile(path.join(__dirname, filename), content);
}

console.log('Generated workflows and allowed-services.txt');
