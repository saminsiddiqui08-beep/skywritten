const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 8;
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;
const RATE_WINDOW_SECONDS = 60 * 60;
const LINKS_PER_WINDOW = 20;
const EARLIEST_STORABLE_YEAR = 1900;

// Re-checking the date at the boundary, because the field constraints that keep a giver honest are absent from any request made outside the browser
function isStorableBirthDate(rawDateString) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDateString)) return false;

    const [year, month, day] = rawDateString.split('-').map(Number);
    const candidate = new Date(Date.UTC(year, month - 1, day));
    if (candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return false;

    return year >= EARLIEST_STORABLE_YEAR && year <= new Date().getUTCFullYear() + 1;
}

// Drawing from a 62 character alphabet at eight places, which leaves guessing a stranger's gift link about as likely as guessing a specific second in the next seven billion years
function generateShortId() {
    const randomBytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
    let result = '';
    for (let i = 0; i < ID_LENGTH; i++) {
        result += ID_ALPHABET[randomBytes[i] % ID_ALPHABET.length];
    }
    return result;
}

function jsonResponse(body, status) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store'
        }
    });
}

// Counting in the edge cache rather than the key-value store, because a rate counter is written on every single request and KV writes are the scarcest quota this project has
async function consumeRateToken(clientAddress, bucketName, requestsPerWindow, windowSeconds) {
    if (!clientAddress) return true;

    const cache = caches.default;
    const windowStamp = Math.floor(Date.now() / 1000 / windowSeconds);
    const counterKey = `https://skywritten.invalid/${bucketName}/${encodeURIComponent(clientAddress)}/${windowStamp}`;

    const cachedCounter = await cache.match(counterKey);
    const currentCount = cachedCounter ? Number(await cachedCounter.text()) : 0;
    if (currentCount >= requestsPerWindow) return false;

    await cache.put(counterKey, new Response(String(currentCount + 1), {
        headers: { 'Cache-Control': `max-age=${windowSeconds}` }
    }));
    return true;
}

// Rejecting only a mismatched origin and never a missing one, since some clients omit the header entirely on same-site posts and refusing those would break the app to inconvenience nobody
function originIsForeign(request) {
    const declaredOrigin = request.headers.get('Origin');
    if (!declaredOrigin) return false;
    return declaredOrigin !== new URL(request.url).origin;
}

export async function onRequestPost(context) {
    const { request, env } = context;

    if (!env.GIFT_STORE) {
        return jsonResponse({ error: 'Gift storage is not configured.' }, 503);
    }

    if (originIsForeign(request)) {
        return jsonResponse({ error: 'Requests must come from Skywritten itself.' }, 403);
    }

    const clientAddress = request.headers.get('CF-Connecting-IP');
    if (!await consumeRateToken(clientAddress, 'link', LINKS_PER_WINDOW, RATE_WINDOW_SECONDS)) {
        return jsonResponse({
            error: 'That is a lot of gifts at once. Please try again in a little while.'
        }, 429);
    }

    let incoming;
    try {
        incoming = await request.json();
    } catch {
        return jsonResponse({ error: 'Could not parse request body.' }, 400);
    }

    if (!incoming.date || !incoming.template) {
        return jsonResponse({ error: 'Missing required fields: date, template.' }, 400);
    }

    if (!isStorableBirthDate(incoming.date)) {
        return jsonResponse({ error: 'That date is outside the range Skywritten can chart.' }, 400);
    }

    // Capping every stored field at the point of storage, since a browser maxlength attribute does not apply to anything assigned programmatically
    const giftRecord = {
        v: 1,
        date: incoming.date,
        name: (incoming.name || '').trim().substring(0, 60),
        template: incoming.template,
        chosenApodYear: incoming.chosenApodYear || null,
        chosenEpicYear: incoming.chosenEpicYear || null,
        donkiOptedIn: !!incoming.donkiOptedIn,
        chosenDonkiDate: incoming.chosenDonkiDate || null,
        exoplanetOptedIn: !!incoming.exoplanetOptedIn,
        chosenExoplanetYear: incoming.chosenExoplanetYear || null,
        narrative: (incoming.styledNarrative || '').substring(0, 3000),
        message: (incoming.personalMessage || '').substring(0, 1500),
        heroUrl: incoming.heroUrl || null,
        heroTitle: incoming.heroTitle || null,
        createdAt: new Date().toISOString()
    };

    const shortId = generateShortId();

    // Writing the gift once and nothing else, now that the browser remembers the link it already created and no longer retries a request that succeeded
    try {
        await env.GIFT_STORE.put(
            `gift:${shortId}`,
            JSON.stringify(giftRecord),
            { expirationTtl: ONE_YEAR_SECONDS }
        );
    } catch {
        return jsonResponse({ error: 'Could not store the gift. Please try again.' }, 502);
    }

    return jsonResponse({ id: shortId }, 200);
}
