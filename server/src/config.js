import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// 始终加载项目根目录 .env（覆盖默认 cwd 行为，保证从任意目录启动一致）
dotenv.config({ path: path.join(ROOT, '.env') });

function num(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : Number(v);
}
function str(name, def = '') {
  const v = process.env[name];
  return v === undefined ? def : v.trim();
}

export const config = {
  root: ROOT,
  port: num('PORT', 4117),
  dbFile: str('DB_FILE') || path.join(ROOT, 'data', 'hotpulse.db'),
  webDist: path.join(ROOT, 'web', 'dist'),
  scanCron: str('SCAN_CRON', '*/30 * * * *'),

  openrouter: {
    apiKey: str('OPENROUTER_API_KEY'),
    model: str('OPENROUTER_MODEL', 'qwen/qwen3.8-27b:free'),
    fallbackModels: str('OPENROUTER_FALLBACK_MODELS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    baseUrl: str('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
  },
  twitter: {
    apiKey: str('TWITTERAPI_IO_KEY'),
    maxCallsPerScan: num('TWITTER_MAX_CALLS_PER_SCAN', 12),
  },
  smtp: {
    host: str('SMTP_HOST'),
    port: num('SMTP_PORT', 465),
    secure: str('SMTP_SECURE', 'true') === 'true',
    user: str('SMTP_USER'),
    pass: str('SMTP_PASS'),
    from: str('MAIL_FROM') || str('SMTP_USER'),
    to: str('MAIL_TO'),
  },
  vapid: {
    publicKey: str('VAPID_PUBLIC_KEY'),
    privateKey: str('VAPID_PRIVATE_KEY'),
    subject: str('VAPID_SUBJECT', 'mailto:hotpulse@localhost'),
  },
  thresholds: {
    minConfidence: num('AI_NOTIFY_MIN_CONFIDENCE', 0.6),
    minTopicScore: num('TOPIC_NOTIFY_MIN_SCORE', 70),
  },
};

/** 运行时可被 settings 表覆盖的配置项 */
export const SETTING_KEYS = [
  'scanCron',
  'openrouter.model',
  'openrouter.fallbackModels',
  'thresholds.minConfidence',
  'thresholds.minTopicScore',
  'notify.email.enabled',
  'notify.webpush.enabled',
  'twitter.maxCallsPerScan',
  // 质量门槛（gates.*，见 server/src/quality.js DEFAULT_GATES）
  'gates.hnPoints',
  'gates.hnComments',
  'gates.hfUpvotes',
  'gates.ghStarsToday',
  'gates.ghSearchStars',
  'gates.redditScore',
  'gates.lobstersScore',
  'gates.twitterLikes',
    'gates.biliScore',
    'gates.authHn',
    'gates.authReddit',
    'gates.authTwitter',
    'gates.authLobsters',
    'gates.authGhTrending',
    'gates.authGhSearch',
    'gates.authHfPapers',
    'gates.authBili',
  'gates.minQuality',
  'gates.maxAgeDays',
  'gates.dedupThreshold',
  'gates.dedupEnabled',
    'gates.engagementWeight',
    'gates.engagementFull',
  ];

export default config;
