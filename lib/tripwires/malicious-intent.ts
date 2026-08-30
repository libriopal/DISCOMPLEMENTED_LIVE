/**
 * Malicious Intent Detection — pre-prompt tripwires.
 *
 * Fires BEFORE the pipeline runs. If a user's prompt matches any
 * malicious pattern, the request is denied immediately and the
 * account is flagged for review.
 *
 * Detection layers:
 * 1. Regex pattern match (fast, <1ms)
 * 2. Semantic similarity (Cohere embeddings, ~50ms)
 * 3. LLM classification (Command A, ~2s)
 * 4. Multi-turn context analysis (~100ms)
 *
 * This file is public (open-source) — the patterns themselves
 * are defensive, not offensive. The Monte Carlo that TUNES these
 * patterns is in the private DISCOMPLEMENTED_ADMIN repo.
 */

export type MaliciousCategory =
  | 'fraud'
  | 'malware'
  | 'drugs'
  | 'weapons'
  | 'csam'
  | 'trafficking'
  | 'terrorism'
  | 'counterfeit'
  | 'harassment'
  | 'hate'
  | 'disinfo'
  | 'piracy';

export type MaliciousAction =
  | 'deny' // deny the prompt, don't run pipeline
  | 'deny+flag' // deny + flag account
  | 'deny+flag+report'; // deny + flag + report to law enforcement

export interface MaliciousPattern {
  id: string;
  pattern: RegExp;
  severity: 'critical' | 'high';
  action: MaliciousAction;
  category: MaliciousCategory;
  description: string;
}

