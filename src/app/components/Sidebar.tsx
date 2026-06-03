import { Activity, Map, TrendingUp, FileText, Microscope, Cpu, Settings, Waves } from 'lucide-react';
import { motion } from 'motion/react';

interface SidebarProps {
  activeView: string;
  onViewChange: (view: string) => void;
}

const menuItems = [
  { id: 'dashboard', label: 'Dashboard', icon: Activity },
  { id: 'map', label: 'Live Reef Map', icon: Map },
  { id: 'analytics', label: 'Analytics', icon: TrendingUp },
  { id: 'reports', label: 'Conservation Reports', icon: FileText },
  { id: 'workspace', label: 'Researcher Workspace', icon: Microscope },
  { id: 'agents', label: 'Agent Activity', icon: Cpu },
  { id: 'monitoring', label: 'Arize Monitoring', icon: Waves },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export function Sidebar({ activeView, onViewChange }: SidebarProps) {
  return (
    <motion.aside
      initial={{ x: -20, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      className="w-72 h-full border-r border-cyan-glow/10 bg-gradient-to-b from-ocean-dark/62 via-ocean-dark/54 to-ocean-deep/58 backdrop-blur-2xl flex flex-col"
    >
      {/* Logo */}
      <div className="p-8 border-b border-cyan-glow/10">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-cyan-glow to-blue-ocean flex items-center justify-center">
            <Waves className="w-6 h-6 text-ocean-deep" />
          </div>
          <div>
            <h1 className="text-xl tracking-tight text-white">ReefWatch AI</h1>
            <p className="text-xs text-gray-muted">Environmental Intelligence</p>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-6 space-y-2 overflow-y-auto">
        {menuItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeView === item.id;

          return (
            <motion.button
              key={item.id}
              onClick={() => onViewChange(item.id)}
              whileHover={{ x: 4 }}
              whileTap={{ scale: 0.98 }}
              className={`
                w-full flex items-center gap-3 px-4 py-3.5 rounded-xl transition-all
                ${isActive
                  ? 'bg-cyan-glow/10 text-cyan-glow border border-cyan-glow/20'
                  : 'text-gray-light hover:bg-ocean-medium/45 hover:text-white border border-transparent'
                }
              `}
            >
              <Icon className={`w-5 h-5 ${isActive ? 'text-cyan-glow' : ''}`} />
              <span className="text-sm">{item.label}</span>
              {isActive && (
                <motion.div
                  layoutId="activeIndicator"
                  className="ml-auto w-1.5 h-1.5 rounded-full bg-cyan-glow"
                  style={{ boxShadow: '0 0 8px rgba(0, 212, 255, 0.8)' }}
                />
              )}
            </motion.button>
          );
        })}
      </nav>

      {/* System Status */}
      <div className="p-6 border-t border-cyan-glow/10">
        <div className="p-4 rounded-xl bg-ocean-medium/28 border border-cyan-glow/8 shadow-[inset_0_1px_0_rgba(191,253,255,0.04)] space-y-3">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-coral-safe animate-pulse" />
            <span className="text-xs text-gray-light">System Operational</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-cyan-glow animate-pulse" />
            <span className="text-xs text-gray-light">NOAA Data Synced</span>
          </div>
        </div>
      </div>
    </motion.aside>
  );
}
