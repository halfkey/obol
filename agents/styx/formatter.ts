/**
 * STYX — Tweet Formatter
 *
 * Converts whale intelligence profiles into tweet threads.
 * Three content pillars:
 *   1. Whale regime shifts — portfolio composition changes
 *   2. DeFi flow summaries — aggregate patterns across wallets
 *   3. Concentration alerts — single-token risk flags
 *
 * Every tweet answers "so what?" — context, not just data.
 */

import type { WhaleProfile, StateSnapshot, WalletSnapshot } from './state.js';

// ── Formatters ──

function formatUSD(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

// ── Single Wallet Tweet ──

/**
 * Generate a tweet thread for a single whale profile.
 * Returns 1-3 tweets depending on how interesting the data is.
 */
export function formatWhaleThread(profile: WhaleProfile): string[] {
  const tweets: string[] = [];
  const { label, address } = profile;
  const tag = `${label} (${shortAddr(address)})`;

  if (!profile.overview) return [];

  const totalValue = profile.overview.totalValueUSD;

  // Tweet 1: Overview + top holdings
  let main = `${tag}\n`;
  main += `Portfolio: ${formatUSD(totalValue)}\n`;

  if (profile.portfolio?.tokens?.length) {
    const top3 = profile.portfolio.tokens
      .sort((a, b) => b.valueUSD - a.valueUSD)
      .slice(0, 3);

    main += '\nTop holdings:\n';
    for (const t of top3) {
      const sym = t.symbol || t.name || t.mint.slice(0, 6);
      const pct = t.percentOfPortfolio?.toFixed(0) ?? '?';
      main += `${sym}: ${formatUSD(t.valueUSD)} (${pct}%)\n`;
    }
  }

  // Add DeFi summary to first tweet if it fits
  if (profile.defi && profile.defi.totalDefiValueUSD > 0) {
    const defiPct = ((profile.defi.totalDefiValueUSD / totalValue) * 100).toFixed(0);
    main += `\nDeFi: ${formatUSD(profile.defi.totalDefiValueUSD)} (${defiPct}% of portfolio)`;
  }

  if (main.length <= 280) {
    tweets.push(main);
  } else {
    // Trim to fit
    tweets.push(main.slice(0, 277) + '...');
  }

  // Tweet 2: Signals (only if we have something interesting)
  const signals = detectTweetSignals(profile);
  if (signals.length > 0) {
    let signalTweet = `Signals for ${tag}:\n\n`;
    for (const s of signals) {
      const candidate = signalTweet + `${s}\n`;
      if (candidate.length > 280) break;
      signalTweet = candidate;
    }
    tweets.push(signalTweet.trim());
  }

  return tweets;
}

// ── Morning Scan (aggregate) ──

/**
 * Generate a morning scan tweet thread covering all tracked whales.
 * This is the daily "here's what smart money looks like" post.
 */
export function formatMorningScan(profiles: WhaleProfile[]): string[] {
  const tweets: string[] = [];
  const activeProfiles = profiles.filter(p => p.overview);

  if (activeProfiles.length === 0) return [];

  const totalValue = activeProfiles.reduce((s, p) => s + (p.overview?.totalValueUSD ?? 0), 0);
  const totalDefi = activeProfiles.reduce((s, p) => s + (p.defi?.totalDefiValueUSD ?? 0), 0);
  const defiPct = totalValue > 0 ? ((totalDefi / totalValue) * 100).toFixed(0) : '0';

  // Tweet 1: Headline
  let headline = `Styx Morning Scan\n`;
  headline += `${activeProfiles.length} wallets tracked\n\n`;
  headline += `Combined value: ${formatUSD(totalValue)}\n`;
  headline += `DeFi exposure: ${formatUSD(totalDefi)} (${defiPct}%)\n`;

  // Find biggest wallet
  const biggest = activeProfiles.sort((a, b) =>
    (b.overview?.totalValueUSD ?? 0) - (a.overview?.totalValueUSD ?? 0),
  )[0];
  if (biggest?.overview) {
    headline += `\nLargest: ${biggest.label} at ${formatUSD(biggest.overview.totalValueUSD)}`;
  }

  tweets.push(headline);

  // Tweet 2: Per-wallet summary
  let summary = 'Wallet breakdown:\n\n';
  for (const p of activeProfiles) {
    if (!p.overview) continue;
    const line = `${p.label}: ${formatUSD(p.overview.totalValueUSD)}\n`;
    if ((summary + line).length > 280) break;
    summary += line;
  }
  tweets.push(summary.trim());

  // Tweet 3: Aggregate signals
  const allSignals: string[] = [];
  for (const p of activeProfiles) {
    const signals = detectTweetSignals(p);
    for (const s of signals) {
      allSignals.push(`${p.label}: ${s}`);
    }
  }

  if (allSignals.length > 0) {
    let signalTweet = 'Notable signals:\n\n';
    for (const s of allSignals) {
      const candidate = signalTweet + `${s}\n`;
      if (candidate.length > 280) break;
      signalTweet = candidate;
    }
    tweets.push(signalTweet.trim());
  }

  // Tweet 4: Footer
  tweets.push('Data via Obol (x402 micropayments on Solana)\ngithub.com/halfkey/obol');

  return tweets;
}

// ── Change Detection Tweets ──

/**
 * Generate tweets based on changes between snapshots.
 * This is the "regime shift" content — only fires when something meaningful changes.
 */
export function formatChangeTweets(
  profiles: WhaleProfile[],
  previousSnapshot: StateSnapshot | null,
): string[] {
  if (!previousSnapshot) return []; // No prior state to compare against

  const tweets: string[] = [];

  for (const profile of profiles) {
    if (!profile.overview) continue;

    const prev = previousSnapshot.wallets[profile.address];
    if (!prev) continue; // New wallet, no comparison

    const changes = detectChanges(profile, prev);
    if (changes.length === 0) continue;

    let changeTweet = `${profile.label} (${shortAddr(profile.address)}) shift detected:\n\n`;
    for (const c of changes) {
      const candidate = changeTweet + `${c}\n`;
      if (candidate.length > 280) break;
      changeTweet = candidate;
    }
    tweets.push(changeTweet.trim());
  }

  return tweets;
}

// ── Change Detection Logic ──

function detectChanges(current: WhaleProfile, previous: WalletSnapshot): string[] {
  const changes: string[] = [];
  const currentValue = current.overview?.totalValueUSD ?? 0;
  const prevValue = previous.totalValueUSD;

  // Portfolio value shift > 10%
  if (prevValue > 0) {
    const pctChange = ((currentValue - prevValue) / prevValue) * 100;
    if (Math.abs(pctChange) > 10) {
      const direction = pctChange > 0 ? 'up' : 'down';
      changes.push(`Portfolio ${direction} ${Math.abs(pctChange).toFixed(0)}% (${formatUSD(prevValue)} -> ${formatUSD(currentValue)})`);
    }
  }

  // DeFi exposure shift > 15%
  const currentDefi = current.defi?.totalDefiValueUSD ?? 0;
  const prevDefi = previous.defiValueUSD;
  if (prevDefi > 0) {
    const defiChange = ((currentDefi - prevDefi) / prevDefi) * 100;
    if (Math.abs(defiChange) > 15) {
      const direction = defiChange > 0 ? 'increasing' : 'decreasing';
      changes.push(`DeFi exposure ${direction} ${Math.abs(defiChange).toFixed(0)}% (${formatUSD(prevDefi)} -> ${formatUSD(currentDefi)})`);
    }
  }

  // LST position change
  const currentLST = current.defi?.lst?.totalValueUSD ?? 0;
  const prevLST = previous.lstValueUSD;
  if (prevLST > 1000) {
    const lstChange = ((currentLST - prevLST) / prevLST) * 100;
    if (Math.abs(lstChange) > 20) {
      const direction = lstChange > 0 ? 'adding to' : 'unwinding';
      changes.push(`${direction} LST positions (${formatUSD(prevLST)} -> ${formatUSD(currentLST)})`);
    }
  }

  // New top holding that wasn't there before
  if (current.portfolio?.tokens?.length) {
    const currentTop = current.portfolio.tokens[0];
    if (currentTop && currentTop.percentOfPortfolio > 30) {
      const sym = currentTop.symbol || currentTop.name || currentTop.mint.slice(0, 8);
      if (!previous.topHoldings.includes(sym)) {
        changes.push(`New dominant position: ${sym} at ${currentTop.percentOfPortfolio.toFixed(0)}% of portfolio`);
      }
    }
  }

  // Risk level change
  if (current.risk && previous.riskLevel) {
    if (current.risk.riskLevel !== previous.riskLevel) {
      changes.push(`Risk shifted: ${previous.riskLevel} -> ${current.risk.riskLevel}`);
    }
  }

  return changes;
}

// ── Signal Detection ──

function detectTweetSignals(profile: WhaleProfile): string[] {
  const signals: string[] = [];

  // Major whale
  if (profile.overview && profile.overview.totalValueUSD > 1_000_000) {
    signals.push(`${formatUSD(profile.overview.totalValueUSD)} portfolio`);
  }

  // Heavy concentration
  if (profile.portfolio?.tokens?.length) {
    const top = profile.portfolio.tokens[0];
    if (top && top.percentOfPortfolio > 50) {
      const sym = top.symbol || top.name || top.mint.slice(0, 8);
      signals.push(`${top.percentOfPortfolio.toFixed(0)}% concentrated in ${sym}`);
    }
  }

  // High DeFi exposure
  if (profile.defi && profile.overview) {
    const defiPct = (profile.defi.totalDefiValueUSD / profile.overview.totalValueUSD) * 100;
    if (defiPct > 30) {
      signals.push(`${defiPct.toFixed(0)}% in DeFi`);
    }
  }

  // LST heavy
  if (profile.defi?.lst?.totalValueUSD && profile.defi.lst.totalValueUSD > 100_000) {
    signals.push(`${formatUSD(profile.defi.lst.totalValueUSD)} in liquid staking`);
  }

  // High risk
  if (profile.risk && profile.risk.overallScore > 70) {
    signals.push(`Risk: ${profile.risk.overallScore}/100 (${profile.risk.riskLevel})`);
  }

  return signals;
}
