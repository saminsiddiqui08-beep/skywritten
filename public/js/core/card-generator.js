(function () {
    var CARD_WIDTH = 1080;
    var CARD_HEIGHT = 1920;
    var VOID_HEX = '#060608';
    var STARLIGHT_HEX = '#f4f4f5';
    var IMAGE_PROXY = 'https://images.weserv.nl/?url=';
    var ANIMATED_STILL_FRAME = 6;
    var MINIMUM_HERO_LUMINANCE = 14;

    var NARRATIVE_CHARS_WITH_MESSAGE = 150;
    var NARRATIVE_CHARS_ALONE = 260;
    var NARRATIVE_LINES_WITH_MESSAGE = 3;
    var NARRATIVE_LINES_ALONE = 6;
    var MESSAGE_CHARS = 300;
    var MESSAGE_LINES = 7;

    // Reading the live font off a rendered element, so an exported card matches whichever template produced it instead of guessing at the stack
    function resolveDisplayFontFamily() {
        var probe = document.querySelector('.cosmic-headline')
            || document.querySelector('.cover-title')
            || document.querySelector('.letter-heading');
        if (probe) return getComputedStyle(probe).fontFamily;
        return '"Cormorant Garamond", Georgia, serif';
    }

    function resolveBodyFontFamily() {
        var probe = document.querySelector('.telemetry-detail')
            || document.querySelector('.vitals-note')
            || document.querySelector('.letter-detail-item');
        if (probe) return getComputedStyle(probe).fontFamily;
        return '"Inter", system-ui, sans-serif';
    }

    function readFieldValue(node) {
        if (!node) return '';
        return (node.value !== undefined ? node.value : node.textContent).trim();
    }

    // Reading the live input before the payload, so a name typed but not yet submitted still reaches the exported card
    function readRecipientName(root, inputId, payload) {
        var inputNode = root.querySelector('#' + inputId);
        if (inputNode) return readFieldValue(inputNode);
        if (payload && payload.mode === 'recipient') return (payload.recipientName || '').trim();
        var rendered = root.querySelector('.recipient-name-rendered');
        return rendered ? rendered.textContent.trim() : '';
    }

    // Recomputing the vitals at export time rather than scraping them off the page, which keeps the card correct even mid-animation
    function deriveVitalsFromPayload(payload) {
        if (!payload) {
            return {
                cosmicDisplacement: '',
                lunarPhase: '',
                solarRevolutions: '',
                stellarAlignment: ''
            };
        }
        return {
            cosmicDisplacement: payload.displacement.toLocaleString() + ' km',
            lunarPhase: payload.lunar.phase,
            solarRevolutions: payload.orbital.orbits + ' Orbits',
            stellarAlignment: payload.astro.sign
        };
    }

    var shellFieldMap = {
        'cosmic-scroll': {
            nameInput: 'recipient-name-input',
            heroImage: '#apod-hero-img',
            heroCaption: '#apod-caption-display',
            heroTitle: '.hero-title-text',
            narrative: '#narrative-text, #narrative-readonly',
            personal: '#writing-sample-input, #personal-message-readonly',
            dateLine: '.date-badge'
        },
        'storybook': {
            nameInput: 'sb-recipient-name',
            heroImage: '#apod-sb-hero',
            heroCaption: '#apod-sb-caption',
            heroTitle: '#apod-sb-title',
            narrative: '#sb-narrative-text, #sb-narrative-readonly',
            personal: '#sb-writing-sample, #sb-message-readonly',
            dateLine: '.cover-date'
        },
        'keepsake-letter': {
            nameInput: 'kl-recipient-name',
            heroImage: '#kl-apod-hero',
            heroCaption: '#kl-apod-caption',
            heroTitle: '#kl-apod-title',
            narrative: '#kl-narrative-text, #kl-narrative-readonly',
            personal: '#kl-writing-sample, #kl-message-readonly',
            dateLine: '.letter-dateline'
        }
    };

    // Collecting from whichever template is mounted by querying every known field identifier, since only one of the three is ever present
    function harvestCardContent() {
        var activeShell = window.SkywrittenRouter
            ? window.SkywrittenRouter.getActiveShell()
            : 'cosmic-scroll';
        var payload = window.SkywrittenRouter
            ? window.SkywrittenRouter.getActivePayload()
            : null;
        var root = document.getElementById('template-root');
        if (!root) return null;

        var fields = shellFieldMap[activeShell] || shellFieldMap['cosmic-scroll'];
        var heroImg = root.querySelector(fields.heroImage);
        var heroTitleNode = root.querySelector(fields.heroTitle);
        var captionNode = root.querySelector(fields.heroCaption);
        var dateNode = root.querySelector(fields.dateLine);
        var vitals = deriveVitalsFromPayload(payload);

        return {
            recipientName: readRecipientName(root, fields.nameInput, payload),
            heroImageSource: heroImg ? heroImg.src : null,
            heroTitle: heroTitleNode
                ? heroTitleNode.textContent.trim()
                : (heroImg ? heroImg.alt : ''),
            heroCaption: captionNode ? captionNode.textContent.trim() : '',
            cosmicDisplacement: vitals.cosmicDisplacement,
            lunarPhase: vitals.lunarPhase,
            solarRevolutions: vitals.solarRevolutions,
            stellarAlignment: vitals.stellarAlignment,
            narrativeText: readFieldValue(root.querySelector(fields.narrative)),
            personalMessage: readFieldValue(root.querySelector(fields.personal)),
            dateString: dateNode ? dateNode.textContent.trim() : ''
        };
    }

    // Cutting at a word boundary because a card is read at a glance and a severed word draws the eye straight to it
    function truncateAtWordBoundary(text, maxChars) {
        if (text.length <= maxChars) return text;
        var trimmed = text.substring(0, maxChars);
        var lastSpace = trimmed.lastIndexOf(' ');
        if (lastSpace > maxChars * 0.5) trimmed = trimmed.substring(0, lastSpace);
        return trimmed + '\u2026';
    }

    // Seeding the card starfield from the same date the page uses, so an exported card carries the recipient's own sky rather than a fresh random one
    function mulberry32(seed) {
        return function () {
            seed |= 0;
            seed = seed + 0x6D2B79F5 | 0;
            var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
            t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
    }

    function hashSeedString(str) {
        var h = 0;
        for (var i = 0; i < str.length; i++) {
            h = ((h << 5) - h + str.charCodeAt(i)) | 0;
        }
        return h;
    }

    function paintCardStarfield(ctx, seedPhrase) {
        var rng = mulberry32(hashSeedString(seedPhrase));
        for (var i = 0; i < 240; i++) {
            var x = rng() * CARD_WIDTH;
            var y = rng() * CARD_HEIGHT;
            var radius = rng() * 1.6 + 0.3;
            var alpha = rng() * 0.28 + 0.05;
            ctx.beginPath();
            ctx.arc(x, y, radius, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(244, 244, 245, ' + alpha + ')';
            ctx.fill();
        }
    }

    // Trying the image directly before the proxy, since heroes already arrive through the resizing proxy and are therefore reusable from cache without a second download
    function loadCrossOriginImage(src) {
        return new Promise(function (resolve, reject) {
            var directImg = new Image();
            directImg.crossOrigin = 'anonymous';
            directImg.onload = function () { resolve(directImg); };
            directImg.onerror = function () {
                var proxyUrl = IMAGE_PROXY + encodeURIComponent(src);
                if (/\.gif(\?|$)/i.test(src)) {
                    proxyUrl += '&page=' + ANIMATED_STILL_FRAME;
                }

                var proxiedImg = new Image();
                proxiedImg.crossOrigin = 'anonymous';
                proxiedImg.onload = function () { resolve(proxiedImg); };
                proxiedImg.onerror = function () { reject(new Error('All image load attempts failed')); };
                proxiedImg.src = proxyUrl;
            };
            directImg.src = src;
        });
    }

    function wrapTextLines(ctx, text, maxWidth) {
        // Measuring each candidate line against the canvas context rather than estimating by character count, which is the only way proportional text wraps predictably
        var words = text.split(' ');
        var lines = [];
        var currentLine = words[0] || '';
        for (var i = 1; i < words.length; i++) {
            var candidate = currentLine + ' ' + words[i];
            if (ctx.measureText(candidate).width > maxWidth) {
                lines.push(currentLine);
                currentLine = words[i];
            } else {
                currentLine = candidate;
            }
        }
        if (currentLine) lines.push(currentLine);
        return lines;
    }

    // Sampling animated sources only, because a flattened frame can arrive as a near-black rectangle while a genuinely dark astrophotograph is a legitimate hero that must never be swapped out
    function frameIsEffectivelyBlank(img) {
        var probe = document.createElement('canvas');
        probe.width = 32;
        probe.height = 32;

        var probeCtx = probe.getContext('2d');
        probeCtx.drawImage(img, 0, 0, 32, 32);

        var pixels = probeCtx.getImageData(0, 0, 32, 32).data;
        var total = 0;
        for (var i = 0; i < pixels.length; i += 4) {
            total += 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
        }

        return (total / (pixels.length / 4)) < MINIMUM_HERO_LUMINANCE;
    }

    // Cropping to fill rather than letterboxing, since an archive capture and a story card almost never share an aspect ratio
    function coverFitImage(ctx, img, regionX, regionY, regionW, regionH) {
        var imgRatio = img.naturalWidth / img.naturalHeight;
        var regionRatio = regionW / regionH;
        var sx, sy, sw, sh;

        if (imgRatio > regionRatio) {
            sh = img.naturalHeight;
            sw = sh * regionRatio;
            sx = (img.naturalWidth - sw) / 2;
            sy = 0;
        } else {
            sw = img.naturalWidth;
            sh = sw / regionRatio;
            sx = 0;
            sy = (img.naturalHeight - sh) / 2;
        }

        ctx.drawImage(img, sx, sy, sw, sh, regionX, regionY, regionW, regionH);
    }

    // Centring each cell on its own axis so the row stays balanced whatever the digit count, which varies by several places across birth years
    function drawStatCell(ctx, label, value, cellCenterX, baseY, bodyFont, displayFont) {
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(244, 244, 245, 0.25)';
        ctx.font = '300 14px ' + bodyFont;
        ctx.letterSpacing = '2.5px';
        ctx.fillText(label.toUpperCase(), cellCenterX, baseY);
        ctx.letterSpacing = '0px';

        ctx.fillStyle = 'rgba(244, 244, 245, 0.88)';
        ctx.font = '400 30px ' + displayFont;
        ctx.fillText(value, cellCenterX, baseY + 36);
    }

    function drawHorizontalRule(ctx, centerX, y, halfWidth) {
        ctx.strokeStyle = 'rgba(244, 244, 245, 0.06)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(centerX - halfWidth, y);
        ctx.lineTo(centerX + halfWidth, y);
        ctx.stroke();
    }

    // Painting in a fixed 1080 by 1920 frame, the aspect every major platform accepts for a full-screen story without recompressing it
    async function composeStoryCard(content) {
        await document.fonts.ready;

        var canvas = document.createElement('canvas');
        canvas.width = CARD_WIDTH;
        canvas.height = CARD_HEIGHT;
        var ctx = canvas.getContext('2d');

        var displayFont = resolveDisplayFontFamily();
        var bodyFont = resolveBodyFontFamily();

        ctx.fillStyle = VOID_HEX;
        ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

        paintCardStarfield(ctx, content.dateString || 'skywritten');

        var heroZoneBottom = 880;
        var heroRendered = false;

        if (content.heroImageSource) {
            try {
                var heroImage = await loadCrossOriginImage(content.heroImageSource);
                if (/\.gif(\?|$)/i.test(content.heroImageSource) && frameIsEffectivelyBlank(heroImage)) {
                    throw new Error('Hero frame is effectively blank');
                }

                coverFitImage(ctx, heroImage, 0, 0, CARD_WIDTH, heroZoneBottom);

                var bottomFade = ctx.createLinearGradient(0, heroZoneBottom * 0.3, 0, heroZoneBottom);
                bottomFade.addColorStop(0, 'rgba(6, 6, 8, 0)');
                bottomFade.addColorStop(0.55, 'rgba(6, 6, 8, 0.7)');
                bottomFade.addColorStop(1, 'rgba(6, 6, 8, 1)');
                ctx.fillStyle = bottomFade;
                ctx.fillRect(0, 0, CARD_WIDTH, heroZoneBottom);

                var topVeil = ctx.createLinearGradient(0, 0, 0, 200);
                topVeil.addColorStop(0, 'rgba(6, 6, 8, 0.5)');
                topVeil.addColorStop(1, 'rgba(6, 6, 8, 0)');
                ctx.fillStyle = topVeil;
                ctx.fillRect(0, 0, CARD_WIDTH, 200);

                heroRendered = true;
            } catch (_) { }
        }

        if (!heroRendered) {
            var nebulousGlow = ctx.createRadialGradient(
                CARD_WIDTH / 2, heroZoneBottom * 0.35, 0,
                CARD_WIDTH / 2, heroZoneBottom * 0.35, CARD_WIDTH * 0.6
            );
            nebulousGlow.addColorStop(0, 'rgba(60, 70, 120, 0.12)');
            nebulousGlow.addColorStop(0.5, 'rgba(40, 50, 100, 0.06)');
            nebulousGlow.addColorStop(1, 'rgba(6, 6, 8, 0)');
            ctx.fillStyle = nebulousGlow;
            ctx.fillRect(0, 0, CARD_WIDTH, heroZoneBottom);
        }

        var centerX = CARD_WIDTH / 2;
        var gutterX = 90;
        var maxContentWidth = CARD_WIDTH - gutterX * 2;

        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';

        ctx.fillStyle = 'rgba(244, 244, 245, 0.45)';
        ctx.font = '400 24px ' + displayFont;
        ctx.letterSpacing = '6px';
        ctx.fillText('Skywritten', centerX, 82);
        ctx.letterSpacing = '0px';

        if (content.heroTitle && heroRendered) {
            ctx.fillStyle = 'rgba(244, 244, 245, 0.55)';
            ctx.font = 'italic 400 22px ' + displayFont;
            ctx.fillText('\u201C' + content.heroTitle + '\u201D', centerX, heroZoneBottom - 58);
        }

        if (content.heroCaption) {
            ctx.fillStyle = 'rgba(244, 244, 245, 0.35)';
            ctx.font = '300 19px ' + bodyFont;
            ctx.fillText(content.heroCaption, centerX, heroZoneBottom - 28);
        }

        var cursor = heroZoneBottom + 48;

        ctx.fillStyle = 'rgba(244, 244, 245, 0.16)';
        ctx.font = '400 18px serif';
        ctx.fillText('\u2726', centerX, cursor);
        cursor += 48;

        var displayName = content.recipientName || 'Someone Special';
        ctx.fillStyle = STARLIGHT_HEX;
        ctx.font = '400 52px ' + displayFont;
        var nameLines = wrapTextLines(ctx, displayName, maxContentWidth);
        for (var n = 0; n < nameLines.length; n++) {
            ctx.fillText(nameLines[n], centerX, cursor);
            cursor += 62;
        }
        cursor += 4;

        if (content.dateString) {
            ctx.fillStyle = 'rgba(244, 244, 245, 0.35)';
            ctx.font = '300 22px ' + bodyFont;
            ctx.fillText(content.dateString, centerX, cursor);
            cursor += 44;
        }

        drawHorizontalRule(ctx, centerX, cursor, 130);
        cursor += 42;

        var leftColCenter = CARD_WIDTH * 0.27;
        var rightColCenter = CARD_WIDTH * 0.73;

        if (content.cosmicDisplacement) {
            drawStatCell(ctx, 'Cosmic Displacement', content.cosmicDisplacement,
                centerX, cursor, bodyFont, displayFont);
            cursor += 64;
        }

        var hasSecondaryStats = content.lunarPhase || content.stellarAlignment || content.solarRevolutions;
        if (hasSecondaryStats) {
            cursor += 8;
            var gridY = cursor;

            if (content.lunarPhase) {
                drawStatCell(ctx, 'Lunar Phase', content.lunarPhase,
                    leftColCenter, gridY, bodyFont, displayFont);
            }
            if (content.stellarAlignment) {
                drawStatCell(ctx, 'Stellar Alignment', content.stellarAlignment,
                    rightColCenter, gridY, bodyFont, displayFont);
            }

            cursor = gridY + 58;

            if (content.solarRevolutions) {
                drawStatCell(ctx, 'Solar Revolutions', content.solarRevolutions,
                    centerX, cursor, bodyFont, displayFont);
                cursor += 58;
            }
        }

        cursor += 16;
        drawHorizontalRule(ctx, centerX, cursor, 130);
        cursor += 36;

        var hasPersonalMessage = (content.personalMessage || '').length > 0;
        var narrativeLimit = hasPersonalMessage ? NARRATIVE_CHARS_WITH_MESSAGE : NARRATIVE_CHARS_ALONE;

        if (content.narrativeText) {
            var narrativeExcerpt = truncateAtWordBoundary(content.narrativeText, narrativeLimit);
            ctx.fillStyle = hasPersonalMessage ? 'rgba(244, 244, 245, 0.38)' : 'rgba(244, 244, 245, 0.45)';
            ctx.font = '300 ' + (hasPersonalMessage ? '20' : '22') + 'px ' + displayFont;
            var narrativeLines = wrapTextLines(ctx, narrativeExcerpt, maxContentWidth);
            var maxNarrativeLines = hasPersonalMessage ? NARRATIVE_LINES_WITH_MESSAGE : NARRATIVE_LINES_ALONE;
            for (var e = 0; e < Math.min(narrativeLines.length, maxNarrativeLines); e++) {
                ctx.fillText(narrativeLines[e], centerX, cursor);
                cursor += hasPersonalMessage ? 29 : 34;
            }
            if (hasPersonalMessage) cursor += 26;
        }

        if (hasPersonalMessage) {
            var personalExcerpt = truncateAtWordBoundary(content.personalMessage, MESSAGE_CHARS);
            ctx.fillStyle = 'rgba(244, 244, 245, 0.82)';
            ctx.font = 'italic 400 27px ' + displayFont;
            var personalLines = wrapTextLines(ctx, personalExcerpt, maxContentWidth);
            for (var p = 0; p < Math.min(personalLines.length, MESSAGE_LINES); p++) {
                ctx.fillText(personalLines[p], centerX, cursor);
                cursor += 40;
            }
        }

        var footerRuleY = CARD_HEIGHT - 120;

        ctx.strokeStyle = 'rgba(244, 244, 245, 0.04)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(centerX - 80, footerRuleY);
        ctx.lineTo(centerX - 12, footerRuleY);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(centerX + 12, footerRuleY);
        ctx.lineTo(centerX + 80, footerRuleY);
        ctx.stroke();

        ctx.fillStyle = 'rgba(244, 244, 245, 0.08)';
        ctx.font = '400 12px serif';
        ctx.fillText('\u2726', centerX, footerRuleY + 4);

        ctx.fillStyle = 'rgba(244, 244, 245, 0.15)';
        ctx.font = '400 19px ' + displayFont;
        ctx.letterSpacing = '5px';
        ctx.fillText('Skywritten', centerX, footerRuleY + 44);
        ctx.letterSpacing = '0px';

        return canvas;
    }

    // Handing back a PNG because the card is mostly flat colour and type, where JPEG artefacts show up along every letter edge
    function triggerPngDownload(canvas, recipientName) {
        var safeName = recipientName
            ? recipientName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
            : 'universe';
        var filename = 'skywritten-' + safeName + '.png';

        canvas.toBlob(function (blob) {
            if (!blob) return;
            var objectUrl = URL.createObjectURL(blob);
            var anchor = document.createElement('a');
            anchor.href = objectUrl;
            anchor.download = filename;
            anchor.style.display = 'none';
            document.body.appendChild(anchor);
            anchor.click();
            requestAnimationFrame(function () {
                document.body.removeChild(anchor);
                URL.revokeObjectURL(objectUrl);
            });
        }, 'image/png');
    }

    // Composing on demand rather than keeping a canvas alive, since the export is occasional and the memory cost on a mid-range phone is not
    async function exportStoryCard() {
        var content = harvestCardContent();
        if (!content) return;
        var canvas = await composeStoryCard(content);
        triggerPngDownload(canvas, content.recipientName);
    }

    document.addEventListener('click', function (e) {
        var trigger = e.target.closest('#export-card-btn, #sb-export-card, #kl-export-card');
        if (!trigger) return;

        trigger.disabled = true;
        var originalLabel = trigger.textContent;
        trigger.textContent = 'Generating\u2026';

        exportStoryCard()
            .then(function () {
                trigger.textContent = 'Downloaded!';
                setTimeout(function () {
                    trigger.textContent = originalLabel;
                    trigger.disabled = false;
                }, 2200);
            })
            .catch(function () {
                trigger.textContent = 'Failed \u2014 Try Again';
                setTimeout(function () {
                    trigger.textContent = originalLabel;
                    trigger.disabled = false;
                }, 2200);
            });
    });

    window.SkywrittenCardExport = { exportStoryCard: exportStoryCard };
})();
