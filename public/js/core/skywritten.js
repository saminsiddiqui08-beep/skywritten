(function () {
    const EARTH_ORBITAL_SPEED_KM_S = 29.78;
    const SOLAR_SYSTEM_GALACTIC_SPEED_KM_S = 230;
    const LUNAR_CYCLE_DAYS = 29.53058770576;
    const TROPICAL_YEAR_DAYS = 365.242189;
    const EARLIEST_SELECTABLE_YEAR = 1900;

    // Deriving the ceiling at load rather than hardcoding it, so the field admits next year's births forever instead of quietly expiring on a fixed date
    function computeLatestSelectableYear() {
        return new Date().getUTCFullYear() + 1;
    }

    function parseUtcDate(rawDateString) {
        if (!rawDateString) return null;
        const parts = rawDateString.trim().split('-').map(Number);
        if (parts.length === 3 && !parts.some(isNaN)) {
            const [y, m, d] = parts;
            if (m < 1 || m > 12 || d < 1 || d > 31) return null;

            // Rejecting a day that Date.UTC quietly rolled into the following month, so 1990-02-31 fails outright instead of producing a biography for the third of March
            const candidate = new Date(Date.UTC(y, m - 1, d));
            return candidate.getUTCDate() === d ? candidate : null;
        }
        return null;
    }

    // Anchoring to the new moon of 6 January 2000, the conventional epoch for mean synodic phase arithmetic
    function computeLunarPhase(targetDate) {
        const referenceNewMoon = new Date(Date.UTC(2000, 0, 6, 18, 14, 0)).getTime();
        const targetTime = targetDate.getTime();
        const diffMs = targetTime - referenceNewMoon;
        const daysSince = diffMs / (1000 * 60 * 60 * 24);
        const cycles = daysSince / LUNAR_CYCLE_DAYS;
        const phaseProgress = cycles - Math.floor(cycles);
        const ageInDays = phaseProgress * LUNAR_CYCLE_DAYS;

        let phaseDescriptor = "";
        if (phaseProgress < 0.03 || phaseProgress > 0.97) phaseDescriptor = "New Moon";
        else if (phaseProgress < 0.22) phaseDescriptor = "Waxing Crescent";
        else if (phaseProgress < 0.28) phaseDescriptor = "First Quarter";
        else if (phaseProgress < 0.47) phaseDescriptor = "Waxing Gibbous";
        else if (phaseProgress < 0.53) phaseDescriptor = "Full Moon";
        else if (phaseProgress < 0.72) phaseDescriptor = "Waning Gibbous";
        else if (phaseProgress < 0.78) phaseDescriptor = "Last Quarter";
        else phaseDescriptor = "Waning Crescent";

        return {
            age: ageInDays,
            phase: phaseDescriptor,
            illumination: (0.5 * (1 - Math.cos(phaseProgress * 2 * Math.PI))) * 100
        };
    }

    function computeCosmicDisplacement(birthDate) {
        const now = new Date();
        const secondsAlive = (now.getTime() - birthDate.getTime()) / 1000;
        if (secondsAlive < 0) return 0;

        const earthDistance = secondsAlive * EARTH_ORBITAL_SPEED_KM_S;
        const solarDistance = secondsAlive * SOLAR_SYSTEM_GALACTIC_SPEED_KM_S;

        // Combining the two velocities in quadrature rather than adding them, since Earth's orbital motion reverses direction relative to the Sun's galactic track and a straight sum would overstate the total
        return Math.floor(Math.sqrt(Math.pow(earthDistance, 2) + Math.pow(solarDistance, 2)));
    }

    function computeZodiacAndWeekday(targetDate) {
        const month = targetDate.getUTCMonth() + 1;
        const day = targetDate.getUTCDate();
        const weekday = targetDate.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });

        // Defaulting to Capricorn, the only sign that straddles the year boundary and therefore cannot be expressed as a single month range below
        let sign = "Capricorn";
        if ((month === 1 && day >= 20) || (month === 2 && day <= 18)) sign = "Aquarius";
        else if ((month === 2 && day >= 19) || (month === 3 && day <= 20)) sign = "Pisces";
        else if ((month === 3 && day >= 21) || (month === 4 && day <= 19)) sign = "Aries";
        else if ((month === 4 && day >= 20) || (month === 5 && day <= 20)) sign = "Taurus";
        else if ((month === 5 && day >= 21) || (month === 6 && day <= 20)) sign = "Gemini";
        else if ((month === 6 && day >= 21) || (month === 7 && day <= 22)) sign = "Cancer";
        else if ((month === 7 && day >= 23) || (month === 8 && day <= 22)) sign = "Leo";
        else if ((month === 8 && day >= 23) || (month === 9 && day <= 22)) sign = "Virgo";
        else if ((month === 9 && day >= 23) || (month === 10 && day <= 22)) sign = "Libra";
        else if ((month === 10 && day >= 23) || (month === 11 && day <= 21)) sign = "Scorpio";
        else if ((month === 11 && day >= 22) || (month === 12 && day <= 21)) sign = "Sagittarius";

        return { sign, weekday };
    }

    function computeOrbitalStats(birthDate) {
        const now = new Date();
        const diffMs = now.getTime() - birthDate.getTime();
        const daysAlive = diffMs / (1000 * 60 * 60 * 24);

        if (daysAlive < 0) return { orbits: "0.00", daysAlive: 0 };

        return {
            orbits: (daysAlive / TROPICAL_YEAR_DAYS).toFixed(2),
            daysAlive: Math.floor(daysAlive)
        };
    }

    function assemblePayload(rawDateString, templateSlug) {
        const parsedTargetDate = parseUtcDate(rawDateString);
        if (!parsedTargetDate) return null;

        return {
            targetDate: rawDateString,
            parsedDate: parsedTargetDate,
            recipientName: '',
            template: templateSlug || 'cosmic-scroll',
            lunar: computeLunarPhase(parsedTargetDate),
            displacement: computeCosmicDisplacement(parsedTargetDate),
            astro: computeZodiacAndWeekday(parsedTargetDate),
            orbital: computeOrbitalStats(parsedTargetDate)
        };
    }

    window.SkywrittenMath = {
        parseUtcDate,
        computeLunarPhase,
        computeCosmicDisplacement,
        computeZodiacAndWeekday,
        computeOrbitalStats,
        assemblePayload
    };

    document.addEventListener('DOMContentLoaded', () => {
        const ingestForm = document.getElementById('date-ingest');
        const coreUI = document.getElementById('app-core');
        const dateInput = document.getElementById('target-date');
        const recipientInput = document.getElementById('recipient-name') || document.getElementById('target-name');
        const templateInput = document.getElementById('template-select');

        if (dateInput) {
            dateInput.min = `${EARLIEST_SELECTABLE_YEAR}-01-01`;
            dateInput.max = `${computeLatestSelectableYear()}-12-31`;
        }

        function triggerAnomalyState() {
            if (!dateInput) return;

            // Killing the transition before the colour flip so the rejection reads as an immediate snap rather than a slow fade into red
            dateInput.style.transition = 'none';
            dateInput.style.color = '#ff3333';
            dateInput.style.borderColor = '#ff3333';

            const keyframes = [
                { transform: 'translateX(0)' },
                { transform: 'translateX(-8px)' },
                { transform: 'translateX(8px)' },
                { transform: 'translateX(-8px)' },
                { transform: 'translateX(0)' }
            ];

            dateInput.animate(keyframes, { duration: 300, easing: 'ease-in-out' });

            setTimeout(() => {
                dateInput.style.transition = 'border-color 0.3s ease, color 0.3s ease';
                dateInput.style.color = 'var(--color-starlight)';
                dateInput.style.borderColor = 'var(--color-nebula-dim)';
            }, 1500);
        }

        function initiateRevealSequence(event) {
            event.preventDefault();

            if (!dateInput) return;
            const rawDateString = dateInput.value ? dateInput.value.trim() : '';
            if (!rawDateString) {
                triggerAnomalyState();
                return;
            }

            const parsedTargetDate = parseUtcDate(rawDateString);
            if (!parsedTargetDate) {
                triggerAnomalyState();
                return;
            }

            const targetYear = parsedTargetDate.getUTCFullYear();
            if (targetYear < EARLIEST_SELECTABLE_YEAR || targetYear > computeLatestSelectableYear()) {
                triggerAnomalyState();
                return;
            }

            // Reseeding from the raw date string so the field the giver sees is the same one the recipient's page will generate
            if (window.SkywrittenStarfield && window.SkywrittenStarfield.boot) {
                window.SkywrittenStarfield.boot(rawDateString);
            }

            const payload = assemblePayload(
                rawDateString,
                templateInput ? templateInput.value : 'cosmic-scroll'
            );
            payload.recipientName = recipientInput ? recipientInput.value.trim() : '';

            if (coreUI) {
                coreUI.style.transition = 'opacity 0.6s ease-out';
                coreUI.style.opacity = '0';
                coreUI.style.pointerEvents = 'none';
            }

            setTimeout(() => {
                if (window.SkywrittenRouter && window.SkywrittenRouter.dispatch) {
                    window.SkywrittenRouter.dispatch(payload);
                    return;
                }

                // Bringing the entry panel back when a template script never arrived, so a dropped connection leaves something to retry rather than an empty sky
                if (coreUI) {
                    coreUI.style.opacity = '1';
                    coreUI.style.pointerEvents = '';
                }
                triggerAnomalyState();
            }, 600);
        }

        if (ingestForm) {
            ingestForm.addEventListener('submit', initiateRevealSequence);
        }
    });
})();
