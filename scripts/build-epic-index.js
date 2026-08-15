const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../public/data');
const META_PATH = path.join(DATA_DIR, 'epic_index.meta.json');
const SHARD_DIR = path.join(DATA_DIR, 'epic');
const SHARD_STAGING_DIR = SHARD_DIR + '.tmp';
const CHECKPOINT_PATH = path.join(__dirname, '.epic-checkpoint.json');
const CHECKPOINT_TEMP_PATH = CHECKPOINT_PATH + '.tmp';

function requireNasaApiKey() {
    const key = process.env.NASA_API_KEY;
    if (key) return key;

    console.error('[Skywritten] NASA_API_KEY is not set. No requests were made.');
    console.error('[Skywritten] PowerShell:  $env:NASA_API_KEY="your-key-here"');
    console.error('[Skywritten] Then re-run:  npm run build:all');
    process.exit(1);
}

const NASA_API_KEY = requireNasaApiKey();

const SCHEMA_VERSION = 2;
const REQUEST_DELAY_MS = 400;
const BATCH_SIZE = 5;
const MAX_ATTEMPTS_PER_DATE = 5;
const GATEWAY_FALLBACK_FROM_ATTEMPT = 3;
const MAX_GATEWAY_FALLBACKS = 300;
const BASE_BACKOFF_MS = 1200;
const MAX_BACKOFF_MS = 45000;
const BACKOFF_JITTER_MS = 500;
const CHECKPOINT_EVERY_BATCHES = 20;
const VALID_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

let gatewayFallbacksUsed = 0;
let gatewayBudgetExhausted = false;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function computeBackoffDelay(attempt) {
    const exponential = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt - 1), MAX_BACKOFF_MS);
    return exponential + Math.floor(Math.random() * BACKOFF_JITTER_MS);
}

function hasValidImageExtension(url) {
    const withoutQuery = url.split('?')[0].toLowerCase();
    return VALID_IMAGE_EXTENSIONS.some(extension => withoutQuery.endsWith(extension));
}

function extractCleanDateString(rawEntry) {
    const raw = typeof rawEntry === 'string' ? rawEntry : (rawEntry && rawEntry.date);
    if (!raw) return null;
    const dateOnly = raw.trim().split(' ')[0].split('T')[0];
    return /^\d{4}-\d{2}-\d{2}$/.test(dateOnly) ? dateOnly : null;
}

