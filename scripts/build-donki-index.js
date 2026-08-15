const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../public/data');
const META_PATH = path.join(DATA_DIR, 'donki_index.meta.json');
const SHARD_DIR = path.join(DATA_DIR, 'donki');
const SHARD_STAGING_DIR = SHARD_DIR + '.tmp';

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
const START_YEAR = 2010;
const REQUEST_DELAY_MS = 350;
const MAX_ATTEMPTS_PER_RANGE = 6;
const BASE_BACKOFF_MS = 1500;
const MAX_BACKOFF_MS = 60000;
const BACKOFF_JITTER_MS = 400;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function computeBackoffDelay(attempt) {
    const exponential = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt - 1), MAX_BACKOFF_MS);
    return exponential + Math.floor(Math.random() * BACKOFF_JITTER_MS);
}

function buildYearRanges() {
    const today = new Date();
    const currentYear = today.getUTCFullYear();
    const todayStr = today.toISOString().split('T')[0];

    const ranges = [];
    for (let year = START_YEAR; year <= currentYear; year++) {
        const end = year === currentYear ? todayStr : `${year}-12-31`;
        ranges.push({ year, start: `${year}-01-01`, end });
    }
    return ranges;
}

function splitIntoHalves({ year, start, end }) {
    const halfBounds = [
        [`${year}-01-01`, `${year}-06-30`],
        [`${year}-07-01`, `${year}-12-31`]
    ];

    return halfBounds
        .map(([hStart, hEnd]) => ({
            year,
            start: hStart < start ? start : hStart,
            end: hEnd > end ? end : hEnd
        }))
        .filter(half => half.start <= half.end);
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

// Keeping only M and X class events, because anything weaker has no observable effect on the ground and reads as filler inside a biography
function isSignificantFlare(classType) {
    if (!classType) return false;
    const letter = classType.charAt(0).toUpperCase();
    return letter === 'X' || letter === 'M';
}

function parseFlareIntensity(classType) {
    if (!classType) return 0;
    const letter = classType.charAt(0).toUpperCase();
    const magnitude = parseFloat(classType.substring(1)) || 0;
    const letterWeight = letter === 'X' ? 1000 : 100;
    return letterWeight + magnitude;
}

function extractDateFromTimestamp(timestamp) {
    if (!timestamp) return null;
    const dateOnly = timestamp.split('T')[0];
    return /^\d{4}-\d{2}-\d{2}$/.test(dateOnly) ? dateOnly : null;
}

async function fetchFlareRange({ start, end }, label) {
    const url = `https://api.nasa.gov/DONKI/FLR?startDate=${start}&endDate=${end}&api_key=${NASA_API_KEY}`;
    let attempt = 1;

    while (true) {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP status ${response.status}`);
            const data = await response.json();

            // Accepting an empty array as a real answer, since solar minimum produces long stretches with no M or X class activity at all
            if (!Array.isArray(data)) throw new Error('Malformed payload: expected an array');
            return data;
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

async function fetchFlareArchiveData() {
    const ranges = buildYearRanges();
    const allRecords = [];
    let stillFailed = [];

    console.log(`[Skywritten] Pass 1: Fetching ${ranges.length} yearly chunks (${START_YEAR}-${new Date().getUTCFullYear()})...`);

    for (const range of ranges) {
        try {
            const records = await fetchFlareRange(range, `Year ${range.year}`);
            console.log(`[Skywritten] Year ${range.year}: retrieved ${records.length} raw flare entries.`);
            allRecords.push(...records);
        } catch (err) {
            console.error(`[Skywritten] ${err.message}`);
            stillFailed.push(range);
        }
        await sleep(REQUEST_DELAY_MS);
    }

    // Halving a failed year on the second pass, since an active solar-maximum year returns a payload large enough to time out on its own
    if (stillFailed.length > 0) {
        console.log(`\n[Skywritten] Pass 2: Retrying ${stillFailed.length} failed year(s) in half-year chunks after a 15s cooldown...`);
        await sleep(15000);

        const halfFailures = [];
        for (const range of stillFailed) {
            for (const half of splitIntoHalves(range)) {
                const label = `Year ${half.year} (${half.start}..${half.end})`;
                try {
                    const records = await fetchFlareRange(half, label);
                    console.log(`[Skywritten] ${label}: retrieved ${records.length} raw flare entries.`);
                    allRecords.push(...records);
                } catch (err) {
                    console.error(`[Skywritten] ${err.message}`);
                    halfFailures.push(half);
                }
                await sleep(REQUEST_DELAY_MS);
            }
        }
        stillFailed = halfFailures;
    }

    return { records: allRecords, stillFailed };
}

function processFlareRecords(allRecords) {
    const monthDayIndex = {};
    const seenFlareIds = new Set();
    let skippedMinorClass = 0;
    let skippedNoDate = 0;
    let skippedDuplicates = 0;

    for (const flare of allRecords) {
        if (flare.flrID && seenFlareIds.has(flare.flrID)) {
            skippedDuplicates++;
            continue;
        }
        if (flare.flrID) seenFlareIds.add(flare.flrID);

        if (!isSignificantFlare(flare.classType)) {
            skippedMinorClass++;
            continue;
        }

        const flareDate = extractDateFromTimestamp(flare.beginTime || flare.peakTime);
        if (!flareDate) {
            skippedNoDate++;
            continue;
        }

        // Keying by month and day rather than exact date, which is what lets the flare year picker behave identically to the APOD and EPIC pickers
        const dateParts = flareDate.split('-');
        const monthDayKey = `${dateParts[1]}-${dateParts[2]}`;

        if (!monthDayIndex[monthDayKey]) {
            monthDayIndex[monthDayKey] = [];
        }

        monthDayIndex[monthDayKey].push({
            year: parseInt(dateParts[0], 10),
            classType: flare.classType,
            peakTime: flare.peakTime || flare.beginTime,
            sourceLocation: flare.sourceLocation || null
        });
    }

    // Ranking the strongest flare first within a year so the templates can lead with the most dramatic event on a crowded date
    Object.keys(monthDayIndex).forEach(key => {
        monthDayIndex[key].sort((a, b) => {
            if (b.year !== a.year) return b.year - a.year;
            return parseFlareIntensity(b.classType) - parseFlareIntensity(a.classType);
        });
    });

    return { monthDayIndex, skippedMinorClass, skippedNoDate, skippedDuplicates };
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

// Comparing only against what already existed, because a calendar day can legitimately carry no significant flare across the entire 2010-present window
function assertCoverageAgainstBaseline(baseline, fresh) {
    if (!baseline) return;

    const missingKeys = [...baseline.keys].filter(key => !fresh.keys.has(key));
    if (missingKeys.length > 0) {
        throw new Error(`${missingKeys.length} calendar key(s) present in the existing index are absent from this run: ${missingKeys.join(', ')}. Nothing was written.`);
    }
}

function writeIndexArtifacts(monthDayIndex) {
    fs.mkdirSync(DATA_DIR, { recursive: true });

    // Emitting a shard for every calendar key including the quiet ones, so a birthday with no flare answers with an empty array instead of a 404
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
        source: 'donki',
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
        console.log('[Skywritten] No existing DONKI index found. This run establishes the baseline.');
    }

    const { records, stillFailed } = await fetchFlareArchiveData();

    // Refusing to write while anything is outstanding, because a thin index and a complete one are indistinguishable once they hit the repo
    if (stillFailed.length > 0) {
        console.error(`\n[Skywritten] ${stillFailed.length} range(s) still failing after both passes:`);
        stillFailed.forEach(range => console.error(`  - Year ${range.year}: ${range.start}..${range.end}`));
        throw new Error('Outstanding requests remain. No files were written. Re-run when the API is reachable.');
    }

    if (records.length === 0) {
        throw new Error('Zero flare records retrieved from DONKI. No files were written.');
    }

    const { monthDayIndex, skippedMinorClass, skippedNoDate, skippedDuplicates } = processFlareRecords(records);
    const fresh = summarizeIndex(monthDayIndex);

    assertCoverageAgainstBaseline(baseline, fresh);
    writeIndexArtifacts(monthDayIndex);

    const shardTotalKB = fs.readdirSync(SHARD_DIR)
        .reduce((total, shardFile) => total + fs.statSync(path.join(SHARD_DIR, shardFile)).size, 0) / 1024;

    console.log(`\n==================================================`);
    console.log(`[Skywritten] DONKI INDEX BUILD COMPLETE`);
    console.log(`==================================================`);
    console.log(`[Skywritten]   Schema Version        : ${SCHEMA_VERSION}`);
    console.log(`[Skywritten]   Calendar Keys         : ${describeChange(baseline ? baseline.keyCount : null, fresh.keyCount)}`);
    console.log(`[Skywritten]   Significant Flares    : ${describeChange(baseline ? baseline.entryCount : null, fresh.entryCount)}`);
    console.log(`[Skywritten]   Skipped (Minor Class) : ${skippedMinorClass}`);
    console.log(`[Skywritten]   Skipped (No Date)     : ${skippedNoDate}`);
    console.log(`[Skywritten]   Skipped (Duplicates)  : ${skippedDuplicates}`);
    console.log(`[Skywritten]   Shard Total           : ${shardTotalKB.toFixed(1)} KB`);
    console.log(`[Skywritten]   Shards Written        : ${buildCalendarKeys().length} -> ${SHARD_DIR}`);
    console.log(`[Skywritten]   Outstanding Failures  : none`);
    console.log(`==================================================\n`);
}

runIndexBuild().catch(err => {
    console.error(`[Skywritten] Build execution halted: ${err.message}`);
    fs.rmSync(SHARD_STAGING_DIR, { recursive: true, force: true });
    process.exitCode = 1;
});
