/* First-visit intro: a seed, a pine, a sunrise, and the circuit reaching its roots.
   One video carries the footage. Everything sharp is drawn here, in the video's own
   coordinates, so it stays pinned to the footage at any window shape. The video's last
   frame is the hero image, so the intro becomes the hero instead of cutting to it.
   The inline script in <head> decides whether this runs at all. */
(function () {
    var root = document.documentElement;
    var layer = document.getElementById('intro');
    if (!root.classList.contains('intro') || !layer) return;

    var phone = innerWidth <= 760;
    /* In video pixels: where the hole, ground and pine sit, and the traced roots. Roots run tip to base. */
    var G = phone ? {
        src: 'home/intro-phone.mp4', w: 720, h: 1280, pos: .5,
        hole: [353, 1066], ground: 1040,
        trunk: 'M374 1040L366 40',
        halo: [368, 560, 640],
        lanes: ['M-10 1178H78L133 1123', 'M730 1178H658L593 1113'],
        pads: [[133, 1123], [593, 1113]],
        roots: ['M133 1123L187 1110L233 1090L300 1080L350 1060L374 1044', 'M593 1113L567 1103L513 1097L467 1077L420 1060L374 1044']
    } : {
        src: 'home/intro.mp4', w: 1280, h: 720, pos: .85,
        hole: [857, 562], ground: 540,
        trunk: 'M880 540L872 26',
        halo: [876, 300, 620],
        lanes: ['M-10 668H610L690 598', 'M-10 684H728L762 650', 'M1290 664H1116L1050 598', 'M1290 684H974L945 655'],
        pads: [[690, 598], [762, 650], [1050, 598], [945, 655]],
        roots: ['M690 598L740 590L780 578L825 563L865 553L880 544', 'M762 650L780 645L815 625L830 590L850 565L880 546',
                'M1050 598L1030 583L1000 580L975 575L930 562L893 548L880 544', 'M945 655L920 645L890 620L884 580L881 546']
    };
    var SHOW_TIME = 5.7;            /* video seconds: the sunrise has landed, the circuit starts */

    var stage = layer.querySelector('.i-stage');
    var video = layer.querySelector('video');
    var seed = layer.querySelector('.i-seed');
    var halo = layer.querySelector('.i-halo');
    var svg = layer.querySelector('svg');
    var over = false, started = false, born = performance.now();
    var start = {};

    function finish(fast) {
        if (over) return;
        over = true;
        clearTimeout(guard);
        try { localStorage.setItem('lpc-intro-seen', '1'); } catch (e) { /* it plays again next time */ }
        layer.classList.add('leaving');
        if (fast) layer.style.transitionDuration = '.3s';
        root.classList.remove('intro');
        layer.style.opacity = 0;
        setTimeout(function () { video.pause(); layer.remove(); }, fast ? 320 : 950);
    }

    /* The whole frame, soil included, fills the window; the bottom stays in view */
    function frame() {
        var w = innerWidth, h = innerHeight, r = G.w / G.h;
        start.w = Math.max(w, h * r);
        start.x = (w - start.w) * G.pos;
        start.y = h - start.w / r;
        stage.style.width = start.w + 'px';
        stage.style.height = start.w / r + 'px';
        stage.style.left = start.x + 'px';
        stage.style.top = start.y + 'px';
    }

    /* The camera rises until the frame sits exactly where the hero image does */
    function rise() {
        if (over) return;
        var p = window.heroPlate(), b = 1.03, ox = innerWidth * .45, oy = innerHeight * .58;
        var w = p.iw * b, x = ox + (p.x - ox) * b, y = oy + (p.y - oy) * b;
        stage.style.transform = 'translate(' + (x - start.x) + 'px,' + (y - start.y) + 'px) scale(' + w / start.w + ')';
        setTimeout(finish, 1250);
    }

    function draw(cls, d, style) {
        var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', d);
        p.setAttribute('pathLength', 1);
        p.setAttribute('class', cls);
        p.setAttribute('style', style);
        svg.appendChild(p);
    }

    function buildCircuit() {
        svg.setAttribute('viewBox', '0 0 ' + G.w + ' ' + G.h);
        G.lanes.forEach(function (d, i) {
            var at = '--d:' + i * .12 + 's;--w:' + (.7 + i * .17) + 's;--t:1.5s';
            draw('i-under', d, at);
            draw('i-lane', d, at);
            draw('i-pulse', d, at);
        });
        G.roots.forEach(function (d, i) {
            var at = '--d:' + i * .06 + 's';
            draw('i-rootglow', d, at);
            draw('i-root', d, at);
        });
        draw('i-trunk', G.trunk, '');
        G.pads.forEach(function (p, i) {
            var c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            c.setAttribute('cx', p[0]);
            c.setAttribute('cy', p[1]);
            c.setAttribute('r', 4);
            c.setAttribute('class', 'i-pad');
            c.setAttribute('style', '--d:' + (.75 + i * .12) + 's');
            svg.appendChild(c);
        });
        halo.style.left = G.halo[0] / G.w * 100 + '%';
        halo.style.top = G.halo[1] / G.h * 100 + '%';
        halo.style.width = G.halo[2] / G.w * 100 + '%';
        seed.style.left = G.hole[0] / G.w * 100 + '%';
        seed.style.top = G.hole[1] / G.h * 100 + '%';
        layer.querySelector('.i-soil').style.top = G.ground / G.h * 100 + '%';
    }

    function watch() {
        if (over) return;
        if (video.currentTime >= SHOW_TIME || video.ended) {
            stage.classList.add('go');
            setTimeout(function () { stage.classList.add('lit'); }, 1000);
            setTimeout(rise, 1950);
            return;
        }
        requestAnimationFrame(watch);
    }

    function begin() {
        if (started || over) return;
        started = true;
        clearTimeout(wait);
        /* A beat of black with just the seed, even when the video is already cached */
        setTimeout(fall, Math.max(0, 1100 - (performance.now() - born)));
    }

    function fall() {
        if (over) return;
        layer.classList.add('fall');
        setTimeout(function () {
            if (over) return;
            layer.classList.add('landed');
            var playing = video.play();
            if (playing) playing.catch(function () { finish(true); });
            watch();
        }, 1150);
    }

    /* Never hold the page hostage: a slow, failed or blocked video just means no intro */
    var wait = setTimeout(function () { finish(true); }, 3000);
    var guard = setTimeout(function () { finish(); }, 17000);

    layer.addEventListener('click', function () { finish(true); });
    addEventListener('keydown', function (e) { if (e.key === 'Escape') finish(true); });
    addEventListener('resize', function () { if (!stage.style.transform) frame(); });
    video.addEventListener('error', function () { finish(true); });
    video.addEventListener('canplay', begin, { once: true });

    buildCircuit();
    frame();
    video.src = G.src;
    video.load();
})();