function buildCalendarKeys() {
    const keys = [];
    const cursor = new Date(Date.UTC(2024, 0, 1));

    // Walking a leap year so 02-29 receives a shard alongside every other calendar key
    while (cursor.getUTCFullYear() === 2024) {
        keys.push(cursor.toISOString().slice(5, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return keys;
}

// Serving imagery straight from Goddard because the NASA gateway meters every request against a 1,000/hour key ceiling that ~4,000 dates would exhaust outright
function constructEpicArchiveUrl(yyyy, mm, dd, imageName, variant) {
    return `https://epic.gsfc.nasa.gov/archive/natural/${yyyy}/${mm}/${dd}/${variant}/${imageName}.jpg`;
}

function selectDateEndpoint(dateStr, attempt) {
    if (attempt < GATEWAY_FALLBACK_FROM_ATTEMPT) {
        return `https://epic.gsfc.nasa.gov/api/natural/date/${dateStr}`;
    }

    // Spending the metered gateway only as insurance against a bad Goddard hour, and stopping the run outright rather than burning the whole key quota on it
    if (gatewayFallbacksUsed >= MAX_GATEWAY_FALLBACKS) {
        gatewayBudgetExhausted = true;
        return null;
    }

    gatewayFallbacksUsed++;
    return `https://api.nasa.gov/EPIC/api/natural/date/${dateStr}?api_key=${NASA_API_KEY}`;
}

async function fetchAvailableObservationDates() {
    const endpoints = [
        'https://epic.gsfc.nasa.gov/api/natural/all',
        `https://api.nasa.gov/EPIC/api/natural/all?api_key=${NASA_API_KEY}`
    ];

    for (const url of endpoints) {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP status ${response.status}`);
            const data = await response.json();
            if (Array.isArray(data) && data.length > 0) return data;
            throw new Error('Empty or malformed date directory');
        } catch (err) {
            console.warn(`[Skywritten] Date directory unavailable at ${url.split('?')[0]} (${err.message}).`);
        }
    }

    throw new Error('Failed to retrieve the EPIC observation date directory from either endpoint.');
}

async function fetchDateImagery(dateStr) {
    let attempt = 1;

    while (true) {
        const url = selectDateEndpoint(dateStr, attempt);
        if (!url) {
            throw new Error(`${dateStr} abandoned: gateway fallback budget of ${MAX_GATEWAY_FALLBACKS} exhausted`);
        }

        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP status ${response.status}`);
            const data = await response.json();
            if (!Array.isArray(data)) throw new Error('Malformed payload: expected an array');
            return data;
        } catch (err) {
            if (attempt >= MAX_ATTEMPTS_PER_DATE) {
                throw new Error(`${dateStr} failed after ${MAX_ATTEMPTS_PER_DATE} attempts (${err.message})`);
            }
            const backoff = computeBackoffDelay(attempt);
            console.warn(`[Skywritten] ${dateStr} attempt ${attempt} failed (${err.message}). Retrying in ${backoff}ms...`);
            await sleep(backoff);
            attempt++;
        }
    }
}

function composeObservationTitle(yyyy, mm, dd) {
    const monthName = MONTH_NAMES[parseInt(mm, 10) - 1];
    return `Earth from a Million Miles \u2014 ${monthName} ${parseInt(dd, 10)}, ${yyyy}`;
}

// Replacing the archive's stock caption, which is byte-identical on every observation and left the year picker showing ten indistinguishable rows
function buildObservationEntry(dateStr, photos) {
    if (photos.length === 0) return null;

    const representativeShot = photos[0];
    if (!representativeShot.image) return null;

    const [yyyy, mm, dd] = dateStr.split('-');
    const displayUrl = constructEpicArchiveUrl(yyyy, mm, dd, representativeShot.image, 'jpg');
    if (!hasValidImageExtension(displayUrl)) return null;

    return {
        year: parseInt(yyyy, 10),
        url: displayUrl,
        thumb: constructEpicArchiveUrl(yyyy, mm, dd, representativeShot.image, 'thumbs'),
        title: composeObservationTitle(yyyy, mm, dd)
    };
}

// Resuming from disk because a full pass over four thousand dates runs well past half an hour and a failure near the end should not cost the entire run
function loadCheckpoint() {
    if (!fs.existsSync(CHECKPOINT_PATH)) return {};

    const saved = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
    if (saved.schemaVersion !== SCHEMA_VERSION) {
        console.log(`[Skywritten] Discarding checkpoint written for schema v${saved.schemaVersion}; this build emits v${SCHEMA_VERSION}.`);
        return {};
    }

    const resumedCount = Object.keys(saved.observations).length;
    console.log(`[Skywritten] Resuming from checkpoint: ${resumedCount} date(s) already retrieved.`);
    return saved.observations;
}

function persistCheckpoint(observations) {
    fs.writeFileSync(CHECKPOINT_TEMP_PATH, JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        savedAt: new Date().toISOString(),
        observations
    }), 'utf8');
    fs.renameSync(CHECKPOINT_TEMP_PATH, CHECKPOINT_PATH);
}

// Settling the whole batch instead of racing it, so a single unreachable date cannot discard four perfectly good responses alongside it
async function retrieveBatch(dateBatch, observations) {
    const settled = await Promise.allSettled(
        dateBatch.map(dateStr => fetchDateImagery(dateStr).then(photos => ({ dateStr, photos })))
    );

    const batchFailures = [];

    settled.forEach((result, index) => {
        if (result.status !== 'fulfilled') {
            batchFailures.push(dateBatch[index]);
            return;
        }
        observations[result.value.dateStr] = buildObservationEntry(result.value.dateStr, result.value.photos);
    });

    return batchFailures;
}

