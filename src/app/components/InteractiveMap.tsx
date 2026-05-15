import { motion } from 'motion/react';
import { useState } from 'react';
import { AlertTriangle, Droplet, ThermometerSun } from 'lucide-react';

interface ReefLocation {
  id: string;
  name: string;
  lat: number;
  lng: number;
  risk: 'safe' | 'warning' | 'critical';
  temperature: number;
  bleachingRisk: number;
}

const reefLocations: ReefLocation[] = [
  { id: '1', name: 'Great Barrier Reef', lat: 35, lng: 45, risk: 'warning', temperature: 28.5, bleachingRisk: 67 },
  { id: '2', name: 'Ningaloo Reef', lat: 42, lng: 38, risk: 'safe', temperature: 25.2, bleachingRisk: 23 },
  { id: '3', name: 'Raja Ampat', lat: 50, lng: 72, risk: 'critical', temperature: 31.2, bleachingRisk: 89 },
  { id: '4', name: 'Maldives Reefs', lat: 45, lng: 55, risk: 'warning', temperature: 29.1, bleachingRisk: 54 },
  { id: '5', name: 'Red Sea Reefs', lat: 38, lng: 42, risk: 'safe', temperature: 26.8, bleachingRisk: 18 },
  { id: '6', name: 'Caribbean Coral', lat: 32, lng: 22, risk: 'critical', temperature: 30.8, bleachingRisk: 92 },
  { id: '7', name: 'Hawaiian Reefs', lat: 28, lng: 15, risk: 'warning', temperature: 27.9, bleachingRisk: 48 },
  { id: '8', name: 'Palau Reefs', lat: 48, lng: 68, risk: 'safe', temperature: 26.1, bleachingRisk: 21 },
];

interface InteractiveMapProps {
  onReefSelect: (reef: ReefLocation) => void;
}

