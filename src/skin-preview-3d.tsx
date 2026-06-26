import { useEffect, useRef } from 'react';
import steveUrl from './assets/steve.png';

// A 3D Minecraft skin preview
// (skinview3d / three.js): drag to rotate, gentle auto-rotate + walk. `src` is a skin-texture URL — the
// cross-origin /cdn/skins works (it sends Access-Control-Allow-Origin: *) — or a data: URL for an instant
// local preview. Falls back to Steve on any error. skinview3d is dynamic-imported so three.js stays out of
// the main bundle and only loads on the profile page.

type Viewer = {
  loadSkin: (src: string) => Promise<void>;
  dispose: () => void;
  animation: unknown;
  autoRotate: boolean;
  autoRotateSpeed: number;
  zoom: number;
  controls: { enableZoom: boolean; enablePan: boolean };
};

export function SkinPreview3D({ src, width = 240, height = 320 }: { src: string; width?: number; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const srcRef = useRef(src);
  srcRef.current = src;

  useEffect(() => {
    let disposed = false;
    let viewer: Viewer | null = null;
    void import('skinview3d').then((sv) => {
      if (disposed || !canvasRef.current) return;
      viewer = new sv.SkinViewer({ canvas: canvasRef.current, width, height }) as unknown as Viewer;
      const walk = new sv.WalkingAnimation();
      walk.speed = 0.55;
      viewer.animation = walk;
      viewer.autoRotate = true;
      viewer.autoRotateSpeed = 0.5;
      viewer.controls.enableZoom = false;
      viewer.controls.enablePan = false;
      viewer.zoom = 0.82;
      viewerRef.current = viewer;
      void viewer.loadSkin(srcRef.current || steveUrl).catch(() => viewer?.loadSkin(steveUrl).catch(() => {}));
    });
    return () => {
      disposed = true;
      viewerRef.current = null;
      viewer?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = viewerRef.current;
    if (v) void v.loadSkin(src || steveUrl).catch(() => v.loadSkin(steveUrl).catch(() => {}));
  }, [src]);

  return <canvas ref={canvasRef} aria-label="3D skin preview — drag to rotate" className="skin3d" />;
}

export default SkinPreview3D;
