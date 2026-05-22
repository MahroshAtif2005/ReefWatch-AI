import type { CSSProperties } from 'react';

type FishDrift = {
  top: string;
  size: number;
  duration: string;
  delay: string;
  opacity: number;
  scale: number;
  wave: number;
  rotation: number;
  staticX: string;
  tone: string;
};

type FishStyle = CSSProperties & {
  '--fish-top': string;
  '--fish-duration': string;
  '--fish-delay': string;
  '--fish-opacity': number;
  '--fish-scale': number;
  '--fish-wave': string;
  '--fish-rotation': string;
  '--fish-static-x': string;
};

const fishDrifts: FishDrift[] = [
  { top: '14%', size: 96, duration: '78s', delay: '-18s', opacity: 0.06, scale: 0.78, wave: 8, rotation: 1.4, staticX: '8vw', tone: '#7ee8fa' },
  { top: '24%', size: 128, duration: '92s', delay: '-54s', opacity: 0.075, scale: 1, wave: 12, rotation: 1.8, staticX: '64vw', tone: '#5ddbe8' },
  { top: '36%', size: 74, duration: '66s', delay: '-31s', opacity: 0.055, scale: 0.62, wave: 6, rotation: 1.1, staticX: '32vw', tone: '#9ff4ff' },
  { top: '51%', size: 112, duration: '84s', delay: '-8s', opacity: 0.08, scale: 0.9, wave: 10, rotation: 1.6, staticX: '76vw', tone: '#67e8f9' },
  { top: '67%', size: 86, duration: '72s', delay: '-43s', opacity: 0.065, scale: 0.7, wave: 7, rotation: 1.2, staticX: '18vw', tone: '#22d3ee' },
  { top: '79%', size: 150, duration: '108s', delay: '-72s', opacity: 0.05, scale: 1.16, wave: 14, rotation: 2, staticX: '48vw', tone: '#a5f3fc' },
  { top: '88%', size: 68, duration: '58s', delay: '-25s', opacity: 0.07, scale: 0.56, wave: 5, rotation: 0.9, staticX: '88vw', tone: '#5eead4' },
];

export function UnderwaterAmbientBackground() {
  return (
    <div className="underwater-ambient-background" aria-hidden="true">
      {fishDrifts.map((fish, index) => (
        <svg
          key={`${fish.top}-${fish.duration}`}
          className="underwater-ambient-fish"
          viewBox="0 0 140 54"
          width={fish.size}
          height={Math.round(fish.size * 0.39)}
          style={{
            '--fish-top': fish.top,
            '--fish-duration': fish.duration,
            '--fish-delay': fish.delay,
            '--fish-opacity': fish.opacity,
            '--fish-scale': fish.scale,
            '--fish-wave': `${fish.wave}px`,
            '--fish-rotation': `${fish.rotation}deg`,
            '--fish-static-x': fish.staticX,
            color: fish.tone,
          } as FishStyle}
        >
          <g className="underwater-ambient-fish__glow">
            <g transform="translate(140 0) scale(-1 1)">
              <path
                d="M24 27C42 8 80 6 109 27C80 48 42 46 24 27Z"
                fill="currentColor"
              />
              <path
                d="M107 27L134 9C128 22 128 32 134 45L107 27Z"
                fill="currentColor"
              />
              <path
                d="M44 20C54 14 68 13 83 18C70 22 56 24 44 20Z"
                fill="currentColor"
                opacity="0.48"
              />
              {index % 3 === 0 && (
                <path
                  d="M56 34C67 40 80 40 91 34C81 32 67 31 56 34Z"
                  fill="currentColor"
                  opacity="0.34"
                />
              )}
            </g>
          </g>
        </svg>
      ))}
    </div>
  );
}
