import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultConfigPath = path.join(__dirname, 'service-map.json');
const defaultLocalConfigPath = path.join(__dirname, 'config.local.json');
const templateMetaPlaceholders = {
  baseUrl: '__BASE_URL__',
  mailTo: '__MAIL_TO__',
  mailFrom: '__MAIL_FROM__',
  checkerHeartbeatUrl: '__CHECKER_HEARTBEAT_URL__',
  operatorIdentityHeader: '__OPERATOR_IDENTITY_HEADER__',
  precheckDiskUsageLimitPct: '__PRECHECK_DISK_USAGE_LIMIT_PCT__',
  backupMarkerPath: '__BACKUP_MARKER_PATH__',
  backupMarkerMaxAgeSeconds: '__BACKUP_MARKER_MAX_AGE_SECONDS__',
  uiPath: '__UI_PATH__',
  runPath: '__RUN_PATH__',
  operators: [
    {
      id: '__OPERATOR__',
      label: '__OPERATOR_LABEL__',
      token: '__OPERATOR_TOKEN__',
      identities: ['__OPERATOR_IDENTITY__'],
    },
  ],
  smtpCredentialName: '__SMTP_CREDENTIAL_NAME__',
  sshCredentialName: '__SSH_CREDENTIAL_NAME__',
  sshHost: '__SSH_HOST__',
};

function mergeConfig(baseConfig, overrideConfig) {
  return {
    ...baseConfig,
    ...overrideConfig,
    meta: {
      ...(baseConfig.meta || {}),
      ...(overrideConfig.meta || {}),
    },
    services: overrideConfig.services || baseConfig.services,
  };
}

function parseCliArgs(argv) {
  let configPath = defaultConfigPath;
  let printOnly = null;
  let templateOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--config') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('Missing value for --config');
      }
      configPath = path.resolve(__dirname, next);
      index += 1;
      continue;
    }

    if (arg === '--print-only') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('Missing value for --print-only');
      }
      printOnly = next;
      index += 1;
      continue;
    }

    if (arg === '--template-only') {
      templateOnly = true;
      continue;
    }

    if (!arg.startsWith('--') && !printOnly) {
      printOnly = arg;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { configPath, printOnly, templateOnly };
}

async function loadConfig(filePath) {
  const resolvedPath = path.resolve(filePath);
  const rawConfig = JSON.parse(await fs.readFile(resolvedPath, 'utf8'));

  if (!rawConfig.extends) {
    return rawConfig;
  }

  const baseConfig = await loadConfig(path.resolve(path.dirname(resolvedPath), rawConfig.extends));

  return mergeConfig(baseConfig, rawConfig);
}

async function loadLocalConfig(configPath) {
  try {
    const rawLocalConfig = JSON.parse(await fs.readFile(defaultLocalConfigPath, 'utf8'));
    const relativeConfigPath = path.relative(__dirname, configPath).replace(/\\/g, '/');
    const profileConfig =
      rawLocalConfig.profiles?.[relativeConfigPath] ||
      rawLocalConfig.profiles?.[path.basename(relativeConfigPath)] ||
      {};

    return mergeConfig(rawLocalConfig.defaults || {}, profileConfig);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function isUnsetLocalValue(value) {
  if (typeof value !== 'string') {
    return true;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return true;
  }

  return /^__.+__$/.test(trimmed);
}

function normalizeLocalOperatorEntry(entry) {
  if (typeof entry === 'string') {
    const id = entry.trim();
    if (isUnsetLocalValue(id)) {
      return null;
    }

    return {
      id,
      token: null,
    };
  }

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }

  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  if (isUnsetLocalValue(id)) {
    return null;
  }

  const token = typeof entry.token === 'string' && entry.token.trim() && !isUnsetLocalValue(entry.token)
    ? entry.token.trim()
    : null;

  return {
    id,
    token,
  };
}

function normalizeHeaderMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      ([name, headerValue]) =>
        typeof name === 'string' &&
        name.trim() &&
        typeof headerValue === 'string' &&
        headerValue.trim() &&
        !isUnsetLocalValue(headerValue),
    ),
  );
}

function buildTemplateConfig(config) {
  return mergeConfig(config, {
    meta: templateMetaPlaceholders,
  });
}

function validateRenderedConfig(config, configPath) {
  const requiredMetaKeys = [
    'baseUrl',
    'mailTo',
    'mailFrom',
    'uiPath',
    'runPath',
    'smtpCredentialName',
    'sshCredentialName',
    'sshHost',
  ];
  const missingKeys = requiredMetaKeys.filter((key) => isUnsetLocalValue(config.meta?.[key]));
  const operators = Array.isArray(config.meta?.operators)
    ? config.meta.operators
        .map((operator) => {
          if (typeof operator === 'string') {
            return isUnsetLocalValue(operator) ? null : operator.trim();
          }

          if (!operator || typeof operator !== 'object' || Array.isArray(operator)) {
            return null;
          }

          const operatorId = typeof operator.id === 'string' ? operator.id.trim() : '';
          return isUnsetLocalValue(operatorId) ? null : operatorId;
        })
        .filter(Boolean)
    : [];

  if (!operators.length) {
    missingKeys.push('operators[0]');
  }

  const normalizedOperators = Array.isArray(config.meta?.operators)
    ? config.meta.operators
        .map((operator) => normalizeLocalOperatorEntry(operator))
        .filter(Boolean)
    : [];
  const trustedOperatorHeader =
    typeof config.meta?.operatorIdentityHeader === 'string' &&
    config.meta.operatorIdentityHeader.trim() &&
    !isUnsetLocalValue(config.meta.operatorIdentityHeader)
      ? config.meta.operatorIdentityHeader.trim()
      : null;
  const operatorsWithoutToken = normalizedOperators
    .filter((operator) => !operator.token)
    .map((operator) => operator.id);

  if (!trustedOperatorHeader && !normalizedOperators.some((operator) => operator.token)) {
    missingKeys.push('operatorIdentityHeader or operators[].token');
  }

  if (!trustedOperatorHeader && operatorsWithoutToken.length) {
    missingKeys.push(`operators[].token for: ${operatorsWithoutToken.join(', ')}`);
  }

  if (missingKeys.length > 0) {
    throw new Error(
      `Missing required rendered config values for ${path.basename(configPath)}: ${missingKeys.join(', ')}. ` +
        'Fill them in config.local.json or run with --template-only.',
    );
  }

  return config;
}

function renderedArtifactName(filename) {
  if (filename.includes('workflows/legacy/')) {
    return filename
      .replace('workflows/legacy/', 'workflows/rendered/legacy/')
      .replace(/\.json$/, '.rendered.json');
  }

  if (filename.includes('workflows/hardening-test/')) {
    return filename
      .replace('workflows/hardening-test/', 'workflows/rendered/hardening-test/')
      .replace(/\.json$/, '.rendered.json');
  }

  if (!filename.endsWith('.json')) {
    return filename;
  }

  return filename.replace(/\.json$/, '.rendered.json');
}

const cli = parseCliArgs(process.argv.slice(2));
const configPath = cli.configPath;
const baseConfig = await loadConfig(configPath);
const localConfig = cli.templateOnly ? null : await loadLocalConfig(configPath);

if (!cli.templateOnly && !localConfig) {
  throw new Error(
    'Missing config.local.json. Copy config.local.example.json to config.local.json and fill local values, or run with --template-only.',
  );
}

const config = cli.templateOnly
  ? buildTemplateConfig(baseConfig)
  : validateRenderedConfig(mergeConfig(baseConfig, localConfig), configPath);

const { meta, services } = config;
const workflowNames = meta.workflowNames || {
  checker: 'Docker Updates - Checker (Codex)',
  ui: 'Docker Updates - UI (Codex)',
  run: 'Docker Updates - Run (Codex)',
};
const artifactNames = meta.artifactNames || {
  allowedServices: 'workflows/legacy/allowed-services.txt',
  checker: 'workflows/legacy/workflow-A-checker.json',
  ui: 'workflows/legacy/workflow-B-ui.json',
  run: 'workflows/legacy/workflow-C-run.json',
};
const checkerTriggerMode = meta.checkerTriggerMode === 'manual' ? 'manual' : 'schedule';
const checkerHeartbeatUrl = isUnsetLocalValue(meta.checkerHeartbeatUrl) ? null : meta.checkerHeartbeatUrl;
const checkerHeartbeatHeaders = normalizeHeaderMap(meta.checkerHeartbeatHeaders);
const checkerHeartbeatEnabled = checkerTriggerMode === 'schedule' && Boolean(checkerHeartbeatUrl);
const uiHeading = meta.uiHeading || workflowNames.ui;
const mailHeading = meta.mailHeading || `Docker updates - ${meta.variantName || 'Codex'}`;

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

