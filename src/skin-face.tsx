import { useEffect, useRef } from 'react';
import steveUrl from './assets/steve.png';

// Draws the FACE (head front)
// of a Minecraft skin onto a crisp, pixelated canvas: the 8×8 region at (8,8) is the head front,
// and (40,8) is the hat/overlay on 64×64 skins. drawImage display doesn't need CORS. Falls back
// to Steve when there's no skin / the image fails to load.

export function SkinFace({
  src,
  size = 28,
  className = '',
}: {
  src?: string | null;
  size?: number;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let cancelled = false;
    const draw = (image: HTMLImageElement) => {
      if (cancelled) return;
      ctx.clearRect(0, 0, size, size);
      ctx.imageSmoothingEnabled = false; // keep blocky pixels crisp
      ctx.drawImage(image, 8, 8, 8, 8, 0, 0, size, size); // head front
      if (image.naturalHeight >= 64) ctx.drawImage(image, 40, 8, 8, 8, 0, 0, size, size); // hat layer
    };

    const img = new Image();
    img.onload = () => draw(img);
    img.onerror = () => {
      if (cancelled || (src || steveUrl) === steveUrl) return;
      const fb = new Image();
      fb.onload = () => draw(fb);
      fb.src = steveUrl;
    };
    img.src = src || steveUrl;

    return () => {
      cancelled = true;
    };
  }, [src, size]);

  return (
    <canvas
      ref={ref}
      width={size}
      height={size}
      aria-hidden="true"
      className={className}
      style={{ imageRendering: 'pixelated', width: size, height: size }}
    />
  );
}

export default SkinFace;
