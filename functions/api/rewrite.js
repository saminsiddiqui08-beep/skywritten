const REWRITE_SYSTEM_PROMPT = [
    'You are the invisible writing partner inside Skywritten, a birthday gift app.',
    'The giver has already received an auto-generated cosmic biography for the recipient.',
    'Now they are writing a personal message to accompany it.',
    'Your job: polish and enhance their personal message so it hits harder emotionally',
    'while still sounding authentically like them at their best.',
    '',
    'You receive two inputs:',
    '',
    '1. THE GIVER\'S PERSONAL MESSAGE — their words to the recipient. Study it for:',
    '   - Nicknames (keep them exactly as spelled)',
    '   - Vocabulary, rhythm, slang, punctuation style',
    '   - Inside jokes or shared memories',
    '   - Emotional register (match THEIR depth — casual, sincere, understated, whatever they are)',
    '   - Explicit instructions at the end ("keep it warm," "make it funny," etc.) — follow them',
    '',
    '2. BIRTHDAY CONTEXT (optional reference) — astronomical facts about the recipient\'s birthday.',
    '   You may weave in 1-2 subtle cosmic references if they fit naturally (e.g. "you\'ve been',
    '   lighting up my world for 20 orbits around the Sun"), but this is OPTIONAL.',
    '   The cosmic biography already covers the facts. Do NOT turn the message into a data dump.',
    '',
    'RULES:',
    '1. VOICE MATCH: The output must sound like the giver wrote it on their best day.',
    '2. EMOTIONAL IMPACT: Make it warmer, more vivid, more heartfelt.',
    '3. AUTHENTICITY: Preserve their words, nicknames, inside jokes, and tone.',
    '   Do not make it sound generic or greeting-card-like.',
    '4. LENGTH: Stay under 600 characters, and stay close to the length they wrote.',
    '   A short message stays short. Never pad it out to fill the budget.',
    '5. OUTPUT: Respond with ONLY the enhanced message. No preamble, no quotation marks,',
    '   no "Here\'s the enhanced version:", no commentary. Just the message text itself.'
].join('\n');

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const PRIMARY_MODEL = 'openai/gpt-oss-120b';
const FALLBACK_MODEL = 'openai/gpt-oss-20b';
// Budgeting generously because the provider model reasons before it answers, and a tight ceiling is consumed entirely by that phase leaving the message empty
const MAX_OUTPUT_TOKENS = 1600;
const MESSAGE_CHAR_CEILING = 600;
const CONTEXT_CHAR_CEILING = 400;
const RETRY_DELAY_MS = 2200;
const RATE_WINDOW_SECONDS = 60 * 60;
const REWRITES_PER_WINDOW = 12;
const REWRITES_PER_DRAFT = 10;
const DRAFT_WINDOW_SECONDS = 24 * 60 * 60;

function truncateAtWordBoundary(text, charLimit) {
    if (text.length <= charLimit) return text;
    const clipped = text.substring(0, charLimit);
    const lastSpace = clipped.lastIndexOf(' ');
    return (lastSpace > charLimit * 0.6 ? clipped.substring(0, lastSpace) : clipped).trim();
}

function composeUserPrompt(personalMessage, birthdayContext, recipientBirthday) {
    const parts = [
        'PERSONAL MESSAGE FROM THE GIVER:',
        '"""',
        personalMessage,
        '"""'
    ];

    if (birthdayContext && birthdayContext.trim()) {
        parts.push('');
        parts.push('BIRTHDAY CONTEXT (for optional cosmic references only):');
        parts.push('"""');
        parts.push(truncateAtWordBoundary(birthdayContext.trim(), CONTEXT_CHAR_CEILING));
        parts.push('"""');
    }

    if (recipientBirthday) {
        parts.push('');
        parts.push(`RECIPIENT'S BIRTHDAY: ${recipientBirthday}`);
    }

    return parts.join('\n');
}

function extractNarrativeFromResponse(apiResult) {
    if (!apiResult.choices || !apiResult.choices.length) return null;
    const firstChoice = apiResult.choices[0];
    if (!firstChoice.message) return null;

    const outputText = firstChoice.message.content;
    if (outputText && outputText.trim().length > 0) {
        return sanitizeOutput(outputText);
    }

    return null;
}