function isPlaceholderValue(value) {
  return typeof value === 'string' && /^__.+__$/.test(value.trim());
}

function identityCandidates(value) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return [];
  }

  const normalized = raw.toLowerCase();
  const candidates = new Set([normalized]);
  const localPart = normalized.includes('@') ? normalized.split('@')[0] : normalized;
  if (localPart) {
    candidates.add(localPart);
  }
  return [...candidates];
}

function normalizeOperatorEntry(entry) {
  if (typeof entry === 'string') {
    const id = entry.trim();
    if (!id || isPlaceholderValue(id)) {
      return null;
    }

    return {
      id,
      label: id,
      token: null,
      identities: identityCandidates(id),
    };
  }

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }

  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  if (!id || isPlaceholderValue(id)) {
    return null;
  }

  const label = typeof entry.label === 'string' && entry.label.trim() && !isPlaceholderValue(entry.label)
    ? entry.label.trim()
    : id;
  const token = typeof entry.token === 'string' && entry.token.trim() && !isPlaceholderValue(entry.token)
    ? entry.token.trim()
    : null;
  const rawIdentities = Array.isArray(entry.identities) ? entry.identities : [];
  const identities = rawIdentities
    .flatMap((identity) => identityCandidates(identity))
    .filter(Boolean);

  if (!identities.length) {
    identities.push(...identityCandidates(id));
  }

  return {
    id,
    label,
    token,
    identities: [...new Set(identities)],
  };
}

const CONFIGURED_OPERATORS = Array.isArray(META.operators)
  ? META.operators.map(normalizeOperatorEntry).filter(Boolean)
  : [];
const CONFIGURED_OPERATOR_IDS = CONFIGURED_OPERATORS.map((operator) => operator.id);
const CONFIGURED_OPERATOR_MAP = new Map(CONFIGURED_OPERATORS.map((operator) => [operator.id, operator]));
const HAS_OPERATOR_TOKENS = CONFIGURED_OPERATORS.some((operator) => Boolean(operator.token));
const TRUSTED_OPERATOR_HEADER = typeof META.operatorIdentityHeader === 'string' &&
  META.operatorIdentityHeader.trim() &&
  !isPlaceholderValue(META.operatorIdentityHeader)
  ? META.operatorIdentityHeader.trim()
  : null;

function getOperatorEntry(operatorId) {
  if (typeof operatorId !== 'string') {
    return null;
  }
  return CONFIGURED_OPERATOR_MAP.get(operatorId.trim()) || null;
}

function readHeaderValue(headers, headerName) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers) || !headerName) {
    return null;
  }

  const targetName = headerName.toLowerCase();
  const match = Object.entries(headers).find(([name]) => String(name || '').toLowerCase() === targetName);
  if (!match) {
    return null;
  }

  const [, value] = match;
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function resolveOperatorFromIdentity(identityValue) {
  const candidates = identityCandidates(identityValue);
  if (!candidates.length) {
    return null;
  }

  for (const operator of CONFIGURED_OPERATORS) {
    const identitySet = new Set(operator.identities.flatMap((identity) => identityCandidates(identity)));
    identitySet.add(operator.id.toLowerCase());
    identitySet.add(operator.label.toLowerCase());

    if (candidates.some((candidate) => identitySet.has(candidate))) {
      return operator;
    }
  }

  return null;
}

function resolveTrustedRequestOperator(headers) {
  if (!TRUSTED_OPERATOR_HEADER) {
    return null;
  }

  const headerValue = readHeaderValue(headers, TRUSTED_OPERATOR_HEADER);
  if (!headerValue) {
    return null;
  }

  return resolveOperatorFromIdentity(headerValue);
}

