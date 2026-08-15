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
    const HERO_LAYOUT_SIZES = '(max-width: 760px) calc(100vw - 48px), 720px';
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

    function buildHeroSectionMarkup(sourceLabel, sourceId, defaultEntry, birthYear, monthDayText) {
        const caption = composeHeroCaption(defaultEntry.year, birthYear, monthDayText);

        return `
            <div class="hero-viewport reveal-node" id="${sourceId}-hero-viewport">
                <span class="hero-source-label">${sourceLabel}</span>
                <div class="hero-image-frame">
                    <img id="${sourceId}-hero-img" ${composeHeroImageAttributes(defaultEntry)} data-origin-src="${escapeMarkup(defaultEntry.url)}" alt="${escapeMarkup(defaultEntry.title)}"
                         loading="${sourceId === 'apod' ? 'eager' : 'lazy'}" fetchpriority="${sourceId === 'apod' ? 'high' : 'low'}" decoding="async">
                </div>
                <div class="hero-meta-strip">
                    <div class="hero-title-text" id="${sourceId}-title-display">${escapeMarkup(resolveHeroDisplayTitle(sourceId, defaultEntry.title))}</div>
                    <div class="hero-attribution" id="${sourceId}-caption-display">${caption}</div>
                </div>
            </div>`;
    }

    function buildPickerStripMarkup(sourceId, candidates, defaultEntry) {
        if (candidates.length <= 1) return '';

        return `
            <div class="picker-section reveal-node" id="${sourceId}-picker-section">
                <span class="picker-label">Alternate Captures</span>
                <div class="picker-carousel" id="${sourceId}-thumb-carousel">
                    ${candidates.map((item, idx) => `
                        <div class="thumb-node ${item.year === defaultEntry.year ? 'thumb-selected' : ''}"
                             data-source="${sourceId}" data-idx="${idx}">
                            <img src="${resolveThumbnailSource(item)}" data-origin-src="${escapeMarkup(item.url)}" alt="${escapeMarkup(item.title)}" loading="lazy" decoding="async">
                            <span class="thumb-year-tag">${item.year}</span>
                        </div>`).join('')}
                </div>
            </div>`;
    }

    function buildDonkiFeaturedMarkup(entry, birthYear, monthDayText) {
        const caption = composeSolarEventCaption(entry.year, birthYear, monthDayText);
        const peakDisplay = formatFlarePeakTime(entry.peakTime);
        const sourceRegion = entry.sourceLocation || 'Region not recorded';

        return `
            <div class="enrichment-featured" id="donki-featured">
                <span class="featured-class-indicator">${escapeMarkup(entry.classType)}</span>
                <span class="featured-attribution">${caption}</span>
                <div class="featured-detail-row">
                    <span class="detail-fragment">Peak: ${peakDisplay}</span>
                    <span class="detail-fragment">Source: ${escapeMarkup(sourceRegion)}</span>
                </div>
            </div>`;
    }

    function buildDonkiPickerMarkup(uniqueEntries, defaultEntry) {
        if (uniqueEntries.length <= 1) return '';

        return `
            <div class="enrichment-picker-strip" id="donki-picker-strip">
                ${uniqueEntries.map((entry, idx) => `
                    <div class="enrichment-pick-node ${entry.year === defaultEntry.year ? 'enrichment-pick-selected' : ''}"
                         data-source="donki" data-idx="${idx}">
                        <span class="pick-class-badge">${escapeMarkup(entry.classType)}</span>
                        <span class="pick-year-tag">${entry.year}</span>
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
            <div class="enrichment-featured" id="exoplanet-featured">
                <span class="featured-planet-name">${escapeMarkup(planet.name)}</span>
                ${planet.hostStar ? `<span class="featured-host-star">orbiting ${escapeMarkup(planet.hostStar)}</span>` : ''}
                <span class="featured-attribution">${caption}</span>
                ${detailFragments.length > 0 ? `
                    <div class="featured-detail-row">
                        ${detailFragments.map(d => `<span class="detail-fragment">${d}</span>`).join('')}
                    </div>` : ''}
            </div>`;
    }

    function buildExoplanetPickerMarkup(pickerEntries, defaultYear) {
        if (pickerEntries.length <= 1) return '';

        return `
            <div class="enrichment-picker-strip" id="exoplanet-picker-strip">
                ${pickerEntries.map((entry, idx) => `
                    <div class="enrichment-pick-node ${entry.year === defaultYear ? 'enrichment-pick-selected' : ''}"
                         data-source="exoplanet" data-idx="${idx}">
                        <span class="pick-planet-badge">${escapeMarkup(entry.planet.name)}</span>
                        <span class="pick-year-tag">${entry.year}</span>
                    </div>`).join('')}
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

    async function mountCosmicScroll(rootContainer, payload) {
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
        const exoplanetBirthYearPlanets = catalogs.exoplanet[birthYearKey] || [];
        const exoplanetHasExactYear = exoplanetBirthYearPlanets.length > 0;
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
            const narrativeField = rootContainer.querySelector('#narrative-text');
            if (narrativeField) {
                narrativeField.value = synthesizeNarrative(payload, activeSelections);
                window.SkywrittenFields.resizeToContent(narrativeField);
            }
        }

        let stageMarkup = '';

        stageMarkup += `
            <header class="cosmic-header-panel reveal-node">
                <span class="date-badge">${fullDateDisplay}</span>
                <h2 class="cosmic-headline">Universe Biography</h2>
                ${isRecipientView ? '' : `
                <div class="recipient-field">
                    <input type="text" id="recipient-name-input" class="recipient-name-input"
                           placeholder="Who is this for?" autocomplete="off" spellcheck="false">
                </div>`}
            </header>`;

        stageMarkup += buildHeroSectionMarkup('The Sky', 'apod', apodDefault, birthYear, monthDayText);
        if (!isRecipientView) {
            stageMarkup += buildPickerStripMarkup('apod', apodCandidates, apodDefault);
        }

        if (epicDefault) {
            stageMarkup += buildHeroSectionMarkup('The Earth', 'epic', epicDefault, birthYear, monthDayText);
            if (!isRecipientView) {
                stageMarkup += buildPickerStripMarkup('epic', epicCandidates, epicDefault);
            }
        }

        if (donkiHasAnyData && (donkiFeatured || !isRecipientView)) {
            stageMarkup += `<div class="enrichment-panel reveal-node" id="donki-panel">`;
            stageMarkup += `<span class="enrichment-section-label">Solar Activity</span>`;

            if (donkiFeatured) {
                stageMarkup += `<div class="enrichment-active-zone" id="donki-active-zone">`;
                stageMarkup += buildDonkiFeaturedMarkup(donkiFeatured, birthYear, monthDayText);
                if (!isRecipientView) {
                    stageMarkup += buildDonkiPickerMarkup(donkiUniqueByYear, donkiFeatured);
                }
                stageMarkup += `</div>`;
            } else {
                stageMarkup += `
                    <div class="enrichment-dormant" id="donki-dormant">
                        <p class="enrichment-toggle-prompt">
                            No significant solar flares were recorded on your exact birthdate in ${birthYear}.
                        </p>
                        <button class="enrichment-opt-in-btn" id="donki-opt-in-trigger">
                            Explore flares from other years
                        </button>
                    </div>
                    <div class="enrichment-active-zone" id="donki-active-zone" style="display: none;"></div>`;
            }

            stageMarkup += `</div>`;
        }

        if (exoplanetHasAnyData && (exoplanetFeatured || !isRecipientView)) {
            stageMarkup += `<div class="enrichment-panel reveal-node" id="exoplanet-panel">`;
            stageMarkup += `<span class="enrichment-section-label">Exoplanet Discoveries</span>`;

            if (exoplanetFeatured) {
                stageMarkup += `<div class="enrichment-active-zone" id="exoplanet-active-zone">`;
                stageMarkup += buildExoplanetFeaturedMarkup(
                    exoplanetFeatured.planet, exoplanetFeatured.year, birthYear
                );
                if (!isRecipientView) {
                    stageMarkup += buildExoplanetPickerMarkup(exoplanetPickerEntries, exoplanetFeatured.year);
                }
                stageMarkup += `</div>`;
            } else if (exoplanetDefaultEntry) {
                stageMarkup += `
                    <div class="enrichment-dormant" id="exoplanet-dormant">
                        <p class="enrichment-toggle-prompt">
                            No exoplanet discoveries were confirmed in ${birthYear}.
                        </p>
                        <button class="enrichment-opt-in-btn" id="exoplanet-opt-in-trigger">
                            Explore discoveries from nearby years
                        </button>
                    </div>
                    <div class="enrichment-active-zone" id="exoplanet-active-zone" style="display: none;"></div>`;
            }

            stageMarkup += `</div>`;
        }

        stageMarkup += `
            <div class="telemetry-grid reveal-node">
                <div class="telemetry-node">
                    <span class="telemetry-heading">Cosmic Displacement</span>
                    <span class="telemetry-value">${payload.displacement.toLocaleString()} km</span>
                    <span class="telemetry-detail">Distance traveled through space since birth</span>
                </div>
                <div class="telemetry-node">
                    <span class="telemetry-heading">Lunar Phase</span>
                    <span class="telemetry-value">${payload.lunar.phase}</span>
                    <span class="telemetry-detail">${payload.lunar.illumination.toFixed(1)}% illumination \u00B7 ${payload.lunar.age.toFixed(1)} days old</span>
                </div>
                <div class="telemetry-node">
                    <span class="telemetry-heading">Solar Revolutions</span>
                    <span class="telemetry-value">${payload.orbital.orbits} Orbits</span>
                    <span class="telemetry-detail">${payload.orbital.daysAlive.toLocaleString()} total days aboard Earth</span>
                </div>
                <div class="telemetry-node">
                    <span class="telemetry-heading">Stellar Alignment</span>
                    <span class="telemetry-value">${payload.astro.sign}</span>
                    <span class="telemetry-detail">Born on a ${payload.astro.weekday}</span>
                </div>
            </div>`;

        const initialNarrative = synthesizeNarrative(payload, activeSelections);

        stageMarkup += isRecipientView ? `
            <div class="narrative-stage reveal-node">
                <p class="narrative-readonly" id="narrative-readonly"></p>
            </div>` : `
            <div class="narrative-stage reveal-node">
                <textarea class="narrative-output" id="narrative-text" rows="6">${escapeMarkup(initialNarrative)}</textarea>
            </div>`;

        if (isRecipientView) {
            stageMarkup += `
            <div class="personal-message-panel reveal-node" id="personal-message-panel">
                <span class="personal-message-mark">\u2726</span>
                <p class="personal-message-body" id="personal-message-readonly"></p>
            </div>`;
        } else {
            stageMarkup += `
            <div class="style-transform-block reveal-node">
                <span class="style-block-label">Your Message</span>
                <textarea class="style-input-field" id="writing-sample-input"
                          placeholder="Say what you\u2019d say to them \u2014 in your words, your way. Nicknames, jokes, whatever feels right. Any notes for the AI can go at the end (e.g. \u2018keep it warm\u2019 or \u2018we\u2019ve been friends since school\u2019)."></textarea>
                <span class="field-tally" id="cs-message-tally"></span>
                <button class="transform-action-btn" id="trigger-style-transfer">Match Writing Style</button>
            </div>`;
        }

        stageMarkup += isRecipientView ? `
            <div class="action-bar-footer reveal-node">
                <button class="action-trigger action-primary" id="export-card-btn">Export Story Card</button>
                <a class="action-trigger action-secondary" href="/">Make One For Someone Else</a>
            </div>` : `
            <div class="action-bar-footer reveal-node">
                <button class="action-trigger action-primary" id="finalize-share-btn">Copy Gift Link</button>
                <button class="action-trigger action-secondary" id="export-card-btn">Export Story Card</button>
            </div>`;

        rootContainer.innerHTML = `<div class="cosmic-stage">${stageMarkup}</div>`;

        if (isRecipientView) {
            const storedName = (gift.recipientName || '').trim();
            if (storedName) {
                rootContainer.querySelector('.cosmic-headline').textContent =
                    `${storedName}\u2019s Universe Biography`;
            }

            rootContainer.querySelector('#narrative-readonly').textContent =
                // Preferring the stored narrative on a recipient page, since the giver may have edited or rewritten it before sending
                gift.narrative || initialNarrative;

            const messagePanel = rootContainer.querySelector('#personal-message-panel');
            const storedMessage = (gift.message || '').trim();
            if (storedMessage) {
                messagePanel.querySelector('#personal-message-readonly').textContent = storedMessage;
            } else {
                messagePanel.remove();
            }
        }

        const stageNode = rootContainer.querySelector('.cosmic-stage');
        requestAnimationFrame(() => {
            stageNode.classList.add('stage-ready');
        });

        // Fading each capture in on its own load event, since a scroll template shows several heroes and a single shared handler would flash the later ones
        function attachImageLoadDetection(imgId) {
            const img = rootContainer.querySelector(`#${imgId}`);
            if (!img) return;
            if (img.complete && img.naturalWidth > 0) {
                img.classList.add('img-loaded');
            } else {
                img.addEventListener('load', () => img.classList.add('img-loaded'));
            }
        }

        bindProxyFallbacks(rootContainer);
        attachImageLoadDetection('apod-hero-img');
        attachImageLoadDetection('epic-hero-img');

        // Reading the chosen capture out of the closure, so tapping an alternate year is a source swap with no further network request
        function bindHeroPicker(sourceId, candidates) {
            const carousel = rootContainer.querySelector(`#${sourceId}-thumb-carousel`);
            if (!carousel) return;

            const thumbNodes = carousel.querySelectorAll('.thumb-node');
            const heroImg = rootContainer.querySelector(`#${sourceId}-hero-img`);
            const titleDisplay = rootContainer.querySelector(`#${sourceId}-title-display`);
            const captionDisplay = rootContainer.querySelector(`#${sourceId}-caption-display`);

            thumbNodes.forEach(node => {
                node.addEventListener('click', () => {
                    const idx = parseInt(node.getAttribute('data-idx'), 10);
                    const chosen = candidates[idx];
                    if (!chosen) return;

                    thumbNodes.forEach(n => n.classList.remove('thumb-selected'));
                    node.classList.add('thumb-selected');

                    if (heroImg) {
                        heroImg.classList.remove('img-loaded');
                        setTimeout(() => {
                            applyHeroImageSource(heroImg, chosen);
                            heroImg.alt = chosen.title;
                            heroImg.addEventListener('load', () => heroImg.classList.add('img-loaded'), { once: true });
                        }, 200);
                    }

                    if (titleDisplay) titleDisplay.textContent = resolveHeroDisplayTitle(sourceId, chosen.title);
                    if (captionDisplay) {
                        captionDisplay.textContent = composeHeroCaption(chosen.year, birthYear, monthDayText);
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

        // Leaving the solar section dormant until the giver opts in, because a flare from a neighbouring year is a weaker claim than one from the birthday itself
        function activateDonkiZone(defaultEntry) {
            const activeZone = rootContainer.querySelector('#donki-active-zone');
            if (!activeZone) return;

            activeZone.innerHTML =
                buildDonkiFeaturedMarkup(defaultEntry, birthYear, monthDayText) +
                buildDonkiPickerMarkup(donkiUniqueByYear, defaultEntry);
            activeZone.style.display = '';

            activeSelections.donki = { ...defaultEntry };
            activeSelections.donkiOptedIn = true;
            refreshNarrative();
            bindDonkiPicker();
        }

        function bindDonkiPicker() {
            const pickerStrip = rootContainer.querySelector('#donki-picker-strip');
            if (!pickerStrip) return;

            pickerStrip.querySelectorAll('.enrichment-pick-node').forEach(node => {
                node.addEventListener('click', () => {
                    const idx = parseInt(node.getAttribute('data-idx'), 10);
                    const chosen = donkiUniqueByYear[idx];
                    if (!chosen) return;

                    pickerStrip.querySelectorAll('.enrichment-pick-node').forEach(n =>
                        n.classList.remove('enrichment-pick-selected')
                    );
                    node.classList.add('enrichment-pick-selected');

                    const featuredEl = rootContainer.querySelector('#donki-featured');
                    if (featuredEl) {
                        featuredEl.outerHTML = buildDonkiFeaturedMarkup(chosen, birthYear, monthDayText);
                    }

                    activeSelections.donki = { ...chosen };
                    refreshNarrative();
                });
            });
        }

        const donkiOptInTrigger = rootContainer.querySelector('#donki-opt-in-trigger');
        if (donkiOptInTrigger && donkiDefault) {
            // Rendering the solar section only once the giver accepts it, so an unaccepted section costs nothing in the final page
            donkiOptInTrigger.addEventListener('click', () => {
                const dormantEl = rootContainer.querySelector('#donki-dormant');
                if (dormantEl) dormantEl.style.display = 'none';
                activateDonkiZone(donkiDefault);
            });
        }

        if (donkiExactYearMatch) {
            bindDonkiPicker();
        }

        function activateExoplanetZone(defaultPickerEntry) {
            const activeZone = rootContainer.querySelector('#exoplanet-active-zone');
            if (!activeZone) return;

            activeZone.innerHTML =
                buildExoplanetFeaturedMarkup(defaultPickerEntry.planet, defaultPickerEntry.year, birthYear) +
                buildExoplanetPickerMarkup(exoplanetPickerEntries, defaultPickerEntry.year);
            activeZone.style.display = '';

            activeSelections.exoplanet = {
                ...defaultPickerEntry.planet,
                discoveryYear: defaultPickerEntry.year
            };
            activeSelections.exoplanetOptedIn = true;
            refreshNarrative();
            bindExoplanetPicker();
        }

        function bindExoplanetPicker() {
            const pickerStrip = rootContainer.querySelector('#exoplanet-picker-strip');
            if (!pickerStrip) return;

            pickerStrip.querySelectorAll('.enrichment-pick-node').forEach(node => {
                node.addEventListener('click', () => {
                    const idx = parseInt(node.getAttribute('data-idx'), 10);
                    const chosen = exoplanetPickerEntries[idx];
                    if (!chosen) return;

                    pickerStrip.querySelectorAll('.enrichment-pick-node').forEach(n =>
                        n.classList.remove('enrichment-pick-selected')
                    );
                    node.classList.add('enrichment-pick-selected');

                    const featuredEl = rootContainer.querySelector('#exoplanet-featured');
                    if (featuredEl) {
                        featuredEl.outerHTML = buildExoplanetFeaturedMarkup(
                            chosen.planet, chosen.year, birthYear
                        );
                    }

                    activeSelections.exoplanet = {
                        ...chosen.planet,
                        discoveryYear: chosen.year
                    };
                    refreshNarrative();
                });
            });
        }

        const exoplanetOptInTrigger = rootContainer.querySelector('#exoplanet-opt-in-trigger');
        if (exoplanetOptInTrigger && exoplanetDefaultEntry) {
            // Rendering the discovery section only once the giver accepts it, on the same terms as the solar section above
            exoplanetOptInTrigger.addEventListener('click', () => {
                const dormantEl = rootContainer.querySelector('#exoplanet-dormant');
                if (dormantEl) dormantEl.style.display = 'none';
                activateExoplanetZone(exoplanetDefaultEntry);
            });
        }

        if (exoplanetHasExactYear && exoplanetDefaultEntry) {
            bindExoplanetPicker();
        }

        const recipientNameInput = rootContainer.querySelector('#recipient-name-input');
        const cosmicHeadline = rootContainer.querySelector('.cosmic-headline');
        if (recipientNameInput && cosmicHeadline) {
            recipientNameInput.addEventListener('input', () => {
                const name = recipientNameInput.value.trim();
                cosmicHeadline.textContent = name
                    ? `${name}\u2019s Universe Biography`
                    : 'Universe Biography';
            });
        }

        // Revealing sections on intersection instead of on scroll position, which keeps the work off the scroll thread on mid-range Android
        const scrollRevealObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('node-visible');
                }
            });
        }, { threshold: 0.15 });

        rootContainer.querySelectorAll('.reveal-node').forEach(node => {
            scrollRevealObserver.observe(node);
        });

        const styleTransferBtn = rootContainer.querySelector('#trigger-style-transfer');
        const writingSampleInput = rootContainer.querySelector('#writing-sample-input');
        const narrativeOutput = rootContainer.querySelector('#narrative-text');
        const messageTally = rootContainer.querySelector('#cs-message-tally');

        window.SkywrittenFields.bindMessageField(writingSampleInput, messageTally);
        window.SkywrittenFields.bindAutoGrow(narrativeOutput);

        if (styleTransferBtn && writingSampleInput && narrativeOutput) {
            const resetStyleBtn = (label, delay) => {
                styleTransferBtn.textContent = label;
                setTimeout(() => {
                    styleTransferBtn.textContent = 'Match Writing Style';
                    styleTransferBtn.disabled = false;
                }, delay);
            };

            styleTransferBtn.addEventListener('click', async () => {
                const sampleText = writingSampleInput.value.trim();
                styleTransferBtn.disabled = true;

                if (!sampleText) {
                    resetStyleBtn('Write your message first', 2500);
                    return;
                }

                styleTransferBtn.textContent = 'Rewriting\u2026';

                try {
                    // Sending only the personal message for rewriting, never the factual narrative, so the astronomy stays accurate and the AI only touches the giver's own words
                    const response = await fetch('/api/rewrite', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            sample: sampleText,
                            baseNarrative: narrativeOutput.value,
                            targetDate: payload.targetDate,
                            draftId: draftIdentifier
                        })
                    });

                    const result = await response.json().catch(() => ({}));

                    if (response.ok && result.styledNarrative) {
                        writingSampleInput.value = result.styledNarrative;
                        window.SkywrittenFields.syncAfterProgrammaticEdit(writingSampleInput, messageTally);
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

        const shareLinkBtn = rootContainer.querySelector('#finalize-share-btn');
        if (shareLinkBtn && narrativeOutput) {
            shareLinkBtn.addEventListener('click', () => {
                // Catching at the boundary so an unexpected fault resets the control rather than stranding it mid-generation
                createGiftLink().catch(() => restoreShareButton(shareLinkBtn, 'Failed \u2014 Try Again'));
            });

            async function createGiftLink() {
                const recipientName = (rootContainer.querySelector('#recipient-name-input') || {}).value || '';

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
                    narrativeOutput.value,
                    (rootContainer.querySelector('#writing-sample-input') || {}).value || ''
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
                            template: 'cosmic-scroll',
                            chosenApodYear: activeSelections.apod ? activeSelections.apod.year : null,
                            chosenEpicYear: activeSelections.epic ? activeSelections.epic.year : null,
                            donkiOptedIn: activeSelections.donkiOptedIn,
                            chosenDonkiDate: donkiDate,
                            exoplanetOptedIn: activeSelections.exoplanetOptedIn,
                            chosenExoplanetYear: activeSelections.exoplanet
                                ? activeSelections.exoplanet.discoveryYear
                                : null,
                            styledNarrative: narrativeOutput.value,
                            personalMessage: (rootContainer.querySelector('#writing-sample-input') || {}).value || '',
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

    window.SkywrittenTemplates.cosmicScroll = {
        mount: mountCosmicScroll
    };
})();
