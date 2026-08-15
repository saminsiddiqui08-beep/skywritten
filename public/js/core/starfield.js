(function () {
    const canvasSurface = document.getElementById('ambient-starfield');
    const renderContext = canvasSurface.getContext('2d', { alpha: false });

    const DEFAULT_SEED_PHRASE = 'skywritten-default-seed';
    const RESIZE_SETTLE_MS = 150;
    const MAX_PIXEL_DENSITY = 2;

    let viewportWidth = 0;
    let viewportHeight = 0;
    let astralEntities = [];
    let renderLoopId = null;
    let resizeSettleTimer = null;
    let starfieldBooted = false;
    let activeSeedPhrase = DEFAULT_SEED_PHRASE;
    let lastMeasuredViewportWidth = window.innerWidth;

    function mapViewportDimensions() {
        viewportWidth = canvasSurface.clientWidth;
        viewportHeight = canvasSurface.clientHeight;
        // Capping the backing buffer at twice the layout size, since a three times display would otherwise fill several million pixels every frame for stars a pixel wide
        const pixelDensity = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_DENSITY);

        canvasSurface.width = Math.round(viewportWidth * pixelDensity);
        canvasSurface.height = Math.round(viewportHeight * pixelDensity);
        renderContext.scale(pixelDensity, pixelDensity);
    }

    // Hashing the date into a seed so the same birthday always produces the same sky, on the giver's screen and the recipient's alike
    function computeHashSequence(inputString) {
        let block1 = 1779033703, block2 = 3144134277, block3 = 1013904242, block4 = 2773480762;
        for (let i = 0, charCode; i < inputString.length; i++) {
            charCode = inputString.charCodeAt(i);
            block1 = block2 ^ Math.imul(block1 ^ charCode, 597399067);
            block2 = block3 ^ Math.imul(block2 ^ charCode, 2869860233);
            block3 = block4 ^ Math.imul(block3 ^ charCode, 951274213);
            block4 = block1 ^ Math.imul(block4 ^ charCode, 2716044179);
        }
        block1 = Math.imul(block3 ^ (block1 >>> 18), 597399067);
        block2 = Math.imul(block4 ^ (block2 >>> 22), 2869860233);
        block3 = Math.imul(block1 ^ (block3 >>> 17), 951274213);
        block4 = Math.imul(block2 ^ (block4 >>> 19), 2716044179);
        return (block1 ^ block2 ^ block3 ^ block4) >>> 0;
    }

    // Using a seeded generator rather than Math.random, which cannot be reproduced across two devices
    function instantiateMulberry32(seed) {
        return function () {
            let t = seed += 0x6D2B79F5;
            t = Math.imul(t ^ t >>> 15, t | 1);
            t ^= t + Math.imul(t ^ t >>> 7, t | 61);
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        }
    }

    function forgeAstralMap(deterministicSeed) {
        const generator = instantiateMulberry32(deterministicSeed);
        astralEntities = [];

        const densityFactor = Math.floor((viewportWidth * viewportHeight) / 3500);

        for (let i = 0; i < densityFactor; i++) {
            astralEntities.push({
                x: generator() * viewportWidth,
                y: generator() * viewportHeight,
                radius: generator() * 1.1 + 0.4,
                luminosity: generator() * 0.7 + 0.15,
                oscillationOffset: generator() * Math.PI * 2,
                driftRate: generator() * 0.03 + 0.005
            });
        }
    }

    function executeRenderCycle(timestamp) {
        renderContext.fillStyle = '#030304';
        renderContext.fillRect(0, 0, viewportWidth, viewportHeight);

        astralEntities.forEach(entity => {
            const dynamicAlpha = entity.luminosity + Math.sin(timestamp * 0.001 * entity.driftRate + entity.oscillationOffset) * 0.15;
            const clampedAlpha = Math.max(0, Math.min(1, dynamicAlpha));

            renderContext.beginPath();
            renderContext.arc(entity.x, entity.y, entity.radius, 0, Math.PI * 2);
            renderContext.fillStyle = `rgba(244, 244, 245, ${clampedAlpha})`;
            renderContext.fill();
        });

        renderLoopId = requestAnimationFrame(executeRenderCycle);
    }

    function bootStarfield(targetDateString) {
        starfieldBooted = true;
        activeSeedPhrase = targetDateString || activeSeedPhrase;

        if (renderLoopId) {
            cancelAnimationFrame(renderLoopId);
        }

        mapViewportDimensions();
        forgeAstralMap(computeHashSequence(activeSeedPhrase));
        executeRenderCycle(0);
    }

    // Rebuilding only when the width actually changes, and only once it settles, because a scrolling mobile address bar fires this continuously
    window.addEventListener('resize', () => {
        if (!starfieldBooted) return;
        if (window.innerWidth === lastMeasuredViewportWidth) return;
        lastMeasuredViewportWidth = window.innerWidth;

        clearTimeout(resizeSettleTimer);
        resizeSettleTimer = setTimeout(() => bootStarfield(activeSeedPhrase), RESIZE_SETTLE_MS);
    });

    window.SkywrittenStarfield = {
        boot: bootStarfield
    };
})();