function buildUiUrl(operatorEntry) {
  const baseUrl = META.baseUrl + '/webhook/' + META.uiPath;
  if (!operatorEntry) {
    return baseUrl;
  }

  const entry = typeof operatorEntry === 'string' ? getOperatorEntry(operatorEntry) : operatorEntry;
  if (!entry) {
    return baseUrl;
  }

  const params = ['operator=' + encodeURIComponent(entry.id)];
  if (entry.token) {
    params.push('token=' + encodeURIComponent(entry.token));
  }
  return baseUrl + (baseUrl.includes('?') ? '&' : '?') + params.join('&');
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
    uiUrl: buildUiUrl(),
    runUrl: META.baseUrl + '/webhook/' + META.runPath,
    checkerHeartbeatUrl: META.checkerHeartbeatUrl || null,
    uiAccessLinks: HAS_OPERATOR_TOKENS && !TRUSTED_OPERATOR_HEADER
      ? CONFIGURED_OPERATORS.filter((operator) => operator.token).map((operator) => ({
          id: operator.id,
          label: operator.label,
          url: buildUiUrl(operator),
        }))
      : [],
    authMode: TRUSTED_OPERATOR_HEADER
      ? 'trusted_header'
      : HAS_OPERATOR_TOKENS
        ? 'operator_token'
        : 'operator_only',
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
const uiAccessLinks = Array.isArray(data.uiAccessLinks) ? data.uiAccessLinks : [];
const uiActions = uiAccessLinks.length > 1
  ? '<div style="margin-top:24px;display:flex;flex-wrap:wrap;gap:12px">' +
      uiAccessLinks.map((link) =>
        '<a href="' + escapeHtml(link.url) + '" style="display:inline-block;background:#2563eb;color:#ffffff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">Otevrit UI jako ' + escapeHtml(link.label) + '</a>'
      ).join('') +
    '</div>'
  : '<div style="margin-top:24px"><a href="' + escapeHtml(uiAccessLinks[0]?.url || data.uiUrl) + '" style="display:inline-block;background:#2563eb;color:#ffffff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">Otevrit update UI</a></div>';

const html = '<div style="font-family:Segoe UI,Arial,sans-serif;max-width:760px;margin:0 auto;color:#e2e8f0;background:#0f172a;padding:24px;border-radius:16px">' +
  '<h2 style="margin:0 0 8px;color:#f8fafc">' + escapeHtml(${JSON.stringify(mailHeading)}) + '</h2>' +
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
  uiActions +
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
const webhookRequest = $('Webhook UI').first().json || {};
const requestQuery = webhookRequest.query && typeof webhookRequest.query === 'object' && !Array.isArray(webhookRequest.query)
  ? webhookRequest.query
  : {};
const requestHeaders = webhookRequest.headers && typeof webhookRequest.headers === 'object' && !Array.isArray(webhookRequest.headers)
  ? webhookRequest.headers
  : {};
const authRequired = Boolean(TRUSTED_OPERATOR_HEADER || HAS_OPERATOR_TOKENS);
const queryOperatorId = typeof requestQuery.operator === 'string' ? requestQuery.operator.trim() : '';
const queryToken = typeof requestQuery.token === 'string' ? requestQuery.token.trim() : '';
const trustedOperator = resolveTrustedRequestOperator(requestHeaders);
const requestedOperator = queryOperatorId ? getOperatorEntry(queryOperatorId) : null;
let currentOperator = null;
let authError = '';

if (trustedOperator) {
  currentOperator = trustedOperator;
  if (requestedOperator && requestedOperator.id !== trustedOperator.id) {
    authError = 'Operator v URL neodpovida trusted identite.';
  }
} else if (requestedOperator && requestedOperator.token) {
  if (queryToken && queryToken === requestedOperator.token) {
    currentOperator = requestedOperator;
  } else {
    authError = 'Neplatny operator token.';
  }
} else if (requestedOperator && !requestedOperator.token && !authRequired) {
  currentOperator = requestedOperator;
} else if (!requestedOperator && CONFIGURED_OPERATORS.length === 1 && !authRequired) {
  currentOperator = CONFIGURED_OPERATORS[0];
} else if (authRequired) {
  authError = TRUSTED_OPERATOR_HEADER
    ? 'Nepodarilo se overit operatora z trusted hlavicky.'
    : 'Chybi nebo je neplatny operator token.';
}

if (authError) {
  const html = '<!DOCTYPE html><html lang="cs"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + escapeHtml(META.uiTitle) + '</title>' +
    '<style>body{margin:0;font-family:Segoe UI,Arial,sans-serif;background:#0b1220;color:#e5e7eb;padding:24px}.wrap{max-width:720px;margin:0 auto}.error{background:#3f1d1d;border:1px solid #7f1d1d;border-radius:16px;padding:20px}h1{margin:0 0 12px;font-size:28px}p{margin:0 0 12px;color:#fecaca}.meta{color:#cbd5e1;font-size:14px}</style></head><body><div class="wrap"><div class="error"><h1>Pristup odmitnut</h1><p>' + escapeHtml(authError) + '</p><div class="meta">Tahle UI varianta je vazana na operatora. Otevri ji z aktualniho checker mailu nebo pres trusted access vrstvu.</div></div></div></body></html>';
  return [{ json: { html } }];
}

const operatorOptions = CONFIGURED_OPERATORS;
const operatorField = currentOperator
  ? '<input type="hidden" id="operator" name="operator" value="' + escapeHtml(currentOperator.id) + '">' +
    (currentOperator.token
      ? '<input type="hidden" id="operator-token" name="operatorToken" value="' + escapeHtml(currentOperator.token) + '">'
      : '') +
    '<div class="operator-badge">Operator: ' + escapeHtml(currentOperator.label) + '</div>'
  : operatorOptions.length > 1
    ? '<label class="operator-field"><span>Operator</span><select id="operator" name="operator">' +
        operatorOptions.map((operator) =>
          '<option value="' + escapeHtml(operator.id) + '">' + escapeHtml(operator.label) + '</option>'
        ).join('') +
      '</select></label>'
    : operatorOptions.length === 1
      ? '<input type="hidden" id="operator" name="operator" value="' + escapeHtml(operatorOptions[0].id) + '">' +
        '<div class="operator-badge">Operator: ' + escapeHtml(operatorOptions[0].label) + '</div>'
      : '';

const html = '<!DOCTYPE html><html lang="cs"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>' + escapeHtml(META.uiTitle) + '</title>' +
  '<style>' +
  'body{margin:0;font-family:Segoe UI,Arial,sans-serif;background:#0b1220;color:#e5e7eb;padding:24px}' +
  '.wrap{max-width:960px;margin:0 auto}.hero{margin-bottom:24px}.hero h1{margin:0 0 8px;font-size:30px}.hero p{margin:0;color:#94a3b8}' +
  '.card{display:flex;gap:16px;background:#111827;border:1px solid #1f2937;border-radius:16px;padding:16px;margin-bottom:12px;cursor:pointer}.card:hover{border-color:#374151}' +
  '.check{padding-top:4px}.body{flex:1}.topline{display:flex;gap:12px;align-items:center;justify-content:space-between}.title{font-size:18px;font-weight:700}' +
  '.badge{display:inline-block;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:700}.badge.safe{background:#14532d;color:#86efac}.badge.caution{background:#78350f;color:#fde68a}.badge.manual{background:#7f1d1d;color:#fecaca}' +
  '.reason{margin:10px 0;color:#cbd5e1;line-height:1.45}.meta{font-size:12px;color:#94a3b8;margin-top:8px}.meta a{color:#93c5fd}.meta strong{color:#cbd5e1}.meta.note{color:#fbbf24}.extra{font-size:12px;color:#c4b5fd;margin-top:8px}' +
  '.operator-field{display:flex;flex-direction:column;gap:6px;font-size:12px;color:#cbd5e1}.operator-field select{background:#0f172a;color:#e5e7eb;border:1px solid #334155;border-radius:10px;padding:10px 12px;min-width:180px}.operator-badge{padding:10px 14px;border-radius:12px;background:#0f172a;border:1px solid #334155;color:#cbd5e1;font-size:13px}' +
  '.toolbar{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:24px 0}.toolbar button{background:#2563eb;color:#fff;border:none;border-radius:12px;padding:12px 18px;font-weight:700;cursor:pointer}.toolbar button.secondary{background:#1d4ed8;color:#dbeafe}.toolbar button.ghost{background:#1f2937;color:#e5e7eb}.toolbar button:disabled{opacity:.6;cursor:not-allowed}' +
  '#status{display:none;margin-top:16px;padding:14px 16px;border-radius:12px}.status-ok{background:#14532d;color:#dcfce7}.status-err{background:#7f1d1d;color:#fee2e2}.status-loading{background:#1f2937;color:#cbd5e1}' +
  '.empty,.unknowns,.warning{background:#111827;border:1px solid #1f2937;border-radius:16px;padding:16px;margin-top:16px}.unknown{padding:12px;background:#3f1d1d;border-radius:12px;margin-top:8px;color:#fecaca}.warning{background:#422006;border-color:#92400e;color:#fde68a}' +
  '</style></head><body><div class="wrap">' +
  '<div class="hero"><h1>' + escapeHtml(META.uiHeading || ${JSON.stringify(uiHeading)}) + '</h1><p>' + escapeHtml(META.uiSubtitle) + ' · ' + escapeHtml(data.tailscaleNote) + '</p></div>' +
  (data.updates.length
    ? '<form id="update-form">' + cards +
        '<div class="toolbar">' + operatorField + '<button type="submit" id="submit-btn">Spustit update vybranych</button><button type="submit" class="secondary" id="dry-run-btn" data-mode="dry-run">Dry-run bez zmen</button><button type="button" class="ghost" id="toggle-btn">Prepnout vse</button></div>' +
      '</form>'
    : '<div class="empty">Zadne mapovane updaty k bezpecnemu spusteni. Pokud je niz neco v sekci unknown, je potreba nejdriv doplnit service map.</div>') +
  (issueCards ? '<div class="warning"><h2>Kontrolni chyby</h2>' + issueCards + '</div>' : '') +
  (unknownCards ? '<div class="unknowns"><h2>Unknown updates</h2>' + unknownCards + '</div>' : '') +
  '<div id="status"></div></div>' +
  '<script>' +
    'const form=document.getElementById("update-form");const status=document.getElementById("status");const operatorInput=document.getElementById("operator");const operatorTokenInput=document.getElementById("operator-token");const submitButtons=[...document.querySelectorAll(\\'button[type="submit"]\\')];' +
    'document.getElementById("toggle-btn")?.addEventListener("click",()=>{document.querySelectorAll(\\'input[name="services"]\\').forEach((box)=>{box.checked=!box.checked;});});' +
    'form?.addEventListener("submit",async(event)=>{event.preventDefault();const services=[...document.querySelectorAll(\\'input[name="services"]:checked\\')].map((input)=>input.value);const dryRun=event.submitter?.dataset.mode==="dry-run";const operator=operatorInput?.value||"";const operatorToken=operatorTokenInput?.value||"";if(!operator){window.alert("Neni nastaven operator.");return;}if(!services.length){window.alert("Vyber aspon jednu sluzbu.");return;}submitButtons.forEach((button)=>{button.disabled=true;});status.style.display="block";status.className="status-loading";status.textContent=dryRun?"Spoustim dry-run bez zmen...":"Spoustim update...";try{const response=await fetch("' + escapeHtml(data.runUrl) + '",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({services,dryRun,operator,operatorToken})});const payload=await response.json();status.className=payload.ok?"status-ok":"status-err";status.textContent=payload.message || (payload.ok?(dryRun?"Dry-run dokoncen.":"Update dokoncen."):(dryRun?"Dry-run selhal.":"Update selhal."));}catch(error){status.className="status-err";status.textContent="Chyba spojeni: "+error.message;}finally{submitButtons.forEach((button)=>{button.disabled=false;});}});' +
  '</script></body></html>';

return [{ json: { html } }];
`.trim();

const runValidateCode = `
${sharedRuntime}
const FLOATING_TAGS = new Set(['latest', 'release', 'stable', 'main', 'master', 'nightly', 'edge']);

function imageTag(imageRef) {
  const value = String(imageRef || '').trim();
  if (!value || value.includes('@')) return null;
  const slashIndex = value.lastIndexOf('/');
  const colonIndex = value.lastIndexOf(':');
  if (colonIndex <= slashIndex) return null;
  return value.slice(colonIndex + 1);
}

function shellQuote(value) {
  return "'" + String(value ?? '').replace(/'/g, "'\\\"'\\\"'") + "'";
}

function optionalString(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || isPlaceholderValue(trimmed)) {
    return null;
  }

  return trimmed;
}

function optionalNonNegativeInteger(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }

  const normalized = optionalString(value);
  if (!normalized || !/^\\d+$/.test(normalized)) {
    return null;
  }

  return Number(normalized);
}

function normalizeHealthCheckConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { type: 'none' };
  }

  const type = optionalString(value.type) || 'none';
  if (type === 'none') {
    return { type: 'none' };
  }

  const timeoutSeconds = optionalNonNegativeInteger(value.timeoutSeconds);
  const intervalSeconds = optionalNonNegativeInteger(value.intervalSeconds);

  if (type === 'docker') {
    return {
      type,
      timeoutSeconds: timeoutSeconds && timeoutSeconds > 0 ? timeoutSeconds : 60,
      intervalSeconds: intervalSeconds && intervalSeconds > 0 ? intervalSeconds : 5,
    };
  }

  if (type === 'http') {
    const url = optionalString(value.url);
    if (!url) {
      return { type: 'none' };
    }

    const rawExpectStatus = Array.isArray(value.expectStatus) ? value.expectStatus : [value.expectStatus];
    const expectStatus = rawExpectStatus
      .map((entry) => optionalNonNegativeInteger(entry))
      .filter((entry) => entry !== null && entry > 0);

    return {
      type,
      url,
      expectStatus: expectStatus.length ? expectStatus : [200],
      timeoutSeconds: timeoutSeconds && timeoutSeconds > 0 ? timeoutSeconds : 60,
      intervalSeconds: intervalSeconds && intervalSeconds > 0 ? intervalSeconds : 5,
      headers: value.headers && typeof value.headers === 'object' && !Array.isArray(value.headers)
        ? Object.fromEntries(
            Object.entries(value.headers)
              .map(([name, headerValue]) => [optionalString(name), optionalString(headerValue)])
              .filter(([name, headerValue]) => name && headerValue),
          )
        : {},
    };
  }

  return { type: 'none' };
}

function validationResult(summary, extra = {}) {
  const requestedServices = Array.isArray(extra.requestedServices) ? extra.requestedServices : [];

  return [{
    json: {
      ok: false,
      isValid: false,
      validationError: true,
      errorCode: extra.errorCode || 'validation_error',
      statusCode: extra.statusCode || 400,
      requestedServices,
      expandedServices: [],
      services: requestedServices,
      labels: [],
      dryRun: Boolean(extra.dryRun),
      summary,
      message: summary,
      sshCommand: null,
      mailTo: META.mailTo,
      floatingTagWarning: false,
      floatingServices: [],
      compactOutput: summary,
      operator: extra.operator || null,
      workflowExecutionId: extra.workflowExecutionId || null,
      auditLogPath: META.auditLogPath || null,
    },
  }];
}

const rawBody = $input.first().json.body;
const body = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) ? rawBody : {};
const requestHeaders = $input.first().json.headers && typeof $input.first().json.headers === 'object' && !Array.isArray($input.first().json.headers)
  ? $input.first().json.headers
  : {};
const requested = Array.isArray(body.services) ? body.services : [];
const dryRun = Boolean(body.dryRun);
const rawOperator = typeof body.operator === 'string' ? body.operator.trim() : '';
const operator = rawOperator;
const operatorEntry = getOperatorEntry(operator);
const trustedOperator = resolveTrustedRequestOperator(requestHeaders);
const operatorToken = typeof body.operatorToken === 'string'
  ? body.operatorToken.trim()
  : String(readHeaderValue(requestHeaders, 'x-operator-token') || '').trim();
const workflowExecutionId = String($execution.id || '');

if (!operator || /^__.+__$/.test(operator)) {
  return validationResult('Neni nastaven operator.', {
    dryRun,
    requestedServices: requested,
    errorCode: 'missing_operator',
    operator: rawOperator || null,
    workflowExecutionId,
  });
}

if (CONFIGURED_OPERATOR_IDS.length && !operatorEntry) {
  return validationResult('Nepovoleny operator: ' + rawOperator, {
    dryRun,
    requestedServices: requested,
    errorCode: 'invalid_operator',
    operator: rawOperator,
    workflowExecutionId,
  });
}

if (TRUSTED_OPERATOR_HEADER && !trustedOperator && !operatorEntry?.token) {
  return validationResult('Nepodarilo se overit operatora z trusted hlavicky.', {
    dryRun,
    requestedServices: requested,
    errorCode: 'missing_operator_identity',
    operator,
    workflowExecutionId,
  });
}

if (!trustedOperator && HAS_OPERATOR_TOKENS && !operatorEntry?.token) {
  return validationResult('Operator nema nastaveny token.', {
    dryRun,
    requestedServices: requested,
    errorCode: 'missing_operator_token_config',
    operator,
    workflowExecutionId,
  });
}

if (trustedOperator && trustedOperator.id !== operator) {
  return validationResult('Trusted identita neodpovida operatorovi: ' + operator, {
    dryRun,
    requestedServices: requested,
    errorCode: 'operator_identity_mismatch',
    operator,
    workflowExecutionId,
  });
}

if (!trustedOperator && operatorEntry?.token && operatorToken !== operatorEntry.token) {
  return validationResult('Neplatny operator token.', {
    dryRun,
    requestedServices: requested,
    errorCode: 'invalid_operator_token',
    operator,
    workflowExecutionId,
  });
}

if (!requested.length) {
  return validationResult('Neni vybrana zadna sluzba.', {
    dryRun,
    requestedServices: requested,
    errorCode: 'no_services',
    operator,
    workflowExecutionId,
  });
}

const invalid = requested.filter((service) => !SERVICE_MAP_BY_SERVICE[service]);
if (invalid.length) {
  return validationResult('Nepovolene sluzby: ' + invalid.join(', '), {
    dryRun,
    requestedServices: requested,
    errorCode: 'invalid_services',
    operator,
    workflowExecutionId,
  });
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
const floatingServices = expanded
  .map((service) => SERVICE_MAP_BY_SERVICE[service])
  .filter((meta) => {
    const tag = imageTag(meta?.image);
    return tag && FLOATING_TAGS.has(tag.toLowerCase());
  })
  .map((meta) => meta.label || meta.service);
const floatingTagWarning = floatingServices.length > 0;
const sshArguments = ['bash', META.sshScriptPath];
if (dryRun) {
  sshArguments.push('--dry-run');
}
if (META.auditLogPath) {
  sshArguments.push('--audit-log-path', META.auditLogPath);
}
sshArguments.push('--operator', operator);
if (workflowExecutionId) {
  sshArguments.push('--workflow-execution-id', workflowExecutionId);
}
const precheckDiskUsageLimitPct = optionalNonNegativeInteger(META.precheckDiskUsageLimitPct);
if (precheckDiskUsageLimitPct !== null) {
  sshArguments.push('--disk-usage-limit-pct', String(precheckDiskUsageLimitPct));
}
const backupMarkerPath = optionalString(META.backupMarkerPath);
if (backupMarkerPath) {
  sshArguments.push('--backup-marker-path', backupMarkerPath);
}
const backupMarkerMaxAgeSeconds = optionalNonNegativeInteger(META.backupMarkerMaxAgeSeconds);
if (backupMarkerPath && backupMarkerMaxAgeSeconds !== null) {
  sshArguments.push('--backup-marker-max-age-seconds', String(backupMarkerMaxAgeSeconds));
}
const healthChecksPayload = Object.fromEntries(
  expanded.map((service) => [service, normalizeHealthCheckConfig(SERVICE_MAP_BY_SERVICE[service]?.healthCheck)]),
);
const healthChecksPayloadBase64 = Buffer.from(JSON.stringify(healthChecksPayload), 'utf8').toString('base64');
sshArguments.push('--health-checks-payload-base64', healthChecksPayloadBase64);
sshArguments.push(...expanded);
const sshCommand = sshArguments.map(shellQuote).join(' ');

return [{
  json: {
    isValid: true,
    validationError: false,
    statusCode: 200,
    requestedServices: requested,
    expandedServices: expanded,
    labels,
    dryRun,
    sshCommand,
    mailTo: META.mailTo,
    floatingTagWarning,
    floatingServices,
    operator,
    workflowExecutionId,
    auditLogPath: META.auditLogPath || null,
    precheckDiskUsageLimitPct,
    backupMarkerPath,
    backupMarkerMaxAgeSeconds: backupMarkerPath ? backupMarkerMaxAgeSeconds : null,
    healthChecksPayload,
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
const META = ${JSON.stringify(meta)};

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

function isPlaceholderValue(value) {
  return typeof value === 'string' && /^__.+__$/.test(value.trim());
}

function identityCandidates(value) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return [];
  }

  const normalized = raw.toLowerCase();
  const candidates = new Set([normalized]);
  const localPart = normalized.includes('@') ? normalized.split('@')[0] : normalized;
  if (localPart) {
    candidates.add(localPart);
  }
  return [...candidates];
}

function normalizeOperatorEntry(entry) {
  if (typeof entry === 'string') {
    const id = entry.trim();
    if (!id || isPlaceholderValue(id)) {
      return null;
    }

    return {
      id,
      label: id,
      token: null,
      identities: identityCandidates(id),
    };
  }

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }

  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  if (!id || isPlaceholderValue(id)) {
    return null;
  }

  const label = typeof entry.label === 'string' && entry.label.trim() && !isPlaceholderValue(entry.label)
    ? entry.label.trim()
    : id;
  const token = typeof entry.token === 'string' && entry.token.trim() && !isPlaceholderValue(entry.token)
    ? entry.token.trim()
    : null;
  const rawIdentities = Array.isArray(entry.identities) ? entry.identities : [];
  const identities = rawIdentities
    .flatMap((identity) => identityCandidates(identity))
    .filter(Boolean);

  if (!identities.length) {
    identities.push(...identityCandidates(id));
  }

  return {
    id,
    label,
    token,
    identities: [...new Set(identities)],
  };
}

const CONFIGURED_OPERATORS = Array.isArray(META.operators)
  ? META.operators.map(normalizeOperatorEntry).filter(Boolean)
  : [];
const HAS_OPERATOR_TOKENS = CONFIGURED_OPERATORS.some((operator) => Boolean(operator.token));
const TRUSTED_OPERATOR_HEADER = typeof META.operatorIdentityHeader === 'string' &&
  META.operatorIdentityHeader.trim() &&
  !isPlaceholderValue(META.operatorIdentityHeader)
  ? META.operatorIdentityHeader.trim()
  : null;

function getOperatorEntry(operatorId) {
  if (typeof operatorId !== 'string') {
    return null;
  }
  const normalized = operatorId.trim();
  return CONFIGURED_OPERATORS.find((operator) => operator.id === normalized) || null;
}

function readHeaderValue(headers, headerName) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers) || !headerName) {
    return null;
  }

  const targetName = headerName.toLowerCase();
  const match = Object.entries(headers).find(([name]) => String(name || '').toLowerCase() === targetName);
  if (!match) {
    return null;
  }

  const [, value] = match;
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function resolveOperatorFromIdentity(identityValue) {
  const candidates = identityCandidates(identityValue);
  if (!candidates.length) {
    return null;
  }

  for (const operator of CONFIGURED_OPERATORS) {
    const identitySet = new Set(operator.identities.flatMap((identity) => identityCandidates(identity)));
    identitySet.add(operator.id.toLowerCase());
    identitySet.add(operator.label.toLowerCase());

    if (candidates.some((candidate) => identitySet.has(candidate))) {
      return operator;
    }
  }

  return null;
}