export function InteractiveMap({ onReefSelect }: InteractiveMapProps) {
  const [hoveredReef, setHoveredReef] = useState<string | null>(null);

  const getRiskColor = (risk: string) => {
    switch (risk) {
      case 'safe': return '#00d9a3';
      case 'warning': return '#ff8800';
      case 'critical': return '#ff4757';
      default: return '#00e5ff';
    }
  };

  return (
    <div className="relative w-full h-full bg-gradient-to-br from-ocean-deep via-blue-deep/20 to-ocean-dark overflow-hidden">
      {/* Ocean Grid Pattern */}
      <div className="absolute inset-0 opacity-5">
        <svg className="w-full h-full">
          <defs>
            <pattern id="grid" width="60" height="60" patternUnits="userSpaceOnUse">
              <path d="M 60 0 L 0 0 0 60" fill="none" stroke="currentColor" strokeWidth="0.5" className="text-cyan-glow" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid)" />
        </svg>
      </div>

      {/* Animated Ocean Waves */}
      <motion.div
        animate={{
          backgroundPosition: ['0% 0%', '100% 100%'],
        }}
        transition={{ duration: 25, repeat: Infinity, ease: 'linear' }}
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: 'radial-gradient(circle at 20% 50%, rgba(0, 212, 255, 0.4) 0%, transparent 60%), radial-gradient(circle at 80% 80%, rgba(0, 102, 204, 0.4) 0%, transparent 60%)',
          backgroundSize: '200% 200%',
        }}
      />

      {/* World Map Silhouette */}
      <div className="absolute inset-0 flex items-center justify-center opacity-20">
        <svg viewBox="0 0 800 400" className="w-full h-full">
          <path
            d="M100,150 Q150,100 250,120 T400,140 T550,130 Q650,140 700,160 L700,250 Q650,240 550,250 T400,260 T250,255 Q150,270 100,250 Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            className="text-blue-ocean"
          />
          <path
            d="M150,200 Q200,180 280,190 L320,210 Q360,200 400,210"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            className="text-blue-ocean"
          />
        </svg>
      </div>

      {/* Reef Markers */}
      <svg className="absolute inset-0 w-full h-full">
        {reefLocations.map((reef) => {
          const isHovered = hoveredReef === reef.id;
          const color = getRiskColor(reef.risk);

          return (
            <g key={reef.id}>
              {/* Pulse Ring */}
              <motion.circle
                cx={`${reef.lng}%`}
                cy={`${reef.lat}%`}
                r={isHovered ? 30 : 20}
                fill="none"
                stroke={color}
                strokeWidth="2"
                opacity={isHovered ? 0.6 : 0.3}
                animate={{
                  r: isHovered ? [20, 35, 20] : [15, 25, 15],
                  opacity: isHovered ? [0.6, 0, 0.6] : [0.3, 0, 0.3],
                }}
                transition={{
                  duration: 2,
                  repeat: Infinity,
                  ease: 'easeInOut',
                }}
              />

              {/* Main Marker */}
              <motion.circle
                cx={`${reef.lng}%`}
                cy={`${reef.lat}%`}
                r={isHovered ? 8 : 6}
                fill={color}
                style={{ filter: `drop-shadow(0 0 ${isHovered ? 12 : 8}px ${color})` }}
                className="cursor-pointer"
                onMouseEnter={() => setHoveredReef(reef.id)}
                onMouseLeave={() => setHoveredReef(null)}
                onClick={() => onReefSelect(reef)}
                whileHover={{ scale: 1.3 }}
                whileTap={{ scale: 0.9 }}
              />
            </g>
          );
        })}
      </svg>

      {/* Reef Info Tooltips */}
      {reefLocations.map((reef) => {
        if (hoveredReef !== reef.id) return null;

        return (
          <motion.div
            key={`tooltip-${reef.id}`}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            className="absolute pointer-events-none"
            style={{
              left: `${reef.lng}%`,
              top: `${reef.lat}%`,
              transform: 'translate(-50%, -120%)',
            }}
          >
            <div className="reef-panel-soft px-4 py-3 rounded-lg bg-ocean-dark/95 backdrop-blur-xl border border-gray-border/70 shadow-2xl">
              <h3 className="text-sm text-white mb-2">{reef.name}</h3>
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-xs">
                  <ThermometerSun className="w-3.5 h-3.5 text-coral-warning" />
                  <span className="text-gray-light">{reef.temperature}°C</span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <AlertTriangle className="w-3.5 h-3.5" style={{ color: getRiskColor(reef.risk) }} />
                  <span className="text-gray-light">Risk: {reef.bleachingRisk}%</span>
                </div>
              </div>
            </div>
          </motion.div>
        );
      })}

      {/* Floating Legend - Cleaner */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="reef-panel-soft absolute bottom-8 left-8 p-5 rounded-2xl bg-ocean-dark/72 backdrop-blur-2xl border border-gray-border/70 shadow-2xl"
      >
        <h4 className="text-xs uppercase tracking-wider text-gray-muted mb-4">Risk Level</h4>
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-2.5 h-2.5 rounded-full bg-coral-safe" style={{ boxShadow: '0 0 10px rgba(0, 217, 163, 0.6)' }} />
            <span className="text-sm text-gray-light">Safe</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-2.5 h-2.5 rounded-full bg-coral-warning" style={{ boxShadow: '0 0 10px rgba(255, 136, 0, 0.6)' }} />
            <span className="text-sm text-gray-light">Warning</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-2.5 h-2.5 rounded-full bg-coral-critical" style={{ boxShadow: '0 0 10px rgba(255, 71, 87, 0.6)' }} />
            <span className="text-sm text-gray-light">Critical</span>
          </div>
        </div>
      </motion.div>

      {/* Time Slider - More Spacious */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="reef-panel-soft absolute bottom-8 right-8 p-5 rounded-2xl bg-ocean-dark/72 backdrop-blur-2xl border border-gray-border/70 shadow-2xl min-w-[320px]"
      >
        <h4 className="text-xs uppercase tracking-wider text-gray-muted mb-4">Time Range</h4>
        <div className="space-y-4">
          <input
            type="range"
            min="0"
            max="100"
            defaultValue="100"
            className="w-full h-1.5 bg-ocean-medium rounded-lg appearance-none cursor-pointer accent-cyan-glow"
          />
          <div className="flex justify-between text-xs text-gray-muted">
            <span>Past Week</span>
            <span className="text-cyan-glow">Live</span>
            <span>Forecast</span>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
