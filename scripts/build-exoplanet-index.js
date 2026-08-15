const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../public/data');
const OUTPUT_PATH = path.join(DATA_DIR, 'exoplanet_index.json');
const TEMP_PATH = OUTPUT_PATH + '.tmp';
const META_PATH = path.join(DATA_DIR, 'exoplanet_index.meta.json');

const SCHEMA_VERSION = 2;
const TAP_ENDPOINT = 'https://exoplanetarchive.ipac.caltech.edu/TAP/sync';
const MAX_CANDIDATES_PER_YEAR = 8;
const MAX_ATTEMPTS = 6;
const BASE_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60000;
const BACKOFF_JITTER_MS = 600;
const EARLIEST_DISCOVERY_YEAR = 1990;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function computeBackoffDelay(attempt) {
    const exponential = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt - 1), MAX_BACKOFF_MS);
    return exponential + Math.floor(Math.random() * BACKOFF_JITTER_MS);
}

// Querying the composite pscomppars table rather than ps, which returns one row per published measurement and would duplicate every well-studied planet
function buildTapQueryUrl() {
    const adql = [
        'SELECT pl_name, hostname, disc_year, disc_method, disc_facility,',
        'pl_orbper, pl_rade, pl_bmasse',
        'FROM pscomppars',
        'WHERE disc_year IS NOT NULL',
        'AND pl_name IS NOT NULL',
        'ORDER BY disc_year, pl_name'
    ].join(' ');

    return `${TAP_ENDPOINT}?query=${encodeURIComponent(adql)}&format=json`;
}

// Scoring by how much the record can actually say, so a year's shortlist leads with planets that have a radius and a mass rather than a bare designation
function computeNarrativeRichness(planet) {
    let score = 0;
    if (planet.pl_rade) score += 2;
    if (planet.pl_bmasse) score += 2;
    if (planet.pl_orbper) score += 1;
    if (planet.disc_facility) score += 1;
    if (planet.disc_method) score += 1;
    return score;
}

