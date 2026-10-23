import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ConnectionStatus from '../components/common/ConnectionStatus';
import QlickerWordmark from '../components/common/QlickerWordmark';
import { APP_VERSION } from '../utils/version';
import './HomeAnimated.css';

const DOODLES = [
  '/animated-hero/assets/doodles/atom.svg',
  '/animated-hero/assets/doodles/flask.svg',
  '/animated-hero/assets/doodles/globe.svg',
  '/animated-hero/assets/doodles/paperplane.svg',
  '/animated-hero/assets/doodles/pencil.svg',
  '/animated-hero/assets/doodles/backpack.svg',
  '/animated-hero/assets/doodles/apple.svg',
  '/animated-hero/assets/doodles/cap.svg',
];

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

export default function Home() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const heroRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) return undefined;

    const heroEl = heroRef.current;
    const canvasEl = canvasRef.current;
    if (!heroEl || !canvasEl) return undefined;

    const ctx = canvasEl.getContext('2d', { alpha: true });
    if (!ctx) return undefined;

    const sprites = [];
    let resizeObserver = null;
    let frameId = null;
    let canceled = false;
    const parallax = { x: 0, y: 0 };
    const parallaxTarget = { x: 0, y: 0 };

    function lerp(a, b, t) {
      return a + (b - a) * t;
    }

    function resize() {
      const rect = heroEl.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvasEl.width = Math.floor(rect.width * dpr);
      canvasEl.height = Math.floor(rect.height * dpr);
      canvasEl.style.width = `${rect.width}px`;
      canvasEl.style.height = `${rect.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function makeSprite(img, x0 = null, y0 = null) {
      const rect = heroEl.getBoundingClientRect();
      const depth = rand(0.35, 1.0);
      const size = rand(90, 220) * depth;
      return {
        img,
        depth,
        x: x0 === null ? rand(-160, rect.width + 160) : x0,
        y: y0 === null ? rand(-160, rect.height + 160) : y0,
        size,
        vx: rand(-0.18, 0.18) * (0.25 + depth),
        vy: rand(-0.18, 0.18) * (0.25 + depth),
        rot: rand(0, Math.PI * 2),
        vr: rand(-0.004, 0.004) * (0.2 + depth),
        alpha: rand(0.35, 0.65) * (0.45 + depth * 0.55),
        wobblePhase: rand(0, Math.PI * 2),
        wobbleSpeed: rand(0.002, 0.007) * (0.4 + depth),
        wobbleAmp: rand(6, 18) * (0.4 + depth),
        blur: (1 - depth) * 2.2,
      };
    }

    function handleMouseMove(event) {
      const rect = heroEl.getBoundingClientRect();
      const nx = (event.clientX - rect.left) / rect.width;
      const ny = (event.clientY - rect.top) / rect.height;

      const boundedX = Math.max(0, Math.min(1, nx));
      const boundedY = Math.max(0, Math.min(1, ny));

      parallaxTarget.x = (boundedX - 0.5) * 2;
      parallaxTarget.y = (boundedY - 0.5) * 2;
    }

    function handleMouseLeave() {
      parallaxTarget.x = 0;
      parallaxTarget.y = 0;
    }

    function drawFrame() {
      if (canceled) return;
      const rect = heroEl.getBoundingClientRect();
      ctx.clearRect(0, 0, rect.width, rect.height);

      parallax.x = lerp(parallax.x, parallaxTarget.x, 0.06);
      parallax.y = lerp(parallax.y, parallaxTarget.y, 0.06);

      const wash = ctx.createRadialGradient(
        rect.width * 0.55,
        rect.height * 0.35,
        60,
        rect.width * 0.55,
        rect.height * 0.35,
        Math.max(rect.width, rect.height)
      );
      wash.addColorStop(0, 'rgba(255,255,255,0.06)');
      wash.addColorStop(1, 'rgba(255,255,255,0.72)');
      ctx.fillStyle = wash;
      ctx.fillRect(0, 0, rect.width, rect.height);

      sprites.sort((a, b) => a.depth - b.depth);

      for (const sprite of sprites) {
        sprite.x += sprite.vx;
        sprite.y += sprite.vy;
        sprite.rot += sprite.vr;
        sprite.wobblePhase += sprite.wobbleSpeed;

        const pad = 260;
        if (sprite.x < -pad) sprite.x = rect.width + pad;
        if (sprite.x > rect.width + pad) sprite.x = -pad;
        if (sprite.y < -pad) sprite.y = rect.height + pad;
        if (sprite.y > rect.height + pad) sprite.y = -pad;

        const wobbleX = Math.cos(sprite.wobblePhase) * sprite.wobbleAmp;
        const wobbleY = Math.sin(sprite.wobblePhase * 0.9) * (sprite.wobbleAmp * 0.85);
        const parallaxX = parallax.x * 28 * sprite.depth;
        const parallaxY = parallax.y * 18 * sprite.depth;

        ctx.save();
        ctx.globalAlpha = sprite.alpha;
        ctx.filter = sprite.blur > 0 ? `blur(${sprite.blur}px)` : 'none';
        ctx.translate(sprite.x + wobbleX + parallaxX, sprite.y + wobbleY + parallaxY);
        ctx.rotate(sprite.rot);
        ctx.drawImage(sprite.img, -sprite.size / 2, -sprite.size / 2, sprite.size, sprite.size);
        ctx.restore();
      }

      frameId = requestAnimationFrame(drawFrame);
    }

    async function loadImages() {
      const loaders = DOODLES.map((src) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
      }));
      return Promise.all(loaders);
    }

    async function init() {
      try {
        resize();
        const images = await loadImages();
        if (canceled) return;

        const spriteCount = 52;
        const rect = heroEl.getBoundingClientRect();
        const cols = 10;
        const rows = 6;

        let i = 0;
        for (let gy = 0; gy < rows && i < spriteCount; gy += 1) {
          for (let gx = 0; gx < cols && i < spriteCount; gx += 1) {
            const cellW = rect.width / cols;
            const cellH = rect.height / rows;
            const x = (gx * cellW) + rand(cellW * 0.15, cellW * 0.85);
            const y = (gy * cellH) + rand(cellH * 0.15, cellH * 0.85);
            sprites.push(makeSprite(images[i % images.length], x, y));
            i += 1;
          }
        }

        while (i < spriteCount) {
          sprites.push(makeSprite(images[i % images.length]));
          i += 1;
        }

        resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(heroEl);
        heroEl.addEventListener('mousemove', handleMouseMove, { passive: true });
        heroEl.addEventListener('mouseleave', handleMouseLeave, { passive: true });

        drawFrame();
      } catch {
        // Keep hero usable even if decorative assets fail to load.
      }
    }

    init();

    return () => {
      canceled = true;
      if (frameId) cancelAnimationFrame(frameId);
      if (resizeObserver) resizeObserver.disconnect();
      heroEl.removeEventListener('mousemove', handleMouseMove);
      heroEl.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, []);

  return (
    <>
      <ConnectionStatus />
      <main className="homeHero" id="hero" ref={heroRef}>
        <canvas className="homeHeroCanvas" id="bgCanvas" ref={canvasRef} aria-hidden="true" />

        <div className="homeHeroContent">
          <div className="homeHeroCopy">
            <QlickerWordmark className="homeHeroWordmark" title={t('common.appName')} />
            <div className="homeHeroEyebrow">{t('home.tagline')}</div>
            <h1 className="homeHeroTitle">{t('home.subtitle')}</h1>
            <p className="homeHeroSubtitle">
              {t('home.description')}
            </p>
            <div className="homeHeroCtaRow">
              <button className="homeHeroBtn homeHeroBtnPrimary" type="button" onClick={() => navigate('/login')}>
                {t('home.getStarted')}
              </button>
            </div>
            <div className="homeHeroNote">{APP_VERSION}</div>
            <div className="homeHeroNote">{t('home.motionNote')}</div>
          </div>

          <div className="homeHeroDevice">
            <img className="homeHeroPhone" src="/animated-hero/assets/phone/phone-body-new.png" alt={t('home.phoneAlt')} />
            <div className="homeHeroScreenMask" aria-hidden="true">
              <video className="homeHeroScreenVideo" autoPlay muted loop playsInline preload="auto">
                <source src="/animated-hero/assets/video/phonescreen.mp4" type="video/mp4" />
              </video>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
