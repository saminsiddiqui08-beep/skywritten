(function () {
    window.SkywrittenTemplates = window.SkywrittenTemplates || {};

    const catalogCache = {};

    // Falling back to a caller-supplied empty value rather than throwing, so one unreachable shard costs its own section and not the whole page
    async function loadCatalogResource(cacheKey, filepath, emptyValue) {
        if (catalogCache[cacheKey]) return catalogCache[cacheKey];
        try {
            const response = await fetch(filepath);
            catalogCache[cacheKey] = response.ok ? await response.json() : emptyValue;
        } catch (err) {
            catalogCache[cacheKey] = emptyValue;
        }
        return catalogCache[cacheKey];
    }

    // Fetching only the shard for this calendar key, which keeps a page load near ten kilobytes instead of the three megabytes the full archives would cost
    async function loadAllCatalogs(monthDayKey) {
        const [apod, epic, donki, exoplanet] = await Promise.all([
            loadCatalogResource(`apod-${monthDayKey}`, `/data/apod/${monthDayKey}.json`, []),
            loadCatalogResource(`epic-${monthDayKey}`, `/data/epic/${monthDayKey}.json`, []),
            loadCatalogResource(`donki-${monthDayKey}`, `/data/donki/${monthDayKey}.json`, []),
            loadCatalogResource('exoplanet', '/data/exoplanet_index.json', {})
        ]);
        return { apod, epic, donki, exoplanet };
    }

    const IMAGE_PROXY_ORIGIN = 'https://images.weserv.nl/?url=';
    const HERO_CANDIDATE_WIDTHS = [800, 1100, 1400];
    const HERO_LAYOUT_SIZES = '(max-width: 440px) calc(100vw - 48px), 400px';
    const THUMBNAIL_RENDER_WIDTH = 160;
    const ANIMATED_STILL_FRAME = 6;

    // Escaping archive text before it reaches an attribute, since APOD titles legitimately contain quotes and ampersands that would otherwise terminate the tag early
    function escapeMarkup(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // Requesting a fixed render width from the proxy rather than the print master, which is several megabytes and would be scaled down by the browser anyway
    function buildProxiedImageUrl(originalUrl, renderWidth) {
        return `${IMAGE_PROXY_ORIGIN}${encodeURIComponent(originalUrl)}&w=${renderWidth}&q=82&output=webp`;
    }

    function isAnimatedArchiveFormat(url) {
        return /\.gif(\?|$)/i.test(url);
    }

    // Serving animated archive entries straight from NASA, because the resizing proxy flattens a GIF to its first frame and a few of these are the whole point of the day
    function resolveHeroImageSource(entry) {
        if (isAnimatedArchiveFormat(entry.url)) return entry.url;
        return buildProxiedImageUrl(entry.master || entry.url, HERO_CANDIDATE_WIDTHS[HERO_CANDIDATE_WIDTHS.length - 1]);
    }

    // Offering two exact candidate widths, since the proxy renders precisely what it is asked for and a phone showing the hero at 360 points would otherwise decode a frame four times larger than it can display
    function buildHeroSrcset(entry) {
        const originalUrl = entry.master || entry.url;
        return HERO_CANDIDATE_WIDTHS
            .map(candidateWidth => `${buildProxiedImageUrl(originalUrl, candidateWidth)} ${candidateWidth}w`)
            .join(', ');
    }

    // Emitting the responsive attributes only for still imagery, so an animated entry keeps a single unproxied source and stays animated
    function composeHeroImageAttributes(entry) {
        if (isAnimatedArchiveFormat(entry.url)) {
            return `src="${entry.url}"`;
        }
        return `src="${resolveHeroImageSource(entry)}" srcset="${buildHeroSrcset(entry)}" sizes="${HERO_LAYOUT_SIZES}"`;
    }

    // Repointing an image node at the original NASA URL when the proxy fails, so a bad hour at a third party degrades the page to its previous behaviour instead of an empty frame
    function bindProxyFallbacks(scope) {
        scope.querySelectorAll('img[data-origin-src]').forEach(imageNode => {
            imageNode.addEventListener('error', () => {
                const originalUrl = imageNode.getAttribute('data-origin-src');
                if (!originalUrl || imageNode.getAttribute('src') === originalUrl) return;

                imageNode.removeAttribute('srcset');
                imageNode.removeAttribute('sizes');
                imageNode.setAttribute('src', originalUrl);
            });
        });
    }

    function applyHeroImageSource(imageNode, entry) {
        imageNode.setAttribute('data-origin-src', entry.url);

        if (isAnimatedArchiveFormat(entry.url)) {
            imageNode.removeAttribute('srcset');
            imageNode.removeAttribute('sizes');
            imageNode.setAttribute('src', entry.url);
            return;
        }

        imageNode.setAttribute('sizes', HERO_LAYOUT_SIZES);
        imageNode.setAttribute('srcset', buildHeroSrcset(entry));
        imageNode.setAttribute('src', resolveHeroImageSource(entry));
    }

    // Preferring the archive's own thumbnail where one exists and resizing through the proxy where it does not, so a picker strip never pulls ten full-resolution captures
    function resolveThumbnailSource(entry) {
        if (entry.thumb) return entry.thumb;

        const proxied = buildProxiedImageUrl(entry.url, THUMBNAIL_RENDER_WIDTH);

        // Skipping past the opening frame of an animation, since a sequence that begins on a new moon or a fade-in flattens to a black square
        return isAnimatedArchiveFormat(entry.url) ? `${proxied}&page=${ANIMATED_STILL_FRAME}` : proxied;
    }

    // Dropping the date suffix on EPIC heroes only, where the caption underneath already carries it and the full string wraps to a second line
    function resolveHeroDisplayTitle(sourceId, title) {
        return sourceId === 'epic' ? title.split('\u2014')[0].trim() : title;
    }

    // Padding both segments because an unpadded stored date would miss its shard entirely and cost a request that can only ever return a not-found
    function extractMonthDayKey(dateString) {
        const segments = dateString.split('-');
        if (segments.length !== 3) return '01-01';
        return `${segments[1].padStart(2, '0')}-${segments[2].padStart(2, '0')}`;
    }

    // Formatting in UTC throughout, since a birthday is a calendar fact and must not shift for a giver in a different timezone from the recipient
    function formatMonthDay(parsedDate) {
        return parsedDate.toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            timeZone: 'UTC'
        });
    }

    // Preferring the exact birth year and otherwise taking the newest capture, which is what drives the difference between the two caption forms below
    function resolveDefaultCandidate(candidates, birthYear) {
        return candidates.find(entry => entry.year === birthYear) || candidates[0];
    }

    // Keeping the two caption forms strictly separate so an archive image from another year is never described as having been taken on the day of birth
    function composeHeroCaption(selectedYear, birthYear, monthDayText) {
        if (selectedYear === birthYear) {
            return `Captured on the day you were born: ${monthDayText}, ${selectedYear}.`;
        }
        return `Captured on your birthday: ${monthDayText} (${selectedYear} Archive).`;
    }

    function composeSolarEventCaption(selectedYear, birthYear, monthDayText) {
        if (selectedYear === birthYear) {
            return `Solar event on the day you were born: ${monthDayText}, ${selectedYear}.`;
        }
        return `Solar event on your birthday: ${monthDayText} (${selectedYear} Archive).`;
    }

    function composeDiscoveryCaption(discoveryYear, birthYear) {
        if (discoveryYear === birthYear) {
            return `Discovered the year you were born: ${discoveryYear}.`;
        }
        return `Discovered in ${discoveryYear}.`;
    }

    // Collapsing to one entry per year because an active solar day can carry a dozen flares and the picker only offers a year to choose from
    function extractOnePerYear(entries) {
        const yearMap = new Map();
        for (const entry of entries) {
            if (!yearMap.has(entry.year)) {
                yearMap.set(entry.year, entry);
            }
        }
        return Array.from(yearMap.values());
    }

    // Sorting by distance from the birth year to choose the shortlist, then back into descending order so the picker still reads chronologically
    function resolveNearestYears(fullIndex, birthYear, limit) {
        return Object.keys(fullIndex)
            .map(Number)
            .sort((a, b) => Math.abs(a - birthYear) - Math.abs(b - birthYear))
            .slice(0, limit)
            .sort((a, b) => b - a);
    }

    // Reporting peak time in UTC, which is how the DONKI catalogue records it and how any cross-reference will be published
    function formatFlarePeakTime(isoTimestamp) {
        if (!isoTimestamp) return 'Peak time not recorded';
        const timePortion = isoTimestamp.split('T')[1];
        if (!timePortion) return 'Peak time not recorded';
        return timePortion.replace('Z', '').substring(0, 5) + ' UTC';
    }

    function formatMeasurement(value, unit) {
        if (value === null || value === undefined) return null;
        return `${value} ${unit}`;
    }

    // Rebuilding the whole narrative from the current selections rather than patching it, which is what keeps the prose honest when a giver swaps to a different year
    function synthesizeNarrative(payload, selections) {
        const birthYear = payload.parsedDate.getUTCFullYear();
        const monthDayText = formatMonthDay(payload.parsedDate);
        const fragments = [];

        if (selections.apod) {
            if (selections.apod.year === birthYear) {
                fragments.push(
                    `On the day you were born, the cosmos revealed \u201C${selections.apod.title}\u201D \u2014 captured and archived by NASA.`
                );
            } else {
                fragments.push(
                    `Across the archive on ${monthDayText}, NASA captured \u201C${selections.apod.title}\u201D (${selections.apod.year}).`
                );
            }
        }

        if (selections.epic) {
            if (selections.epic.year === birthYear) {
                fragments.push(
                    'That same day, DSCOVR photographed Earth in full-disk detail from a million miles away.'
                );
            } else {
                fragments.push(
                    `On ${monthDayText} in ${selections.epic.year}, DSCOVR captured Earth in full-disk splendor from its Lagrange point.`
                );
            }
        }

        fragments.push(
            `Born on a ${payload.astro.weekday} under ${payload.astro.sign}, ` +
            `you have completed ${payload.orbital.orbits} revolutions around the Sun, ` +
            `traveling approximately ${payload.displacement.toLocaleString()} kilometers through the galaxy ` +
            `beneath a moon in its ${payload.lunar.phase.toLowerCase()} phase.`
        );

        if (selections.donki) {
            if (selections.donki.year === birthYear) {
                fragments.push(
                    `On your exact birthdate, a Class ${selections.donki.classType} solar flare erupted from the Sun\u2019s surface.`
                );
            } else {
                fragments.push(
                    `On ${monthDayText} in ${selections.donki.year}, a Class ${selections.donki.classType} solar flare erupted from the Sun.`
                );
            }
        }

        if (selections.exoplanet) {
            const planetIdentity = selections.exoplanet.hostStar
                ? `${selections.exoplanet.name} orbiting ${selections.exoplanet.hostStar}`
                : selections.exoplanet.name;
            const discYear = selections.exoplanet.discoveryYear;
            if (discYear === birthYear) {
                fragments.push(`In the year you were born, astronomers discovered ${planetIdentity}.`);
            } else {
                fragments.push(`In ${discYear}, astronomers discovered ${planetIdentity}.`);
            }
        }

        return fragments.join(' ');
    }

    function buildCoverLeaf(fullDateDisplay, isRecipientView) {
        return `
            <div class="leaf-inner leaf-cover">
                <div class="cover-spacer"></div>
                <div class="cover-content">
                    <span class="cover-date">${fullDateDisplay}</span>
                    <div class="cover-rule"><span class="cover-rule-star">\u2726</span></div>
                    <h2 class="cover-title">Universe Biography</h2>
                    ${isRecipientView ? '' : `
                    <div class="cover-name-field">
                        <input type="text" id="sb-recipient-name" class="cover-name-input"
                               placeholder="Who is this for?" autocomplete="off" spellcheck="false">
                    </div>`}
                </div>
                <span class="cover-hint">Turn the page \u203A</span>
            </div>`;
    }

    function buildHeroLeaf(sourceLabel, sourceId, defaultEntry, candidates, birthYear, monthDayText, isRecipientView) {
        const caption = composeHeroCaption(defaultEntry.year, birthYear, monthDayText);
        const hasAlternates = !isRecipientView && candidates.length > 1;

        return `
            <div class="leaf-inner leaf-hero">
                <span class="leaf-section-label">${sourceLabel}</span>
                <div class="leaf-hero-frame">
                    <img id="${sourceId}-sb-hero" ${composeHeroImageAttributes(defaultEntry)} data-origin-src="${escapeMarkup(defaultEntry.url)}" alt="${escapeMarkup(defaultEntry.title)}"
                         loading="${sourceId === 'apod' ? 'eager' : 'lazy'}" fetchpriority="${sourceId === 'apod' ? 'high' : 'low'}" decoding="async">
                </div>
                <div class="leaf-hero-meta">
                    <span class="leaf-hero-title" id="${sourceId}-sb-title">${escapeMarkup(resolveHeroDisplayTitle(sourceId, defaultEntry.title))}</span>
                    <span class="leaf-hero-caption" id="${sourceId}-sb-caption">${caption}</span>
                </div>
                ${hasAlternates ? `
                    <div class="leaf-picker-tray">
                        <div class="leaf-picker-scroll" id="${sourceId}-sb-carousel">
                            ${candidates.map((item, idx) => `
                                <div class="leaf-thumb ${item.year === defaultEntry.year ? 'leaf-thumb-active' : ''}"
                                     data-source="${sourceId}" data-idx="${idx}">
                                    <img src="${resolveThumbnailSource(item)}" data-origin-src="${escapeMarkup(item.url)}" alt="${escapeMarkup(item.title)}" loading="lazy" decoding="async">
                                    <span class="leaf-thumb-year">${item.year}</span>
                                </div>`).join('')}
                        </div>
                    </div>` : ''}
            </div>`;
    }

    function buildVitalsLeaf(payload) {
        return `
            <div class="leaf-inner leaf-vitals">
                <span class="leaf-section-label">Cosmic Vitals</span>
                <div class="vitals-grid">
                    <div class="vitals-cell">
                        <span class="vitals-label">Cosmic Displacement</span>
                        <span class="vitals-figure">${payload.displacement.toLocaleString()} km</span>
                        <span class="vitals-note">Distance through space since birth</span>
                    </div>
                    <div class="vitals-cell">
                        <span class="vitals-label">Lunar Phase</span>
                        <span class="vitals-figure">${payload.lunar.phase}</span>
                        <span class="vitals-note">${payload.lunar.illumination.toFixed(1)}% illumination</span>
                    </div>
                    <div class="vitals-cell">
                        <span class="vitals-label">Solar Revolutions</span>
                        <span class="vitals-figure">${payload.orbital.orbits}</span>
                        <span class="vitals-note">${payload.orbital.daysAlive.toLocaleString()} days aboard Earth</span>
                    </div>
                    <div class="vitals-cell">
                        <span class="vitals-label">Stellar Alignment</span>
                        <span class="vitals-figure">${payload.astro.sign}</span>
                        <span class="vitals-note">Born on a ${payload.astro.weekday}</span>
                    </div>
                </div>
            </div>`;
    }

    function buildDonkiFeaturedFragment(entry, birthYear, monthDayText) {
        const caption = composeSolarEventCaption(entry.year, birthYear, monthDayText);
        const peakDisplay = formatFlarePeakTime(entry.peakTime);
        const sourceRegion = entry.sourceLocation || 'Region not recorded';

        return `
            <div class="leaf-enrichment-card" id="sb-donki-featured">
                <span class="leaf-enrichment-value">${escapeMarkup(entry.classType)}</span>
                <span class="leaf-enrichment-caption">${caption}</span>
                <div class="leaf-enrichment-details">
                    <span class="leaf-detail-item">Peak: ${peakDisplay}</span>
                    <span class="leaf-detail-item">Source: ${escapeMarkup(sourceRegion)}</span>
                </div>
            </div>`;
    }

    function buildDonkiPickerFragment(uniqueEntries, defaultEntry) {
        if (uniqueEntries.length <= 1) return '';

        return `
            <div class="leaf-enrichment-picks" id="sb-donki-picks">
                ${uniqueEntries.map((entry, idx) => `
                    <div class="leaf-pick ${entry.year === defaultEntry.year ? 'leaf-pick-active' : ''}"
                         data-source="donki" data-idx="${idx}">
                        <span class="leaf-pick-main">${escapeMarkup(entry.classType)}</span>
                        <span class="leaf-pick-sub">${entry.year}</span>
                    </div>`).join('')}
            </div>`;
    }

    function buildDonkiLeaf(donkiUniqueByYear, donkiDefault, donkiFeatured, birthYear, monthDayText, isRecipientView) {
        let innerContent = `<span class="leaf-section-label">Solar Activity</span>`;

        if (donkiFeatured) {
            innerContent += `
                <div class="leaf-enrichment-zone" id="sb-donki-zone">
                    ${buildDonkiFeaturedFragment(donkiFeatured, birthYear, monthDayText)}
                    ${isRecipientView ? '' : buildDonkiPickerFragment(donkiUniqueByYear, donkiFeatured)}
                </div>`;
        } else {
            innerContent += `
                <div class="leaf-enrichment-dormant" id="sb-donki-dormant">
                    <p class="leaf-dormant-text">
                        No significant solar flares were recorded on your exact birthdate in ${birthYear}.
                    </p>
                    <button class="leaf-opt-in-btn" id="sb-donki-opt-in">
                        Explore flares from other years
                    </button>
                </div>
                <div class="leaf-enrichment-zone" id="sb-donki-zone" style="display: none;"></div>`;
        }

        return `<div class="leaf-inner leaf-enrichment">${innerContent}</div>`;
    }

    function buildExoplanetFeaturedFragment(planet, discoveryYear, birthYear) {
        const caption = composeDiscoveryCaption(discoveryYear, birthYear);
        const details = [];
        if (planet.method) details.push(planet.method);
        if (planet.facility) details.push(planet.facility);
        const radiusText = formatMeasurement(planet.radiusEarth, 'R\u2295');
        const massText = formatMeasurement(planet.massEarth, 'M\u2295');
        if (radiusText) details.push(radiusText);
        if (massText) details.push(massText);

        return `
            <div class="leaf-enrichment-card" id="sb-exoplanet-featured">
                <span class="leaf-enrichment-value leaf-planet-name">${escapeMarkup(planet.name)}</span>
                ${planet.hostStar ? `<span class="leaf-enrichment-host">orbiting ${escapeMarkup(planet.hostStar)}</span>` : ''}
                <span class="leaf-enrichment-caption">${caption}</span>
                ${details.length > 0 ? `
                    <div class="leaf-enrichment-details">
                        ${details.map(d => `<span class="leaf-detail-item">${d}</span>`).join('')}
                    </div>` : ''}
            </div>`;
    }

    function buildExoplanetPickerFragment(pickerEntries, defaultYear) {
        if (pickerEntries.length <= 1) return '';

        return `
            <div class="leaf-enrichment-picks" id="sb-exoplanet-picks">
                ${pickerEntries.map((entry, idx) => `
                    <div class="leaf-pick ${entry.year === defaultYear ? 'leaf-pick-active' : ''}"
                         data-source="exoplanet" data-idx="${idx}">
                        <span class="leaf-pick-main">${escapeMarkup(entry.planet.name)}</span>
                        <span class="leaf-pick-sub">${entry.year}</span>
                    </div>`).join('')}
            </div>`;
    }

    function buildExoplanetLeaf(pickerEntries, featuredEntry, defaultEntry, birthYear, isRecipientView) {
        let innerContent = `<span class="leaf-section-label">Exoplanet Discoveries</span>`;

        if (featuredEntry) {
            innerContent += `
                <div class="leaf-enrichment-zone" id="sb-exoplanet-zone">
                    ${buildExoplanetFeaturedFragment(featuredEntry.planet, featuredEntry.year, birthYear)}
                    ${isRecipientView ? '' : buildExoplanetPickerFragment(pickerEntries, featuredEntry.year)}
                </div>`;
        } else if (defaultEntry) {
            innerContent += `
                <div class="leaf-enrichment-dormant" id="sb-exoplanet-dormant">
                    <p class="leaf-dormant-text">
                        No exoplanet discoveries were confirmed in ${birthYear}.
                    </p>
                    <button class="leaf-opt-in-btn" id="sb-exoplanet-opt-in">
                        Explore discoveries from nearby years
                    </button>
                </div>
                <div class="leaf-enrichment-zone" id="sb-exoplanet-zone" style="display: none;"></div>`;
        }

        return `<div class="leaf-inner leaf-enrichment">${innerContent}</div>`;
    }

    function buildRecipientNarrativeLeaf() {
        return `
            <div class="leaf-inner leaf-narrative">
                <span class="leaf-section-label">Your Story</span>
                <p class="leaf-narrative-readonly narrative-readonly" id="sb-narrative-readonly"></p>
                <div class="personal-message-panel" id="sb-message-panel">
                    <span class="personal-message-mark">\u2726</span>
                    <p class="personal-message-body" id="sb-message-readonly"></p>
                </div>
            </div>`;
    }

    function buildNarrativeLeaf(initialNarrative) {
        return `
            <div class="leaf-inner leaf-narrative">
                <span class="leaf-section-label">Your Story</span>
                <textarea class="leaf-narrative-field" id="sb-narrative-text" rows="5">${escapeMarkup(initialNarrative)}</textarea>
                <div class="leaf-style-block">
                    <span class="leaf-style-label">Your Message</span>
                    <textarea class="leaf-style-input" id="sb-writing-sample"
                              placeholder="Say what you\u2019d say to them \u2014 in your words, your way. Nicknames, jokes, whatever feels right. Any notes for the AI can go at the end (e.g. \u2018keep it warm\u2019 or \u2018we\u2019ve been friends since school\u2019)."></textarea>
                    <span class="field-tally" id="sb-message-tally"></span>
                    <button class="leaf-style-btn" id="sb-style-transfer">Match Writing Style</button>
                </div>
            </div>`;
    }

    function buildShareLeaf(isRecipientView) {
        if (isRecipientView) {
            return `
            <div class="leaf-inner leaf-share">
                <div class="share-content">
                    <div class="cover-rule"><span class="cover-rule-star">\u2726</span></div>
                    <span class="share-heading">Keep this somewhere safe</span>
                    <p class="share-subtext">Save the card, or write one of your own.</p>
                    <div class="share-actions">
                        <button class="share-btn share-btn-primary" id="sb-export-card">Export Story Card</button>
                        <a class="share-btn share-btn-secondary" href="/">Make One For Someone Else</a>
                    </div>
                </div>
            </div>`;
        }

        return `
            <div class="leaf-inner leaf-share">
                <div class="share-content">
                    <div class="cover-rule"><span class="cover-rule-star">\u2726</span></div>
                    <span class="share-heading">Ready to send?</span>
                    <p class="share-subtext">This link will stay active for one year.</p>
                    <div class="share-actions">
                        <button class="share-btn share-btn-primary" id="sb-share-link">Copy Gift Link</button>
                        <button class="share-btn share-btn-secondary" id="sb-export-card">Export Story Card</button>
                    </div>
                </div>
            </div>`;
    }

    // Surfacing the link as a selectable anchor whenever the clipboard refuses, since the gift already exists in storage by that point and a copy failure must never read as a creation failure
    function revealShareLinkReadout(triggerNode, shareUrl) {
        let readout = triggerNode.parentNode.querySelector('.share-link-readout');

        if (!readout) {
            readout = document.createElement('a');
            readout.className = 'share-link-readout';
            readout.target = '_blank';
            readout.rel = 'noopener';
            triggerNode.parentNode.insertBefore(readout, triggerNode.nextSibling);
        }

        readout.href = shareUrl;
        readout.textContent = shareUrl;
    }

    // Restoring the control from a single place, so no failure path can leave a giver looking at a disabled button with no explanation
    function restoreShareButton(triggerNode, label) {
        triggerNode.textContent = label;
        setTimeout(() => {
            triggerNode.textContent = 'Copy Gift Link';
            triggerNode.disabled = false;
        }, 2000);
    }

    async function copyShareLink(shareUrl) {
        if (!navigator.clipboard) return false;

        try {
            await navigator.clipboard.writeText(shareUrl);
            return true;
        } catch (err) {
            return false;
        }
    }

    // Minting one identifier per draft so the worker can cap rewrites for a single gift, which an address-based limit alone would never catch
    function mintDraftIdentifier() {
        const entropy = new Uint8Array(8);
        crypto.getRandomValues(entropy);
        return Array.from(entropy).map(byte => byte.toString(16).padStart(2, '0')).join('');
    }

    async function mountStorybook(rootContainer, payload) {
        const monthDayKey = extractMonthDayKey(payload.targetDate);
        const catalogs = await loadAllCatalogs(monthDayKey);
        const isRecipientView = payload.mode === 'recipient';
        const gift = payload.gift || {};
        const birthYear = payload.parsedDate.getUTCFullYear();
        const monthDayText = formatMonthDay(payload.parsedDate);
        const fullDateDisplay = payload.parsedDate.toLocaleDateString('en-US', {
            month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC'
        });

        let apodCandidates = catalogs.apod;
        if (apodCandidates.length === 0) {
            apodCandidates = [{
                year: birthYear,
                url: 'https://apod.nasa.gov/apod/image/2401/OrionNebula_Hubble_960.jpg',
                title: 'Orion Nebula Ambient Composite'
            }];
        }
        const apodDefault = resolveDefaultCandidate(apodCandidates, birthYear);

        const epicCandidates = catalogs.epic;
        const epicDefault = epicCandidates.length > 0
            ? resolveDefaultCandidate(epicCandidates, birthYear)
            : null;

        const donkiRawEntries = catalogs.donki;
        const donkiUniqueByYear = extractOnePerYear(donkiRawEntries);
        const donkiExactYearMatch = donkiUniqueByYear.find(e => e.year === birthYear) || null;
        const donkiHasAnyData = donkiUniqueByYear.length > 0;
        const donkiDefault = donkiExactYearMatch || (donkiHasAnyData ? donkiUniqueByYear[0] : null);
        const donkiStoredPick = gift.chosenDonkiDate
            ? donkiUniqueByYear.find(e => (e.peakTime || '').startsWith(gift.chosenDonkiDate))
            : null;
        const donkiFeatured = isRecipientView
            ? (gift.donkiOptedIn ? (donkiStoredPick || donkiDefault) : null)
            : donkiExactYearMatch;

        const birthYearKey = String(birthYear);
        const exoplanetHasExactYear = (catalogs.exoplanet[birthYearKey] || []).length > 0;
        const exoplanetAllYears = Object.keys(catalogs.exoplanet).map(Number);
        const exoplanetHasAnyData = exoplanetAllYears.length > 0;

        let exoplanetPickerEntries = [];
        if (exoplanetHasAnyData) {
            const nearestYears = resolveNearestYears(catalogs.exoplanet, birthYear, 10);
            exoplanetPickerEntries = nearestYears
                .map(yr => ({ year: yr, planet: catalogs.exoplanet[String(yr)][0] }))
                .filter(e => e.planet);
        }

        const exoplanetDefaultEntry = exoplanetHasExactYear
            ? exoplanetPickerEntries.find(e => e.year === birthYear) || exoplanetPickerEntries[0]
            : (exoplanetPickerEntries.length > 0 ? exoplanetPickerEntries[0] : null);

        const exoplanetStoredPick = gift.chosenExoplanetYear
            ? exoplanetPickerEntries.find(e => e.year === gift.chosenExoplanetYear)
            : null;
        const exoplanetFeatured = isRecipientView
            ? (gift.exoplanetOptedIn ? (exoplanetStoredPick || exoplanetDefaultEntry) : null)
            : (exoplanetHasExactYear ? exoplanetDefaultEntry : null);

        // Holding the current pick for every source in one place, so the narrative can be regenerated from a single object whenever any picker changes
        const activeSelections = {
            apod: { year: apodDefault.year, url: apodDefault.url, title: apodDefault.title },
            epic: epicDefault
                ? { year: epicDefault.year, url: epicDefault.url, title: epicDefault.title }
                : null,
            donki: donkiFeatured ? { ...donkiFeatured } : null,
            exoplanet: exoplanetFeatured
                ? { ...exoplanetFeatured.planet, discoveryYear: exoplanetFeatured.year }
                : null,
            donkiOptedIn: !!donkiFeatured,
            exoplanetOptedIn: !!exoplanetFeatured
        };

        // Leaving an edited narrative alone, because a giver who has rewritten the prose should not lose it to a later year swap
        function refreshNarrative() {
            const field = rootContainer.querySelector('#sb-narrative-text');
            if (field) {
                field.value = synthesizeNarrative(payload, activeSelections);
                window.SkywrittenFields.resizeToContent(field);
            }
        }

        const pageSequence = [];

        pageSequence.push({ id: 'cover', html: buildCoverLeaf(fullDateDisplay, isRecipientView) });
        pageSequence.push({
            id: 'apod',
            html: buildHeroLeaf('The Sky', 'apod', apodDefault, apodCandidates, birthYear, monthDayText, isRecipientView)
        });

        if (epicDefault) {
            pageSequence.push({
                id: 'epic',
                html: buildHeroLeaf('The Earth', 'epic', epicDefault, epicCandidates, birthYear, monthDayText, isRecipientView)
            });
        }

        pageSequence.push({ id: 'vitals', html: buildVitalsLeaf(payload) });

        if (donkiHasAnyData && (donkiFeatured || !isRecipientView)) {
            pageSequence.push({
                id: 'donki',
                html: buildDonkiLeaf(donkiUniqueByYear, donkiDefault, donkiFeatured, birthYear, monthDayText, isRecipientView)
            });
        }

        if (exoplanetHasAnyData && exoplanetDefaultEntry && (exoplanetFeatured || !isRecipientView)) {
            pageSequence.push({
                id: 'exoplanet',
                html: buildExoplanetLeaf(exoplanetPickerEntries, exoplanetFeatured, exoplanetDefaultEntry, birthYear, isRecipientView)
            });
        }

        const initialNarrative = synthesizeNarrative(payload, activeSelections);
        pageSequence.push({
            id: 'narrative',
            html: isRecipientView ? buildRecipientNarrativeLeaf() : buildNarrativeLeaf(initialNarrative)
        });
        pageSequence.push({ id: 'share', html: buildShareLeaf(isRecipientView) });

        const totalPages = pageSequence.length;
        let currentPageIndex = 0;
        let turnLocked = false;

        const leafMarkup = pageSequence.map((page, i) => `
            <div class="storybook-leaf ${i === 0 ? 'leaf-current' : ''}"
                 style="z-index: ${totalPages - i}"
                 data-page-index="${i}" id="sb-leaf-${page.id}">
                <div class="leaf-back"></div>
                ${page.html}
            </div>`).join('');

        rootContainer.innerHTML = `
            <div class="storybook-stage">
                <div class="storybook-viewport" id="sb-viewport">
                    ${leafMarkup}
                </div>
                <div class="storybook-nav">
                    <button class="sb-nav-btn sb-nav-prev" id="sb-prev" disabled aria-label="Previous page">\u2039</button>
                    <span class="sb-page-counter" id="sb-counter">1 of ${totalPages}</span>
                    <button class="sb-nav-btn sb-nav-next" id="sb-next" aria-label="Next page">\u203A</button>
                </div>
            </div>`;

        if (isRecipientView) {
            const storedName = (gift.recipientName || '').trim();
            if (storedName) {
                rootContainer.querySelector('.cover-title').textContent =
                    `${storedName}\u2019s Universe Biography`;
            }

            rootContainer.querySelector('#sb-narrative-readonly').textContent =
                // Preferring the stored narrative on a recipient page, since the giver may have edited or rewritten it before sending
                gift.narrative || initialNarrative;

            const messagePanel = rootContainer.querySelector('#sb-message-panel');
            const storedMessage = (gift.message || '').trim();
            if (storedMessage) {
                messagePanel.querySelector('#sb-message-readonly').textContent = storedMessage;
            } else {
                messagePanel.remove();
            }
        }

        const stageNode = rootContainer.querySelector('.storybook-stage');
        requestAnimationFrame(() => {
            stageNode.classList.add('stage-ready');
        });

        const allLeaves = rootContainer.querySelectorAll('.storybook-leaf');
        const prevBtn = rootContainer.querySelector('#sb-prev');
        const nextBtn = rootContainer.querySelector('#sb-next');
        const pageCounter = rootContainer.querySelector('#sb-counter');

        // Driving the page controls from the same index the transform uses, so a turn cannot leave the arrows describing a different leaf
        function updateNavState() {
            prevBtn.disabled = currentPageIndex === 0;
            nextBtn.disabled = currentPageIndex === totalPages - 1;
            pageCounter.textContent = `${currentPageIndex + 1} of ${totalPages}`;
        }

        // Driving the page turn from a transform on the leaf rather than any layout property, which is what keeps the animation on the compositor on mid-range Android
        function turnToPage(newIndex) {
            if (newIndex < 0 || newIndex >= totalPages) return;
            if (newIndex === currentPageIndex || turnLocked) return;

            turnLocked = true;
            const goingForward = newIndex > currentPageIndex;

            allLeaves[currentPageIndex].classList.remove('leaf-current');

            if (goingForward) {
                allLeaves[currentPageIndex].classList.add('leaf-turned');
            } else {
                allLeaves[newIndex].classList.remove('leaf-turned');
            }

            allLeaves[newIndex].classList.add('leaf-current');
            currentPageIndex = newIndex;
            updateNavState();

            setTimeout(() => { turnLocked = false; }, 750);
        }

        prevBtn.addEventListener('click', () => turnToPage(currentPageIndex - 1));
        nextBtn.addEventListener('click', () => turnToPage(currentPageIndex + 1));

        const viewport = rootContainer.querySelector('#sb-viewport');
        let swipeOriginX = 0;
        let swipeOriginY = 0;
        const SWIPE_THRESHOLD = 50;

        viewport.addEventListener('touchstart', (e) => {
            swipeOriginX = e.touches[0].clientX;
            swipeOriginY = e.touches[0].clientY;
        }, { passive: true });

        viewport.addEventListener('touchend', (e) => {
            const deltaX = e.changedTouches[0].clientX - swipeOriginX;
            const deltaY = e.changedTouches[0].clientY - swipeOriginY;

            if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > SWIPE_THRESHOLD) {
                if (deltaX < 0) turnToPage(currentPageIndex + 1);
                else turnToPage(currentPageIndex - 1);
            }
        }, { passive: true });

        document.addEventListener('keydown', (e) => {
            const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
            if (activeTag === 'input' || activeTag === 'textarea') return;

            if (e.key === 'ArrowRight') turnToPage(currentPageIndex + 1);
            if (e.key === 'ArrowLeft') turnToPage(currentPageIndex - 1);
        });

        // Fading each capture in on its own load event, since a leaf can be turned to before its image has arrived
        function attachHeroLoadState(imgId) {
            const img = rootContainer.querySelector(`#${imgId}`);
            if (!img) return;
            if (img.complete && img.naturalWidth > 0) {
                img.classList.add('sb-img-loaded');
            } else {
                img.addEventListener('load', () => img.classList.add('sb-img-loaded'));
            }
        }

        bindProxyFallbacks(rootContainer);
        attachHeroLoadState('apod-sb-hero');
        attachHeroLoadState('epic-sb-hero');

        function bindHeroPicker(sourceId, candidates) {
            const carousel = rootContainer.querySelector(`#${sourceId}-sb-carousel`);
            if (!carousel) return;

            const thumbs = carousel.querySelectorAll('.leaf-thumb');
            const heroImg = rootContainer.querySelector(`#${sourceId}-sb-hero`);
            const titleEl = rootContainer.querySelector(`#${sourceId}-sb-title`);
            const captionEl = rootContainer.querySelector(`#${sourceId}-sb-caption`);

            thumbs.forEach(node => {
                node.addEventListener('click', () => {
                    const idx = parseInt(node.getAttribute('data-idx'), 10);
                    const chosen = candidates[idx];
                    if (!chosen) return;

                    thumbs.forEach(n => n.classList.remove('leaf-thumb-active'));
                    node.classList.add('leaf-thumb-active');

                    if (heroImg) {
                        heroImg.classList.remove('sb-img-loaded');
                        setTimeout(() => {
                            applyHeroImageSource(heroImg, chosen);
                            heroImg.alt = chosen.title;
                            heroImg.addEventListener('load', () => heroImg.classList.add('sb-img-loaded'), { once: true });
                        }, 150);
                    }

                    if (titleEl) titleEl.textContent = resolveHeroDisplayTitle(sourceId, chosen.title);
                    if (captionEl) {
                        captionEl.textContent = composeHeroCaption(chosen.year, birthYear, monthDayText);
                    }

                    activeSelections[sourceId] = {
                        year: chosen.year, url: chosen.url, title: chosen.title
                    };
                    refreshNarrative();
                });
            });
        }

        bindHeroPicker('apod', apodCandidates);
        bindHeroPicker('epic', epicCandidates);

        // Leaving the solar leaf dormant until the giver opts in, because a flare from a neighbouring year is a weaker claim than one from the birthday itself
        function activateDonkiZone(defaultEntry) {
            const zone = rootContainer.querySelector('#sb-donki-zone');
            if (!zone) return;

            zone.innerHTML =
                buildDonkiFeaturedFragment(defaultEntry, birthYear, monthDayText) +
                buildDonkiPickerFragment(donkiUniqueByYear, defaultEntry);
            zone.style.display = '';

            activeSelections.donki = { ...defaultEntry };
            activeSelections.donkiOptedIn = true;
            refreshNarrative();
            bindDonkiPicker();
        }

        // Rebinding after the leaf is rendered, because the solar leaf does not exist in the document until the giver opts in
        function bindDonkiPicker() {
            const picks = rootContainer.querySelector('#sb-donki-picks');
            if (!picks) return;

            picks.querySelectorAll('.leaf-pick').forEach(node => {
                node.addEventListener('click', () => {
                    const idx = parseInt(node.getAttribute('data-idx'), 10);
                    const chosen = donkiUniqueByYear[idx];
                    if (!chosen) return;

                    picks.querySelectorAll('.leaf-pick').forEach(n => n.classList.remove('leaf-pick-active'));
                    node.classList.add('leaf-pick-active');

                    const featuredEl = rootContainer.querySelector('#sb-donki-featured');
                    if (featuredEl) {
                        featuredEl.outerHTML = buildDonkiFeaturedFragment(chosen, birthYear, monthDayText);
                    }

                    activeSelections.donki = { ...chosen };
                    refreshNarrative();
                });
            });
        }

        const donkiOptIn = rootContainer.querySelector('#sb-donki-opt-in');
        if (donkiOptIn && donkiDefault) {
            donkiOptIn.addEventListener('click', () => {
                const dormant = rootContainer.querySelector('#sb-donki-dormant');
                if (dormant) dormant.style.display = 'none';
                activateDonkiZone(donkiDefault);
            });
        }
        if (donkiExactYearMatch) bindDonkiPicker();

        function activateExoplanetZone(defaultPickerEntry) {
            const zone = rootContainer.querySelector('#sb-exoplanet-zone');
            if (!zone) return;

            zone.innerHTML =
                buildExoplanetFeaturedFragment(defaultPickerEntry.planet, defaultPickerEntry.year, birthYear) +
                buildExoplanetPickerFragment(exoplanetPickerEntries, defaultPickerEntry.year);
            zone.style.display = '';

            activeSelections.exoplanet = {
                ...defaultPickerEntry.planet,
                discoveryYear: defaultPickerEntry.year
            };
            activeSelections.exoplanetOptedIn = true;
            refreshNarrative();
            bindExoplanetPicker();
        }

        // Rebinding after the leaf is rendered, on the same terms as the solar picker above
        function bindExoplanetPicker() {
            const picks = rootContainer.querySelector('#sb-exoplanet-picks');
            if (!picks) return;

            picks.querySelectorAll('.leaf-pick').forEach(node => {
                node.addEventListener('click', () => {
                    const idx = parseInt(node.getAttribute('data-idx'), 10);
                    const chosen = exoplanetPickerEntries[idx];
                    if (!chosen) return;

                    picks.querySelectorAll('.leaf-pick').forEach(n => n.classList.remove('leaf-pick-active'));
                    node.classList.add('leaf-pick-active');

                    const featuredEl = rootContainer.querySelector('#sb-exoplanet-featured');
                    if (featuredEl) {
                        featuredEl.outerHTML = buildExoplanetFeaturedFragment(chosen.planet, chosen.year, birthYear);
                    }

                    activeSelections.exoplanet = {
                        ...chosen.planet,
                        discoveryYear: chosen.year
                    };
                    refreshNarrative();
                });
            });
        }

        const exoplanetOptIn = rootContainer.querySelector('#sb-exoplanet-opt-in');
        if (exoplanetOptIn && exoplanetDefaultEntry) {
            exoplanetOptIn.addEventListener('click', () => {
                const dormant = rootContainer.querySelector('#sb-exoplanet-dormant');
                if (dormant) dormant.style.display = 'none';
                activateExoplanetZone(exoplanetDefaultEntry);
            });
        }
        if (exoplanetHasExactYear && exoplanetDefaultEntry) bindExoplanetPicker();

        const nameInput = rootContainer.querySelector('#sb-recipient-name');
        const coverTitle = rootContainer.querySelector('.cover-title');
        if (nameInput && coverTitle) {
            nameInput.addEventListener('input', () => {
                const name = nameInput.value.trim();
                coverTitle.textContent = name
                    ? `${name}\u2019s Universe Biography`
                    : 'Universe Biography';
            });
        }

        const styleBtn = rootContainer.querySelector('#sb-style-transfer');
        const sampleInput = rootContainer.querySelector('#sb-writing-sample');
        const narrativeField = rootContainer.querySelector('#sb-narrative-text');
        const messageTally = rootContainer.querySelector('#sb-message-tally');

        window.SkywrittenFields.bindMessageField(sampleInput, messageTally);
        window.SkywrittenFields.bindAutoGrow(narrativeField);

        if (styleBtn && sampleInput && narrativeField) {
            const resetStyleBtn = (label, delay) => {
                styleBtn.textContent = label;
                setTimeout(() => {
                    styleBtn.textContent = 'Match Writing Style';
                    styleBtn.disabled = false;
                }, delay);
            };

            styleBtn.addEventListener('click', async () => {
                const sample = sampleInput.value.trim();
                styleBtn.disabled = true;

                if (!sample) {
                    resetStyleBtn('Write your message first', 2500);
                    return;
                }

                styleBtn.textContent = 'Rewriting\u2026';

                try {
                    // Sending only the personal message for rewriting, never the factual narrative, so the astronomy stays accurate and the AI only touches the giver's own words
                    const response = await fetch('/api/rewrite', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            sample: sample,
                            baseNarrative: narrativeField.value,
                            targetDate: payload.targetDate,
                            draftId: draftIdentifier
                        })
                    });

                    const result = await response.json().catch(() => ({}));

                    if (response.ok && result.styledNarrative) {
                        sampleInput.value = result.styledNarrative;
                        window.SkywrittenFields.syncAfterProgrammaticEdit(sampleInput, messageTally);
                        resetStyleBtn('Rewritten \u2714', 1800);
                        return;
                    }

                    if (response.status === 429) {
                        resetStyleBtn('Too many requests \u2014 wait a moment', 3500);
                    } else if (response.status === 422) {
                        resetStyleBtn('Message flagged \u2014 try rephrasing', 3500);
                    } else {
                        resetStyleBtn('Couldn\u2019t rewrite \u2014 try again', 3500);
                    }
                } catch {
                    resetStyleBtn('Connection failed \u2014 try again', 3500);
                }
            });
        }

        const draftIdentifier = mintDraftIdentifier();
        let createdShareUrl = null;
        let createdRequestSignature = null;

        const shareLinkBtn = rootContainer.querySelector('#sb-share-link');
        if (shareLinkBtn && narrativeField) {
            shareLinkBtn.addEventListener('click', () => {
                // Catching at the boundary so an unexpected fault resets the control rather than stranding it mid-generation
                createGiftLink().catch(() => restoreShareButton(shareLinkBtn, 'Failed \u2014 Try Again'));
            });

            async function createGiftLink() {
                const recipientName = (rootContainer.querySelector('#sb-recipient-name') || {}).value || '';

                shareLinkBtn.textContent = 'Generating Link\u2026';
                shareLinkBtn.disabled = true;

                const donkiDate = activeSelections.donki && activeSelections.donki.peakTime
                    ? activeSelections.donki.peakTime.split('T')[0]
                    : null;

                // Fingerprinting the outgoing selections in the browser, so a retry after a refused clipboard reuses the gift that was already stored instead of writing a second one
                const requestSignature = JSON.stringify([
                    payload.targetDate,
                    recipientName.trim(),
                    activeSelections.apod ? activeSelections.apod.year : null,
                    activeSelections.epic ? activeSelections.epic.year : null,
                    activeSelections.donkiOptedIn,
                    donkiDate,
                    activeSelections.exoplanetOptedIn,
                    activeSelections.exoplanet ? activeSelections.exoplanet.discoveryYear : null,
                    narrativeField.value,
                    (rootContainer.querySelector('#sb-writing-sample') || {}).value || ''
                ]);

                if (createdShareUrl && createdRequestSignature === requestSignature) {
                    const reusedCopy = await copyShareLink(createdShareUrl);
                    if (!reusedCopy) {
                        revealShareLinkReadout(shareLinkBtn, createdShareUrl);
                    }

                    restoreShareButton(shareLinkBtn, reusedCopy ? 'Link Copied!' : 'Link Ready \u2014 Copy Below');
                    return;
                }

                try {
                    // Posting the resolved selections rather than the rendered markup, which lets a recipient page rebuild itself from the same shards the giver saw
                    const response = await fetch('/api/link', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            date: payload.targetDate,
                            name: recipientName.trim(),
                            template: 'storybook',
                            chosenApodYear: activeSelections.apod ? activeSelections.apod.year : null,
                            chosenEpicYear: activeSelections.epic ? activeSelections.epic.year : null,
                            donkiOptedIn: activeSelections.donkiOptedIn,
                            chosenDonkiDate: donkiDate,
                            exoplanetOptedIn: activeSelections.exoplanetOptedIn,
                            chosenExoplanetYear: activeSelections.exoplanet
                                ? activeSelections.exoplanet.discoveryYear
                                : null,
                            styledNarrative: narrativeField.value,
                            personalMessage: (rootContainer.querySelector('#sb-writing-sample') || {}).value || '',
                            heroUrl: activeSelections.apod ? activeSelections.apod.url : null,
                            heroTitle: activeSelections.apod ? activeSelections.apod.title : null
                        })
                    });

                    if (!response.ok) {
                        throw new Error('Link generation response not ok');
                    }

                    const result = await response.json();
                    createdShareUrl = `${window.location.origin}/u/${result.id}`;
                    createdRequestSignature = requestSignature;
                } catch (err) {
                    restoreShareButton(shareLinkBtn, 'Failed \u2014 Try Again');
                    return;
                }

                const copied = await copyShareLink(createdShareUrl);
                if (!copied) {
                    revealShareLinkReadout(shareLinkBtn, createdShareUrl);
                }

                restoreShareButton(shareLinkBtn, copied ? 'Link Copied!' : 'Link Ready \u2014 Copy Below');
            }
        }
    }

    window.SkywrittenTemplates.storybook = {
        mount: mountStorybook
    };
})();
