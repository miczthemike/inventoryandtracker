(() => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) {
        throw new Error('Unable to initialize the dot-grid background canvas.');
    }

    canvas.className = 'dot-grid-background';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.setAttribute('role', 'presentation');
    document.body.prepend(canvas);

    const spacing = 30;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let width = 0;
    let height = 0;
    let columns = 0;
    let rows = 0;
    let animationFrame = 0;
    let lastFrameTime = 0;
    let pointer = null;
    let startTime = 0;
    let pixelRatio = 1;

    function resize() {
        pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
        width = window.innerWidth;
        height = window.innerHeight;
        columns = Math.ceil(width / spacing) + 1;
        rows = Math.ceil(height / spacing) + 1;
        canvas.width = Math.round(width * pixelRatio);
        canvas.height = Math.round(height * pixelRatio);
        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        draw(performance.now());
    }

    function draw(now) {
        context.clearRect(0, 0, width, height);
        const elapsed = reducedMotion ? 0 : (now - startTime) / 1000;
        const pointerStrength = pointer && !reducedMotion
            ? Math.max(0, 1 - (now - pointer.time) / 1200)
            : 0;

        for (let row = 0; row < rows; row += 1) {
            const y = row * spacing;
            for (let column = 0; column < columns; column += 1) {
                const x = column * spacing;
                const wave = reducedMotion
                    ? 0
                    : Math.pow((Math.sin((x + y) * 0.006 - elapsed * 0.8) + 1) / 2, 5);
                let lens = 0;
                if (pointerStrength > 0) {
                    const dx = x - pointer.x;
                    const dy = y - pointer.y;
                    lens = Math.exp(-(dx * dx + dy * dy) / 18000) * pointerStrength;
                }

                const highlight = Math.max(wave, lens * 0.9);
                const radius = 1.05 + highlight * 1.25;
                const alpha = 0.16 + highlight * 0.55;
                context.beginPath();
                context.arc(x, y, radius, 0, Math.PI * 2);
                context.fillStyle = `rgba(7, 138, 147, ${alpha})`;
                context.fill();
            }
        }
    }

    function animate(now) {
        if (document.hidden) {
            animationFrame = 0;
            return;
        }
        if (now - lastFrameTime >= 1000 / 30) {
            draw(now);
            lastFrameTime = now;
        }
        animationFrame = window.requestAnimationFrame(animate);
    }

    function startAnimation() {
        if (!reducedMotion && !document.hidden && !animationFrame) {
            startTime = performance.now();
            animationFrame = window.requestAnimationFrame(animate);
        }
    }

    window.addEventListener('resize', resize, { passive: true });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            window.cancelAnimationFrame(animationFrame);
            animationFrame = 0;
        } else {
            startAnimation();
        }
    });

    if (!reducedMotion) {
        window.addEventListener('pointermove', (event) => {
            if (event.pointerType === 'mouse' || event.pointerType === 'pen') {
                pointer = { x: event.clientX, y: event.clientY, time: performance.now() };
            }
        }, { passive: true });
        window.addEventListener('pointerleave', () => {
            pointer = null;
        }, { passive: true });
    }

    resize();
    startAnimation();
})();