function assembleMonthDayIndex(observations) {
    const monthDayIndex = {};
    let emptyObservations = 0;

    Object.keys(observations).forEach(dateStr => {
        const entry = observations[dateStr];

        // Treating a date with no imagery as a real answer rather than a failure, since the DSCOVR archive has genuine gaps the build can never fill
        if (!entry) {
            emptyObservations++;
            return;
        }

        const monthDayKey = dateStr.slice(5);
        if (!monthDayIndex[monthDayKey]) {
            monthDayIndex[monthDayKey] = [];
        }
        monthDayIndex[monthDayKey].push(entry);
    });

    Object.keys(monthDayIndex).forEach(key => {
        monthDayIndex[key].sort((a, b) => b.year - a.year);
    });

    return { monthDayIndex, emptyObservations };
}

function summarizeIndex(index) {
    const keys = Object.keys(index);
    return {
        keys: new Set(keys),
        keyCount: keys.length,
        entryCount: keys.reduce((sum, key) => sum + index[key].length, 0)
    };
}

function readBaselineSummary() {
    if (!fs.existsSync(SHARD_DIR)) return null;

    const previousIndex = {};
    fs.readdirSync(SHARD_DIR).forEach(shardFile => {
        const entries = JSON.parse(fs.readFileSync(path.join(SHARD_DIR, shardFile), 'utf8'));
        if (entries.length > 0) {
            previousIndex[shardFile.replace('.json', '')] = entries;
        }
    });

    return summarizeIndex(previousIndex);
}

function assertCoverageAgainstBaseline(baseline, fresh) {
    if (!baseline) return;

    const missingKeys = [...baseline.keys].filter(key => !fresh.keys.has(key));
    if (missingKeys.length > 0) {
        throw new Error(`${missingKeys.length} calendar key(s) present in the existing index are absent from this run: ${missingKeys.join(', ')}. Nothing was written.`);
    }
}

function writeIndexArtifacts(monthDayIndex) {
    fs.mkdirSync(DATA_DIR, { recursive: true });

    // Sharding by calendar key so one birthday costs a couple of KB rather than the entire archive on every page load
    fs.rmSync(SHARD_STAGING_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHARD_STAGING_DIR, { recursive: true });

    buildCalendarKeys().forEach(key => {
        fs.writeFileSync(path.join(SHARD_STAGING_DIR, `${key}.json`), JSON.stringify(monthDayIndex[key] || []), 'utf8');
    });

    // Clearing the live shard directory only once the staging copy is complete on disk, so a failed fetch can never leave the site with no data at all
    fs.rmSync(SHARD_DIR, { recursive: true, force: true });
    fs.renameSync(SHARD_STAGING_DIR, SHARD_DIR);

    const summary = summarizeIndex(monthDayIndex);
    fs.writeFileSync(META_PATH, JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        source: 'epic',
        keying: 'month-day',
        generatedAt: new Date().toISOString(),
        keyCount: summary.keyCount,
        entryCount: summary.entryCount
    }), 'utf8');
}

function describeChange(previousValue, currentValue) {
    if (previousValue === null) return `${currentValue}  (no baseline)`;
    const delta = currentValue - previousValue;
    const sign = delta < 0 ? '' : '+';
    return `${currentValue}  (was ${previousValue}, ${sign}${delta})`;
}

function reportOutstanding(failedDates, observations) {
    persistCheckpoint(observations);

    console.error(`\n[Skywritten] ${failedDates.length} date(s) still failing after both passes:`);
    failedDates.forEach(dateStr => console.error(`  - ${dateStr}`));
    console.error(`[Skywritten] Progress saved to ${CHECKPOINT_PATH}. Re-run npm run build:epic to resume.`);
}

