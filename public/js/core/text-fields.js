(function () {
    const MESSAGE_CHAR_CEILING = 600;
    const WARN_AT_CHARS = 480;

    const growingFields = new Set();
    let lastMeasuredViewportWidth = window.innerWidth;

    // Collapsing the height before measuring, because scrollHeight never reports a value smaller than the height already set
    function resizeToContent(field) {
        if (!field) return;

        // Measuring an empty field against its own placeholder, which scrollHeight otherwise ignores entirely and leaves the hint clipped mid-sentence
        const measuringPlaceholder = !field.value && field.placeholder;
        if (measuringPlaceholder) {
            field.value = field.placeholder;
        }

        field.style.height = 'auto';
        field.style.height = field.scrollHeight + 'px';

        if (measuringPlaceholder) {
            field.value = '';
        }
    }

    function resizeAllAttachedFields() {
        growingFields.forEach(function (field) {
            if (field.isConnected) {
                resizeToContent(field);
            } else {
                growingFields.delete(field);
            }
        });
    }

    function bindAutoGrow(field) {
        if (!field) return;
        field.style.overflowY = 'hidden';
        field.style.resize = 'none';
        growingFields.add(field);
        field.addEventListener('input', function () {
            resizeToContent(field);
        });
        requestAnimationFrame(function () {
            resizeToContent(field);
        });
    }

    function renderTally(tallyNode, usedChars) {
        if (!tallyNode) return;
        tallyNode.textContent = usedChars + ' / ' + MESSAGE_CHAR_CEILING + ' characters';
        tallyNode.classList.toggle('tally-warn', usedChars >= WARN_AT_CHARS && usedChars < MESSAGE_CHAR_CEILING);
        tallyNode.classList.toggle('tally-full', usedChars >= MESSAGE_CHAR_CEILING);
    }

    // Setting maxlength alongside the tally so the ceiling holds even if the counter is never rendered
    function bindMessageField(field, tallyNode) {
        if (!field) return;
        field.setAttribute('maxlength', String(MESSAGE_CHAR_CEILING));
        bindAutoGrow(field);
        renderTally(tallyNode, field.value.length);
        field.addEventListener('input', function () {
            renderTally(tallyNode, field.value.length);
        });
    }

    // Re-enforcing the ceiling after an assignment from code, which maxlength does not police
    function syncAfterProgrammaticEdit(field, tallyNode) {
        if (!field) return;
        if (field.value.length > MESSAGE_CHAR_CEILING) {
            field.value = field.value.substring(0, MESSAGE_CHAR_CEILING);
        }
        resizeToContent(field);
        renderTally(tallyNode, field.value.length);
    }

    // Ignoring height-only resizes, since a mobile address bar sliding away does not change how many lines a field needs
    window.addEventListener('resize', function () {
        if (window.innerWidth === lastMeasuredViewportWidth) return;
        lastMeasuredViewportWidth = window.innerWidth;
        resizeAllAttachedFields();
    });

    // Remeasuring once webfonts settle, because a field sized against fallback metrics ends up short by a line
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(resizeAllAttachedFields);
    }

    window.SkywrittenFields = {
        MESSAGE_CHAR_CEILING: MESSAGE_CHAR_CEILING,
        bindAutoGrow: bindAutoGrow,
        bindMessageField: bindMessageField,
        syncAfterProgrammaticEdit: syncAfterProgrammaticEdit,
        resizeToContent: resizeToContent
    };
})();