function resolveTrustedRequestOperator(headers) {
  if (!TRUSTED_OPERATOR_HEADER) {
    return null;
  }

  const headerValue = readHeaderValue(headers, TRUSTED_OPERATOR_HEADER);
  if (!headerValue) {
    return null;
  }

  return resolveOperatorFromIdentity(headerValue);
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
const uiAccessLinks = Array.isArray(data.uiAccessLinks) ? data.uiAccessLinks : [];
const uiActions = uiAccessLinks.length > 1
  ? '<div style="margin-top:24px;display:flex;flex-wrap:wrap;gap:12px">' +
      uiAccessLinks.map((link) =>
        '<a href="' + escapeHtml(link.url) + '" style="display:inline-block;background:#2563eb;color:#ffffff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">Otevrit UI jako ' + escapeHtml(link.label) + '</a>'
      ).join('') +
    '</div>'
  : '<div style="margin-top:24px"><a href="' + escapeHtml(uiAccessLinks[0]?.url || data.uiUrl) + '" style="display:inline-block;background:#2563eb;color:#ffffff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">Otevrit update UI</a></div>';

const html = '<div style="font-family:Segoe UI,Arial,sans-serif;max-width:760px;margin:0 auto;color:#e2e8f0;background:#0f172a;padding:24px;border-radius:16px">' +
  '<h2 style="margin:0 0 8px;color:#f8fafc">' + escapeHtml(${JSON.stringify(mailHeading)}) + '</h2>' +
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
  uiActions +
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
const webhookRequest = $('Webhook UI').first().json || {};
const requestQuery = webhookRequest.query && typeof webhookRequest.query === 'object' && !Array.isArray(webhookRequest.query)
  ? webhookRequest.query
  : {};
const requestHeaders = webhookRequest.headers && typeof webhookRequest.headers === 'object' && !Array.isArray(webhookRequest.headers)
  ? webhookRequest.headers
  : {};
const authRequired = Boolean(TRUSTED_OPERATOR_HEADER || HAS_OPERATOR_TOKENS);
const queryOperatorId = typeof requestQuery.operator === 'string' ? requestQuery.operator.trim() : '';
const queryToken = typeof requestQuery.token === 'string' ? requestQuery.token.trim() : '';
const trustedOperator = resolveTrustedRequestOperator(requestHeaders);
const requestedOperator = queryOperatorId ? getOperatorEntry(queryOperatorId) : null;
let currentOperator = null;
let authError = '';

if (trustedOperator) {
  currentOperator = trustedOperator;
  if (requestedOperator && requestedOperator.id !== trustedOperator.id) {
    authError = 'Operator v URL neodpovida trusted identite.';
  }
} else if (requestedOperator && requestedOperator.token) {
  if (queryToken && queryToken === requestedOperator.token) {
    currentOperator = requestedOperator;
  } else {
    authError = 'Neplatny operator token.';
  }
} else if (requestedOperator && !requestedOperator.token && !authRequired) {
  currentOperator = requestedOperator;
} else if (!requestedOperator && CONFIGURED_OPERATORS.length === 1 && !authRequired) {
  currentOperator = CONFIGURED_OPERATORS[0];
} else if (authRequired) {
  authError = TRUSTED_OPERATOR_HEADER
    ? 'Nepodarilo se overit operatora z trusted hlavicky.'
    : 'Chybi nebo je neplatny operator token.';
}

if (authError) {
  const html = '<!DOCTYPE html><html lang="cs"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + escapeHtml(META.uiTitle) + '</title>' +
    '<style>body{margin:0;font-family:Segoe UI,Arial,sans-serif;background:#0b1220;color:#e5e7eb;padding:24px}.wrap{max-width:720px;margin:0 auto}.error{background:#3f1d1d;border:1px solid #7f1d1d;border-radius:16px;padding:20px}h1{margin:0 0 12px;font-size:28px}p{margin:0 0 12px;color:#fecaca}.meta{color:#cbd5e1;font-size:14px}</style></head><body><div class="wrap"><div class="error"><h1>Pristup odmitnut</h1><p>' + escapeHtml(authError) + '</p><div class="meta">Tahle UI varianta je vazana na operatora. Otevri ji z aktualniho checker mailu nebo pres trusted access vrstvu.</div></div></div></body></html>';
  return [{ json: { html } }];
}

const operatorOptions = CONFIGURED_OPERATORS;
const operatorField = currentOperator
  ? '<input type="hidden" id="operator" name="operator" value="' + escapeHtml(currentOperator.id) + '">' +
    (currentOperator.token
      ? '<input type="hidden" id="operator-token" name="operatorToken" value="' + escapeHtml(currentOperator.token) + '">'
      : '') +
    '<div class="operator-badge">Operator: ' + escapeHtml(currentOperator.label) + '</div>'
  : operatorOptions.length > 1
    ? '<label class="operator-field"><span>Operator</span><select id="operator" name="operator">' +
        operatorOptions.map((operator) =>
          '<option value="' + escapeHtml(operator.id) + '">' + escapeHtml(operator.label) + '</option>'
        ).join('') +
      '</select></label>'
    : operatorOptions.length === 1
      ? '<input type="hidden" id="operator" name="operator" value="' + escapeHtml(operatorOptions[0].id) + '">' +
        '<div class="operator-badge">Operator: ' + escapeHtml(operatorOptions[0].label) + '</div>'
      : '';

const html = '<!DOCTYPE html><html lang="cs"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>' + escapeHtml(META.uiTitle) + '</title>' +
  '<style>' +
  'body{margin:0;font-family:Segoe UI,Arial,sans-serif;background:#0b1220;color:#e5e7eb;padding:24px}' +
  '.wrap{max-width:960px;margin:0 auto}.hero{margin-bottom:24px}.hero h1{margin:0 0 8px;font-size:30px}.hero p{margin:0;color:#94a3b8}' +
  '.card{display:flex;gap:16px;background:#111827;border:1px solid #1f2937;border-radius:16px;padding:16px;margin-bottom:12px;cursor:pointer}.card:hover{border-color:#374151}' +
  '.check{padding-top:4px}.body{flex:1}.topline{display:flex;gap:12px;align-items:center;justify-content:space-between}.title{font-size:18px;font-weight:700}' +
  '.badge{display:inline-block;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:700}.badge.safe{background:#14532d;color:#86efac}.badge.caution{background:#78350f;color:#fde68a}.badge.manual{background:#7f1d1d;color:#fecaca}' +
  '.reason{margin:10px 0;color:#cbd5e1;line-height:1.45}.meta{font-size:12px;color:#94a3b8;margin-top:8px}.meta a{color:#93c5fd}.meta strong{color:#cbd5e1}.meta.note{color:#fbbf24}.extra{font-size:12px;color:#c4b5fd;margin-top:8px}' +
  '.operator-field{display:flex;flex-direction:column;gap:6px;font-size:12px;color:#cbd5e1}.operator-field select{background:#0f172a;color:#e5e7eb;border:1px solid #334155;border-radius:10px;padding:10px 12px;min-width:180px}.operator-badge{padding:10px 14px;border-radius:12px;background:#0f172a;border:1px solid #334155;color:#cbd5e1;font-size:13px}' +
  '.toolbar{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:24px 0}.toolbar button{background:#2563eb;color:#fff;border:none;border-radius:12px;padding:12px 18px;font-weight:700;cursor:pointer}.toolbar button.secondary{background:#1d4ed8;color:#dbeafe}.toolbar button.ghost{background:#1f2937;color:#e5e7eb}.toolbar button:disabled{opacity:.6;cursor:not-allowed}' +
  '#status{display:none;margin-top:16px;padding:14px 16px;border-radius:12px}.status-ok{background:#14532d;color:#dcfce7}.status-err{background:#7f1d1d;color:#fee2e2}.status-loading{background:#1f2937;color:#cbd5e1}' +
  '.empty,.unknowns,.warning,.issues{background:#111827;border:1px solid #1f2937;border-radius:16px;padding:16px;margin-top:16px}.unknown{padding:12px;background:#3f1d1d;border-radius:12px;margin-top:8px;color:#fecaca}.warning{background:#422006;border-color:#92400e;color:#fde68a}.issues{background:#422006;border-color:#92400e;color:#fde68a}' +
  '</style></head><body><div class="wrap">' +
  '<div class="hero"><h1>' + escapeHtml(META.uiHeading || ${JSON.stringify(uiHeading)}) + '</h1><p>' + escapeHtml(META.uiSubtitle || data.tailscaleNote) + (META.uiSubtitle ? ' · ' + escapeHtml(data.tailscaleNote) : '') + '</p></div>' +
  (data.versionLookupError ? '<div class="warning">Version metadata se nepodarilo nacist kompletne: ' + escapeHtml(data.versionLookupError) + '</div>' : '') +
  (data.updates.length
    ? '<form id="update-form">' + cards +
        '<div class="toolbar">' + operatorField + '<button type="submit" id="submit-btn">Spustit update vybranych</button><button type="submit" class="secondary" id="dry-run-btn" data-mode="dry-run">Dry-run bez zmen</button><button type="button" class="ghost" id="toggle-btn">Prepnout vse</button></div>' +
      '</form>'
    : '<div class="empty">Zadne zastarale mapovane sluzby k bezpecnemu spusteni.</div>') +
  (issueCards ? '<div class="issues"><h2>Kontrolni chyby</h2>' + issueCards + '</div>' : '') +
  (unknownCards ? '<div class="unknowns"><h2>Unknown updates</h2>' + unknownCards + '</div>' : '') +
  '<div id="status"></div></div>' +
  '<script>' +
    'const form=document.getElementById("update-form");const status=document.getElementById("status");const operatorInput=document.getElementById("operator");const operatorTokenInput=document.getElementById("operator-token");const submitButtons=[...document.querySelectorAll(\\'button[type="submit"]\\')];' +
    'document.getElementById("toggle-btn")?.addEventListener("click",()=>{document.querySelectorAll(\\'input[name="services"]\\').forEach((box)=>{box.checked=!box.checked;});});' +
    'form?.addEventListener("submit",async(event)=>{event.preventDefault();const services=[...document.querySelectorAll(\\'input[name="services"]:checked\\')].map((input)=>input.value);const dryRun=event.submitter?.dataset.mode==="dry-run";const operator=operatorInput?.value||"";const operatorToken=operatorTokenInput?.value||"";if(!operator){window.alert("Neni nastaven operator.");return;}if(!services.length){window.alert("Vyber aspon jednu sluzbu.");return;}submitButtons.forEach((button)=>{button.disabled=true;});status.style.display="block";status.className="status-loading";status.textContent=dryRun?"Spoustim dry-run bez zmen...":"Spoustim update...";try{const response=await fetch("' + escapeHtml(data.runUrl) + '",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({services,dryRun,operator,operatorToken})});const payload=await response.json();status.className=payload.ok?"status-ok":"status-err";status.textContent=payload.message || (payload.ok?(dryRun?"Dry-run dokoncen.":"Update dokoncen."):(dryRun?"Dry-run selhal.":"Update selhal."));}catch(error){status.className="status-err";status.textContent="Chyba spojeni: "+error.message;}finally{submitButtons.forEach((button)=>{button.disabled=false;});}});' +
  '</script></body></html>';

return [{ json: { html } }];
`.trim();

const runResultRenderCode = `
${sharedRuntime}
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseStructuredResult(text) {
  const matches = [...String(text || '').matchAll(/^__RESULT_JSON__:(.*)$/gm)];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(matches[index][1]);
    } catch {
      // Ignore malformed JSON and fall back to the legacy result markers.
    }
  }
  return null;
}

