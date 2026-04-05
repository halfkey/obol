/**
 * STYX — Twitter Client
 *
 * Handles OAuth 1.0a authentication and tweet posting via X API v2.
 * Supports single tweets and threads (reply chains).
 *
 * Requires: twitter-api-v2 package
 * Env vars: TWITTER_APP_KEY, TWITTER_APP_SECRET, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_SECRET
 */

import { TwitterApi } from 'twitter-api-v2';
import { logger } from './logger.js';

export interface TweetResult {
  id: string;
  text: string;
}

export class StyxTwitterClient {
  private client: TwitterApi;
  private dryRun: boolean;

  constructor(opts?: { dryRun?: boolean }) {
    this.dryRun = opts?.dryRun ?? false;

    const appKey = process.env.TWITTER_APP_KEY;
    const appSecret = process.env.TWITTER_APP_SECRET;
    const accessToken = process.env.TWITTER_ACCESS_TOKEN;
    const accessSecret = process.env.TWITTER_ACCESS_SECRET;

    if (!this.dryRun && (!appKey || !appSecret || !accessToken || !accessSecret)) {
      throw new Error(
        'Missing Twitter credentials. Set TWITTER_APP_KEY, TWITTER_APP_SECRET, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_SECRET',
      );
    }

    // Only create the real client when we have credentials
    if (!this.dryRun) {
      this.client = new TwitterApi({
        appKey: appKey!,
        appSecret: appSecret!,
        accessToken: accessToken!,
        accessSecret: accessSecret!,
      });
    } else {
      this.client = null as unknown as TwitterApi;
    }
  }

  /**
   * Post a single tweet.
   * Returns the tweet ID and text on success, null on failure.
   */
  async tweet(text: string): Promise<TweetResult | null> {
    if (text.length > 280) {
      logger.warn(`Tweet exceeds 280 chars (${text.length}), truncating`);
      text = text.slice(0, 277) + '...';
    }

    if (this.dryRun) {
      logger.info(`[DRY RUN] Would tweet:\n${text}`);
      return { id: `dry-${Date.now()}`, text };
    }

    try {
      const result = await this.client.v2.tweet(text);
      logger.info(`Tweet posted: ${result.data.id}`);
      return { id: result.data.id, text: result.data.text };
    } catch (err) {
      logger.error(`Failed to post tweet: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Post a thread (array of tweet texts).
   * Each tweet is posted as a reply to the previous one.
   * Returns array of tweet results.
   */
  async thread(tweets: string[]): Promise<TweetResult[]> {
    if (tweets.length === 0) return [];

    const results: TweetResult[] = [];
    let lastTweetId: string | null = null;

    for (let i = 0; i < tweets.length; i++) {
      let text = tweets[i];
      if (text.length > 280) {
        logger.warn(`Thread tweet ${i + 1} exceeds 280 chars (${text.length}), truncating`);
        text = text.slice(0, 277) + '...';
      }

      if (this.dryRun) {
        const id = `dry-${Date.now()}-${i}`;
        logger.info(`[DRY RUN] Thread ${i + 1}/${tweets.length}${lastTweetId ? ` (reply to ${lastTweetId})` : ''}:\n${text}`);
        results.push({ id, text });
        lastTweetId = id;
        continue;
      }

      try {
        const payload: { text: string; reply?: { in_reply_to_tweet_id: string } } = { text };
        if (lastTweetId) {
          payload.reply = { in_reply_to_tweet_id: lastTweetId };
        }

        const result = await this.client.v2.tweet(payload);
        const tweetResult = { id: result.data.id, text: result.data.text };
        results.push(tweetResult);
        lastTweetId = result.data.id;

        logger.info(`Thread ${i + 1}/${tweets.length} posted: ${result.data.id}`);

        // Small delay between tweets to avoid rate limits
        if (i < tweets.length - 1) {
          await new Promise(r => setTimeout(r, 1000));
        }
      } catch (err) {
        logger.error(`Thread tweet ${i + 1} failed: ${(err as Error).message}`);
        break; // Don't continue thread if a tweet fails
      }
    }

    return results;
  }

  /**
   * Verify credentials work by fetching the authenticated user.
   */
  async verify(): Promise<{ id: string; username: string } | null> {
    if (this.dryRun) {
      logger.info('[DRY RUN] Skipping credential verification');
      return { id: 'dry', username: 'StyxOnSolana' };
    }

    try {
      const me = await this.client.v2.me();
      logger.info(`Authenticated as @${me.data.username} (${me.data.id})`);
      return { id: me.data.id, username: me.data.username };
    } catch (err) {
      logger.error(`Twitter auth failed: ${(err as Error).message}`);
      return null;
    }
  }
}