export const MALICIOUS_PATTERNS: MaliciousPattern[] = [
  // Fraud & Scams
  {
    id: 'mal_01_phishing',
    pattern:
      /phishing|fake.{0,10}login|steal.{0,10}password|credential.{0,10}harvest/i,
    severity: 'critical',
    action: 'deny+flag',
    category: 'fraud',
    description: 'Phishing or credential harvesting application',
  },
  {
    id: 'mal_02_ponzi',
    pattern:
      /ponzi|pyramid.{0,10}scheme|guaranteed.{0,10}return|investment.{0,10}scam/i,
    severity: 'critical',
    action: 'deny+flag',
    category: 'fraud',
    description: 'Ponzi scheme or investment scam',
  },
  {
    id: 'mal_03_money_steal',
    pattern:
      /steal.{0,10}money|drain.{0,10}wallet|crypto.{0,10}steal|hack.{0,10}bank/i,
    severity: 'critical',
    action: 'deny+flag',
    category: 'fraud',
    description: 'Money or cryptocurrency theft tool',
  },
  {
    id: 'mal_04_fake_exchange',
    pattern: /fake.{0,10}exchange|wash.{0,10}trading|market.{0,10}manipulat/i,
    severity: 'critical',
    action: 'deny+flag',
    category: 'fraud',
    description: 'Fake exchange or market manipulation platform',
  },

  // Malware
  {
    id: 'mal_05_malware',
    pattern: /\bmalware\b|\bvirus\b|\btrojan\b|\bbackdoor\b|\brootkit\b/i,
    severity: 'critical',
    action: 'deny+flag',
    category: 'malware',
    description: 'Malware creation tool',
  },
  {
    id: 'mal_06_ransomware',
    pattern:
      /ransomware|encrypt.{0,10}files.{0,10}demand|lock.{0,10}computer.{0,10}ransom/i,
    severity: 'critical',
    action: 'deny+flag',
    category: 'malware',
    description: 'Ransomware or extortion tool',
  },
  {
    id: 'mal_07_spyware',
    pattern:
      /spyware|keylogger|screen.{0,10}capture.{0,10}spy|surveillance.{0,10}app/i,
    severity: 'critical',
    action: 'deny+flag',
    category: 'malware',
    description: 'Spyware or surveillance tool',
  },
  {
    id: 'mal_08_botnet',
    pattern: /botnet|ddos.{0,10}tool|zombie.{0,10}army|c2.{0,10}server/i,
    severity: 'critical',
    action: 'deny+flag',
    category: 'malware',
    description: 'Botnet or DDoS tool',
  },
  {
    id: 'mal_09_cryptominer',
    pattern: /crypto.{0,10}miner|silent.{0,10}mining|cryptojacking/i,
    severity: 'high',
    action: 'deny+flag',
    category: 'malware',
    description: 'Cryptocurrency miner or cryptojacking tool',
  },

  // Illegal drugs
  {
    id: 'mal_10_drug_market',
    pattern:
      /drug.{0,10}market|drug.{0,10}selling|narcotic.{0,10}trade|dark.{0,10}web.{0,10}shop/i,
    severity: 'critical',
    action: 'deny+flag',
    category: 'drugs',
    description: 'Illegal drug marketplace',
  },
  {
    id: 'mal_11_drug_manufacture',
    pattern:
      /meth.{0,10}recipe|cocaine.{0,10}manufactur|fentanyl.{0,10}synthesi/i,
    severity: 'critical',
    action: 'deny+flag',
    category: 'drugs',
    description: 'Drug manufacturing instructions',
  },

  // Weapons
  {
    id: 'mal_12_weapons',
    pattern:
      /weapon.{0,10}blueprint|gun.{0,10}manufactur|bomb.{0,10}instruction|3d.{0,10}print.{0,10}gun/i,
    severity: 'critical',
    action: 'deny+flag',
    category: 'weapons',
    description: 'Weapon manufacturing or bomb-making instructions',
  },

  // CSAM (zero tolerance — report to NCMEC)
  {
    id: 'mal_13_csam',
    pattern:
      /child.{0,10}sexual|minor.{0,10}explicit|\bcsam\b|underage.{0,10}content/i,
    severity: 'critical',
    action: 'deny+flag+report',
    category: 'csam',
    description:
      'Child sexual abuse material (zero tolerance, reported to NCMEC)',
  },

  // Human trafficking
  {
    id: 'mal_14_trafficking',
    pattern:
      /human.{0,10}traffick|trafficking.{0,10}platform|smuggle.{0,10}people/i,
    severity: 'critical',
    action: 'deny+flag+report',
    category: 'trafficking',
    description: 'Human trafficking platform',
  },

  // Terrorism
  {
    id: 'mal_15_terrorism',
    pattern:
      /terrorist.{0,10}recruit|bomb.{0,10}making|extremist.{0,10}platform|isis|al.{0,5}qaeda/i,
    severity: 'critical',
    action: 'deny+flag+report',
    category: 'terrorism',
    description: 'Terrorism facilitation or recruitment platform',
  },

  // Counterfeit
  {
    id: 'mal_16_counterfeit',
    pattern:
      /counterfeit.{0,10}goods|fake.{0,10}brand|replica.{0,10}sell|knock.{0,5}off.{0,10}market/i,
    severity: 'high',
    action: 'deny+flag',
    category: 'counterfeit',
    description: 'Counterfeit goods marketplace',
  },

  // Hate/harassment platforms
  {
    id: 'mal_17_harassment',
    pattern:
      /doxxing.{0,10}tool|harass.{0,10}campaign|swatting|raid.{0,10}tool/i,
    severity: 'critical',
    action: 'deny+flag',
    category: 'harassment',
    description: 'Harassment or doxxing tool',
  },
  {
    id: 'mal_18_hate_platform',
    pattern:
      /hate.{0,10}speech.{0,10}platform|nazi.{0,10}forum|white.{0,10}supremacist.{0,10}site/i,
    severity: 'critical',
    action: 'deny+flag',
    category: 'hate',
    description: 'Hate speech or supremacist platform',
  },

  // Election interference
  {
    id: 'mal_19_disinfo',
    pattern:
      /disinformation.{0,10}campaign|fake.{0,10}news.{0,10}generator|election.{0,10}manipulat/i,
    severity: 'high',
    action: 'deny+flag',
    category: 'disinfo',
    description: 'Disinformation or election interference tool',
  },

  // Copyright piracy
  {
    id: 'mal_20_piracy',
    pattern:
      /pirate.{0,10}content|crack.{0,10}software|license.{0,10}bypass|drm.{0,10}circumvent/i,
    severity: 'high',
    action: 'deny+flag',
    category: 'piracy',
    description: 'Copyright piracy or DRM circumvention tool',
  },
];

/**
 * Layer 1: Fast regex scan.
 * Runs on every prompt. Returns first match or null.
 */
export function scanPromptRegex(prompt: string): MaliciousPattern | null {
  for (const pattern of MALICIOUS_PATTERNS) {
    if (pattern.pattern.test(prompt)) {
      return pattern;
    }
  }
  return null;
}

/**
 * Get all patterns by category.
 */
export function getPatternsByCategory(
  category: MaliciousCategory
): MaliciousPattern[] {
  return MALICIOUS_PATTERNS.filter((p) => p.category === category);
}

/**
 * Get all critical patterns (immediate ban).
 */
export function getCriticalPatterns(): MaliciousPattern[] {
  return MALICIOUS_PATTERNS.filter((p) => p.severity === 'critical');
}