function sanitizeOutput(text) {
  const lines = String(text || '')
    .replace(/\\r\\n/g, '\\n')
    .split('\\n')
    .map((line) => line.replace(/\\u001b\\[[0-9;]*m/g, '').trimEnd())
    .filter((line) => !/^__RESULT__(:|$)/.test(line))
    .filter((line) => !/^__RESULT_JSON__:(.*)$/.test(line))
    .filter((line) => !/^Image .+ Pulling\\s*$/.test(line))
    .filter((line) => !/^ Image .+ Pulled\\s*$/.test(line));

  const compacted = [];
  let lastBlank = false;

  for (const line of lines) {
    if (!line.trim()) {
      if (lastBlank) continue;
      compacted.push('');
      lastBlank = true;
      continue;
    }

    compacted.push(line);
    lastBlank = false;
  }

  return compacted.join('\\n').trim();
}

function phaseLabel(phase) {
  const labels = {
    dry_run: 'Dry-run',
    complete: 'Dokonceno',
    lock: 'Soubezny beh',
    backup_snapshot: 'Snapshot pred updatem',
    precheck_disk: 'Kontrola disku',
    precheck_compose: 'Kontrola docker compose',
    precheck_backup: 'Kontrola backupu',
    post_check: 'Kontrola po updatu',
  };

  return labels[phase] || (phase || 'Neznama faze');
}

function phaseExplanation(ok, dryRun, phase) {
  if (ok) {
    return dryRun
      ? 'Dry-run probehl bez chyby a nic na hostu nemenil.'
      : 'Update probehl bez chyby a nasledne kontroly prosly.';
  }

  if (dryRun) {
    return 'Dry-run narazil na problem jeste pred ostrou zmenou kontejneru.';
  }

  if (phase === 'post_check') {
    return 'Update se provedl, ale nasledna kontrola sluzby neprosla. Sluzba potrebuje rucni kontrolu.';
  }

  if (phase === 'lock') {
    return 'Jiny update uz prave bezi, proto se tento pokus bezpecne zastavil.';
  }

  if (phase === 'backup_snapshot') {
    return 'Pred samotnym pull se nepodarilo vytvorit compose-level snapshot. Update se proto bezpecne zastavil.';
  }

  if (phase === 'precheck_disk' || phase === 'precheck_compose' || phase === 'precheck_backup') {
    return 'Update se vubec nespustil, protoze neprosla predbezna kontrola.';
  }

  return 'Workflow narazil na chybu a potrebuje rucni kontrolu.';
}

const requestData = $('Validate Selection').first().json;
const stdout = $input.first().json.stdout || '';
const stderr = $input.first().json.stderr || '';
const combined = [stdout, stderr].filter(Boolean).join('\\n').trim();
const structuredResult = parseStructuredResult(combined);
const ok = structuredResult ? structuredResult.status === 'ok' : combined.includes('__RESULT__:OK');
const dryRun = structuredResult?.phase === 'dry_run' || Boolean(requestData.dryRun) || combined.includes('__RESULT__:OK:DRY_RUN');
const phase = structuredResult?.phase || (dryRun ? 'dry_run' : ok ? 'complete' : null);
const errorMatch = combined.match(/__RESULT__:ERROR:(.*)/);
const summary = structuredResult?.summary || (errorMatch ? errorMatch[1].trim() : '');
const prevDigests = structuredResult?.prev_digests || {};
const newDigests = structuredResult?.new_digests || {};
const floatingTagWarning = Boolean(requestData.floatingTagWarning || structuredResult?.floating_tag_warning);
const floatingServices = requestData.floatingServices || [];
const sanitizedOutput = sanitizeOutput(combined);
const compactOutput = sanitizedOutput.length > 3500 ? sanitizedOutput.slice(0, 3500) + '\\n...[truncated]' : sanitizedOutput;
const actionLabel = dryRun ? 'Dry-run' : 'Update';
const operator = structuredResult?.operator || requestData.operator || null;
const workflowExecutionId = structuredResult?.workflow_execution_id || requestData.workflowExecutionId || String($execution.id || '');
const auditHost = structuredResult?.host || null;
const backupSnapshotDir = structuredResult?.backup_snapshot_dir || null;
const backupMarkerPath = structuredResult?.backup_marker_path || requestData.backupMarkerPath || null;
const servicesText = requestData.labels.join(', ');
const titleText = ok
  ? (dryRun ? 'Dry-run probehl v poradku' : 'Docker update probehl v poradku')
  : (dryRun ? 'Dry-run selhal' : 'Docker update selhal');
const explanationText = phaseExplanation(ok, dryRun, phase);

const message = ok
  ? actionLabel + ' dokoncen pro: ' + servicesText
  : actionLabel + ' selhal pro: ' + servicesText + (summary ? ' - ' + summary : '');

const rollbackPlans = phase === 'post_check'
  ? requestData.expandedServices
      .map((service) => {
        const meta = SERVICE_MAP_BY_SERVICE[service];
        const previousDigest = prevDigests[service];
        const newDigest = newDigests[service];
        const imageRef = meta?.image;
        const label = meta?.label || service;

        if (!previousDigest || !imageRef) {
          return {
            service,
            label,
            kind: 'missing',
          };
        }

        if (newDigest && previousDigest === newDigest) {
          return {
            service,
            label,
            kind: 'unchanged',
            digest: previousDigest,
          };
        }

        return {
          service,
          label,
          kind: 'available',
          commands: [
            '# ' + label,
            'docker image tag ' + previousDigest + ' ' + imageRef,
            'docker compose up -d --no-deps ' + service,
            'docker compose ps ' + service,
          ].join('\\n'),
        };
      })
  : [];
const rollbackCommands = rollbackPlans
  .filter((plan) => plan.kind === 'available')
  .map((plan) => plan.commands);
const rollbackCommandsText = rollbackCommands.join('\\n\\n');
const rollbackUnavailableNotes = rollbackPlans
  .filter((plan) => plan.kind !== 'available')
  .map((plan) => {
    if (plan.kind === 'unchanged') {
      return plan.label + ': rollback z tohoto behu nedava smysl, protoze predchozi a novy digest jsou stejne (' + plan.digest + ').';
    }

    return plan.label + ': chybi predchozi digest, takze rollback prikaz nejde vygenerovat automaticky.';
  });

const metadataHtml = [
  '<div style="margin:0 0 6px"><strong>Sluzby:</strong> ' + escapeHtml(servicesText) + '</div>',
  '<div style="margin:0 0 6px"><strong>Faze:</strong> ' + escapeHtml(phaseLabel(phase)) + '</div>',
  operator ? '<div style="margin:0 0 6px"><strong>Operator:</strong> ' + escapeHtml(operator) + '</div>' : '',
  workflowExecutionId ? '<div style="margin:0 0 6px"><strong>Execution:</strong> ' + escapeHtml(workflowExecutionId) + '</div>' : '',
  auditHost ? '<div style="margin:0 0 6px"><strong>Host:</strong> ' + escapeHtml(auditHost) + '</div>' : '',
  backupSnapshotDir ? '<div style="margin:0 0 6px"><strong>Snapshot:</strong> ' + escapeHtml(backupSnapshotDir) + '</div>' : '',
  backupMarkerPath ? '<div style="margin:0 0 6px"><strong>Marker:</strong> ' + escapeHtml(backupMarkerPath) + '</div>' : '',
  summary ? '<div style="margin:0"><strong>Chyba:</strong> ' + escapeHtml(summary) + '</div>' : '',
].filter(Boolean).join('');

const floatingTagHtml = floatingTagWarning
  ? '<div style="margin:14px 0;padding:12px 14px;background:#422006;color:#fde68a;border-radius:12px"><strong>Pozor na floating tag:</strong> ' +
      escapeHtml('U vybranych sluzeb se muze zmenit digest i bez zjevne zmeny verze.') +
      (floatingServices.length ? '<div style="margin-top:6px">' + escapeHtml(floatingServices.join(', ')) + '</div>' : '') +
    '</div>'
  : '';

const rollbackHtml = rollbackCommandsText
  ? '<div style="margin:16px 0;padding:16px;background:#1f2937;color:#e5e7eb;border-radius:14px"><div style="font-size:18px;font-weight:700;margin-bottom:8px">Rollback runbook</div><div style="color:#cbd5e1;margin-bottom:10px">Pouzij jen pokud potvrdis, ze problem zpusobil novy image. Rollback neni automaticky.</div><pre style="white-space:pre-wrap;word-break:break-word;background:#111827;color:#e5e7eb;padding:14px;border-radius:12px;margin:0">' +
      escapeHtml('cd /opt/docker\\n\\n' + rollbackCommandsText) +
    '</pre><div style="margin-top:10px;color:#cbd5e1">Po navratu zkontroluj logy, health endpoint a pripadne DB migrace.</div></div>'
  : rollbackUnavailableNotes.length
    ? '<div style="margin:16px 0;padding:14px;background:#172554;color:#dbeafe;border-radius:14px"><div style="font-weight:700;margin-bottom:8px">Rollback z tohoto behu</div><div>' +
        rollbackUnavailableNotes.map((note) => '<div style="margin:0 0 6px">' + escapeHtml(note) + '</div>').join('') +
      '</div></div>'
    : '';

const nextSteps = ok
  ? [
      'Otevri sluzbu a rychle over, ze UI funguje.',
      'Kdyz je to stateful sluzba, zkontroluj i logy a background joby.',
    ]
  : phase === 'post_check'
    ? [
        'Otevri sluzbu nebo health endpoint a over, co presne po updatu nefunguje.',
        'Zkontroluj docker compose logy dane sluzby.',
        rollbackCommandsText
          ? 'Kdyz problem zpusobil novy image, pouzij rollback runbook niz.'
          : 'Pokud bude potreba navrat, udelej ho rucne po kontrole digestu a logu.',
      ]
    : phase === 'backup_snapshot'
      ? [
          'Zkontroluj, proc nesel vytvorit snapshot compose konfigurace.',
          'Over zapis do /opt/docker/.backups a .last-backup markeru.',
          'Po oprave spust novy test.',
        ]
    : [
        'Otevri execution v n8n a zkontroluj detail chyby.',
        'Podle faze oprav problem a pak spust novy test.',
      ];
const nextStepsHtml = '<ol style="margin:10px 0 0 20px;padding:0;color:#1e293b">' +
  nextSteps.map((step) => '<li style="margin:0 0 8px">' + escapeHtml(step) + '</li>').join('') +
  '</ol>';

const mailHtml = '<div style="font-family:Segoe UI,Arial,sans-serif;max-width:760px;margin:0 auto;color:#0f172a">' +
  '<h2 style="margin:0 0 12px;font-size:32px;line-height:1.2">' + escapeHtml(titleText) + '</h2>' +
  '<p style="margin:0 0 14px;font-size:16px;line-height:1.6">' + escapeHtml(explanationText) + '</p>' +
  '<div style="margin:0 0 16px;padding:16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px">' + metadataHtml + '</div>' +
  floatingTagHtml +
  '<div style="margin:16px 0;padding:16px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:14px"><div style="font-size:18px;font-weight:700;margin-bottom:6px">Dalsi doporuceny krok</div>' +
    nextStepsHtml +
  '</div>' +
  rollbackHtml +
  '<div style="margin:16px 0 0;padding:16px;background:#0f172a;color:#e2e8f0;border-radius:14px"><div style="font-size:18px;font-weight:700;margin-bottom:8px">Zkraceny technicky log</div><pre style="white-space:pre-wrap;word-break:break-word;margin:0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace">' +
    escapeHtml(compactOutput || 'Bez vystupu') +
  '</pre></div></div>';

return [{
  json: {
    ok,
    dryRun,
    phase,
    summary,
    message,
    services: requestData.expandedServices,
    labels: requestData.labels,
    floatingTagWarning,
    floatingServices,
    operator,
    workflowExecutionId,
    auditHost,
    backupSnapshotDir,
    backupMarkerPath,
    auditLogPath: requestData.auditLogPath || null,
    prevDigests,
    newDigests,
    rollbackCommands,
    structuredResult,
    compactOutput,
    mailHtml,
  },
}];
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

function emailSendNode(name, id, position, subject, html) {
  return {
    id,
    name,
    type: 'n8n-nodes-base.emailSend',
    typeVersion: 2.1,
    position,
    parameters: {
      resource: 'email',
      operation: 'send',
      fromEmail: meta.mailFrom,
      toEmail: meta.mailTo,
      subject,
      emailFormat: 'html',
      html,
      options: {
        appendAttribution: false,
      },
    },
  };
}

function checkerTriggerNode() {
  if (checkerTriggerMode === 'manual') {
    return {
      id: 'manual-trigger-1',
      name: 'Manualni test trigger',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [240, 300],
      parameters: {},
    };
  }

  return {
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
  };
}

function checkerHeartbeatNode() {
  const parameters = {
    method: 'GET',
    url: checkerHeartbeatUrl,
    options: {},
  };

  const headerParameters = Object.entries(checkerHeartbeatHeaders).map(([name, value]) => ({
    name,
    value,
  }));

  if (headerParameters.length > 0) {
    parameters.sendHeaders = true;
    parameters.headerParameters = {
      parameters: headerParameters,
    };
  }

  return {
    id: 'http-heartbeat-1',
    name: 'Send Watchdog Heartbeat',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [2220, 300],
    parameters,
  };
}

function checkerProductionExecutionNode() {
  return {
    id: 'if-heartbeat-mode-1',
    name: 'Production Execution?',
    type: 'n8n-nodes-base.if',
    typeVersion: 1,
    position: [2220, 300],
    parameters: {
      conditions: {
        boolean: [
          {
            value1: '={{ $exec.mode === "production" }}',
            operation: 'equal',
            value2: true,
          },
        ],
      },
    },
  };
}

const checkerTrigger = checkerTriggerNode();
const checkerNodes = [
  checkerTrigger,
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
  emailSendNode('Send Mail', 'email-1', [2000, 220], '={{ $json.subject }}', '={{ $json.html }}'),
];

if (checkerHeartbeatEnabled) {
  checkerNodes.push(checkerProductionExecutionNode());
  checkerNodes.push(checkerHeartbeatNode());
}

const checkerConnections = {
  [checkerTrigger.name]: {
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
  'Anything to Notify?': checkerHeartbeatEnabled
    ? {
        main: [
          [{ node: 'Send Mail', type: 'main', index: 0 }],
          [{ node: 'Production Execution?', type: 'main', index: 0 }],
        ],
      }
    : {
        main: [[{ node: 'Send Mail', type: 'main', index: 0 }], []],
      },
};

if (checkerHeartbeatEnabled) {
  checkerConnections['Send Mail'] = {
    main: [[{ node: 'Production Execution?', type: 'main', index: 0 }]],
  };
  checkerConnections['Production Execution?'] = {
    main: [
      [{ node: 'Send Watchdog Heartbeat', type: 'main', index: 0 }],
      [],
    ],
  };
}

const checkerWorkflow = {
  name: workflowNames.checker,
  nodes: checkerNodes,
  connections: checkerConnections,
  settings: { executionOrder: 'v1' },
};

const uiWorkflow = {
  name: workflowNames.ui,
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
  name: workflowNames.run,
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
    {
      id: 'if-run-valid',
      name: 'Valid Request?',
      type: 'n8n-nodes-base.if',
      typeVersion: 1,
      position: [680, 300],
      parameters: {
        conditions: {
          boolean: [
            {
              value1: '={{ $json.isValid }}',
              operation: 'equal',
              value2: true,
            },
          ],
        },
      },
    },
    sshNode('SSH Apply Update', 'ssh-run', [900, 220], '={{ $json.sshCommand }}'),
    {
      id: 'code-run-2',
      name: 'Build Result',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [1120, 220],
      parameters: {
        jsCode: runResultRenderCode,
      },
    },
    {
      id: 'respond-run',
      name: 'Respond JSON',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1.4,
      position: [1340, 140],
      parameters: {
        respondWith: 'json',
        responseBody: '={{ JSON.stringify({ ok: $json.ok, dryRun: $json.dryRun, phase: $json.phase, summary: $json.summary, operator: $json.operator, workflowExecutionId: $json.workflowExecutionId, backupSnapshotDir: $json.backupSnapshotDir, backupMarkerPath: $json.backupMarkerPath, floatingTagWarning: $json.floatingTagWarning, floatingServices: $json.floatingServices, message: $json.message, services: $json.services, output: $json.compactOutput }) }}',
        options: {
          responseCode: '={{ $json.statusCode || 200 }}',
        },
      },
    },
    {
      id: 'if-run-mail',
      name: 'Send Mail?',
      type: 'n8n-nodes-base.if',
      typeVersion: 1,
      position: [1340, 340],
      parameters: {
        conditions: {
          boolean: [
            {
              value1: '={{ $json.dryRun }}',
              operation: 'equal',
              value2: false,
            },
          ],
        },
      },
    },
    emailSendNode(
      'Send Result Mail',
      'email-run',
      [1560, 340],
      '={{ `${$json.dryRun ? ($json.ok ? "DRY-RUN OK" : "DRY-RUN FAIL") : ($json.ok ? "OK" : "FAIL")} Docker update: ${$json.labels.join(", ")}` }}',
      '={{ $json.mailHtml }}',
    ),
  ],
  connections: {
    'Webhook Run': {
      main: [[{ node: 'Validate Selection', type: 'main', index: 0 }]],
    },
    'Validate Selection': {
      main: [[{ node: 'Valid Request?', type: 'main', index: 0 }]],
    },
    'Valid Request?': {
      main: [
        [{ node: 'SSH Apply Update', type: 'main', index: 0 }],
        [{ node: 'Respond JSON', type: 'main', index: 0 }],
      ],
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
  [cli.templateOnly ? artifactNames.allowedServices : renderedArtifactName(artifactNames.allowedServices)]:
    services.map((service) => service.service).join('\n') + '\n',
  [cli.templateOnly ? artifactNames.checker : renderedArtifactName(artifactNames.checker)]:
    JSON.stringify(checkerWorkflow, null, 2) + '\n',
  [cli.templateOnly ? artifactNames.ui : renderedArtifactName(artifactNames.ui)]:
    JSON.stringify(uiWorkflow, null, 2) + '\n',
  [cli.templateOnly ? artifactNames.run : renderedArtifactName(artifactNames.run)]:
    JSON.stringify(runWorkflow, null, 2) + '\n',
};

const printOnly = cli.printOnly;
if (printOnly) {
  if (!artifacts[printOnly]) {
    console.error(`Unknown artifact: ${printOnly}`);
    process.exit(1);
  }
  process.stdout.write(artifacts[printOnly]);
  process.exit(0);
}

for (const [filename, content] of Object.entries(artifacts)) {
  await fs.mkdir(path.dirname(path.join(__dirname, filename)), { recursive: true });
  await fs.writeFile(path.join(__dirname, filename), content);
}

console.log(
  `Generated ${cli.templateOnly ? 'template' : 'rendered'} artifacts from ${path.basename(configPath)}`,
);
