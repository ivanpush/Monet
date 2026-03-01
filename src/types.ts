// Status emoji mapping
// Four statuses: thinking (processing), active (using tools), waiting (needs input), idle (done)
export const STATUS_EMOJI: Record<string, string> = {
  thinking: '🔵',
  active: '🟢',
  waiting: '🟡',
  idle: '⚪'
};

// Project colors - Monet-inspired soft pastels with 50% transparency
// Custom colors defined in package.json contributes.colors
export const PROJECT_COLORS = [
  'monet.waterLily',      // Soft cyan - water lily reflections
  'monet.gardenMint',     // Soft green - garden foliage
  'monet.roseFloral',     // Soft pink - impressionist florals
  'monet.sunlightGold',   // Soft gold - sunlight on haystacks
  'monet.skyBlue',        // Soft blue - Monet skies
  'monet.deepWater',      // Muted teal - deeper water
  'monet.afternoonWarm',  // Soft tan - afternoon warmth
  'monet.eveningMauve',   // Soft purple - evening tones
  'monet.cloudWhite',     // Soft lavender - clouds
  'monet.sunsetCoral'     // Soft coral - sunset glow
] as const;

// Icon filenames matching the Monet palette order
export const PROJECT_ICONS = [
  'claude-spark-cyan.svg',      // Water lily blue
  'claude-spark-mint.svg',      // Mint green
  'claude-spark-rose.svg',      // Pink florals
  'claude-spark-yellow.svg',    // Pale gold
  'claude-spark-sky.svg',       // Sky blue
  'claude-spark-green.svg',     // Teal
  'claude-spark-peach.svg',     // Warm yellow
  'claude-spark-magenta.svg',   // Mauve
  'claude-spark-lavender.svg',  // Soft white
  'claude-spark-coral.svg'      // Coral - last resort
] as const;

// Session metadata stored in globalState
export interface SessionMeta {
  sessionId: string;       // Unique 8-char hex ID (never changes)
  position: number;        // Slot 1-20 (for display/ordering)
  projectPath: string;     // Full path to project
  projectName: string;     // Display name
  terminalName: string;    // Current terminal name
  createdAt: number;       // Timestamp
  isContinue: boolean;     // Was started with -c flag
  processId?: number;      // Terminal PID for reconnection after Extension Host restart
}

// Status file written by Claude agent at ~/.monet/status/{sessionId}.json
export interface SessionStatusFile {
  sessionId: string;       // Unique session ID
  project: string;         // Project name
  status: keyof typeof STATUS_EMOJI;
  title: string;           // What agent is working on
  titleSource?: 'draft' | 'final' | 'manual'; // Who set the title (draft < final < manual)
  error?: string;          // Error message if status is error
  updated: number;         // Timestamp
  processId?: number;      // Terminal PID for reconnection after Extension Host restart
  projectPath?: string;    // Full project path for reconnection
}

// Human-readable color names for QuickPick display
export const COLOR_DISPLAY_NAMES: Record<string, string> = {
  'monet.waterLily': 'Water Lily (cyan)',
  'monet.gardenMint': 'Garden Mint (green)',
  'monet.roseFloral': 'Rose Floral (pink)',
  'monet.sunlightGold': 'Sunlight Gold (gold)',
  'monet.skyBlue': 'Sky Blue (blue)',
  'monet.deepWater': 'Deep Water (teal)',
  'monet.afternoonWarm': 'Afternoon Warm (tan)',
  'monet.eveningMauve': 'Evening Mauve (purple)',
  'monet.cloudWhite': 'Cloud White (lavender)',
  'monet.sunsetCoral': 'Sunset Coral (coral)'
};

// Project info
export interface ProjectInfo {
  name: string;
  path: string;
  colorIndex: number;
}
