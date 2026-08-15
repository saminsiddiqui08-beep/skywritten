const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../public/data');
const META_PATH = path.join(DATA_DIR, 'apod_index.meta.json');
const SHARD_DIR = path.join(DATA_DIR, 'apod');
const SHARD_STAGING_DIR = SHARD_DIR + '.tmp';

// Exiting on a missing key rather than falling through, so an unconfigured shell can never quietly produce a half-empty index
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
const START_YEAR = 1995;
const EXPECTED_CALENDAR_KEYS = 366;
const REQUEST_DELAY_MS = 350;
const MAX_ATTEMPTS_PER_RANGE = 6;
const BASE_BACKOFF_MS = 1500;
const MAX_BACKOFF_MS = 60000;
const BACKOFF_JITTER_MS = 400;
const VALID_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const VIDEO_STILL_TITLE_PATTERN = /\b(movies?|videos?|time[\s-]?lapses?|timelapses?)\b/i;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function computeBackoffDelay(attempt) {
    const exponential = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt - 1), MAX_BACKOFF_MS);
    return exponential + Math.floor(Math.random() * BACKOFF_JITTER_MS);
}

// Anchoring the first range to 1995-06-16, the earliest entry the APOD archive actually serves
function buildYearRanges() {
    const today = new Date();
    const currentYear = today.getUTCFullYear();
    const todayStr = today.toISOString().split('T')[0];

    const ranges = [];
    for (let year = START_YEAR; year <= currentYear; year++) {
        const start = year === START_YEAR ? '1995-06-16' : `${year}-01-01`;
        const end = year === currentYear ? todayStr : `${year}-12-31`;
        ranges.push({ year, start, end });
    }
    return ranges;
}

