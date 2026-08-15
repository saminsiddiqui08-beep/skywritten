(function () {
    const templateKeyMap = {
        'cosmic-scroll': 'cosmicScroll',
        'storybook': 'storybook',
        'keepsake-letter': 'keepsakeLetter'
    };

    // Holding the mounted template and its payload so the card exporter can ask what is on screen without reaching into the templates themselves
    let activeShell = null;
    let activePayload = null;

    function dispatch(payload) {
        const rootContainer = document.getElementById('template-root');
        if (!rootContainer) return;

        rootContainer.classList.add('active-layer');

        // Clearing any body state the previous template left behind, so a scroll lock cannot survive into a template that has no way to release it
        document.body.classList.remove('letter-sealed');

        const templateSlug = payload.template || 'cosmic-scroll';
        // Falling back to the scroll template for any unrecognised slug, which keeps an old or hand-edited gift link renderable
        const registrationKey = templateKeyMap[templateSlug] || 'cosmicScroll';
        activeShell = templateSlug;
        activePayload = payload;

        const shell = window.SkywrittenTemplates && window.SkywrittenTemplates[registrationKey];

        if (shell && shell.mount) {
            shell.mount(rootContainer, payload);
        }
    }

    function getActiveShell() {
        return activeShell;
    }

    function getActivePayload() {
        return activePayload;
    }

    window.SkywrittenRouter = {
        dispatch: dispatch,
        getActiveShell: getActiveShell,
        getActivePayload: getActivePayload
    };
})();