// Reaching Caltech directly, which requires no credentials and therefore leaves the NASA key quota entirely untouched
async function fetchExoplanetCatalog() {
    const url = buildTapQueryUrl();
    let attempt = 1;

    while (true) {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP status ${response.status}`);
            const data = await response.json();

            if (Array.isArray(data)) return data;
            if (data && Array.isArray(data.data)) return data.data;
            throw new Error('Malformed payload: unexpected TAP response structure');
        } catch (err) {
            if (attempt >= MAX_ATTEMPTS) {
                throw new Error(`Exoplanet catalog fetch failed after ${MAX_ATTEMPTS} attempts (${err.message})`);
            }
            const backoff = computeBackoffDelay(attempt);
            console.warn(`[Skywritten] Catalog fetch attempt ${attempt} failed (${err.message}). Retrying in ${backoff}ms...`);
            await sleep(backoff);
            attempt++;
        }
    }
}

function processExoplanetCatalog(rawPlanets) {
    const yearBuckets = {};
    const seenPlanetNames = new Set();
    let skippedDuplicates = 0;
    let skippedInvalidYear = 0;

    for (const planet of rawPlanets) {
        const discoveryYear = parseInt(planet.disc_year, 10);
        if (!discoveryYear || discoveryYear < EARLIEST_DISCOVERY_YEAR) {
            skippedInvalidYear++;
            continue;
        }

        const planetName = planet.pl_name ? planet.pl_name.trim() : null;
        if (!planetName) continue;

        if (seenPlanetNames.has(planetName)) {
            skippedDuplicates++;
            continue;
        }
        seenPlanetNames.add(planetName);

        const yearKey = String(discoveryYear);
        if (!yearBuckets[yearKey]) {
            yearBuckets[yearKey] = [];
        }

        yearBuckets[yearKey].push({
            name: planetName,
            hostStar: planet.hostname || null,
            method: planet.disc_method || null,
            facility: planet.disc_facility || null,
            orbitalPeriodDays: planet.pl_orbper || null,
            radiusEarth: planet.pl_rade || null,
            massEarth: planet.pl_bmasse || null,
            _richness: computeNarrativeRichness(planet)
        });
    }

    const yearIndex = {};
    let totalCapped = 0;

    const sortedYears = Object.keys(yearBuckets).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

    // Capping each year because Kepler's bulk releases alone would otherwise push a handful of years past two thousand entries apiece
    for (const year of sortedYears) {
        const planets = yearBuckets[year];

        planets.sort((a, b) => {
            if (b._richness !== a._richness) return b._richness - a._richness;
            return a.name.localeCompare(b.name);
        });

        totalCapped += Math.max(0, planets.length - MAX_CANDIDATES_PER_YEAR);
        yearIndex[year] = planets
            .slice(0, MAX_CANDIDATES_PER_YEAR)
            .map(({ _richness, ...entry }) => entry);
    }

    return { yearIndex, skippedDuplicates, skippedInvalidYear, totalCapped };
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
    if (!fs.existsSync(OUTPUT_PATH)) return null;
    return summarizeIndex(JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8')));
}

// Guarding discovery years rather than calendar days, since this is the one index the templates address by birth year instead of by month and day
function assertCoverageAgainstBaseline(baseline, fresh) {
    if (!baseline) return;

    const missingYears = [...baseline.keys].filter(year => !fresh.keys.has(year));
    if (missingYears.length > 0) {
        throw new Error(`${missingYears.length} discovery year(s) present in the existing index are absent from this run: ${missingYears.join(', ')}. Nothing was written.`);
    }
}

function writeIndexArtifacts(yearIndex) {
    fs.mkdirSync(DATA_DIR, { recursive: true });

    fs.writeFileSync(TEMP_PATH, JSON.stringify(yearIndex), 'utf8');
    fs.renameSync(TEMP_PATH, OUTPUT_PATH);

    const summary = summarizeIndex(yearIndex);
    fs.writeFileSync(META_PATH, JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        source: 'exoplanet',
        keying: 'discovery-year',
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
        console.log('[Skywritten] No existing exoplanet index found. This run establishes the baseline.');
    }

    console.log('[Skywritten] Querying the NASA Exoplanet Archive (pscomppars table via TAP)...');
    const rawPlanets = await fetchExoplanetCatalog();

    if (rawPlanets.length === 0) {
        throw new Error('Zero records returned from the Exoplanet Archive. No files were written.');
    }

    console.log(`[Skywritten] Retrieved ${rawPlanets.length} confirmed exoplanet records.`);

    const { yearIndex, skippedDuplicates, skippedInvalidYear, totalCapped } = processExoplanetCatalog(rawPlanets);
    const fresh = summarizeIndex(yearIndex);

    assertCoverageAgainstBaseline(baseline, fresh);
    writeIndexArtifacts(yearIndex);

    const fileSizeKB = (fs.statSync(OUTPUT_PATH).size / 1024).toFixed(1);

    console.log(`\n==================================================`);
    console.log(`[Skywritten] EXOPLANET INDEX BUILD COMPLETE`);
    console.log(`==================================================`);
    console.log(`[Skywritten]   Schema Version        : ${SCHEMA_VERSION}`);
    console.log(`[Skywritten]   Discovery Years       : ${describeChange(baseline ? baseline.keyCount : null, fresh.keyCount)}`);
    console.log(`[Skywritten]   Indexed Planets       : ${describeChange(baseline ? baseline.entryCount : null, fresh.entryCount)}`);
    console.log(`[Skywritten]   Capped Overflow       : ${totalCapped} planets trimmed at ${MAX_CANDIDATES_PER_YEAR}/year`);
    console.log(`[Skywritten]   Skipped (Duplicates)  : ${skippedDuplicates}`);
    console.log(`[Skywritten]   Skipped (Invalid Year): ${skippedInvalidYear}`);
    console.log(`[Skywritten]   File Size             : ${fileSizeKB} KB`);
    console.log(`[Skywritten]   Outstanding Failures  : none`);
    console.log(`==================================================\n`);
}

runIndexBuild().catch(err => {
    console.error(`[Skywritten] Build execution halted: ${err.message}`);
    fs.rmSync(TEMP_PATH, { force: true });
    process.exitCode = 1;
});
