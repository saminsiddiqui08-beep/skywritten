const ESCAPE_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
};

function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, ch => ESCAPE_MAP[ch]);
}

// Neutralising angle brackets so a stored personal message can never close the surrounding script tag
function embedJson(record) {
    return JSON.stringify(record)
        .replace(/</g, '\\u003C')
        .replace(/>/g, '\\u003E')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

// Formatting in UTC so the date in a link preview matches the one on the page rather than the server's own timezone
function formatFullDate(isoDate) {
    const parsed = new Date(isoDate + 'T00:00:00Z');
    return parsed.toLocaleDateString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC'
    });
}

// Verifying the round trip because Date.UTC rolls an impossible day into the next month, which would otherwise render a biography for the wrong date
function isRenderableDate(rawDateString) {
    if (!rawDateString || !/^\d{4}-\d{2}-\d{2}$/.test(rawDateString)) return false;

    const [year, month, day] = rawDateString.split('-').map(Number);
    const candidate = new Date(Date.UTC(year, month - 1, day));
    return candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day;
}

function renderExpiredPage(origin) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#030304">
<meta name="robots" content="noindex">
<title>This gift has drifted away &middot; Skywritten</title>
<link rel="stylesheet" href="${origin}/css/core/foundation.css">
<link rel="stylesheet" href="${origin}/css/core/structure.css">
</head>
<body>
<canvas id="ambient-starfield"></canvas>
<main id="app-core">
    <section class="ingest-wrapper lapsed-gift">
        <h1 class="brand-mark">Skywritten</h1>
        <p class="lapsed-message">
            This gift link has expired, or it never existed.
            Every Skywritten link stays open for a year from the day it is made.
        </p>
        <a class="lapsed-action" href="${origin}/">Write one of your own</a>
    </section>
</main>
<script src="${origin}/js/core/starfield.js"></script>
</body>
</html>`;
}

// Cropping the preview to a known 1200 by 630 so the dimensions can be declared in the markup, which is what lets a scraper render the card on the very first share instead of queueing the image
function buildSocialPreviewImage(heroUrl) {
    if (!heroUrl) return null;

    const frameSelector = /\.gif(\?|$)/i.test(heroUrl) ? '&page=6' : '';
    return `https://images.weserv.nl/?url=${encodeURIComponent(heroUrl)}&w=1200&h=630&fit=cover&q=82&output=jpg${frameSelector}`;
}

// Rendering the page from stored values on the server, so a recipient sees the gift before any template script has run
function renderGiftPage(gift, origin, shortId) {
    const displayName = gift.name ? escapeHtml(gift.name) : 'Someone Special';
    const ogTitle = gift.name
        ? `${escapeHtml(gift.name)}\u2019s Universe Biography`
        : 'A Universe Biography';
    const ogDescription = `The cosmos on ${escapeHtml(formatFullDate(gift.date))}, written for ${displayName}.`;
    const ogImage = gift.heroUrl ? escapeHtml(buildSocialPreviewImage(gift.heroUrl)) : `${origin}/og-default.jpg`;
    const canonical = `${origin}/u/${escapeHtml(shortId)}`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#030304">
<meta name="robots" content="noindex">
<title>${ogTitle} &middot; Skywritten</title>
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="website">
<meta property="og:title" content="${ogTitle}">
<meta property="og:description" content="${ogDescription}">
<meta property="og:image" content="${ogImage}">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="${canonical}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${ogTitle}">
<meta name="twitter:description" content="${ogDescription}">
<meta name="twitter:image" content="${ogImage}">
<link rel="stylesheet" href="${origin}/css/core/foundation.css">
<link rel="stylesheet" href="${origin}/css/core/structure.css">
<link rel="stylesheet" href="${origin}/css/templates/cosmic-scroll.css">
<link rel="stylesheet" href="${origin}/css/templates/storybook.css">
<link rel="stylesheet" href="${origin}/css/templates/keepsake-letter.css">
</head>
<body class="recipient-body">
<canvas id="ambient-starfield"></canvas>
<div id="app-core" hidden></div>
<div id="template-root"></div>

<script src="${origin}/js/core/starfield.js"></script>
<script src="${origin}/js/core/text-fields.js"></script>
<script src="${origin}/js/templates/template-router.js"></script>
<script src="${origin}/js/templates/cosmic-scroll.js"></script>
<script src="${origin}/js/templates/storybook.js"></script>
<script src="${origin}/js/templates/keepsake-letter.js"></script>
<script src="${origin}/js/core/card-generator.js"></script>
<script src="${origin}/js/core/skywritten.js"></script>
<script>
const storedGift = ${embedJson(gift)};

document.addEventListener('DOMContentLoaded', function () {
    const payload = window.SkywrittenMath.assemblePayload(storedGift.date, storedGift.template);
    if (!payload) return;

    window.SkywrittenStarfield.boot(storedGift.date);

    payload.mode = 'recipient';
    payload.recipientName = storedGift.name;
    payload.gift = {
        recipientName: storedGift.name,
        narrative: storedGift.narrative,
        message: storedGift.message,
        chosenApodYear: storedGift.chosenApodYear,
        chosenEpicYear: storedGift.chosenEpicYear,
        chosenDonkiDate: storedGift.chosenDonkiDate,
        chosenExoplanetYear: storedGift.chosenExoplanetYear,
        donkiOptedIn: storedGift.donkiOptedIn,
        exoplanetOptedIn: storedGift.exoplanetOptedIn
    };
    window.SkywrittenRouter.dispatch(payload);
});
</script>
</body>
</html>`;
}

export async function onRequestGet(context) {
    const { params, env, request } = context;
    const origin = new URL(request.url).origin;
    const shortId = params.id;

    const expiredHeaders = {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
    };

    if (!env.GIFT_STORE || !/^[A-Za-z0-9]{8}$/.test(shortId || '')) {
        return new Response(renderExpiredPage(origin), { status: 404, headers: expiredHeaders });
    }

    const stored = await env.GIFT_STORE.get(`gift:${shortId}`, { type: 'json' });

    if (!stored || !isRenderableDate(stored.date)) {
        return new Response(renderExpiredPage(origin), { status: 404, headers: expiredHeaders });
    }

    return new Response(renderGiftPage(stored, origin, shortId), {
        status: 200,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'strict-origin-when-cross-origin'
        }
    });
}