async function runIndexBuild() {
    const baseline = readBaselineSummary();
    if (!baseline) {
        console.log('[Skywritten] No existing EPIC index found. This run establishes the baseline.');
    }

    console.log('[Skywritten] Querying EPIC observation date directory...');
    const rawDatesList = await fetchAvailableObservationDates();

    // Collapsing the directory to unique days, since DSCOVR records many observations per date and the index only needs one per day
    const observationDates = [...new Set(rawDatesList.map(extractCleanDateString).filter(Boolean))].sort();
    if (observationDates.length === 0) {
        throw new Error('No valid observation dates found in the EPIC directory. No files were written.');
    }

    const observations = loadCheckpoint();
    const outstandingDates = observationDates.filter(dateStr => !(dateStr in observations));

    console.log(`[Skywritten] Located ${observationDates.length} observation dates; ${outstandingDates.length} still to retrieve.`);
    console.log(`[Skywritten] Pass 1: Fetching metadata in batches of ${BATCH_SIZE}...\n`);

    let failedDates = [];
    let batchesSinceCheckpoint = 0;

    for (let i = 0; i < outstandingDates.length; i += BATCH_SIZE) {
        const batch = outstandingDates.slice(i, i + BATCH_SIZE);
        failedDates.push(...await retrieveBatch(batch, observations));

        batchesSinceCheckpoint++;
        if (batchesSinceCheckpoint >= CHECKPOINT_EVERY_BATCHES) {
            persistCheckpoint(observations);
            batchesSinceCheckpoint = 0;
        }

        if (gatewayBudgetExhausted) {
            persistCheckpoint(observations);
            throw new Error(`Gateway fallback budget of ${MAX_GATEWAY_FALLBACKS} exhausted. Goddard is likely degraded; progress saved, re-run later to resume.`);
        }

        const processed = Math.min(i + BATCH_SIZE, outstandingDates.length);
        if (processed % 100 < BATCH_SIZE || processed === outstandingDates.length) {
            console.log(`[Skywritten] Progress: ${processed} / ${outstandingDates.length} dates (${failedDates.length} failed, ${gatewayFallbacksUsed} gateway fallbacks)`);
        }

        await sleep(REQUEST_DELAY_MS);
    }

    if (failedDates.length > 0) {
        console.log(`\n[Skywritten] Pass 2: Retrying ${failedDates.length} failed date(s) after a 15s cooldown...`);
        persistCheckpoint(observations);
        await sleep(15000);

        const permanentFailures = [];
        for (const dateStr of failedDates) {
            try {
                observations[dateStr] = buildObservationEntry(dateStr, await fetchDateImagery(dateStr));
            } catch (err) {
                console.error(`[Skywritten] ${err.message}`);
                permanentFailures.push(dateStr);
            }
            await sleep(REQUEST_DELAY_MS);
        }
        failedDates = permanentFailures;
    }

    // Refusing to write while anything is outstanding, because a thin index and a complete one are indistinguishable once they hit the repo
    if (failedDates.length > 0) {
        reportOutstanding(failedDates, observations);
        throw new Error('Outstanding requests remain. No files were written.');
    }

    const { monthDayIndex, emptyObservations } = assembleMonthDayIndex(observations);
    const fresh = summarizeIndex(monthDayIndex);

    if (fresh.entryCount === 0) {
        throw new Error('Zero images indexed from the EPIC archive. No files were written.');
    }

    assertCoverageAgainstBaseline(baseline, fresh);
    writeIndexArtifacts(monthDayIndex);
    fs.rmSync(CHECKPOINT_PATH, { force: true });

    const shardTotalKB = fs.readdirSync(SHARD_DIR)
        .reduce((total, shardFile) => total + fs.statSync(path.join(SHARD_DIR, shardFile)).size, 0) / 1024;

    console.log(`\n==================================================`);
    console.log(`[Skywritten] EPIC INDEX BUILD COMPLETE`);
    console.log(`==================================================`);
    console.log(`[Skywritten]   Schema Version       : ${SCHEMA_VERSION}`);
    console.log(`[Skywritten]   Calendar Keys        : ${describeChange(baseline ? baseline.keyCount : null, fresh.keyCount)}`);
    console.log(`[Skywritten]   Authentic Images     : ${describeChange(baseline ? baseline.entryCount : null, fresh.entryCount)}`);
    console.log(`[Skywritten]   Dates Without Images : ${emptyObservations}`);
    console.log(`[Skywritten]   Gateway Fallbacks    : ${gatewayFallbacksUsed} / ${MAX_GATEWAY_FALLBACKS}`);
    console.log(`[Skywritten]   Shard Total          : ${shardTotalKB.toFixed(1)} KB`);
    console.log(`[Skywritten]   Shards Written       : ${buildCalendarKeys().length} -> ${SHARD_DIR}`);
    console.log(`[Skywritten]   Outstanding Failures : none`);
    console.log(`==================================================\n`);
}

runIndexBuild().catch(err => {
    console.error(`[Skywritten] Build execution halted: ${err.message}`);
    fs.rmSync(SHARD_STAGING_DIR, { recursive: true, force: true });
    process.exitCode = 1;
});
