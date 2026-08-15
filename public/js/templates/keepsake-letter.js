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
    const HERO_LAYOUT_SIZES = '(max-width: 600px) calc(100vw - 48px), 560px';
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

    function composeVitalsProse(payload) {
        return `You have traveled ${payload.displacement.toLocaleString()} kilometers through the cosmos \u2014 ` +
            `${payload.orbital.orbits} complete orbits, ` +
            `${payload.orbital.daysAlive.toLocaleString()} days aboard Earth \u2014 ` +
            `beneath a ${payload.lunar.phase.toLowerCase()} moon at ` +
            `${payload.lunar.illumination.toFixed(1)}% illumination. ` +
            `Born on a ${payload.astro.weekday} under ${payload.astro.sign}.`;
    }

    function buildPhotographMarkup(sourceLabel, sourceId, defaultEntry, candidates, birthYear, monthDayText, isRecipientView) {
        const caption = composeHeroCaption(defaultEntry.year, birthYear, monthDayText);
        const hasAlternates = !isRecipientView && candidates.length > 1;
        const figureClass = sourceId === 'epic' ? 'letter-figure-epic' : 'letter-figure-apod';

        let pickerMarkup = '';
        if (hasAlternates) {
            pickerMarkup = `
                <div class="letter-picker-tray">
                    <span class="letter-picker-label">Alternate captures</span>
                    <div class="letter-picker-scroll" id="kl-${sourceId}-carousel">
                        ${candidates.map((item, idx) => `
                            <div class="letter-thumb ${item.year === defaultEntry.year ? 'letter-thumb-active' : ''}"
                                 data-source="${sourceId}" data-idx="${idx}">
                                <img src="${resolveThumbnailSource(item)}" data-origin-src="${escapeMarkup(item.url)}" alt="${escapeMarkup(item.title)}" loading="lazy" decoding="async">
                                <span class="letter-thumb-year">${item.year}</span>
                            </div>`).join('')}
                    </div>
                </div>`;
        }

        return `
            <div class="letter-figure ${figureClass}">
                <span class="letter-figure-source">${sourceLabel}</span>
                <div class="letter-figure-frame">
                    <img id="kl-${sourceId}-hero" ${composeHeroImageAttributes(defaultEntry)} data-origin-src="${escapeMarkup(defaultEntry.url)}" alt="${escapeMarkup(defaultEntry.title)}"
                         loading="${sourceId === 'apod' ? 'eager' : 'lazy'}" fetchpriority="${sourceId === 'apod' ? 'high' : 'low'}" decoding="async">
                </div>
                <div class="letter-figure-meta">
                    <span class="letter-figure-title" id="kl-${sourceId}-title">${escapeMarkup(resolveHeroDisplayTitle(sourceId, defaultEntry.title))}</span>
                    <span class="letter-figure-caption" id="kl-${sourceId}-caption">${caption}</span>
                </div>
            </div>
            ${pickerMarkup}`;
    }

    function buildDonkiFeaturedMarkup(entry, birthYear, monthDayText) {
        const caption = composeSolarEventCaption(entry.year, birthYear, monthDayText);
        const peakDisplay = formatFlarePeakTime(entry.peakTime);
        const sourceRegion = entry.sourceLocation || 'Region not recorded';

        return `
            <div class="letter-enrichment-card" id="kl-donki-featured">
                <span class="letter-enrichment-value">${escapeMarkup(entry.classType)}</span>
                <span class="letter-enrichment-caption">${caption}</span>
                <div class="letter-enrichment-details">
                    <span class="letter-detail-item">Peak: ${peakDisplay}</span>
                    <span class="letter-detail-item">Source: ${escapeMarkup(sourceRegion)}</span>
                </div>
            </div>`;
    }

    function buildDonkiPickerMarkup(uniqueEntries, defaultEntry) {
        if (uniqueEntries.length <= 1) return '';

        return `
            <div class="letter-enrichment-picks" id="kl-donki-picks">
                ${uniqueEntries.map((entry, idx) => `
                    <div class="letter-pick ${entry.year === defaultEntry.year ? 'letter-pick-active' : ''}"
                         data-source="donki" data-idx="${idx}">
                        <span class="letter-pick-main">${escapeMarkup(entry.classType)}</span>
                        <span class="letter-pick-sub">${entry.year}</span>
                    </div>`).join('')}
            </div>`;
    }

    function buildExoplanetFeaturedMarkup(planet, discoveryYear, birthYear) {
        const caption = composeDiscoveryCaption(discoveryYear, birthYear);
        const detailFragments = [];
        if (planet.method) detailFragments.push(planet.method);
        if (planet.facility) detailFragments.push(planet.facility);
        const radiusText = formatMeasurement(planet.radiusEarth, 'R\u2295');
        const massText = formatMeasurement(planet.massEarth, 'M\u2295');
        if (radiusText) detailFragments.push(radiusText);
        if (massText) detailFragments.push(massText);

        return `
            <div class="letter-enrichment-card" id="kl-exoplanet-featured">
                <span class="letter-enrichment-value letter-planet-name">${escapeMarkup(planet.name)}</span>
                ${planet.hostStar ? `<span class="letter-enrichment-host">orbiting ${escapeMarkup(planet.hostStar)}</span>` : ''}
                <span class="letter-enrichment-caption">${caption}</span>
                ${detailFragments.length > 0 ? `
                    <div class="letter-enrichment-details">
                        ${detailFragments.map(d => `<span class="letter-detail-item">${d}</span>`).join('')}
                    </div>` : ''}
            </div>`;
    }

    function buildExoplanetPickerMarkup(pickerEntries, defaultYear) {
        if (pickerEntries.length <= 1) return '';

        return `
            <div class="letter-enrichment-picks" id="kl-exoplanet-picks">
                ${pickerEntries.map((entry, idx) => `
                    <div class="letter-pick ${entry.year === defaultYear ? 'letter-pick-active' : ''}"
                         data-source="exoplanet" data-idx="${idx}">
                        <span class="letter-pick-main">${escapeMarkup(entry.planet.name)}</span>
                        <span class="letter-pick-sub">${entry.year}</span>
                    </div>`).join('')}
            </div>`;
    }

    function revealVerses(rootContainer) {
        const verses = rootContainer.querySelectorAll('.letter-verse');
        verses.forEach((verse, i) => {
            setTimeout(() => verse.classList.add('verse-visible'), 200 + i * 160);
        });
    }

    // Staging the opening as discrete transform steps, because the seal, the flap and the letter body have to settle in order for the gesture to read as opening rather than expanding
    function initiateEnvelopeOpening(stage, rootContainer) {
        stage.classList.add('seal-cracking');
        document.body.classList.remove('letter-sealed');

        setTimeout(() => {
            stage.classList.add('opened');
        }, 900);

        setTimeout(() => {
            revealVerses(rootContainer);
        }, 1600);
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

    async function mountKeepsakeLetter(rootContainer, payload) {
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
        const apodDefault = (isRecipientView
            && apodCandidates.find(entry => entry.year === gift.chosenApodYear))
            || resolveDefaultCandidate(apodCandidates, birthYear);

        const epicCandidates = catalogs.epic;
        const epicDefault = epicCandidates.length === 0
            ? null
            : ((isRecipientView && epicCandidates.find(entry => entry.year === gift.chosenEpicYear))
                || resolveDefaultCandidate(epicCandidates, birthYear));

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
        const exoplanetHasAnyData = Object.keys(catalogs.exoplanet).length > 0;

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
            const field = rootContainer.querySelector('#kl-narrative-text');
            if (field) {
                field.value = synthesizeNarrative(payload, activeSelections);
                window.SkywrittenFields.resizeToContent(field);
            }
        }

        const recipientPlaceholder = payload.recipientName || 'Someone Special';

        const envelopeMarkup = `
            <div class="envelope-scene">
                <div class="envelope-sleeve">
                    <div class="envelope-body">
                        <div class="envelope-flap"></div>
                    </div>
                    <span class="envelope-address">${recipientPlaceholder}</span>
                    <div class="envelope-seal" id="kl-seal" tabindex="0" role="button" aria-label="Open the letter">
                        <span class="seal-glyph">\u2726</span>
                    </div>
                </div>
                <span class="envelope-hint">Tap the seal</span>
            </div>`;

        let letterMarkup = '';

        letterMarkup += `
            <div class="letter-verse">
                <span class="letter-dateline">${fullDateDisplay}</span>
                <h2 class="letter-heading">The Universe on the Day You Arrived</h2>
            </div>`;

        letterMarkup += `
            <div class="letter-verse">
                <span class="letter-salutation">Dear ${isRecipientView
                ? `<span class="letter-address-rendered recipient-name-rendered" id="kl-name-rendered"></span>`
                : `<input type="text" id="kl-recipient-name"
                    class="letter-address-input" placeholder="someone special"
                    autocomplete="off" spellcheck="false">`},</span>
            </div>`;

        letterMarkup += `
            <div class="letter-verse">
                <div class="letter-rule"><span class="letter-rule-glyph">\u2726</span></div>
            </div>`;

        letterMarkup += `
            <div class="letter-verse">
                ${buildPhotographMarkup('The Sky', 'apod', apodDefault, apodCandidates, birthYear, monthDayText, isRecipientView)}
            </div>`;

        if (epicDefault) {
            letterMarkup += `
                <div class="letter-verse">
                    ${buildPhotographMarkup('The Earth', 'epic', epicDefault, epicCandidates, birthYear, monthDayText, isRecipientView)}
                </div>`;
        }

        letterMarkup += `
            <div class="letter-verse">
                <p class="letter-vitals-prose">${composeVitalsProse(payload)}</p>
            </div>`;

        letterMarkup += `
            <div class="letter-verse">
                <div class="letter-rule"><span class="letter-rule-glyph">\u2726</span></div>
            </div>`;

        const initialNarrative = synthesizeNarrative(payload, activeSelections);

        letterMarkup += isRecipientView ? `
            <div class="letter-verse">
                <p class="letter-narrative-readonly narrative-readonly" id="kl-narrative-readonly"></p>
            </div>` : `
            <div class="letter-verse">
                <textarea class="letter-narrative-field" id="kl-narrative-text" rows="5">${escapeMarkup(initialNarrative)}</textarea>
            </div>`;

        if (donkiHasAnyData && (donkiFeatured || !isRecipientView)) {
            let donkiContent = '';

            if (donkiFeatured) {
                donkiContent = `
                    <div id="kl-donki-zone">
                        ${buildDonkiFeaturedMarkup(donkiFeatured, birthYear, monthDayText)}
                        ${isRecipientView ? '' : buildDonkiPickerMarkup(donkiUniqueByYear, donkiFeatured)}
                    </div>`;
            } else {
                donkiContent = `
                    <div class="letter-dormant" id="kl-donki-dormant">
                        <p class="letter-dormant-text">
                            No significant solar flares were recorded on ${monthDayText} in ${birthYear}.
                        </p>
                        <button class="letter-opt-in-btn" id="kl-donki-opt-in">
                            Explore flares from other years
                        </button>
                    </div>
                    <div id="kl-donki-zone" style="display: none;"></div>`;
            }

            letterMarkup += `
                <div class="letter-verse">
                    <div class="letter-ps-block">
                        <span class="letter-ps-label">P.S. \u2014 Solar Activity</span>
                        ${donkiContent}
                    </div>
                </div>`;
        }

        if (exoplanetHasAnyData && exoplanetDefaultEntry && (exoplanetFeatured || !isRecipientView)) {
            let exoContent = '';

            if (exoplanetFeatured) {
                exoContent = `
                    <div id="kl-exoplanet-zone">
                        ${buildExoplanetFeaturedMarkup(exoplanetFeatured.planet, exoplanetFeatured.year, birthYear)}
                        ${isRecipientView ? '' : buildExoplanetPickerMarkup(exoplanetPickerEntries, exoplanetFeatured.year)}
                    </div>`;
            } else {
                exoContent = `
                    <div class="letter-dormant" id="kl-exoplanet-dormant">
                        <p class="letter-dormant-text">
                            No exoplanet discoveries were confirmed in ${birthYear}.
                        </p>
                        <button class="letter-opt-in-btn" id="kl-exoplanet-opt-in">
                            Explore discoveries from nearby years
                        </button>
                    </div>
                    <div id="kl-exoplanet-zone" style="display: none;"></div>`;
            }

            letterMarkup += `
                <div class="letter-verse">
                    <div class="letter-ps-block">
                        <span class="letter-ps-label">P.P.S. \u2014 Exoplanet Discoveries</span>
                        ${exoContent}
                    </div>
                </div>`;
        }

        letterMarkup += isRecipientView ? `
            <div class="letter-verse">
                <div class="personal-message-panel" id="kl-message-panel">
                    <span class="personal-message-mark">\u2726</span>
                    <p class="personal-message-body" id="kl-message-readonly"></p>
                </div>
            </div>` : `
            <div class="letter-verse">
                <div class="letter-message-block">
                    <span class="letter-message-label">Your Message</span>
                    <textarea class="letter-message-input" id="kl-writing-sample"
                              placeholder="Say what you\u2019d say to them \u2014 in your words, your way. Nicknames, jokes, whatever feels right. Any notes for the AI can go at the end (e.g. \u2018keep it warm\u2019 or \u2018we\u2019ve been friends since school\u2019)."></textarea>
                    <span class="field-tally" id="kl-message-tally"></span>
                    <button class="letter-style-btn" id="kl-style-transfer">Match Writing Style</button>
                </div>
            </div>`;

        letterMarkup += `
            <div class="letter-verse">
                <span class="letter-signoff">Written in the stars \u2014 sealed with light.</span>
            </div>`;

        letterMarkup += isRecipientView ? `
            <div class="letter-verse">
                <div class="letter-closing">
                    <button class="letter-action letter-action-primary" id="kl-export-card">Export Story Card</button>
                    <a class="letter-action letter-action-secondary" href="/">Make One For Someone Else</a>
                </div>
            </div>` : `
            <div class="letter-verse">
                <div class="letter-closing">
                    <button class="letter-action letter-action-primary" id="kl-share-link">Copy Gift Link</button>
                    <button class="letter-action letter-action-secondary" id="kl-export-card">Export Story Card</button>
                </div>
            </div>`;

        rootContainer.innerHTML = `
            <div class="letter-stage">
                ${envelopeMarkup}
                <div class="letter-parchment">${letterMarkup}</div>
            </div>`;

        if (isRecipientView) {
            const storedName = (gift.recipientName || '').trim();
            rootContainer.querySelector('#kl-name-rendered').textContent = storedName || 'someone special';
            rootContainer.querySelector('#kl-narrative-readonly').textContent =
                // Preferring the stored narrative on a recipient page, since the giver may have edited or rewritten it before sending
                gift.narrative || initialNarrative;

            const messagePanel = rootContainer.querySelector('#kl-message-panel');
            const storedMessage = (gift.message || '').trim();
            if (storedMessage) {
                messagePanel.querySelector('#kl-message-readonly').textContent = storedMessage;
            } else {
                messagePanel.closest('.letter-verse').remove();
            }
        }

        const stageNode = rootContainer.querySelector('.letter-stage');
        const sealNode = rootContainer.querySelector('#kl-seal');

        requestAnimationFrame(() => {
            stageNode.classList.add('stage-ready');
        });

        // Holding the page still while the envelope is closed, since the letter is already laid out behind it and would otherwise scroll away into empty sky
        document.body.classList.add('letter-sealed');

        let envelopeOpened = false;

        // Firing the opening once and detaching, so a second tap during the animation cannot restart it halfway through
        function handleSealActivation() {
            if (envelopeOpened) return;
            envelopeOpened = true;
            initiateEnvelopeOpening(stageNode, rootContainer);
        }

        sealNode.addEventListener('click', handleSealActivation);

        sealNode.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleSealActivation();
            }
        });

        // Fading each photograph in on its own load event, since the letter body is revealed as a whole once the envelope opens
        function attachImageLoadState(imgId) {
            const img = rootContainer.querySelector(`#${imgId}`);
            if (!img) return;
            if (img.complete && img.naturalWidth > 0) {
                img.classList.add('kl-img-loaded');
            } else {
                img.addEventListener('load', () => img.classList.add('kl-img-loaded'));
            }
        }

        bindProxyFallbacks(rootContainer);
        attachImageLoadState('kl-apod-hero');
        attachImageLoadState('kl-epic-hero');

        function bindHeroPicker(sourceId, candidates) {
            const carousel = rootContainer.querySelector(`#kl-${sourceId}-carousel`);
            if (!carousel) return;

            const thumbs = carousel.querySelectorAll('.letter-thumb');
            const heroImg = rootContainer.querySelector(`#kl-${sourceId}-hero`);
            const titleEl = rootContainer.querySelector(`#kl-${sourceId}-title`);
            const captionEl = rootContainer.querySelector(`#kl-${sourceId}-caption`);

            thumbs.forEach(node => {
                node.addEventListener('click', () => {
                    const idx = parseInt(node.getAttribute('data-idx'), 10);
                    const chosen = candidates[idx];
                    if (!chosen) return;

                    thumbs.forEach(n => n.classList.remove('letter-thumb-active'));
                    node.classList.add('letter-thumb-active');

                    if (heroImg) {
                        heroImg.classList.remove('kl-img-loaded');
                        setTimeout(() => {
                            applyHeroImageSource(heroImg, chosen);
                            heroImg.alt = chosen.title;
                            heroImg.addEventListener('load', () => heroImg.classList.add('kl-img-loaded'), { once: true });
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

        // Leaving the solar passage dormant until the giver opts in, because a flare from a neighbouring year is a weaker claim than one from the birthday itself
        function activateDonkiZone(defaultEntry) {
            const zone = rootContainer.querySelector('#kl-donki-zone');
            if (!zone) return;

            zone.innerHTML =
                buildDonkiFeaturedMarkup(defaultEntry, birthYear, monthDayText) +
                buildDonkiPickerMarkup(donkiUniqueByYear, defaultEntry);
            zone.style.display = '';

            activeSelections.donki = { ...defaultEntry };
            activeSelections.donkiOptedIn = true;
            refreshNarrative();
            bindDonkiPicker();
        }

        // Rebinding after the passage is rendered, because the solar passage does not exist in the document until the giver opts in
        function bindDonkiPicker() {
            const picks = rootContainer.querySelector('#kl-donki-picks');
            if (!picks) return;

            picks.querySelectorAll('.letter-pick').forEach(node => {
                node.addEventListener('click', () => {
                    const idx = parseInt(node.getAttribute('data-idx'), 10);
                    const chosen = donkiUniqueByYear[idx];
                    if (!chosen) return;

                    picks.querySelectorAll('.letter-pick').forEach(n => n.classList.remove('letter-pick-active'));
                    node.classList.add('letter-pick-active');

                    const featuredEl = rootContainer.querySelector('#kl-donki-featured');
                    if (featuredEl) {
                        featuredEl.outerHTML = buildDonkiFeaturedMarkup(chosen, birthYear, monthDayText);
                    }

                    activeSelections.donki = { ...chosen };
                    refreshNarrative();
                });
            });
        }

        const donkiOptIn = rootContainer.querySelector('#kl-donki-opt-in');
        if (donkiOptIn && donkiDefault) {
            donkiOptIn.addEventListener('click', () => {
                const dormant = rootContainer.querySelector('#kl-donki-dormant');
                if (dormant) dormant.style.display = 'none';
                activateDonkiZone(donkiDefault);
            });
        }
        if (donkiExactYearMatch) bindDonkiPicker();

        function activateExoplanetZone(defaultPickerEntry) {
            const zone = rootContainer.querySelector('#kl-exoplanet-zone');
            if (!zone) return;

            zone.innerHTML =
                buildExoplanetFeaturedMarkup(defaultPickerEntry.planet, defaultPickerEntry.year, birthYear) +
                buildExoplanetPickerMarkup(exoplanetPickerEntries, defaultPickerEntry.year);
            zone.style.display = '';

            activeSelections.exoplanet = {
                ...defaultPickerEntry.planet,
                discoveryYear: defaultPickerEntry.year
            };
            activeSelections.exoplanetOptedIn = true;
            refreshNarrative();
            bindExoplanetPicker();
        }

        // Rebinding after the passage is rendered, on the same terms as the solar picker above
        function bindExoplanetPicker() {
            const picks = rootContainer.querySelector('#kl-exoplanet-picks');
            if (!picks) return;

            picks.querySelectorAll('.letter-pick').forEach(node => {
                node.addEventListener('click', () => {
                    const idx = parseInt(node.getAttribute('data-idx'), 10);
                    const chosen = exoplanetPickerEntries[idx];
                    if (!chosen) return;

                    picks.querySelectorAll('.letter-pick').forEach(n => n.classList.remove('letter-pick-active'));
                    node.classList.add('letter-pick-active');

                    const featuredEl = rootContainer.querySelector('#kl-exoplanet-featured');
                    if (featuredEl) {
                        featuredEl.outerHTML = buildExoplanetFeaturedMarkup(chosen.planet, chosen.year, birthYear);
                    }

                    activeSelections.exoplanet = {
                        ...chosen.planet,
                        discoveryYear: chosen.year
                    };
                    refreshNarrative();
                });
            });
        }

        const exoplanetOptIn = rootContainer.querySelector('#kl-exoplanet-opt-in');
        if (exoplanetOptIn && exoplanetDefaultEntry) {
            exoplanetOptIn.addEventListener('click', () => {
                const dormant = rootContainer.querySelector('#kl-exoplanet-dormant');
                if (dormant) dormant.style.display = 'none';
                activateExoplanetZone(exoplanetDefaultEntry);
            });
        }
        if (exoplanetHasExactYear && exoplanetDefaultEntry) bindExoplanetPicker();

        const nameInput = rootContainer.querySelector('#kl-recipient-name');
        const letterHeading = rootContainer.querySelector('.letter-heading');
        const envelopeAddress = rootContainer.querySelector('.envelope-address');
        if (nameInput) {
            nameInput.addEventListener('input', () => {
                const name = nameInput.value.trim();
                if (letterHeading) {
                    letterHeading.textContent = name
                        ? `The Universe on the Day ${name} Arrived`
                        : 'The Universe on the Day You Arrived';
                }
                if (envelopeAddress) {
                    envelopeAddress.textContent = name || 'Someone Special';
                }
            });
        }

        const styleBtn = rootContainer.querySelector('#kl-style-transfer');
        const sampleInput = rootContainer.querySelector('#kl-writing-sample');
        const narrativeField = rootContainer.querySelector('#kl-narrative-text');
        const messageTally = rootContainer.querySelector('#kl-message-tally');

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

        const shareLinkBtn = rootContainer.querySelector('#kl-share-link');
        if (shareLinkBtn && narrativeField) {
            shareLinkBtn.addEventListener('click', () => {
                // Catching at the boundary so an unexpected fault resets the control rather than stranding it mid-generation
                createGiftLink().catch(() => restoreShareButton(shareLinkBtn, 'Failed \u2014 Try Again'));
            });

            async function createGiftLink() {
                const recipientName = (rootContainer.querySelector('#kl-recipient-name') || {}).value || '';

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
                    (rootContainer.querySelector('#kl-writing-sample') || {}).value || ''
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
                            template: 'keepsake-letter',
                            chosenApodYear: activeSelections.apod ? activeSelections.apod.year : null,
                            chosenEpicYear: activeSelections.epic ? activeSelections.epic.year : null,
                            donkiOptedIn: activeSelections.donkiOptedIn,
                            chosenDonkiDate: donkiDate,
                            exoplanetOptedIn: activeSelections.exoplanetOptedIn,
                            chosenExoplanetYear: activeSelections.exoplanet
                                ? activeSelections.exoplanet.discoveryYear
                                : null,
                            styledNarrative: narrativeField.value,
                            personalMessage: (rootContainer.querySelector('#kl-writing-sample') || {}).value || '',
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

    window.SkywrittenTemplates.keepsakeLetter = {
        mount: mountKeepsakeLetter
    };
})();
