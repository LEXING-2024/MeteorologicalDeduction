import Phaser from 'phaser';
import { GameController } from './app/GameController';
import { MAP_SIZE } from './config/constants';
import { GameScene } from './scenes/GameScene';

/*
 * The interactive chart, loaded on demand.
 *
 * Phaser is ~2 MB gzipped, and the title screen is plain HTML.  Keeping the
 * engine behind a dynamic import means the home screen becomes usable after
 * ~60 kB of JS instead of waiting for the whole engine; the first pointer-down
 * (or a 1.2 s idle window) pulls this module in.
 */

let booted = false;

export function isBooted(): boolean {
  return booted;
}

export function boot(): void {
  if (booted) return;
  booted = true;
  const parent = document.getElementById('weather-map');
  if (!parent) throw new Error('Weather map container is missing.');
  const mapFrame = document.getElementById('map-frame');

  function fitMapFrame(): void {
    if (!mapFrame) return;
    // The chart fills the whole map column; the camera can pan/zoom inside the
    // 1000×1000 world, so no letterboxing or fixed aspect ratio is needed.
    mapFrame.style.flex = '1 1 auto';
    mapFrame.style.width = '100%';
    mapFrame.style.height = '100%';
    mapFrame.style.margin = '0';
  }

  fitMapFrame();

  function renderScaleFor(width: number, height: number): number {
    // Always supersample the weather map, even on 1x displays. This removes the
    // soft, browser-upscaled look while staying inside a sensible pixel budget.
    const desired = 2;
    const budget = Math.sqrt(9_000_000 / Math.max(1, width * height));
    return Math.max(1, Math.min(desired, budget));
  }

  const initialWidth = Math.max(1, parent.clientWidth || MAP_SIZE);
  const initialHeight = Math.max(1, parent.clientHeight || MAP_SIZE);
  const initialScale = renderScaleFor(initialWidth, initialHeight);

  const scene = new GameScene();
  const controller = new GameController();
  scene.readyCallback = () => controller.start(scene);

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'weather-map',
    backgroundColor: '#0d1520',
    transparent: false,
    render: {
      antialias: true,
      pixelArt: false,
      roundPixels: false,
      powerPreference: 'high-performance',
    },
    scale: {
      mode: Phaser.Scale.NONE,
      autoCenter: Phaser.Scale.NO_CENTER,
      width: Math.round(initialWidth * initialScale),
      height: Math.round(initialHeight * initialScale),
      zoom: 1 / initialScale,
    },
    scene: [scene],
  });

  let resizeFrame = 0;

  function applyCanvasSize(): void {
    fitMapFrame();
    const width = Math.max(1, parent!.clientWidth);
    const height = Math.max(1, parent!.clientHeight);
    const scale = renderScaleFor(width, height);
    const targetWidth = Math.round(width * scale);
    const targetHeight = Math.round(height * scale);

    if (
      game.scale.width !== targetWidth ||
      game.scale.height !== targetHeight ||
      Math.abs(game.scale.zoom - 1 / scale) > 0.001
    ) {
      game.scale.setZoom(1 / scale);
      game.scale.resize(targetWidth, targetHeight);
    }
  }

  function queueCanvasResize(): void {
    if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = 0;
      applyCanvasSize();
    });
  }

  const resizeObserver = new ResizeObserver(queueCanvasResize);
  resizeObserver.observe(parent);
  window.addEventListener('resize', queueCanvasResize);
  window.visualViewport?.addEventListener('resize', queueCanvasResize);
  window.requestAnimationFrame(applyCanvasSize);

  // Exposed for local diagnostics; the game does not rely on this global.
  (window as unknown as { __weatherSystem?: Phaser.Game }).__weatherSystem = game;
  (window as unknown as { __weatherController?: GameController }).__weatherController = controller;

  // Vite HMR re-executes this module; detach the old controller's window
  // listeners and canvas observer before the replacement boots.
  import.meta.hot?.dispose(() => {
    resizeObserver.disconnect();
    window.removeEventListener('resize', queueCanvasResize);
    window.visualViewport?.removeEventListener('resize', queueCanvasResize);
    controller.destroy();
    game.destroy(true);
  });
}