// Stripping the assistant preamble because a reasoning model reliably prefixes its answer no matter how firmly the system prompt forbids it
function sanitizeOutput(rawText) {
    let cleaned = rawText.trim();

    const preamblePatterns = [
        /^here(?:'s| is) (?:the |your |a )?(?:enhanced |polished |rewritten |revised |updated ).*?:\s*/i,
        /^(?:enhanced |polished |rewritten |revised |updated )?(?:message|version):\s*/i,
        /^sure[,!.]?\s*(?:here(?:'s| is).*?:\s*)?/i,
        /^of course[,!.]?\s*(?:here(?:'s| is).*?:\s*)?/i
    ];

    for (const pattern of preamblePatterns) {
        cleaned = cleaned.replace(pattern, '');
    }

    if ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
        (cleaned.startsWith('\u201C') && cleaned.endsWith('\u201D'))) {
        cleaned = cleaned.slice(1, -1).trim();
    }

    return cleaned || null;
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

async function callGroq(apiKey, modelId, systemPrompt, userPrompt) {
    const response = await fetch(GROQ_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: modelId,
            max_tokens: MAX_OUTPUT_TOKENS,
            temperature: 0.55,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ]
        })
    });

    return response;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function onRequestPost(context) {
    const { request, env } = context;

    if (!env.AI_API_KEY) {
        return jsonResponse({ error: 'AI service is not configured.' }, 503);
    }

    if (originIsForeign(request)) {
        return jsonResponse({ error: 'Requests must come from Skywritten itself.' }, 403);
    }

    // Throttling before the provider call rather than after, so an abusive client cannot spend the free tier that every other giver shares
    const clientAddress = request.headers.get('CF-Connecting-IP');
    if (!await consumeRateToken(clientAddress, 'rewrite', REWRITES_PER_WINDOW, RATE_WINDOW_SECONDS)) {
        return jsonResponse({
            error: 'You have polished a lot of messages recently. Please try again in a little while.'
        }, 429);
    }

    let incoming;
    try {
        incoming = await request.json();
    } catch {
        return jsonResponse({ error: 'Could not parse request body.' }, 400);
    }

    let personalMessage = (incoming.sample || '').trim();
    const birthdayContext = (incoming.baseNarrative || '').trim();
    const recipientBirthday = incoming.targetDate || '';

    if (!personalMessage) {
        return jsonResponse({ error: 'Write your personal message first \u2014 the AI uses it to match your voice.' }, 400);
    }

    // Capping each individual draft as well as each address, because one giver retrying twenty times can drain a daily allowance that every other giver shares
    const draftIdentifier = (incoming.draftId || '').replace(/[^a-f0-9]/gi, '').slice(0, 32);
    if (draftIdentifier && !await consumeRateToken(draftIdentifier, 'draft', REWRITES_PER_DRAFT, DRAFT_WINDOW_SECONDS)) {
        return jsonResponse({
            error: 'This gift has been rewritten several times already. Edit the wording yourself, or start a new gift.'
        }, 429);
    }

    personalMessage = truncateAtWordBoundary(personalMessage, MESSAGE_CHAR_CEILING);

    const userPrompt = composeUserPrompt(personalMessage, birthdayContext, recipientBirthday);
    const primaryModel = env.AI_MODEL || PRIMARY_MODEL;
    const fallbackModel = env.AI_FALLBACK_MODEL || FALLBACK_MODEL;

    let aiResponse;
    try {
        aiResponse = await callGroq(env.AI_API_KEY, primaryModel, REWRITE_SYSTEM_PROMPT, userPrompt);
    } catch {
        return jsonResponse({ error: 'Could not reach the AI service. Please try again.' }, 502);
    }

    // Stepping down to the smaller model only after a paced retry on the primary, since a burst on the free tier clears within a couple of seconds
    if (aiResponse.status === 429) {
        await sleep(RETRY_DELAY_MS);

        try {
            aiResponse = await callGroq(env.AI_API_KEY, primaryModel, REWRITE_SYSTEM_PROMPT, userPrompt);
        } catch {
            return jsonResponse({ error: 'Could not reach the AI service. Please try again.' }, 502);
        }

        if (aiResponse.status === 429) {
            try {
                aiResponse = await callGroq(env.AI_API_KEY, fallbackModel, REWRITE_SYSTEM_PROMPT, userPrompt);
            } catch {
                return jsonResponse({ error: 'Could not reach the AI service. Please try again.' }, 502);
            }
        }
    }

    if (!aiResponse.ok) {
        if (aiResponse.status === 401) {
            return jsonResponse({ error: 'AI service authentication failed.' }, 503);
        }
        if (aiResponse.status === 429) {
            return jsonResponse({ error: 'The AI service is busy. Please wait a moment and try again.' }, 429);
        }
        return jsonResponse({ error: 'The AI service returned an error. Please try again.' }, 502);
    }

    let aiData;
    try {
        aiData = await aiResponse.json();
    } catch {
        return jsonResponse({ error: 'Received an unreadable response from the AI.' }, 502);
    }

    const styledNarrative = extractNarrativeFromResponse(aiData);

    if (!styledNarrative) {
        return jsonResponse({ error: 'The AI could not generate a rewrite. Please try again.' }, 502);
    }

    return jsonResponse({
        styledNarrative: truncateAtWordBoundary(styledNarrative, MESSAGE_CHAR_CEILING)
    }, 200);
}
