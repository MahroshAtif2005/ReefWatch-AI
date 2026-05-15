import { Search, Bell, User, Activity } from 'lucide-react';
import { motion } from 'motion/react';

export function Header() {
  return (
    <motion.header
      initial={{ y: -20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      className="h-20 border-b border-cyan-glow/10 bg-gradient-to-r from-ocean-dark/66 via-ocean-dark/58 to-ocean-deep/62 backdrop-blur-2xl flex items-center justify-between px-8"
    >
      {/* Search */}
      <div className="flex-1 max-w-2xl">
        <div className="relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-muted" />
          <input
            type="text"
            placeholder="Search reef locations, reports, analyses..."
            className="w-full pl-11 pr-4 py-3 bg-ocean-medium/56 border border-cyan-glow/10 rounded-xl text-sm text-white placeholder:text-gray-muted focus:outline-none focus:border-cyan-glow/30 focus:ring-2 focus:ring-cyan-glow/12 transition-all"
          />
        </div>
      </div>

      {/* Status Indicators */}
      <div className="flex items-center gap-6">
        {/* AI Agent Status */}
        <div className="flex items-center gap-2">
          <motion.div
            animate={{ scale: [1, 1.2, 1] }}
            transition={{ duration: 2, repeat: Infinity }}
            className="w-2 h-2 rounded-full bg-cyan-glow"
            style={{ boxShadow: '0 0 12px rgba(0, 212, 255, 0.8)' }}
          />
          <span className="text-xs text-gray-light">AI Active</span>
        </div>

        {/* NOAA Sync */}
        <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-ocean-medium/34 border border-cyan-glow/8 shadow-[inset_0_1px_0_rgba(191,253,255,0.04)]">
          <Activity className="w-4 h-4 text-blue-ocean" />
          <span className="text-xs text-gray-light">NOAA Live</span>
        </div>

        {/* Notifications */}
        <button className="relative p-2.5 rounded-xl hover:bg-ocean-medium/42 transition-colors">
          <Bell className="w-5 h-5 text-gray-light" />
          <span className="absolute top-1 right-1 w-2 h-2 bg-coral-warning rounded-full" />
        </button>

        {/* User */}
        <button className="flex items-center gap-2 px-4 py-2 rounded-xl hover:bg-ocean-medium/42 transition-colors">
          <User className="w-5 h-5 text-gray-light" />
          <span className="text-sm text-gray-light">Researcher</span>
        </button>
      </div>
    </motion.header>
  );
}