function splitIntoQuarters({ year, start, end }) {
    const quarterBounds = [
        [`${year}-01-01`, `${year}-03-31`],
        [`${year}-04-01`, `${year}-06-30`],
        [`${year}-07-01`, `${year}-09-30`],
        [`${year}-10-01`, `${year}-12-31`]
    ];

    return quarterBounds
        .map(([qStart, qEnd]) => ({
            year,
            start: qStart < start ? start : qStart,
            end: qEnd > end ? end : qEnd
        }))
        .filter(q => q.start <= q.end);
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

async function fetchRange({ year, start, end }, label) {
    const url = `https://api.nasa.gov/planetary/apod?api_key=${NASA_API_KEY}&start_date=${start}&end_date=${end}`;
    let attempt = 1;

    while (true) {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP status ${response.status}`);
            const data = await response.json();
            return Array.isArray(data) ? data : [data];
        } catch (err) {
            if (attempt >= MAX_ATTEMPTS_PER_RANGE) {
                throw new Error(`${label} failed after ${MAX_ATTEMPTS_PER_RANGE} attempts (${err.message})`);
            }
            const backoff = computeBackoffDelay(attempt);
            console.warn(`[Skywritten] ${label} attempt ${attempt} failed (${err.message}). Retrying in ${backoff}ms...`);
            await sleep(backoff);
            attempt++;
        }
    }
}

async function fetchApodArchiveData() {
    const ranges = buildYearRanges();
    const allRecords = [];
    let stillFailed = [];

    console.log(`[Skywritten] Pass 1: Fetching ${ranges.length} yearly chunks (${START_YEAR}-${new Date().getUTCFullYear()})...`);

    for (const range of ranges) {
        try {
            const records = await fetchRange(range, `Year ${range.year}`);
            console.log(`[Skywritten] Year ${range.year}: retrieved ${records.length} raw entries.`);
            allRecords.push(...records);
        } catch (err) {
            console.error(`[Skywritten] ${err.message}`);
            stillFailed.push(range);
        }
        await sleep(REQUEST_DELAY_MS);
    }

    // Narrowing a failed year into quarters, since the range endpoint times out on wide spans far more often than it rejects them
    if (stillFailed.length > 0) {
        console.log(`\n[Skywritten] Pass 2: Retrying ${stillFailed.length} failed year(s) in quarterly chunks after a 15s cooldown...`);
        await sleep(15000);

        const quarterFailures = [];
        for (const range of stillFailed) {
            for (const quarter of splitIntoQuarters(range)) {
                const label = `Year ${quarter.year} (${quarter.start}..${quarter.end})`;
                try {
                    const records = await fetchRange(quarter, label);
                    console.log(`[Skywritten] ${label}: retrieved ${records.length} raw entries.`);
                    allRecords.push(...records);
                } catch (err) {
                    console.error(`[Skywritten] ${err.message}`);
                    quarterFailures.push(quarter);
                }
                await sleep(REQUEST_DELAY_MS);
            }
        }
        stillFailed = quarterFailures;
    }

    return { records: allRecords, stillFailed };
}

function normalizeToHttps(url) {
    if (!url) return null;
    return url.trim().replace(/^http:\/\//i, 'https://');
}

// Rejecting the still frames NASA publishes for video entries, which pass every format check but carry a painted-on play button that does nothing on a gift page
function isVideoStillTitle(title) {
    return VIDEO_STILL_TITLE_PATTERN.test(title || '');
}

function hasValidImageExtension(url) {
    if (!url) return false;
    const withoutQuery = url.split('?')[0].toLowerCase();
    return VALID_IMAGE_EXTENSIONS.some(extension => withoutQuery.endsWith(extension));
}

function processCatalogIntoMonthDayMap(records) {
    const monthDayIndex = {};
    const seenDates = new Set();
    let skippedNonImages = 0;
    let skippedVideoStills = 0;
    let skippedBadExtension = 0;
    let skippedNoUrl = 0;
    let skippedDuplicates = 0;

    records.forEach(entry => {
        if (!entry.date) return;

        if (seenDates.has(entry.date)) {
            skippedDuplicates++;
            return;
        }
        seenDates.add(entry.date);

        if (entry.media_type !== 'image') {
            skippedNonImages++;
            return;
        }

        if (isVideoStillTitle(entry.title)) {
            skippedVideoStills++;
            return;
        }

        const dateParts = entry.date.split('-');
        if (dateParts.length !== 3) return;

        // Rewriting the scheme because pre-2010 archive entries are still served over plain http, which the deployed site blocks as mixed content
        const displayUrl = normalizeToHttps(entry.url) || normalizeToHttps(entry.hdurl);
        if (!displayUrl) {
            skippedNoUrl++;
            return;
        }

        // Trusting the file extension over NASA's own media_type field, which mislabels interactive pages and embedded players as images
        if (!hasValidImageExtension(displayUrl)) {
            skippedBadExtension++;
            return;
        }

        const monthDayKey = `${dateParts[1]}-${dateParts[2]}`;
        const record = {
            year: parseInt(dateParts[0], 10),
            url: displayUrl,
            title: entry.title ? entry.title.trim() : 'Archival Deep Space Field'
        };

        // Carrying the print master alongside the display copy so the hero can be resized on demand instead of shipping a 15 MB original to a phone
        const masterUrl = normalizeToHttps(entry.hdurl);
        if (masterUrl && masterUrl !== displayUrl && hasValidImageExtension(masterUrl)) {
            record.master = masterUrl;
        }

        if (!monthDayIndex[monthDayKey]) {
            monthDayIndex[monthDayKey] = [];
        }
        monthDayIndex[monthDayKey].push(record);
    });

    Object.keys(monthDayIndex).forEach(key => {
        monthDayIndex[key].sort((a, b) => b.year - a.year);
    });

    return { monthDayIndex, skippedNonImages, skippedVideoStills, skippedBadExtension, skippedNoUrl, skippedDuplicates };
}

function summarizeIndex(index) {
    const keys = Object.keys(index);
    return {
        keys: new Set(keys),
        keyCount: keys.length,
        entryCount: keys.reduce((sum, key) => sum + index[key].length, 0)
    };
}

// Treating the previous index as the only available notion of a healthy run, since the build has nothing else to measure itself against
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
    if (fresh.keyCount !== EXPECTED_CALENDAR_KEYS) {
        throw new Error(`Calendar coverage is ${fresh.keyCount}/${EXPECTED_CALENDAR_KEYS}. APOD has published daily since 1995, so a gap means lost data. Nothing was written.`);
    }

    if (!baseline) return;

    const missingKeys = [...baseline.keys].filter(key => !fresh.keys.has(key));
    if (missingKeys.length > 0) {
        throw new Error(`${missingKeys.length} calendar key(s) present in the existing index are absent from this run: ${missingKeys.join(', ')}. Nothing was written.`);
    }
}

function writeIndexArtifacts(monthDayIndex) {
    fs.mkdirSync(DATA_DIR, { recursive: true });

    // Sharding by calendar key so one birthday costs a few KB rather than the entire 1.3 MB archive on every page load
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
        source: 'apod',
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

async function runIndexBuild() {
    const baseline = readBaselineSummary();
    if (!baseline) {
        console.log('[Skywritten] No existing APOD index found. This run establishes the baseline.');
    }

    const { records, stillFailed } = await fetchApodArchiveData();

    // Refusing to write while anything is outstanding, because a thin index and a complete one are indistinguishable once they hit the repo
    if (stillFailed.length > 0) {
        console.error(`\n[Skywritten] ${stillFailed.length} range(s) still failing after both passes:`);
        stillFailed.forEach(range => console.error(`  - Year ${range.year}: ${range.start}..${range.end}`));
        throw new Error('Outstanding requests remain. No files were written. Re-run when the API is reachable.');
    }

    if (records.length === 0) {
        throw new Error('Zero records retrieved from the APOD archive. No files were written.');
    }

    const { monthDayIndex, skippedNonImages, skippedVideoStills, skippedBadExtension, skippedNoUrl, skippedDuplicates } = processCatalogIntoMonthDayMap(records);
    const fresh = summarizeIndex(monthDayIndex);

    assertCoverageAgainstBaseline(baseline, fresh);
    writeIndexArtifacts(monthDayIndex);

    const shardTotalKB = fs.readdirSync(SHARD_DIR)
        .reduce((total, shardFile) => total + fs.statSync(path.join(SHARD_DIR, shardFile)).size, 0) / 1024;

    console.log(`\n==================================================`);
    console.log(`[Skywritten] APOD INDEX BUILD COMPLETE`);
    console.log(`==================================================`);
    console.log(`[Skywritten]   Schema Version       : ${SCHEMA_VERSION}`);
    console.log(`[Skywritten]   Calendar Keys        : ${describeChange(baseline ? baseline.keyCount : null, fresh.keyCount)}`);
    console.log(`[Skywritten]   Authentic Images     : ${describeChange(baseline ? baseline.entryCount : null, fresh.entryCount)}`);
    console.log(`[Skywritten]   Skipped (Non-Image)  : ${skippedNonImages}`);
    console.log(`[Skywritten]   Skipped (Video Still): ${skippedVideoStills}`);
    console.log(`[Skywritten]   Skipped (Bad Ext)    : ${skippedBadExtension}`);
    console.log(`[Skywritten]   Skipped (No URL)     : ${skippedNoUrl}`);
    console.log(`[Skywritten]   Skipped (Duplicates) : ${skippedDuplicates}`);
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
